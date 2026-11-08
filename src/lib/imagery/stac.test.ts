import { afterEach, describe, expect, it, vi } from "vitest";
import type { BBox } from "../domain";
import { covers, isHazy, minClear, pickBest, previewUrl, searchFreeScenes, stacInterval, toCandidates, type SceneCandidate } from "./stac";

const LA: BBox = [-118.2608, 34.041, -118.2392, 34.059];
const TILE_BOX: BBox = [-119, 33.5, -117.5, 34.6];

function item(id: string, datetime: string, opts: { tile?: string; cloud?: number; box?: BBox; gen?: string; baseline?: string } = {}) {
  const [x0, y0, x1, y1] = opts.box ?? TILE_BOX;
  return {
    id,
    geometry: { type: "Polygon", coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] },
    properties: {
      datetime,
      "eo:cloud_cover": opts.cloud ?? 5,
      "s2:mgrs_tile": opts.tile ?? "11SLT",
      "s2:processing_baseline": opts.baseline ?? "05.13",
      "s2:generation_time": opts.gen ?? datetime,
    },
  };
}

function cand(id: string, day: number, clear: number | null, blue: number | null = 0.1, cloud = 5): SceneCandidate {
  return {
    collection: "sentinel-2-l2a",
    item_id: id,
    datetime: `2026-10-${String(day).padStart(2, "0")}T18:00:00Z`,
    cloud_pct: cloud,
    aoi_clear_fraction: clear,
    aoi_blue: blue,
  };
}

describe("pure helpers", () => {
  it("formats STAC intervals and the clear-fraction requirement", () => {
    expect(stacInterval({ start: "2025-01-12", end: "2025-02-10" })).toBe("2025-01-12T00:00:00Z/2025-02-10T23:59:59Z");
    expect(minClear(20)).toBeCloseTo(0.8);
    expect(minClear(0)).toBe(0.95);
  });

  it("checks footprint coverage of all four AOI corners", () => {
    expect(covers(item("a", "x").geometry, LA)).toBe(true);
    expect(covers(item("b", "x", { box: [-118.25, 33.5, -117.5, 34.6] }).geometry, LA)).toBe(false);
    const multi = { type: "MultiPolygon", coordinates: [item("c", "x").geometry.coordinates] };
    expect(covers(multi, LA)).toBe(true);
    expect(covers(null, LA)).toBe(false);
  });

  it("dedupes by date + tile (newest processing wins), sorts newest first, prefers full cover", () => {
    const items = [
      item("old", "2026-10-01T18:00:00Z"),
      item("edge", "2026-10-20T18:00:00Z", { box: [-118.25, 33.5, -117.5, 34.6] }),
      item("dup-a", "2026-10-10T18:00:00Z", { gen: "2026-10-10T20:00:00Z" }),
      item("dup-b", "2026-10-10T18:00:00Z", { gen: "2026-10-11T09:00:00Z" }),
    ];
    const got = toCandidates(items, "sentinel-2-l2a", LA);
    expect(got.map((c) => c.item_id)).toEqual(["dup-b", "old"]);
    expect(got[0]).toMatchObject({ mgrs_tile: "11SLT", processing_baseline: "05.13", covers_aoi: true, cloud_pct: 5 });
    expect(toCandidates([items[1]], "sentinel-2-l2a", LA).map((c) => c.item_id)).toEqual(["edge"]);
  });

  it("keeps one tile per acquisition when the AOI sits on a tile overlap", () => {
    const edge = item("30SYJ-edge", "2024-11-10T10:51:59Z", { tile: "30SYJ", box: [-118.25, 33.5, -117.5, 34.6] });
    const full = item("31SBD-full", "2024-11-10T10:51:59Z", { tile: "31SBD" });
    expect(toCandidates([edge, full], "sentinel-2-l2a", LA).map((c) => c.item_id)).toEqual(["31SBD-full"]);
    expect(toCandidates([full, edge], "sentinel-2-l2a", LA).map((c) => c.item_id)).toEqual(["31SBD-full"]);
  });

  it("picks the newest clear, non-hazy scene", () => {
    expect(pickBest([cand("a", 24, 0.5), cand("b", 19, 0.97), cand("c", 9, 1)], 0.8, 20)?.item_id).toBe("b");
    // SCL said 99.7% clear on a hazy day in LA; blue 0.135 vs 0.101 on a clear one.
    expect(pickBest([cand("hazy", 24, 0.997, 0.135), cand("clear", 19, 1, 0.101)], 0.8, 20)?.item_id).toBe("clear");
    expect(isHazy(0.11, 0.101)).toBe(false);
  });

  it("falls back to the clearest measured, then to tile cloud cover", () => {
    expect(pickBest([cand("a", 24, 0.3), cand("b", 19, 0.6)], 0.8, 20)?.item_id).toBe("b");
    expect(pickBest([cand("a", 24, null, null, 60), cand("b", 19, null, null, 10)], 0.8, 20)?.item_id).toBe("b");
    expect(pickBest([cand("a", 24, null, null, 60)], 0.8, 20)?.item_id).toBe("a");
    expect(pickBest([], 0.8, 20)).toBeNull();
  });
});

describe("previewUrl", () => {
  const scene = { collection: "sentinel-2-l2a", item_id: "S2C_X", datetime: "2026-10-24T18:34:31Z", cloud_pct: 1 };

  it("crops the TCI asset for true colour with the AOI's aspect ratio", () => {
    const url = new URL(previewUrl(scene, LA, "true_color", 400));
    expect(url.pathname).toMatch(/\/api\/data\/v1\/item\/bbox\/-118\.2608,34\.041,-118\.2392,34\.059\/\d+x\d+\.png$/);
    const [w, h] = url.pathname.split("/").pop()!.replace(".png", "").split("x").map(Number);
    expect(Math.max(w, h)).toBe(400);
    expect(Math.abs(w - h)).toBeLessThan(5); // a 2 x 2 km box stays square
    expect(url.searchParams.get("assets")).toBe("visual");
    expect(url.searchParams.get("asset_bidx")).toBe("visual|1,2,3");
  });

  it("folds the BOA offset into the NDVI denominator by baseline or date", () => {
    const ndvi = (s: typeof scene & { processing_baseline?: string }) => new URL(previewUrl(s, LA, "ndvi")).searchParams.get("expression");
    expect(ndvi(scene)).toBe("(B08-B04)/(B08+B04-2000)");
    expect(ndvi({ ...scene, datetime: "2021-06-12T18:00:00Z" })).toBe("(B08-B04)/(B08+B04)");
    expect(ndvi({ ...scene, datetime: "2021-06-12T18:00:00Z", processing_baseline: "04.00" })).toBe("(B08-B04)/(B08+B04-2000)");
    expect(previewUrl(scene, LA, "ndvi")).toContain("expression=%28B08-B04%29%2F%28B08%2BB04-2000%29");
  });

  it("supports Landsat", () => {
    const ls = { ...scene, collection: "landsat-c2-l2", item_id: "LC08_X" };
    expect(new URL(previewUrl(ls, LA, "true_color")).searchParams.getAll("assets")).toEqual(["red", "green", "blue"]);
    expect(new URL(previewUrl(ls, LA, "ndvi")).searchParams.get("expression")).toBe("(nir08-red)/(nir08+red-14545)");
  });
});

describe("searchFreeScenes", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Fake Planetary Computer: STAC features per window start, statistics per item id (null = HTTP 500). */
  function stubPc(features: Record<string, unknown[]>, stats: Record<string, [number, number] | null>, onStats?: (id: string) => void) {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init: RequestInit) => {
        const url = String(input);
        const body = JSON.parse(String(init.body));
        calls.push({ url, body });
        if (url.endsWith("/search")) {
          const start = String(body.datetime).slice(0, 10);
          return Response.json({ type: "FeatureCollection", features: features[start] ?? [] });
        }
        const id = new URL(url).searchParams.get("item")!;
        onStats?.(id);
        const s = stats[id];
        if (!s) return new Response("boom", { status: 500 });
        return Response.json({ properties: { statistics: { clear_expr: { mean: s[0] }, B02: { median: s[1] } } } });
      }),
    );
    return calls;
  }

  const query = {
    bbox: LA,
    after: { start: "2026-09-01", end: "2026-11-07" },
    before: { start: "2025-09-01", end: "2025-11-07" },
    maxCloudPct: 20,
  };

  it("measures the newest candidates and picks clear, non-hazy scenes on the after tile", async () => {
    const calls = stubPc(
      {
        "2026-09-01": [item("A-cloudy", "2026-11-03T18:00:00Z", { cloud: 56 }), item("A-clear", "2026-10-24T18:00:00Z")],
        "2025-09-01": [
          item("B-hazy", "2025-11-03T18:00:00Z"),
          item("B-other-tile", "2025-11-01T18:00:00Z", { tile: "11SLU" }),
          item("B-clear", "2025-10-29T18:00:00Z"),
        ],
      },
      { "A-cloudy": [0.4, 1900], "A-clear": [1, 2010], "B-hazy": [0.997, 2344], "B-clear": [1, 2010] },
    );
    const r = await searchFreeScenes(query);
    expect(r.provider_id).toBe("pc-sentinel-2-l2a");
    expect(r.after).toMatchObject({ item_id: "A-clear", aoi_clear_fraction: 1, aoi_blue: 0.101 });
    expect(r.before?.item_id).toBe("B-clear");
    expect(r.candidates.before.map((c) => c.item_id)).toEqual(["B-hazy", "B-clear"]); // other tile dropped
    expect(r.after?.preview_url).toContain("item=A-clear");
    expect(r.notes.join(" ")).toMatch(/before: skipped 1 scene\(s\) ahead of it/);
    const search = calls.find((c) => c.url.endsWith("/search"))!;
    expect(search.body).toMatchObject({
      collections: ["sentinel-2-l2a"],
      query: { "eo:cloud_cover": { lte: 80 } },
      sortby: [{ field: "datetime", direction: "desc" }],
    });
  });

  it("can prefer the earliest clear after scene (floods)", async () => {
    stubPc(
      { "2026-09-01": [item("late", "2026-11-03T18:00:00Z"), item("mid", "2026-10-24T18:00:00Z"), item("early", "2026-10-14T18:00:00Z")] },
      { late: [1, 2000], mid: [1, 2000], early: [0.2, 2000] },
    );
    const r = await searchFreeScenes({ ...query, before: null, afterPreference: "earliest" });
    expect(r.after?.item_id).toBe("mid");
    expect(r.candidates.after.map((c) => c.item_id)).toEqual(["early", "mid", "late"]);
  });

  const statsIds = (calls: { url: string }[]) => calls.filter((c) => c.url.includes("/statistics")).map((c) => new URL(c.url).searchParams.get("item"));

  /** Four cloudy newest scenes, then six older ones with tile cloud 70, 5, 50, 10, 60, 20 %. */
  function cloudySpell(clearOlder: Record<string, number>) {
    const days = [30, 27, 24, 21, 18, 15, 12, 9, 6, 3];
    const tileCloud = [5, 5, 5, 5, 70, 5, 50, 10, 60, 20];
    const items = days.map((d, i) => item(`D${d}`, `2026-10-${String(d).padStart(2, "0")}T18:00:00Z`, { cloud: tileCloud[i] }));
    const stats = Object.fromEntries(days.map((d) => [`D${d}`, [clearOlder[`D${d}`] ?? 0.3, 2000] as [number, number]]));
    return { features: { "2026-09-01": items }, stats };
  }

  it("when the newest scenes are cloudy, measures the least cloudy older ones before settling for the clearest", async () => {
    const pc = cloudySpell({ D15: 0.9, D9: 0.97, D18: 1 }); // D18 is clear but its tile is 70 % cloud: not measured
    const calls = stubPc(pc.features, pc.stats);
    const r = await searchFreeScenes({ ...query, before: null });
    expect(statsIds(calls)).toEqual(["D30", "D27", "D24", "D21", "D15", "D9", "D3", "D12"]);
    expect(r.after).toMatchObject({ item_id: "D15", aoi_clear_fraction: 0.9 }); // newest of the clear ones
    expect(r.notes).toEqual(["after: D15 (2026-10-15), 90% of the AOI clear (SCL)."]);
  });

  it("stops at 8 statistics calls and reports the clearest measured", async () => {
    const pc = cloudySpell({ D12: 0.5 });
    const calls = stubPc(pc.features, pc.stats);
    const r = await searchFreeScenes({ ...query, before: null });
    expect(statsIds(calls)).toHaveLength(8);
    expect(r.after?.item_id).toBe("D12");
    expect(r.notes[1]).toBe("after: no scene in the window is clear enough; this is the clearest of 8 measured.");
  });

  it("skips the extra round when the first one used up the time budget", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const pc = cloudySpell({ D15: 0.9 });
      const calls = stubPc(pc.features, pc.stats, () => vi.setSystemTime(Date.now() + 1_100)); // 4 slow calls: 4.4 s
      const r = await searchFreeScenes({ ...query, before: null });
      expect(statsIds(calls)).toHaveLength(4);
      expect(r.after?.item_id).toBe("D30"); // clearest measured (ties keep preference order)
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not look further when a newest scene is clear", async () => {
    const pc = cloudySpell({ D24: 0.9 });
    const calls = stubPc(pc.features, pc.stats);
    expect((await searchFreeScenes({ ...query, before: null })).after?.item_id).toBe("D24");
    expect(statsIds(calls)).toHaveLength(4);
  });

  it("falls back to tile cloud cover when statistics fail", async () => {
    stubPc({ "2026-09-01": [item("A1", "2026-11-03T18:00:00Z", { cloud: 60 }), item("A2", "2026-10-24T18:00:00Z", { cloud: 3 })] }, {});
    const r = await searchFreeScenes({ ...query, before: null });
    expect(r.after).toMatchObject({ item_id: "A2", aoi_clear_fraction: null });
    expect(r.before).toBeNull();
    expect(r.notes[0]).toMatch(/AOI cloud not measured, tile cloud cover 3%/);
  });

  it("returns nulls and notes when nothing covers the area", async () => {
    stubPc({}, {});
    const r = await searchFreeScenes(query);
    expect(r.after).toBeNull();
    expect(r.before).toBeNull();
    expect(r.notes).toEqual([
      "after: no scene covers the area between 2026-09-01 and 2026-11-07.",
      "before: no scene covers the area between 2025-09-01 and 2025-11-07.",
    ]);
  });

  it("throws on a STAC outage (not a 'no scenes' case)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    await expect(searchFreeScenes(query)).rejects.toThrow("HTTP 503");
  });
});

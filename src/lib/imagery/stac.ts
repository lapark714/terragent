/**
 * OWNER: imagery builder. Free scene search on Microsoft Planetary Computer (TypeScript, no Python).
 *
 * STAC search (anonymous POST, sorted towards the preferred end of the window) → one item per satellite pass,
 * passes that cover the AOI (one tile, or several stitched) first → AOI clear fraction and haze check for the first few in preference order
 * (newest, or oldest for floods) from the data API (TiTiler) statistics on SCL + B02 (and, when none
 * of them is clear enough, the least cloudy few of the rest, inside a time budget) → best before/after. Verified endpoints and traps: docs/platform/imagery.md §3.1, §3.8, §3.14. The Python
 * pipeline (pipeline/terragent_pipeline/scenes.py) applies the same rules at full resolution.
 */
import type { BBox, DateRange, SceneRef } from "../domain";

const STAC_URL = "https://planetarycomputer.microsoft.com/api/stac/v1";
const DATA_URL = "https://planetarycomputer.microsoft.com/api/data/v1";

const SCREEN_PER_WINDOW = 4; // newest candidates whose AOI we measure (stats calls run in parallel)
const EXTRA_SCREEN = 4; // if none of those is clear enough: the least cloudy (by tile) of the older ones, like scenes.py
const MEASURE_BUDGET_MS = 5_000; // per window (both windows run at once): the extra round only gets what is left …
const MIN_EXTRA_MS = 1_000; // … and is skipped when less than this remains
const LIST_PER_WINDOW = 8; // candidates returned to the agent (keeps the MCP reply small)
const TILE_CLOUD_CAP = 80; // eo:cloud_cover is per 110 km tile: only drop hopeless tiles before measuring
const HAZE_ABS = 0.025; // median blue reflectance this far above the window's clearest scene = haze …
const HAZE_REL = 1.2; // … and this many times it (SCL calls haze "clear"; seen live in downtown LA)
const SEARCH_TIMEOUT_MS = 8_000;
const STATS_TIMEOUT_MS = 4_000;
/** ESA processing baseline 04.00 (DN + 1000 offset) went live on 2022-01-25. */
const BASELINE_04_DATE = "2022-01-25";
/** SCL classes that are not usable ground: nodata, saturated, cloud shadow, cloud medium/high, cirrus. */
const SCL_CLEAR_EXPR = "where((SCL<=1)|(SCL==3)|((SCL>=8)&(SCL<=10)),0,1)";

export interface FreeSceneQuery {
  bbox: BBox;
  before: DateRange | null;
  after: DateRange;
  maxCloudPct: number;
  collection?: "sentinel-2-l2a" | "landsat-c2-l2";
  /** "earliest" = first clear scene of the after window (floods recede within days). Default "latest". */
  afterPreference?: "latest" | "earliest";
}

/** A SceneRef (cloud_pct = tile eo:cloud_cover) plus what we measured over the AOI. */
export interface SceneCandidate extends SceneRef {
  aoi_clear_fraction?: number | null; // share of the AOI clear by SCL; null = not measured
  aoi_blue?: number | null; // median blue reflectance of the AOI (haze check)
  mgrs_tile?: string | null;
  processing_baseline?: string | null;
  covers_aoi?: boolean; // one tile, or the tiles of its satellite pass together, cover the whole AOI
  aoi_coverage_fraction?: number | null; // share of the AOI inside this pass's footprints
  stitched_tiles?: string[]; // no single tile covers the AOI: the pipeline stitches these (the first is item_id's tile)
  pass_items?: { item_id: string; share: number }[]; // each stitched tile and the share of the AOI it holds, for measuring
  preview_url?: string; // true-colour crop of the AOI (PNG), for the chosen scenes
}

export interface FreeSceneResult {
  provider_id: string; // registry id, e.g. "pc-sentinel-2-l2a"
  collection: string;
  before: SceneCandidate | null;
  after: SceneCandidate | null;
  candidates: { before: SceneCandidate[]; after: SceneCandidate[] };
  notes: string[];
}

interface StacItem {
  id: string;
  geometry: { type: string; coordinates: unknown } | null;
  properties: Record<string, unknown>;
}

type Ring = [number, number][];

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

export function stacInterval(w: DateRange): string {
  const stamp = (s: string, time: string) => (s.includes("T") ? s : `${s}${time}`);
  return `${stamp(w.start, "T00:00:00Z")}/${stamp(w.end, "T23:59:59Z")}`;
}

/** Share of the AOI that must be clear; capped below 1 because SCL flags a few stray pixels in most scenes. */
export function minClear(maxCloudPct: number): number {
  return Math.min(Math.max(1 - maxCloudPct / 100, 0), 0.95);
}

function inRing([x, y]: [number, number], ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** True if the footprint contains all four AOI corners (footprints are convex; AOIs are small). */
export function covers(geometry: StacItem["geometry"], [x0, y0, x1, y1]: BBox): boolean {
  if (!geometry) return false;
  const polygons = (geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates) as Ring[][];
  const corners: [number, number][] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  return polygons.some((poly) => corners.every((c) => inRing(c, poly[0])));
}

function tileOf(p: Record<string, unknown>): string | null {
  if (p["s2:mgrs_tile"]) return String(p["s2:mgrs_tile"]);
  if (p["landsat:wrs_path"] && p["landsat:wrs_row"]) return `${p["landsat:wrs_path"]}/${p["landsat:wrs_row"]}`;
  return null;
}

/** Share of the AOI inside the union of the footprints, from an n x n sample of points. Same as stac.py coverage(). */
export function coverage(geometries: (StacItem["geometry"] | undefined)[], [x0, y0, x1, y1]: BBox, n = 24): number {
  const rings: Ring[] = [];
  for (const g of geometries) {
    if (!g) continue;
    const polygons = (g.type === "Polygon" ? [g.coordinates] : g.coordinates) as Ring[][];
    rings.push(...polygons.map((poly) => poly[0]));
  }
  let hits = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const pt: [number, number] = [x0 + ((i + 0.5) * (x1 - x0)) / n, y0 + ((j + 0.5) * (y1 - y0)) / n];
      if (rings.some((ring) => inRing(pt, ring))) hits++;
    }
  }
  return hits / (n * n);
}

/** One satellite pass: UTC day, platform and orbit. Its tiles are cut from one continuous image, so they stitch. */
function passKey(p: Record<string, unknown>): string {
  return `${String(p.datetime).slice(0, 10)}|${p.platform ?? ""}|${p["sat:relative_orbit"] ?? p["landsat:wrs_path"] ?? ""}`;
}

/** The sampled union counts as the whole AOI (one sample point is about 0.17%). */
const FULL_COVERAGE = 0.995;

/**
 * Newest first, one item per satellite pass (tiles overlap, so an AOI can sit in two). The item kept is the tile that
 * covers the most of the AOI, then the latest processing. A pass whose tiles together cover the AOI counts as covering
 * it (the pipeline stitches them: stac.py same_pass); passes that don't stay only if no pass covers the AOI.
 */
export function toCandidates(items: StacItem[], collection: string, bbox: BBox): SceneCandidate[] {
  const rank = (i: StacItem) =>
    [covers(i.geometry, bbox) ? 1 : 0, coverage([i.geometry], bbox), String(i.properties["s2:generation_time"] ?? ""), tileOf(i.properties) ?? ""] as const;
  const better = (a: StacItem, b: StacItem) => {
    const [x, y] = [rank(a), rank(b)];
    for (let k = 0; k < x.length; k++) if (x[k] !== y[k]) return x[k] > y[k];
    return false;
  };
  const passes = new Map<string, StacItem[]>();
  for (const it of items) {
    const key = passKey(it.properties);
    passes.set(key, [...(passes.get(key) ?? []), it]);
  }
  const all = [...passes.values()]
    .map((group): SceneCandidate => {
      const it = group.reduce((best, next) => (better(next, best) ? next : best));
      const p = it.properties;
      const cloud = typeof p["eo:cloud_cover"] === "number" ? (p["eo:cloud_cover"] as number) : null;
      const alone = covers(it.geometry, bbox);
      const union = alone ? 1 : coverage(group.map((g) => g.geometry), bbox);
      const tiles = [...new Set([tileOf(p), ...group.map((g) => tileOf(g.properties))].filter((t): t is string => !!t))];
      const stitched = !alone && tiles.length > 1;
      // One item per tile (the newest processing), the kept item first.
      const perTile = tiles.map((t) => (t === tileOf(p) ? it : group.filter((g) => tileOf(g.properties) === t).reduce((a, b) => (better(b, a) ? b : a))));
      return {
        collection,
        item_id: it.id,
        datetime: String(p.datetime),
        cloud_pct: cloud === null ? null : Math.round(cloud * 100) / 100,
        aoi_clear_fraction: null,
        aoi_blue: null,
        mgrs_tile: tileOf(p),
        processing_baseline: p["s2:processing_baseline"] ? String(p["s2:processing_baseline"]) : null,
        covers_aoi: alone || union >= FULL_COVERAGE,
        aoi_coverage_fraction: Math.round(union * 1000) / 1000,
        ...(stitched ? { stitched_tiles: tiles, pass_items: perTile.map((g) => ({ item_id: g.id, share: Math.round(coverage([g.geometry], bbox) * 1000) / 1000 })) } : {}),
      };
    })
    .sort((a, b) => b.datetime.localeCompare(a.datetime));
  const full = all.filter((c) => c.covers_aoi);
  return full.length ? full : all;
}

export function isHazy(blue: number | null | undefined, clearest: number | null): boolean {
  if (blue == null || clearest == null) return false;
  return blue > clearest + HAZE_ABS && blue > clearest * HAZE_REL;
}

/**
 * Candidates are in preference order (newest first, or oldest first for floods). Measured ones: the first that is
 * clear enough and not hazy, else the first clear enough, else the clearest. Nothing measured: the first whose tile
 * cloud cover is within the limit, else the first.
 */
export function pickBest(cands: SceneCandidate[], need: number, maxCloudPct: number): SceneCandidate | null {
  const measured = cands.filter((c) => c.aoi_clear_fraction != null);
  const ok = measured.filter((c) => c.aoi_clear_fraction! >= need);
  if (ok.length) {
    const blues = ok.map((c) => c.aoi_blue).filter((b): b is number => b != null);
    const clearest = blues.length ? Math.min(...blues) : null;
    return ok.find((c) => !isHazy(c.aoi_blue, clearest)) ?? ok[0];
  }
  if (measured.length) return measured.reduce((a, b) => (b.aoi_clear_fraction! > a.aoi_clear_fraction! ? b : a));
  return cands.find((c) => c.cloud_pct != null && c.cloud_pct <= maxCloudPct) ?? cands[0] ?? null;
}

function usesBoaOffset(scene: SceneRef & { processing_baseline?: string | null }): boolean {
  if (scene.processing_baseline) return parseFloat(scene.processing_baseline) >= 4;
  return scene.datetime.slice(0, 10) >= BASELINE_04_DATE;
}

function sizeFor([x0, y0, x1, y1]: BBox, px: number): [number, number] {
  const midLat = (((y0 + y1) / 2) * Math.PI) / 180;
  const wKm = (x1 - x0) * 111.32 * Math.cos(midLat);
  const hKm = (y1 - y0) * 110.574;
  const s = px / Math.max(wKm, hKm);
  return [Math.max(1, Math.round(wKm * s)), Math.max(1, Math.round(hKm * s))];
}

/** Planetary Computer data API (TiTiler) PNG preview URL for a scene cropped to bbox. */
export function previewUrl(
  scene: SceneRef & { processing_baseline?: string | null },
  bbox: BBox,
  kind: "true_color" | "ndvi",
  px = 512,
): string {
  const q = new URLSearchParams({ collection: scene.collection, item: scene.item_id });
  const landsat = scene.collection === "landsat-c2-l2";
  if (kind === "true_color" && landsat) {
    for (const band of ["red", "green", "blue"]) q.append("assets", band);
    q.set("rescale", "7300,20000");
    q.set("color_formula", "Gamma RGB 1.4");
  } else if (kind === "true_color") {
    q.set("assets", "visual");
    q.set("asset_bidx", "visual|1,2,3");
  } else {
    // The server applies no scale/offset: fold them into the denominator (the numerator offsets cancel).
    const [nir, red] = landsat ? ["nir08", "red"] : ["B08", "B04"];
    const offset = landsat ? 14545 : usesBoaOffset(scene) ? 2000 : 0;
    q.set("expression", offset ? `(${nir}-${red})/(${nir}+${red}-${offset})` : `(${nir}-${red})/(${nir}+${red})`);
    q.set("asset_as_band", "true");
    q.set("rescale", "-0.2,0.8");
    q.set("colormap_name", "rdylgn");
  }
  const [w, h] = sizeFor(bbox, px);
  return `${DATA_URL}/item/bbox/${bbox.join(",")}/${w}x${h}.png?${q}`;
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/**
 * One page (50 items) of the window, sorted towards the end we prefer: newest first by default, oldest first for
 * "earliest". The page is all we read, so with a long window and the wrong direction the first scenes after the
 * event would never be seen (a flood window from the event date to today easily holds hundreds of items).
 */
async function stacSearch(
  collection: string,
  bbox: BBox,
  window: DateRange,
  maxCloudPct: number,
  tile: string | null,
  direction: "asc" | "desc" = "desc",
): Promise<StacItem[]> {
  const query: Record<string, unknown> = { "eo:cloud_cover": { lte: Math.max(TILE_CLOUD_CAP, maxCloudPct) } };
  if (collection === "landsat-c2-l2") query.platform = { in: ["landsat-8", "landsat-9"] };
  if (tile && collection === "sentinel-2-l2a") query["s2:mgrs_tile"] = { eq: tile };
  const [x0, y0, x1, y1] = bbox;
  const res = await fetch(`${STAC_URL}/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      collections: [collection],
      intersects: { type: "Polygon", coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] },
      datetime: stacInterval(window),
      query,
      sortby: [{ field: "datetime", direction }],
      limit: 50,
    }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Planetary Computer STAC search failed: HTTP ${res.status}`);
  return ((await res.json()) as { features?: StacItem[] }).features ?? [];
}

/** Clear fraction (SCL) and median blue reflectance (B02) of one item over the AOI. Null on any failure. */
async function statistics(c: SceneCandidate, itemId: string, bbox: BBox, timeoutMs: number): Promise<{ clear: number | null; blue: number | null } | null> {
  const [x0, y0, x1, y1] = bbox;
  const q = new URLSearchParams({
    collection: c.collection,
    item: itemId,
    expression: `${SCL_CLEAR_EXPR};B02`,
    asset_as_band: "true",
  });
  try {
    const res = await fetch(`${DATA_URL}/item/statistics?${q}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { properties?: { statistics?: Record<string, { mean?: number; median?: number }> } };
    const [clear, blue] = Object.values(body.properties?.statistics ?? {});
    return { clear: typeof clear?.mean === "number" ? clear.mean : null, blue: typeof blue?.median === "number" ? blue.median : null };
  } catch {
    return null;
  }
}

/**
 * AOI clear fraction and haze check for a candidate. The statistics cover only the pixels inside a tile, so a stitched
 * pass is measured tile by tile and combined by each tile's share of the AOI, and the part of the AOI the pass doesn't
 * reach counts as not clear. If any tile can't be measured the candidate stays unmeasured.
 */
async function measure(c: SceneCandidate, bbox: BBox, timeoutMs = STATS_TIMEOUT_MS): Promise<SceneCandidate> {
  const parts = c.pass_items ?? [{ item_id: c.item_id, share: 1 }];
  const stats = await Promise.all(parts.map((p) => statistics(c, p.item_id, bbox, timeoutMs)));
  if (stats.some((s) => s === null)) return c;
  const weigh = (pick: (s: NonNullable<(typeof stats)[number]>) => number | null): number | null => {
    const known = parts.map((p, i) => ({ share: p.share, value: pick(stats[i]!) })).filter((x) => x.value !== null);
    const total = known.reduce((sum, x) => sum + x.share, 0);
    return known.length === parts.length && total > 0 ? known.reduce((sum, x) => sum + x.value! * x.share, 0) / total : null;
  };
  const clear = weigh((s) => s.clear);
  const blue = weigh((s) => s.blue);
  const offset = usesBoaOffset(c) ? 1000 : 0;
  return {
    ...c,
    aoi_clear_fraction: clear === null ? null : Math.round(clear * (c.aoi_coverage_fraction ?? 1) * 1000) / 1000,
    aoi_blue: blue === null ? null : Math.round(((blue - offset) / 10000) * 10000) / 10000,
  };
}

const tileCloud = (c: SceneCandidate) => c.cloud_pct ?? 100;

/**
 * Measures the first few candidates (in preference order). If none is clear enough, also measures the least cloudy
 * (by tile) of the rest, at most EXTRA_SCREEN more and only while the window's budget lasts, so a cloudy spell at
 * the newest end of the window doesn't hide a clear scene a few passes earlier. Order is kept; unmeasured ones
 * stay as they are.
 */
async function measureCandidates(cands: SceneCandidate[], bbox: BBox, need: number): Promise<SceneCandidate[]> {
  const started = Date.now();
  const out = [...cands];
  const measureAt = async (idx: number[], timeoutMs: number) => {
    const done = await Promise.all(idx.map((i) => measure(out[i], bbox, timeoutMs)));
    idx.forEach((i, k) => (out[i] = done[k]));
  };
  await measureAt(out.slice(0, SCREEN_PER_WINDOW).map((_, i) => i), STATS_TIMEOUT_MS);
  if (out.slice(0, SCREEN_PER_WINDOW).some((c) => (c.aoi_clear_fraction ?? 0) >= need)) return out;
  const left = MEASURE_BUDGET_MS - (Date.now() - started);
  if (left < MIN_EXTRA_MS || out.length <= SCREEN_PER_WINDOW) return out;
  const extra = out
    .map((c, i) => ({ c, i }))
    .slice(SCREEN_PER_WINDOW)
    .sort((a, b) => tileCloud(a.c) - tileCloud(b.c) || a.i - b.i)
    .slice(0, EXTRA_SCREEN)
    .map(({ i }) => i);
  await measureAt(extra, Math.min(STATS_TIMEOUT_MS, left));
  return out;
}

function describe(label: string, pick: SceneCandidate | null, cands: SceneCandidate[], need: number, window: DateRange): string[] {
  if (!pick) return [`${label}: no scene covers the area between ${window.start} and ${window.end}.`];
  const day = pick.datetime.slice(0, 10);
  const notes: string[] = [];
  if (pick.aoi_clear_fraction == null) {
    notes.push(`${label}: ${pick.item_id} (${day}); AOI cloud not measured, tile cloud cover ${pick.cloud_pct ?? "?"}%.`);
  } else {
    notes.push(`${label}: ${pick.item_id} (${day}), ${Math.round(pick.aoi_clear_fraction * 100)}% of the AOI clear (SCL).`);
    if (pick.aoi_clear_fraction < need) {
      const checked = cands.filter((c) => c.aoi_clear_fraction != null).length;
      notes.push(`${label}: no scene in the window is clear enough; this is the clearest of ${checked} measured.`);
    }
  }
  if (pick.stitched_tiles?.length) {
    notes.push(`${label}: no single tile covers the AOI; the pipeline stitches ${pick.stitched_tiles.join(" + ")} from this satellite pass.`);
  }
  if ((pick.aoi_coverage_fraction ?? 1) < 0.98) {
    notes.push(
      `${label}: this satellite pass covers only ${Math.round((pick.aoi_coverage_fraction ?? 0) * 100)}% of the AOI. The rest cannot be measured from it: ` +
        "shrink the AOI to what is covered or say so in the option's answers before quoting.",
    );
  }
  const skipped = cands.slice(0, cands.indexOf(pick)).filter((c) => (c.aoi_clear_fraction ?? 0) >= need);
  if (skipped.length) notes.push(`${label}: skipped ${skipped.length} scene(s) ahead of it that SCL calls clear but look hazy.`);
  return notes;
}

/** Best clear before/after scenes for an AOI. Never throws for "no scenes" — returns nulls + notes. */
export async function searchFreeScenes(q: FreeSceneQuery): Promise<FreeSceneResult> {
  const collection = q.collection ?? "sentinel-2-l2a";
  const need = minClear(q.maxCloudPct);
  const earliest = q.afterPreference === "earliest";
  const [afterItems, beforeItems] = await Promise.all([
    stacSearch(collection, q.bbox, q.after, q.maxCloudPct, null, earliest ? "asc" : "desc"),
    q.before ? stacSearch(collection, q.bbox, q.before, q.maxCloudPct, null) : Promise.resolve([]),
  ]);
  const afterCands = toCandidates(afterItems, collection, q.bbox);
  if (earliest) afterCands.reverse(); // toCandidates sorts newest first; the page above holds the oldest items
  let beforeCands = toCandidates(beforeItems, collection, q.bbox);
  // Same MGRS tile before and after = same pixel grid, so change maps line up without resampling.
  // Not across a tile edge: the before pass may be stitched from other tiles (same rule as scenes.py _search).
  const tile = afterCands[0]?.mgrs_tile;
  const sameTile = afterCands[0]?.covers_aoi && !afterCands[0]?.stitched_tiles ? beforeCands.filter((c) => c.mgrs_tile === tile) : [];
  if (sameTile.length) beforeCands = sameTile;

  const screenable = collection === "sentinel-2-l2a";
  const [after, before] = screenable
    ? await Promise.all([measureCandidates(afterCands, q.bbox, need), measureCandidates(beforeCands, q.bbox, need)])
    : [afterCands, beforeCands];
  const afterPick = pickBest(after, need, q.maxCloudPct);
  const beforePick = q.before ? pickBest(before, need, q.maxCloudPct) : null;

  const notes = [
    ...describe("after", afterPick, after, need, q.after),
    ...(q.before ? describe("before", beforePick, before, need, q.before) : []),
  ];
  if (!screenable) notes.push("Landsat scenes are chosen by tile cloud cover; the pipeline measures the AOI itself.");
  const withPreview = (s: SceneCandidate | null) => (s ? { ...s, preview_url: previewUrl(s, q.bbox, "true_color") } : null);
  return {
    provider_id: `pc-${collection}`,
    collection,
    before: withPreview(beforePick),
    after: withPreview(afterPick),
    candidates: { before: before.slice(0, LIST_PER_WINDOW), after: after.slice(0, LIST_PER_WINDOW) },
    notes,
  };
}

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SignalInput } from "../domain";
import type { Db } from "../db/client";
import { listSignals, pollSignals, signalCells, updateSignals } from "./signals";
import { freshDb, reset } from "./testing";

const pollFeed = vi.hoisted(() => vi.fn());
vi.mock("../signals", () => ({
  FEEDS_BY_PLAYBOOK: { disasters: ["nws", "usgs_quake"], deforestation: ["gfw", "firms"], mining: ["mrds", "news"] },
  pollFeed,
}));

const signal = (over: Partial<SignalInput> = {}): SignalInput => ({
  playbook: "disasters", feed: "nws", external_id: "urn:1", title: "Flood Warning", severity: "Severe",
  event_time: "2026-11-07T10:00:00Z", geometry: null, lat: 33.45, lon: -111.94, raw: { areaDesc: "Maricopa, AZ" }, ...over,
});

let db: Db;
beforeAll(async () => {
  db = await freshDb();
});
beforeEach(async () => {
  await reset(db);
  pollFeed.mockReset();
});

describe("pollSignals", () => {
  it("stores new signals once (dedupe on feed + external_id) and returns only new ones", async () => {
    pollFeed.mockImplementation(async (feed: string) =>
      feed === "nws" ? { signals: [signal(), signal({ external_id: "urn:2", title: "Flash Flood" })], warnings: [] } : { signals: [], warnings: ["no key"] },
    );
    const first = await pollSignals({ playbook: "disasters", actor: "sourcing" });
    expect(first.new_count).toBe(2);
    expect(first.signals.map((s) => s.title)).toEqual(["Flood Warning", "Flash Flood"]);
    expect(first.warnings).toEqual(["usgs_quake: no key"]);
    expect(first.feeds).toEqual([{ feed: "nws", fetched: 2, new: 2 }, { feed: "usgs_quake", fetched: 0, new: 0 }]);

    const second = await pollSignals({ playbook: "disasters", actor: "sourcing" });
    expect(second.new_count).toBe(0);
    expect(second.signals).toEqual([]);
    const [{ n }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM signals");
    expect(n).toBe(2);
  });

  it("passes the polling playbook (firms regions), the agent and allowPaid to every feed", async () => {
    pollFeed.mockResolvedValue({ signals: [], warnings: [] });
    await pollSignals({ playbook: "deforestation", sinceHours: 6, actor: "sourcing" });
    expect(pollFeed).toHaveBeenCalledWith("firms", expect.objectContaining({ playbook: "deforestation", agent: "sourcing", allowPaid: true, limit: 50, since: expect.any(Date) }));
    expect(pollFeed).toHaveBeenCalledWith("gfw", expect.objectContaining({ playbook: "deforestation" }));
    await pollSignals({ playbook: "mining", allowPaid: false, limitPerFeed: 10, actor: "sourcing" });
    expect(pollFeed).toHaveBeenCalledWith("news", expect.objectContaining({ playbook: "mining", allowPaid: false, limit: 10 }));
  });

  it("skips invalid rows and survives a feed that throws", async () => {
    pollFeed.mockImplementation(async (feed: string) => {
      if (feed === "usgs_quake") throw new Error("timeout");
      return { signals: [signal(), { title: "broken" }], warnings: [] };
    });
    const res = await pollSignals({ playbook: "disasters", actor: "sourcing" });
    expect(res.new_count).toBe(1);
    expect(res.warnings).toEqual(["nws: skipped invalid signal ?", "usgs_quake: timeout"]);
  });

  it("stores the polling playbook, the point's H3 cell, and a centre for polygon-only signals", async () => {
    const square = { type: "Polygon" as const, coordinates: [[[-112, 33], [-111.98, 33], [-111.98, 33.02], [-112, 33.02], [-112, 33]]] as [number, number][][] };
    pollFeed.mockResolvedValue({ signals: [signal({ playbook: "disasters", feed: "gfw", geometry: square, lat: null, lon: null })], warnings: [] });
    await pollSignals({ playbook: "deforestation", actor: "sourcing" });
    const [row] = await db.query<{ playbook: string; lat: number; h3_cells: string[] }>("SELECT playbook, lat, h3_cells FROM signals");
    expect(row.playbook).toBe("deforestation");
    expect(row.lat).toBeCloseTo(33.01, 5);
    expect(row.h3_cells.length).toBeGreaterThan(1);
  });
});

describe("signalCells", () => {
  it("coarsens resolution for huge polygons and caps the cell count", () => {
    const state = { type: "Polygon" as const, coordinates: [[[-114, 31], [-109, 31], [-109, 37], [-114, 37], [-114, 31]]] as [number, number][][] };
    const cells = signalCells({ geometry: state, lat: null, lon: null });
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.length).toBeLessThanOrEqual(300);
    expect(signalCells({ geometry: null, lat: 33.45, lon: -111.94 })).toHaveLength(1);
    expect(signalCells({ geometry: null, lat: null, lon: null })).toEqual([]);
  });
});

describe("listSignals / updateSignals", () => {
  beforeEach(async () => {
    pollFeed.mockImplementation(async (feed: string) =>
      feed === "nws" ? { signals: [signal(), signal({ external_id: "urn:2" }), signal({ external_id: "urn:3" })], warnings: [] } : { signals: [], warnings: [] },
    );
    await pollSignals({ playbook: "disasters", actor: "sourcing" });
  });

  it("matched signals are logged as outreach decisions; ignored ones only as an event", async () => {
    const [a, b, c] = (await listSignals({ playbook: "disasters" })).map((s) => s.id);
    expect(await updateSignals({ ids: [a, "sig_missing"], status: "matched", reason: "3 warehouses in the polygon", actor: "sourcing" }))
      .toEqual({ updated: 1, not_found: ["sig_missing"] });
    await updateSignals({ ids: [b, c], status: "ignored", reason: "rural, no businesses", actor: "sourcing" });

    const decisions = await db.query<{ kind: string; reasoning: string }>("SELECT kind, reasoning FROM decisions");
    expect(decisions).toEqual([{ kind: "outreach", reasoning: "3 warehouses in the polygon" }]);
    const [ev] = await db.query<{ payload: { ids: string[] } }>("SELECT payload FROM events WHERE type = 'signals.ignored'");
    expect(ev.payload.ids.sort()).toEqual([b, c].sort());

    const matched = await listSignals({ status: "matched", includeRaw: true });
    expect(matched).toHaveLength(1);
    expect(matched[0].status_reason).toBe("3 warehouses in the polygon");
    expect(matched[0].raw).toContain("Maricopa");
  });

  it("errors when no id exists", async () => {
    await expect(updateSignals({ ids: ["sig_nope"], status: "ignored", reason: "x", actor: "sourcing" })).rejects.toThrow(/no signals found/);
  });
});

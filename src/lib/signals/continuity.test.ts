import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, setDb, type Db } from "../db/client";
import { migrate } from "../db/migrate";
import type { SignalInput } from "../domain";
import { carryForwardIds } from "./continuity";

const fetchFirms = vi.hoisted(() => vi.fn());
vi.mock("./firms", () => ({ fetchFirms }));
const { pollFeed } = await import("./index");

const NOW = new Date("2026-11-07T12:00:00Z");
const daysBefore = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

const fire = (id: string, lat: number, lon: number, radius_km = 0.5): SignalInput => ({
  playbook: "disasters", feed: "firms", external_id: id, title: id, severity: "moderate", event_time: NOW.toISOString(),
  geometry: null, lat, lon, raw: { radius_km },
});

let db: Db;

async function store(feed: string, id: string, lat: number, lon: number, eventTime: string, radius_km?: number) {
  await db.query(
    "INSERT INTO signals (id, playbook, feed, external_id, title, event_time, lat, lon, raw) VALUES ($1, 'disasters', $2, $3, $3, $4, $5, $6, $7)",
    [`sig_${id}`, feed, id, eventTime, lat, lon, JSON.stringify(radius_km === undefined ? {} : { radius_km })],
  );
}

beforeAll(async () => {
  db = await createDb({ memory: true });
  await migrate(db);
});
afterAll(async () => {
  setDb(null);
  await db.close();
});
beforeEach(async () => {
  setDb(db);
  await db.query("DELETE FROM signals");
});

describe("carryForwardIds", () => {

  it("gives a cluster the id of a nearby, recent signal of the same feed", async () => {
    await store("firms", "fire:week45", 34, -118, daysBefore(3), 1);
    await store("firms", "fire:stale", 36, -119, daysBefore(20));
    await store("gfw", "forest:same-spot", 35, -120, daysBefore(1));
    const out = await carryForwardIds(
      "firms",
      [fire("grown", 34.02, -118.02), fire("far", 34.2, -118), fire("old-place", 36, -119), fire("other-feed", 35, -120)],
      NOW,
    );
    // 2.9 km apart: within 0.5 + 1 + 2 km of slack. 22 km is not.
    expect(out.map((s) => s.external_id)).toEqual(["fire:week45", "far", "old-place", "other-feed"]);
  });

  it("picks the nearest prior when several are in reach", async () => {
    await store("firms", "fire:a", 34, -118, daysBefore(1), 3);
    await store("firms", "fire:b", 34.03, -118, daysBefore(1), 3);
    const [s] = await carryForwardIds("firms", [fire("new", 34.025, -118)], NOW);
    expect(s.external_id).toBe("fire:b");
  });
});

describe("pollFeed continuity", () => {
  it("merges clusters that continue one stored event, keeping the larger", async () => {
    await store("firms", "fire:known", 40, -120, new Date().toISOString(), 2);
    fetchFirms.mockResolvedValue({ signals: [fire("big", 40.01, -120, 2), fire("spot", 40.03, -120.01, 0.2), fire("elsewhere", 41, -121)], warnings: [] });
    const { signals, warnings } = await pollFeed("firms");
    expect(warnings).toEqual([]);
    expect(signals.map((s) => [s.external_id, s.title])).toEqual([["fire:known", "big"], ["elsewhere", "elsewhere"]]);
  });

  it("falls back to the computed ids, with a warning, when the database is unavailable", async () => {
    setDb({ kind: "pglite", query: async () => { throw new Error("db down"); }, close: async () => {} });
    fetchFirms.mockResolvedValue({ signals: [fire("big", 40.01, -120)], warnings: [] });
    const { signals, warnings } = await pollFeed("firms");
    expect(signals.map((s) => s.external_id)).toEqual(["big"]);
    expect(warnings).toEqual([expect.stringMatching(/^firms: continuity check skipped.*db down/)]);
  });
});

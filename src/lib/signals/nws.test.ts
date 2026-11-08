import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, type Db } from "../db/client";
import { migrate } from "../db/migrate";
import { fixture, mockFetch, text } from "./__fixtures__/fetch-mock";
import { USER_AGENT } from "./http";

const geo = (name: string) => new Response(fixture(name), { headers: { "content-type": "application/geo+json" } });

let db: Db;

/** A fresh nws module (empty memory cache, like a cold start) wired to the test database. */
async function load() {
  vi.resetModules();
  (await import("../db/client")).setDb(db);
  return import("./nws");
}

describe("nws", () => {
  beforeAll(async () => {
    db = await createDb({ memory: true });
    await migrate(db);
  });
  afterAll(() => db.close());
  beforeEach(() => db.query("DELETE FROM nws_zone_cache"));
  afterEach(() => vi.unstubAllGlobals());

  it("keeps imagery-relevant alerts, uses alert polygons or zone hulls, and dedupes on VTEC", async () => {
    const calls = mockFetch([
      ["/alerts/active", geo("nws-alerts.json")],
      ["/zones/forecast/WAZ330", geo("nws-zone-WAZ330.json")],
      ["/zones/forecast/WAZ331", geo("nws-zone-WAZ331.json")],
      ["/zones/", text("upstream error", 503)],
    ]);
    const { fetchNws } = await load();
    const { signals, warnings } = await fetchNws({});

    // Freeze warning skipped; all Severe, so newest first (sent times carry different UTC offsets).
    expect(signals.map((s) => s.raw.event)).toEqual(["High Wind Warning", "Flood Watch", "Flood Warning"]);
    const flood = signals.find((s) => s.raw.event === "Flood Warning")!;
    expect(flood.external_id).toBe("vtec:KPSR.FA.W.0040:2026");
    expect(flood.severity).toBe("severe");
    expect(flood.event_time).toBe("2026-11-07T17:25:00.000Z");
    expect(flood.raw.geometry_source).toBe("alert");
    expect(flood.raw.county_fips).toEqual(["04013"]);
    expect(flood.lat).toBeGreaterThan(33);
    expect(flood.lat).toBeLessThan(34);

    const wind = signals.find((s) => s.raw.event === "High Wind Warning")!;
    expect(wind.external_id).toBe("vtec:KSEW.HW.W.0002:2026");
    expect(wind.raw.geometry_source).toBe("zones");
    expect(wind.geometry?.coordinates[0].length).toBeGreaterThan(3);
    expect(wind.lat).toBeGreaterThan(46);
    expect(wind.lon).toBeLessThan(-123);

    const watch = signals.find((s) => s.raw.event === "Flood Watch")!;
    expect(watch.geometry).toBeNull();
    expect(watch.lat).toBeNull();
    expect(warnings.some((w) => w.includes("zone geometry unavailable for 3 zone(s)"))).toBe(true);

    expect(calls.filter((c) => c.url.includes("/zones/"))).toHaveLength(5); // freeze zones never fetched
    expect((calls[0].init.headers as Record<string, string>)["User-Agent"]).toBe(USER_AGENT);
  });

  it("caches zone geometry between polls", async () => {
    const calls = mockFetch([
      ["/alerts/active", geo("nws-alerts.json")],
      ["/zones/forecast/WAZ330", geo("nws-zone-WAZ330.json")],
      ["/zones/forecast/WAZ331", geo("nws-zone-WAZ331.json")],
    ]);
    const { fetchNws } = await load();
    await fetchNws({});
    await fetchNws({});
    expect(calls.filter((c) => c.url.includes("WAZ330"))).toHaveLength(1);
  });

  it("persists zone hulls, so a cold start doesn't refetch them", async () => {
    const calls = mockFetch([
      ["/alerts/active", geo("nws-alerts.json")],
      ["/zones/forecast/WAZ330", geo("nws-zone-WAZ330.json")],
      ["/zones/forecast/WAZ331", geo("nws-zone-WAZ331.json")],
    ]);
    const warm = await (await load()).fetchNws({});
    const stored = await db.query<{ zone_url: string; hull: number[][] }>("SELECT zone_url, hull FROM nws_zone_cache ORDER BY zone_url");
    expect(stored.map((r) => r.zone_url.split("/").pop())).toEqual(["WAZ330", "WAZ331"]);
    expect(stored[0].hull.length).toBeGreaterThan(3);

    const cold = await (await load()).fetchNws({});
    expect(calls.filter((c) => c.url.includes("/zones/forecast/WAZ33"))).toHaveLength(2);
    const wind = (r: typeof cold) => r.signals.find((s) => s.raw.event === "High Wind Warning")!.geometry;
    expect(wind(cold)).toEqual(wind(warm));
  });

  it("still works when the cache table can't be read", async () => {
    mockFetch([["/alerts/active", geo("nws-alerts.json")]]);
    const { fetchNws } = await load();
    (await import("../db/client")).setDb({ kind: "pglite", query: async () => { throw new Error("db down"); }, close: async () => {} });
    const { signals, warnings } = await fetchNws({});
    expect(signals.length).toBe(3);
    expect(warnings).toContain("zone cache unavailable: db down");
  });

  it("applies the limit before fetching zones", async () => {
    const calls = mockFetch([["/alerts/active", geo("nws-alerts.json")]]);
    const { fetchNws } = await load();
    const { signals } = await fetchNws({ limit: 1 });
    expect(signals.map((s) => s.raw.event)).toEqual(["High Wind Warning"]);
    expect(calls.filter((c) => c.url.includes("/zones/")).map((c) => c.url.split("/").pop())).toEqual(["WAZ330", "WAZ331"]);
  });
});

describe("vtecEventKey", () => {
  it("prefers the segment still in effect and takes the year from the event start", async () => {
    const { vtecEventKey } = await import("./nws");
    const upgrade = ["/O.UPG.KBOU.WS.A.0003.261110T0000Z-261111T0000Z/", "/O.NEW.KBOU.WS.W.0002.261110T0000Z-261111T0000Z/"];
    expect(vtecEventKey(upgrade, "2026-11-09T10:00:00-07:00")).toBe("KBOU.WS.W.0002:2026");
    expect(vtecEventKey(["/O.CON.KMLB.FL.W.0008.000000T0000Z-000000T0000Z/"], "2027-01-02T00:00:00Z")).toBe("KMLB.FL.W.0008:2027");
    expect(vtecEventKey([], "2026-11-07")).toBeNull();
  });
});

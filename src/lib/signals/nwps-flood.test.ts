import { afterEach, describe, expect, it, vi } from "vitest";
import { fixture, fixtureJson, json, mockFetch } from "./__fixtures__/fetch-mock";
import { currentImpact, fetchNwpsFloods } from "./nwps-flood";

describe("nwps_flood", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists gauges in flood, enriched with NWPS readings and the local impact statement", async () => {
    const calls = mockFetch([
      ["riv_gauges/MapServer/0/query", new Response(fixture("nwps-riv-gauges.json"))],
      ["/nwps/v1/gauges/ARCF1", new Response(fixture("nwps-gauge-ARCF1.json"))],
    ]);
    const { signals, warnings } = await fetchNwpsFloods({});
    expect(signals).toHaveLength(5);
    // other gauge details 404 in this test: still signals (MapServer data), plus a warning each
    expect(warnings.filter((w) => w.startsWith("gauge detail"))).toHaveLength(4);
    expect(new URL(calls[0].url).searchParams.get("where")).toBe("status IN ('minor','moderate','major')");

    const arcadia = signals.find((s) => s.raw.lid === "ARCF1")!;
    expect(arcadia).toMatchObject({
      playbook: "disasters",
      feed: "nwps_flood",
      external_id: "ARCF1:moderate:2026-W45",
      severity: "severe",
      title: "Moderate flooding: Peace River at SR 70 Arcadia, FL",
      event_time: "2026-11-07T21:30:00.000Z",
      lat: 27.221944,
      lon: -81.876111,
    });
    expect(arcadia.raw).toMatchObject({
      usgs_id: "02296750",
      county: "DeSoto",
      observed_stage: 15.72,
      thresholds: { action: 9, minor: 11, moderate: 14, major: 16 },
      impact: "25 homes at River Acres are impacted.",
      impact_stage: 15.5,
    });

    const plain = signals.find((s) => s.raw.lid !== "ARCF1")!;
    expect(plain.raw.usgs_id).toBeNull();
    expect(plain.event_time).toMatch(/Z$/);
  });

  it("keeps a gauge whose observation time is missing or garbled, without losing the rest", async () => {
    const doc = fixtureJson<{ features: { properties: { gaugelid: string; obstime: string | null } }[] }>("nwps-riv-gauges.json");
    doc.features[0].properties.obstime = null;
    doc.features[1].properties.obstime = "N/A";
    mockFetch([["riv_gauges", json(doc)]]);
    const { signals, warnings } = await fetchNwpsFloods({});
    expect(signals).toHaveLength(5);
    const bad = signals.filter((s) => s.event_time === null).map((s) => s.raw.lid);
    expect(bad.sort()).toEqual([doc.features[0].properties.gaugelid, doc.features[1].properties.gaugelid].sort());
    expect(warnings.filter((w) => w.includes("no valid observation time"))).toHaveLength(2);
    expect(signals.every((s) => /:20\d\d-W\d\d$/.test(s.external_id))).toBe(true);
  });

  it("orders major before moderate before minor", async () => {
    mockFetch([["riv_gauges", new Response(fixture("nwps-riv-gauges.json"))]]);
    const { signals } = await fetchNwpsFloods({ limit: 2 });
    const order = ["minor", "moderate", "major"];
    expect(order.indexOf(signals[0].raw.flood_category as string)).toBeGreaterThanOrEqual(order.indexOf(signals[1].raw.flood_category as string));
  });

  it("picks the highest impact at or below the stage", () => {
    const impacts = [{ stage: 16, statement: "b" }, { stage: 15, statement: "a" }, { stage: 21, statement: "c" }];
    expect(currentImpact(impacts, 15.9)?.statement).toBe("a");
    expect(currentImpact(impacts, 14)).toBeNull();
    expect(currentImpact(undefined, 20)).toBeNull();
  });
});

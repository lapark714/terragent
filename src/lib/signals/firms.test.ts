import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignalInput } from "../domain";
import { fixture, mockFetch, text } from "./__fixtures__/fetch-mock";
import { fetchFirms, fireSeverity, firmsDayRange, parseFirmsCsv } from "./firms";

const KEY = "test-map-key-123";
const HEADER_ONLY = "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight\n";

describe("firms", () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date("2026-11-08T00:00:00Z"), toFake: ["Date"] }));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("clusters VIIRS hotspots from the area API into one signal per fire", async () => {
    vi.stubEnv("FIRMS_MAP_KEY", KEY);
    const calls = mockFetch([
      [`/api/area/csv/${KEY}/VIIRS_NOAA20_NRT/-125,24,-66,50/2`, text(fixture("firms-area-viirs.csv"))],
      ["/api/area/csv/", text(HEADER_ONLY)],
    ]);
    const { signals, warnings } = await fetchFirms({});
    expect(warnings).toEqual([]);
    expect(calls).toHaveLength(6); // 3 US areas × NOAA-20 + NOAA-21
    expect(calls.every((c) => c.url.endsWith("/2"))).toBe(true); // the last 24 h spans two UTC dates
    expect(signals.length).toBeGreaterThanOrEqual(2);

    for (const s of signals) {
      expect(SignalInput.safeParse(s).success).toBe(true);
      expect(s).toMatchObject({ playbook: "disasters", feed: "firms" });
      expect(s.external_id).toMatch(/^fire:86[0-9a-f]{13}:2026-W45(:88[0-9a-f]{13})?$/);
      expect(s.raw.detections as number).toBeGreaterThanOrEqual(3);
      expect(s.geometry?.type).toBe("Polygon");
    }
    const frp = signals.map((s) => s.raw.frp_sum_mw as number);
    expect(frp).toEqual([...frp].sort((a, b) => b - a));
    expect(signals[0].raw.region).toBe("Contiguous US");
    expect(signals[0].raw.nearest_county_fips).toMatch(/^\d{5}$/);
    expect(typeof signals[0].raw.nearest_county_km).toBe("number");
  });

  it("never leaks the key in warnings", async () => {
    vi.stubEnv("FIRMS_MAP_KEY", KEY);
    mockFetch([["/api/area/csv/", text("Invalid MAP_KEY.", 400)]]);
    const { signals, warnings } = await fetchFirms({ bbox: [-120, 35, -119, 36] });
    expect(signals).toEqual([]);
    expect(warnings).toHaveLength(2);
    expect(warnings.join(" ")).toContain("HTTP 400 Invalid MAP_KEY.");
    expect(warnings.join(" ")).not.toContain(KEY);
  });

  it("polls the forest watch regions for the deforestation playbook", async () => {
    vi.stubEnv("FIRMS_MAP_KEY", KEY);
    const calls = mockFetch([["/api/area/csv/", text(HEADER_ONLY)]]);
    const { signals } = await fetchFirms({ playbook: "deforestation", since: new Date("2026-11-05T00:00:00Z") });
    expect(signals).toEqual([]);
    expect(calls).toHaveLength(16);
    expect(calls.every((c) => c.url.endsWith("/4"))).toBe(true); // 11-05..11-08
  });

  it("counts UTC calendar dates for DAY_RANGE, not 24 h periods", () => {
    const now = new Date("2026-11-07T23:40:00Z");
    expect(firmsDayRange(new Date("2026-11-06T23:40:00Z"), now)).toEqual({ dayRange: 2, clipped: false });
    expect(firmsDayRange(new Date("2026-11-07T00:10:00Z"), now)).toEqual({ dayRange: 1, clipped: false });
    expect(firmsDayRange(new Date("2026-11-03T00:00:00Z"), now)).toEqual({ dayRange: 5, clipped: false });
    expect(firmsDayRange(new Date("2026-11-01T00:00:00Z"), now)).toEqual({ dayRange: 5, clipped: true });
  });

  it("warns when `since` is older than the API can reach", async () => {
    vi.stubEnv("FIRMS_MAP_KEY", KEY);
    mockFetch([["/api/area/csv/", text(HEADER_ONLY)]]);
    const { warnings } = await fetchFirms({ bbox: [-120, 35, -119, 36], since: new Date("2026-11-01T00:00:00Z") });
    expect(warnings).toEqual([expect.stringMatching(/more than 4 UTC dates back/)]);
  });

  it("falls back to the public US file without a key, and skips region queries", async () => {
    vi.stubEnv("FIRMS_MAP_KEY", "");
    const calls = mockFetch([["J1_VIIRS_C2_USA_contiguous_and_Hawaii_24h.csv", text(fixture("firms-area-viirs.csv"))]]);
    const us = await fetchFirms({});
    expect(us.warnings[0]).toMatch(/FIRMS_MAP_KEY not set/);
    expect(us.signals.length).toBeGreaterThan(0);

    const forest = await fetchFirms({ playbook: "deforestation" });
    expect(forest).toEqual({ signals: [], warnings: [expect.stringMatching(/region queries need the area API/)] });
    expect(calls).toHaveLength(1);
  });

  it("parses both CSV dialects", () => {
    const area = parseFirmsCsv(fixture("firms-area-viirs.csv"));
    expect(area[0]).toMatchObject({ lat: 40.89356, lon: -77.71375, confidence: "nominal", satellite: "N20", daynight: "N" });
    expect(area[0].acquired.toISOString()).toBe("2026-11-07T06:07:00.000Z");
    expect(area.some((h) => h.confidence === "low")).toBe(true);

    const publicFile = "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,bright_ti5,frp,daynight\n47.95849,-117.04482,303.67,0.41,0.37,2026-11-06,0947,N20,high,2.0NRT,270.74,0.72,N\n";
    expect(parseFirmsCsv(publicFile)[0]).toMatchObject({ confidence: "high", frp: 0.72 });
    expect(parseFirmsCsv("Invalid MAP_KEY.")).toEqual([]);
  });

  it("scores severity by fire radiative power and size", () => {
    expect(fireSeverity(1200, 20)).toBe("extreme");
    expect(fireSeverity(310, 12)).toBe("severe");
    expect(fireSeverity(20, 12)).toBe("moderate");
    expect(fireSeverity(5, 3)).toBe("minor");
  });
});

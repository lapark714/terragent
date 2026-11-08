import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixture, mockFetch } from "./__fixtures__/fetch-mock";
import { fetchUsgsQuakes, quakeSeverity } from "./usgs-quake";

const geo = (name: string) => new Response(fixture(name));

describe("usgs_quake", () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date("2026-11-08T00:00:00Z"), toFake: ["Date"] }));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("merges the M4.5+ and significant feeds for the period that covers `since`", async () => {
    const calls = mockFetch([
      ["4.5_month.geojson", geo("usgs-4.5_week.json")],
      ["significant_month.geojson", geo("usgs-significant_month.json")],
    ]);
    const { signals, warnings } = await fetchUsgsQuakes({ since: new Date("2026-10-01T00:00:00Z") });
    expect(warnings).toEqual([]);
    expect(calls.map((c) => c.url.split("/").pop())).toEqual(["4.5_month.geojson", "significant_month.geojson"]);
    expect(signals).toHaveLength(7);

    const panama = signals.find((s) => s.external_id === "us6000u18k")!;
    expect(panama).toMatchObject({ playbook: "disasters", feed: "usgs_quake", severity: "severe", geometry: null });
    expect(panama.raw).toMatchObject({ mag: 7.7, pager_alert: "orange" });
    expect(panama.event_time).toBe("2026-10-09T17:56:05.537Z");

    const ambon = signals.find((s) => s.external_id === "us7000twu1")!;
    expect(ambon).toMatchObject({ lat: -3.905, lon: 128.5121, severity: "minor" });
    expect(ambon.raw.depth_km).toBe(136.656);
  });

  it("drops events before `since` and uses the day feed for short windows", async () => {
    const calls = mockFetch([
      ["4.5_day.geojson", geo("usgs-4.5_week.json")],
      ["significant_day.geojson", geo("usgs-significant_month.json")],
    ]);
    const { signals } = await fetchUsgsQuakes({ since: new Date("2026-11-07T00:00:00Z") });
    expect(calls).toHaveLength(2);
    expect(signals.every((s) => s.event_time! >= "2026-11-07")).toBe(true);
    expect(signals.some((s) => s.external_id === "us6000u18k")).toBe(false);
  });

  it("maps PAGER levels, else magnitude bands", () => {
    expect(quakeSeverity(5, "red")).toBe("extreme");
    expect(quakeSeverity(5.7, "yellow")).toBe("moderate");
    expect(quakeSeverity(7.1, null)).toBe("severe");
    expect(quakeSeverity(6.2, null)).toBe("moderate");
    expect(quakeSeverity(null, null)).toBe("minor");
  });
});

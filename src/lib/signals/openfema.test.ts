import { afterEach, describe, expect, it, vi } from "vitest";
import { fixture, mockFetch } from "./__fixtures__/fetch-mock";
import { countyCentroid, nearestCounty } from "./counties";
import { fetchOpenFema } from "./openfema";

describe("openfema", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("turns designated areas into signals placed at the county centroid", async () => {
    const calls = mockFetch([["DisasterDeclarationsSummaries", new Response(fixture("openfema-declarations.json"))]]);
    const since = new Date("2026-10-01T00:00:00Z");
    const { signals, warnings } = await fetchOpenFema({ since });
    expect(warnings).toEqual([]);
    expect(signals).toHaveLength(6);
    const q = new URL(calls[0].url).searchParams;
    expect(q.get("$filter")).toBe("declarationDate ge '2026-10-01T00:00:00.000Z'");
    expect(q.get("$orderby")).toBe("declarationDate desc");

    const escambia = signals.find((s) => s.external_id === "DR-4955-FL:99033")!;
    expect(escambia).toMatchObject({
      playbook: "disasters",
      feed: "openfema",
      severity: "severe",
      title: "Hurricane major disaster DR-4955-FL: Escambia (County), FL",
      event_time: "2026-10-27T00:00:00.000Z",
      lat: 30.53,
      lon: -87.3203,
      geometry: null,
    });
    expect(escambia.raw).toMatchObject({ county_fips: "12033", county_zone_url: "https://api.weather.gov/zones/county/FLC033" });

    const tribal = signals.find((s) => s.raw.designated_area === "Zia Pueblo (Indian Reservation)")!;
    expect(tribal).toMatchObject({ lat: null, lon: null, severity: "moderate" });
    expect(tribal.raw.county_fips).toBeNull();

    const guam = signals.find((s) => s.raw.state === "GU")!;
    expect(guam.lat).toBeNull(); // territory not in the Census county gazetteer

    expect(new Set(signals.map((s) => s.external_id)).size).toBe(signals.length);
  });

  it("knows county centroids by 5-digit FIPS, and the nearest county to a point", () => {
    expect(countyCentroid("06075")).toEqual({ lat: 37.7272, lon: -123.0322 });
    expect(countyCentroid("99999")).toBeNull();
    expect(nearestCounty(27.2219, -81.8761).fips).toBe("12027"); // Arcadia, FL → DeSoto County
    expect(nearestCounty(51.05, -114.07).km).toBeGreaterThan(200); // Calgary: far from any US county
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixture, fixtureJson, json, mockFetch, text } from "../signals/__fixtures__/fetch-mock";

const monidRun = vi.fn();
vi.mock("../monid/client", () => ({ monidRun }));

const census = () => new Response(fixture("census-onelineaddress.json"));
const censusMiss = () => json({ result: { ...fixtureJson<{ result: object }>("census-onelineaddress.json").result, addressMatches: [] } });
const nominatim = () => new Response(fixture("nominatim-search.json"));

// Fresh module per test: the Nominatim throttle and the result cache are process-wide.
const load = async () => {
  vi.resetModules();
  return import("./geocode");
};

describe("geocode", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "Date"] }));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    monidRun.mockReset();
  });

  it("accepts coordinates typed as text", async () => {
    const calls = mockFetch([]);
    const { geocode } = await load();
    expect(await geocode(" 27.2219, -81.8761 ")).toMatchObject({ lat: 27.2219, lon: -81.8761, geocoder: "user", confidence: "high" });
    expect(await geocode("-33.9 151.2")).toMatchObject({ lat: -33.9, lon: 151.2 });
    expect(calls).toHaveLength(0);
  });

  it("uses the Census geocoder for US street addresses", async () => {
    const calls = mockFetch([["geocoding.geo.census.gov", census()]]);
    const { geocode } = await load();
    const r = await geocode("1 Dr Carlton B Goodlett Pl, San Francisco, CA 94102");
    expect(r).toMatchObject({
      geocoder: "census",
      confidence: "high",
      lat: 37.778536095745,
      lon: -122.41831039539,
      county_fips: "06075",
      country_code: "us",
      display_name: "1 DR CARLTON P GOODLETT PL, SAN FRANCISCO, CA, 94102",
    });
    const q = new URL(calls[0].url).searchParams;
    expect(q.get("benchmark")).toBe("Public_AR_Current");
    expect(calls).toHaveLength(1);
  });

  it("falls back to Nominatim without the house number when Census has no match", async () => {
    const calls = mockFetch([["geocoding.geo.census.gov", censusMiss()], ["nominatim.openstreetmap.org", nominatim()]]);
    const { geocode } = await load();
    const r = await geocode("12 Main St, Arcadia, FL 34266");
    expect(r).toMatchObject({ geocoder: "nominatim", confidence: "medium" });
    expect(new URL(calls[1].url).searchParams.get("q")).toBe("Main St, Arcadia, FL 34266");
  });

  it("sends place names straight to Nominatim and maps its strings and bbox", async () => {
    const calls = mockFetch([["nominatim.openstreetmap.org", nominatim()]]);
    const { geocode } = await load();
    const r = await geocode("Arcadia, Florida");
    expect(r).toEqual({
      lat: 27.2158826,
      lon: -81.8584164,
      display_name: "Arcadia, DeSoto County, Florida, United States",
      geocoder: "nominatim",
      confidence: "medium",
      bbox: [-81.8799015, 27.2023031, -81.8345101, 27.2455707],
      country_code: "us",
      attribution: expect.stringContaining("OpenStreetMap"),
    });
    expect(calls).toHaveLength(1);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toMatch(/^Terragent\/0\.1/);
    expect(headers["User-Agent"]).not.toContain("@");
  });

  it("caches results so repeated lookups don't hit Nominatim again", async () => {
    const calls = mockFetch([["nominatim.openstreetmap.org", nominatim()]]);
    const { geocode } = await load();
    await geocode("Arcadia, Florida");
    await geocode("arcadia,   florida");
    expect(calls).toHaveLength(1);
  });

  it("keeps Nominatim to one request per 1.1 s", async () => {
    const calls = mockFetch([["nominatim.openstreetmap.org", nominatim()]]);
    const { geocode } = await load();
    const both = Promise.all([geocode("Arcadia, Florida"), geocode("Bartow, Florida")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1100);
    await both;
    expect(calls).toHaveLength(2);
  });

  it("gives scheduled callers Nominatim's 4/min budget and fails fast past it", async () => {
    const calls = mockFetch([["nominatim.openstreetmap.org", nominatim()]]);
    const { geocode } = await load();
    const periodic = { periodic: true };
    const first = geocode("Arcadia, Florida", periodic);
    const second = geocode("Bartow, Florida", periodic);
    await expect(geocode("Wauchula, Florida", periodic)).rejects.toThrow(/4 lookups\/min; budget used, retry in 30 s/);
    const interactive = geocode("Sebring, Florida"); // not held by the cron budget, only by 1 req/s
    await vi.advanceTimersByTimeAsync(1100);
    expect(calls.map((c) => new URL(c.url).searchParams.get("q"))).toEqual(["Arcadia, Florida", "Sebring, Florida"]);
    await vi.advanceTimersByTimeAsync(15_000 - 1100);
    await Promise.all([first, second, interactive]);
    expect(calls.map((c) => new URL(c.url).searchParams.get("q"))).toEqual(["Arcadia, Florida", "Sebring, Florida", "Bartow, Florida"]);
  });

  it("returns null when nothing matches, without touching Monid", async () => {
    mockFetch([["nominatim.openstreetmap.org", json([])]]);
    const { geocode } = await load();
    expect(await geocode("Nowhere-in-particular")).toBeNull();
    expect(monidRun).not.toHaveBeenCalled();
  });

  it("uses the paid Monid geocoder only when allowed", async () => {
    mockFetch([["nominatim.openstreetmap.org", json([])]]);
    monidRun.mockResolvedValue({
      status: "COMPLETED",
      output: { count: 1, items: [{ type: "geocode", displayName: "Somewhere, Earth", lat: 1.5, lon: 2.5 }] },
      cost_usd: 0.02,
      run_id: "run_x",
    });
    const { geocode } = await load();
    expect(await geocode("Somewhere", { allowPaid: true, agent: "planner" })).toMatchObject({ geocoder: "monid", lat: 1.5, lon: 2.5 });
    expect(monidRun).toHaveBeenCalledWith(expect.objectContaining({ provider: "api.kadec0.xyz", endpoint: "/v1/geocode", input: { q: "Somewhere", maxItems: "1" }, agent: "planner" }));
  });

  it("throws only when every geocoder failed", async () => {
    mockFetch([["", text("unavailable", 503)]]);
    const { geocode } = await load();
    await expect(geocode("Arcadia, Florida")).rejects.toThrow(/geocoding failed: .*HTTP 503/);
  });

  it("recognises US-looking street addresses", async () => {
    const { looksLikeUs, isStreetAddress, withoutHouseNumber } = await load();
    expect(looksLikeUs("1600 Pennsylvania Ave NW, Washington, DC 20500")).toBe(true);
    expect(looksLikeUs("100 Main Street, Springfield, Illinois")).toBe(true);
    expect(looksLikeUs("10 Downing Street, London")).toBe(false);
    expect(isStreetAddress("221B Baker Street, London")).toBe(true);
    expect(isStreetAddress("Arcadia, FL")).toBe(false);
    expect(withoutHouseNumber("1600 Pennsylvania Ave NW, Washington, DC")).toBe("Pennsylvania Ave NW, Washington, DC");
  });
});

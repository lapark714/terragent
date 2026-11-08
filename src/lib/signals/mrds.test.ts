import { afterEach, describe, expect, it, vi } from "vitest";
import { fixture, mockFetch, text } from "./__fixtures__/fetch-mock";
import { fetchMrds, parseMrdsGml } from "./mrds";

describe("mrds", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("answers region queries from the WFS (lon,lat order)", async () => {
    const calls = mockFetch([["mrdata.usgs.gov/services/wfs/mrds", text(fixture("mrds-wfs.xml"))]]);
    const { signals, warnings } = await fetchMrds({ bbox: [-116, 39.5, -115.5, 40] });
    expect(warnings).toEqual([]);
    const q = new URL(calls[0].url).searchParams;
    expect(q.get("version")).toBe("1.0.0");
    expect(q.get("BBOX")).toBe("-116,39.5,-115.5,40");
    expect(signals).toHaveLength(5);
    expect(signals.map((x) => x.raw.dev_stat)).toEqual(["Plant", "Past Producer", "Past Producer", "Past Producer", "Past Producer"]);
    const mine = signals.find((x) => x.external_id === "10098608")!;
    expect(mine).toMatchObject({
      playbook: "mining",
      feed: "mrds",
      external_id: "10098608",
      title: "Phillipsburg Mine (Past Producer): AG, PB, SB, ZN, AU",
      severity: null,
      event_time: null,
      lat: 39.74186,
      lon: -115.86034,
    });
    expect(mine.raw).toMatchObject({ county_fips: "32011", commodities: ["AG", "PB", "SB", "ZN", "AU"] });
  });

  it("returns nothing for a plain 'what is new' poll (static data)", async () => {
    const calls = mockFetch([]);
    const { signals, warnings } = await fetchMrds({ since: new Date() });
    expect(signals).toEqual([]);
    expect(warnings[0]).toMatch(/static reference data/);
    expect(calls).toHaveLength(0);
  });

  it("parses GML blocks and decodes XML entities", () => {
    const site = (id: string, stat: string) =>
      `<ms:mrds fid="mrds.${id}"><ms:geometry><gml:Point><gml:coordinates>-110.5,40.25</gml:coordinates></gml:Point></ms:geometry><ms:dep_id>${id}</ms:dep_id><ms:site_name>S&amp;M ${id}</ms:site_name><ms:dev_stat>${stat}</ms:dev_stat></ms:mrds>`;
    const sites = parseMrdsGml(site("1", "Occurrence") + site("2", "Producer"));
    expect(sites.map((s) => [s.dep_id, s.site_name, s.lat, s.lon])).toEqual([["1", "S&M 1", 40.25, -110.5], ["2", "S&M 2", 40.25, -110.5]]);
  });
});

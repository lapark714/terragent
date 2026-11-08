/**
 * USGS Mineral Resources Data System (WFS, no key). MRDS has not been updated since 2011, so it is
 * mining *context* (known deposits and mines in a region), not a stream of new events: it answers
 * region queries (bbox) and returns nothing for a plain "what's new" poll.
 */
import type { SignalInput } from "../domain";
import { httpText } from "./http";
import type { FeedOptions, FeedResult } from "./types";

const WFS = "https://mrdata.usgs.gov/services/wfs/mrds";
const MAX_FEATURES = 500;
/** Active operations first: those are the businesses a monitoring offer is for. */
const DEV_STAT_ORDER = ["Producer", "Plant", "Past Producer", "Prospect", "Occurrence", "Unknown"];

export interface MrdsSite {
  dep_id: string;
  site_name: string;
  dev_stat: string;
  fips_code: string | null;
  commodities: string[];
  url: string | null;
  lat: number;
  lon: number;
}

const tag = (block: string, name: string) => {
  const m = new RegExp(`<ms:${name}>([\\s\\S]*?)</ms:${name}>`).exec(block);
  return m ? decodeXml(m[1].trim()) : null;
};
const decodeXml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** Parses WFS 1.0.0 GML (coordinates are "lon,lat"). */
export function parseMrdsGml(xml: string): MrdsSite[] {
  return [...xml.matchAll(/<ms:mrds\b[^>]*>([\s\S]*?)<\/ms:mrds>/g)].flatMap(([, block]) => {
    const coords = /<ms:geometry>[\s\S]*?<gml:coordinates>\s*([-\d.]+),([-\d.]+)\s*<\/gml:coordinates>/.exec(block);
    const depId = tag(block, "dep_id");
    if (!coords || !depId) return [];
    return [{
      dep_id: depId,
      site_name: tag(block, "site_name") ?? "Unknown",
      dev_stat: tag(block, "dev_stat") ?? "Unknown",
      fips_code: tag(block, "fips_code")?.replace(/^f/, "") ?? null,
      commodities: (tag(block, "code_list") ?? "").split(/\s+/).filter(Boolean),
      url: tag(block, "url"),
      lon: Number(coords[1]),
      lat: Number(coords[2]),
    }];
  });
}

export async function fetchMrds(opts: FeedOptions): Promise<FeedResult> {
  if (!opts.bbox) {
    return { signals: [], warnings: ["MRDS is static reference data (no updates since 2011); pass a bbox for a region query"] };
  }
  const [w, s, e, n] = opts.bbox;
  const url = new URL(WFS);
  url.search = new URLSearchParams({
    service: "WFS",
    version: "1.0.0", // 1.0.0 keeps lon,lat axis order (1.1.0 flips it)
    request: "GetFeature",
    typeName: "mrds",
    maxFeatures: String(MAX_FEATURES),
    BBOX: `${w},${s},${e},${n}`,
  }).toString();
  const sites = parseMrdsGml(await httpText(url.toString(), { timeoutMs: 30_000 }));
  const rank = (d: string) => (DEV_STAT_ORDER.includes(d) ? DEV_STAT_ORDER.indexOf(d) : DEV_STAT_ORDER.length);
  sites.sort((a, b) => rank(a.dev_stat) - rank(b.dev_stat));
  const warnings = sites.length >= MAX_FEATURES ? [`region capped at ${MAX_FEATURES} sites; use a smaller bbox`] : [];
  return { signals: sites.map(toSignal), warnings };
}

function toSignal(site: MrdsSite): SignalInput {
  return {
    playbook: "mining",
    feed: "mrds",
    external_id: site.dep_id,
    title: `${site.site_name} (${site.dev_stat})${site.commodities.length ? `: ${site.commodities.join(", ")}` : ""}`,
    severity: null,
    event_time: null,
    geometry: null,
    lat: site.lat,
    lon: site.lon,
    raw: {
      dep_id: site.dep_id,
      site_name: site.site_name,
      dev_stat: site.dev_stat,
      commodities: site.commodities,
      county_fips: site.fips_code,
      url: site.url,
      note: "USGS MRDS reference record (static since 2011): context, not a new event",
    },
  };
}

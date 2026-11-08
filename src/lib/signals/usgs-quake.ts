/** USGS earthquakes: M4.5+ and "significant" GeoJSON summary feeds (updated every minute, no key). */
import type { SignalInput } from "../domain";
import { httpJson } from "./http";
import { DAY_MS, daysAgo, isoTime, type FeedOptions, type FeedResult, type Severity } from "./types";

const FEED = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary";

interface QuakeFeature {
  id: string;
  geometry: { coordinates: [number, number, number] };
  properties: {
    mag: number | null;
    place: string | null;
    time: number;
    updated: number;
    url: string;
    felt: number | null;
    mmi: number | null;
    alert: string | null;
    status: string;
    tsunami: number;
    sig: number;
    magType: string;
    title: string;
  };
}

const PAGER: Record<string, Severity> = { red: "extreme", orange: "severe", yellow: "moderate", green: "minor" };

/** PAGER alert level when USGS issued one, else a magnitude band. */
export function quakeSeverity(mag: number | null, alert: string | null): Severity {
  if (alert && PAGER[alert]) return PAGER[alert];
  const m = mag ?? 0;
  return m >= 7 ? "severe" : m >= 6 ? "moderate" : "minor";
}

/** Smallest summary period that covers `since`. */
function period(since: Date): "day" | "week" | "month" {
  const days = (Date.now() - since.getTime()) / DAY_MS;
  return days <= 1 ? "day" : days <= 7 ? "week" : "month";
}

export async function fetchUsgsQuakes(opts: FeedOptions): Promise<FeedResult> {
  const since = opts.since ?? daysAgo(1);
  const p = period(since);
  const feeds = await Promise.all(
    [`4.5_${p}`, `significant_${p}`].map((name) => httpJson<{ features: QuakeFeature[] }>(`${FEED}/${name}.geojson`)),
  );
  const byId = new Map<string, QuakeFeature>();
  for (const f of feeds.flatMap((d) => d.features ?? [])) byId.set(f.id, f);
  const signals = [...byId.values()].filter((f) => f.properties.time >= since.getTime()).map(toSignal);
  return { signals, warnings: [] };
}

function toSignal(f: QuakeFeature): SignalInput {
  const p = f.properties;
  const [lon, lat, depth] = f.geometry.coordinates;
  return {
    playbook: "disasters",
    feed: "usgs_quake",
    external_id: f.id,
    title: p.title,
    severity: quakeSeverity(p.mag, p.alert),
    event_time: isoTime(p.time),
    geometry: null,
    lat,
    lon,
    raw: {
      mag: p.mag,
      mag_type: p.magType,
      place: p.place,
      depth_km: depth,
      pager_alert: p.alert,
      tsunami: p.tsunami === 1,
      significance: p.sig,
      felt_reports: p.felt,
      mmi: p.mmi,
      review_status: p.status,
      updated: isoTime(p.updated),
      url: p.url,
    },
  };
}

/**
 * NASA FIRMS active fires: VIIRS NOAA-20 + NOAA-21 from the area API (FIRMS_MAP_KEY, 5,000 transactions /
 * 10 min). Hotspots are 375 m pixel centres, so nearby detections are clustered into one signal per fire.
 * Without a key, the disasters playbook falls back to the public 24 h US file.
 */
import { env } from "../env";
import type { SignalInput } from "../domain";
import { clusterKeys, clusterPoints, meanPoint, radiusKm } from "./cluster";
import { nearestCounty } from "./counties";
import { hullPolygon } from "./geometry";
import { errorMessage, httpText, mapLimit } from "./http";
import { customRegion, FOREST_WATCH_REGIONS, US_FIRE_AREAS } from "./regions";
import { DAY_MS, type FeedOptions, type FeedResult, type Severity } from "./types";

const AREA_API = "https://firms.modaps.eosdis.nasa.gov/api/area/csv";
const SOURCES = ["VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT"]; // S-NPP files have been empty (docs/platform/signals.md)
const PUBLIC_US_24H =
  "https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_USA_contiguous_and_Hawaii_24h.csv";
/** Single detections are mostly ag burns and flares; a fire worth a look shows up in several pixels. */
const MIN_DETECTIONS = 3;
const HALF_PIXEL_DEG = 0.0017; // ~187 m, half a VIIRS I-band pixel
const MAX_DAY_RANGE = 5;

export interface Hotspot {
  lat: number;
  lon: number;
  frp: number;
  confidence: "low" | "nominal" | "high";
  acquired: Date;
  satellite: string;
  daynight: string;
}

const CONFIDENCE: Record<string, Hotspot["confidence"]> = { l: "low", n: "nominal", h: "high", low: "low", nominal: "nominal", high: "high" };

/** Parses FIRMS CSV (area API or public file; VIIRS letters or words, MODIS 0-100). */
export function parseFirmsCsv(csv: string): Hotspot[] {
  const [head, ...lines] = csv.trim().split(/\r?\n/);
  if (!head?.startsWith("latitude")) return [];
  const cols = head.split(",");
  const at = (name: string) => cols.indexOf(name);
  const [iLat, iLon, iFrp, iConf, iDate, iTime, iSat, iDn] = ["latitude", "longitude", "frp", "confidence", "acq_date", "acq_time", "satellite", "daynight"].map(at);
  return lines.flatMap((line) => {
    const v = line.split(",");
    const lat = Number(v[iLat]);
    const lon = Number(v[iLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
    const rawConf = v[iConf] ?? "";
    const pct = Number(rawConf);
    const confidence = CONFIDENCE[rawConf] ?? (Number.isFinite(pct) ? (pct >= 80 ? "high" : pct >= 30 ? "nominal" : "low") : "nominal");
    const t = (v[iTime] ?? "0").padStart(4, "0");
    return [{
      lat,
      lon,
      frp: Number(v[iFrp]) || 0,
      confidence,
      acquired: new Date(`${v[iDate]}T${t.slice(0, 2)}:${t.slice(2)}:00Z`),
      satellite: v[iSat] ?? "",
      daynight: v[iDn] ?? "",
    }];
  });
}

/** Fire radiative power (MW, summed) and pixel count → shared severity scale. */
export function fireSeverity(frpSum: number, detections: number): Severity {
  if (frpSum >= 1000 || detections >= 100) return "extreme";
  if (frpSum >= 300 || detections >= 40) return "severe";
  if (frpSum >= 50 || detections >= 10) return "moderate";
  return "minor";
}

/**
 * The area API's DAY_RANGE counts UTC calendar dates ending today (DATE..DATE+DAY_RANGE-1), not a rolling
 * window: "the last 24 h" spans yesterday and today, so it needs 2. Max 5 dates.
 */
export function firmsDayRange(since: Date, now: Date): { dayRange: number; clipped: boolean } {
  const utcDate = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dates = Math.round((utcDate(now) - utcDate(since)) / DAY_MS) + 1;
  return { dayRange: Math.min(MAX_DAY_RANGE, Math.max(1, dates)), clipped: dates > MAX_DAY_RANGE };
}

export async function fetchFirms(opts: FeedOptions): Promise<FeedResult> {
  const now = new Date();
  const since = opts.since ?? new Date(now.getTime() - DAY_MS);
  const forest = opts.playbook === "deforestation";
  const regions = opts.bbox ? [customRegion(opts.bbox)] : forest ? FOREST_WATCH_REGIONS : US_FIRE_AREAS;
  const key = env("FIRMS_MAP_KEY");
  const warnings: string[] = [];
  const points: (Hotspot & { region: string })[] = [];

  if (key) {
    const { dayRange, clipped } = firmsDayRange(since, now);
    if (clipped) warnings.push(`since ${since.toISOString()} is more than ${MAX_DAY_RANGE - 1} UTC dates back; the area API returns the last ${MAX_DAY_RANGE} only`);
    const calls = regions.flatMap((r) => SOURCES.map((s) => ({ r, s })));
    await mapLimit(calls, 3, async ({ r, s }) => {
      try {
        const csv = await httpText(`${AREA_API}/${key}/${s}/${r.bbox.join(",")}/${dayRange}`, { secrets: [key], timeoutMs: 30_000 });
        points.push(...parseFirmsCsv(csv).map((h) => ({ ...h, region: r.label })));
      } catch (err) {
        warnings.push(`${s} ${r.label}: ${errorMessage(err)}`);
      }
    });
  } else if (!forest && !opts.bbox) {
    warnings.push("FIRMS_MAP_KEY not set; using the public 24 h NOAA-20 US file");
    points.push(...parseFirmsCsv(await httpText(PUBLIC_US_24H, { timeoutMs: 30_000 })).map((h) => ({ ...h, region: "US" })));
  } else {
    return { signals: [], warnings: ["FIRMS_MAP_KEY not set; region queries need the area API"] };
  }

  const usable = points.filter((p) => p.confidence !== "low" && p.acquired.getTime() >= since.getTime());
  const clusters = clusterPoints(usable)
    .filter((c) => c.length >= MIN_DETECTIONS)
    .map((c) => summarise(c))
    .sort((a, b) => b.frpSum - a.frpSum);
  const ids = clusterKeys("fire", clusters);
  return { signals: clusters.map((c, i) => toSignal(c, ids[i], forest)), warnings };
}

type Cluster = ReturnType<typeof summarise>;

function summarise(points: (Hotspot & { region: string })[]) {
  const times = points.map((p) => p.acquired.getTime());
  const count = (k: Hotspot["confidence"]) => points.filter((p) => p.confidence === k).length;
  const centre = meanPoint(points);
  return {
    points,
    centre,
    radiusKm: radiusKm(centre, points),
    frpSum: Number(points.reduce((s, p) => s + p.frp, 0).toFixed(1)),
    frpMax: Math.max(...points.map((p) => p.frp)),
    first: new Date(Math.min(...times)),
    last: new Date(Math.max(...times)),
    confidence: { high: count("high"), nominal: count("nominal") },
  };
}

function toSignal(c: Cluster, externalId: string, forest: boolean): SignalInput {
  const n = c.points.length;
  // US boxes reach into Canada/Mexico; the nearest county is a FEMA/NWS join key and an "is this the US?" hint.
  const county = forest ? null : nearestCounty(c.centre.lat, c.centre.lon);
  return {
    playbook: forest ? "deforestation" : "disasters",
    feed: "firms",
    external_id: externalId,
    title: `Active fire: ${n} VIIRS detections (${Math.round(c.frpSum)} MW) near ${c.centre.lat.toFixed(2)}, ${c.centre.lon.toFixed(2)}`,
    severity: fireSeverity(c.frpSum, n),
    event_time: c.last.toISOString(),
    geometry: hullPolygon(c.points.map((p) => [p.lon, p.lat]), HALF_PIXEL_DEG),
    lat: c.centre.lat,
    lon: c.centre.lon,
    raw: {
      region: c.points[0].region,
      detections: n,
      radius_km: c.radiusKm,
      frp_sum_mw: c.frpSum,
      frp_max_mw: c.frpMax,
      first_seen: c.first.toISOString(),
      last_seen: c.last.toISOString(),
      confidence: c.confidence,
      satellites: [...new Set(c.points.map((p) => p.satellite))],
      night_detections: c.points.filter((p) => p.daynight === "N").length,
      nearest_county_fips: county?.fips ?? null,
      nearest_county_km: county?.km ?? null,
      source: "NASA FIRMS VIIRS NRT",
    },
  };
}

/**
 * Global Forest Watch integrated deforestation alerts (GLAD-L + GLAD-S2 + RADD, ~10 m, 30°N-30°S).
 * With GFW_API_KEY: /query/json with x-api-key. Without (the default): the keyless /download/json route, POST
 * {sql, geometry}; `latest` answers 307 → the current vYYYYMMDD and fetch re-sends the POST (re-verified live
 * 2026-11-07; best-effort, it may be locked down). Every request sends `origin: <our host>`, since keys are
 * bound to an origin allowlist (localhost, *.vercel.app).
 * High/highest-confidence pixels are clustered into one signal per clearing front.
 */
import { env, publicBaseUrl } from "../env";
import type { SignalInput } from "../domain";
import { clusterKeys, clusterPoints, meanPoint, radiusKm } from "./cluster";
import { hullPolygon } from "./geometry";
import { errorMessage, httpJson, mapLimit } from "./http";
import { customRegion, FOREST_WATCH_REGIONS, type WatchRegion } from "./regions";
import { daysAgo, isoDate, type FeedOptions, type FeedResult, type Severity } from "./types";

const DATASET = "https://data-api.globalforestwatch.org/dataset/gfw_integrated_alerts/latest"; // 307 → current version
const MIN_PIXELS = 10;
/** Alert pixels are 0.0001° (~11 m) squares: ~0.0124 ha at the equator. */
const PIXEL_HA_AT_EQUATOR = 0.0123925;

interface AlertRow {
  latitude: number;
  longitude: number;
  gfw_integrated_alerts__date: string;
  gfw_integrated_alerts__confidence: string;
}

export function forestLossSeverity(areaHa: number): Severity {
  return areaHa >= 50 ? "extreme" : areaHa >= 10 ? "severe" : areaHa >= 1 ? "moderate" : "minor";
}

/** GFW keys are bound to origins (localhost, *.vercel.app); send the host we run on, no scheme. */
export function gfwOrigin(): string {
  return new URL(publicBaseUrl()).hostname;
}

export async function fetchGfw(opts: FeedOptions): Promise<FeedResult> {
  const since = opts.since ?? daysAgo(14);
  const regions = opts.bbox ? [customRegion(opts.bbox)] : FOREST_WATCH_REGIONS;
  const key = env("GFW_API_KEY");
  const warnings = key ? [] : ["GFW_API_KEY not set; using the keyless download route (best-effort, lowest rate tier)"];
  // The API rejects IN (...); != 'nominal' keeps high and highest.
  const sql =
    "SELECT latitude, longitude, gfw_integrated_alerts__date, gfw_integrated_alerts__confidence FROM results " +
    `WHERE gfw_integrated_alerts__date >= '${isoDate(since)}' AND gfw_integrated_alerts__confidence != 'nominal'`;

  const perRegion = await mapLimit(regions, 2, async (region) => {
    try {
      const rows = await queryRegion(region, sql, key);
      return rows.map((r) => ({ lat: r.latitude, lon: r.longitude, date: r.gfw_integrated_alerts__date, confidence: r.gfw_integrated_alerts__confidence, region }));
    } catch (err) {
      warnings.push(`${region.label}: ${errorMessage(err)}`);
      return [];
    }
  });

  const clusters = perRegion
    .flatMap((pixels) => clusterPoints(pixels))
    .filter((c) => c.length >= MIN_PIXELS)
    .map(summarise)
    .sort((a, b) => b.areaHa - a.areaHa);
  const ids = clusterKeys("forest", clusters.map((c) => ({ centre: c.centre, first: new Date(`${c.first}T00:00:00Z`) })));
  return { signals: clusters.map((c, i) => toSignal(c, ids[i])), warnings };
}

async function queryRegion(region: WatchRegion, sql: string, key: string | undefined): Promise<AlertRow[]> {
  const [w, s, e, n] = region.bbox;
  const geometry = { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
  const headers: Record<string, string> = { "Content-Type": "application/json", origin: gfwOrigin() };
  if (key) headers["x-api-key"] = key;
  const res = await httpJson<AlertRow[] | { data?: AlertRow[] }>(`${DATASET}/${key ? "query" : "download"}/json`, {
    method: "POST",
    headers,
    body: JSON.stringify({ sql, geometry }),
    timeoutMs: 45_000,
    secrets: key ? [key] : [],
  });
  return Array.isArray(res) ? res : (res.data ?? []);
}

type Pixel = { lat: number; lon: number; date: string; confidence: string; region: WatchRegion };

function summarise(pixels: Pixel[]) {
  const centre = meanPoint(pixels);
  const dates = pixels.map((p) => p.date).sort();
  return {
    pixels,
    centre,
    radiusKm: radiusKm(centre, pixels),
    region: pixels[0].region,
    areaHa: Number((pixels.length * PIXEL_HA_AT_EQUATOR * Math.cos((centre.lat * Math.PI) / 180)).toFixed(2)),
    first: dates[0],
    last: dates[dates.length - 1],
    highest: pixels.filter((p) => p.confidence === "highest").length,
  };
}

function toSignal(c: ReturnType<typeof summarise>, externalId: string): SignalInput {
  return {
    playbook: "deforestation",
    feed: "gfw",
    external_id: externalId,
    title: `Forest-loss alerts: ~${c.areaHa} ha (${c.pixels.length} pixels) in ${c.region.label}`,
    severity: forestLossSeverity(c.areaHa),
    event_time: new Date(`${c.last}T00:00:00Z`).toISOString(),
    geometry: hullPolygon(c.pixels.map((p) => [p.lon, p.lat]), 0.00005),
    lat: c.centre.lat,
    lon: c.centre.lon,
    raw: {
      region_id: c.region.id,
      region: c.region.label,
      commodity: c.region.commodity || null,
      pixels: c.pixels.length,
      radius_km: c.radiusKm,
      area_ha_approx: c.areaHa,
      first_alert: c.first,
      last_alert: c.last,
      highest_confidence_pixels: c.highest,
      dataset: "gfw_integrated_alerts",
      license: "CC BY 4.0 — UMD/GLAD, WUR (RADD), via Global Forest Watch",
    },
  };
}

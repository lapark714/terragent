/**
 * OWNER: signals builder. Free geocoders first (US Census, Nominatim), Monid only as paid fallback.
 *
 * Order: "lat, lon" text → US Census (US street addresses; returns county FIPS) → Nominatim (place names and
 * everything else) → Monid kadec0 geocode, only with `allowPaid`. Nominatim policy (docs/platform/signals.md
 * §3.9b): ≤1 request/s (4/min for scheduled scripts: pass `periodic`), identifying User-Agent, cache results,
 * no personal data. So street addresses go to Nominatim without the house number (street-level answer, medium
 * confidence), and results are cached.
 */
import type { BBox } from "../domain";
import { monidRun } from "../monid/client";
import { errorMessage, httpJson } from "../signals/http";

export interface GeocodeResult {
  lat: number;
  lon: number;
  display_name: string;
  geocoder: "census" | "nominatim" | "monid" | "user";
  confidence: "high" | "medium" | "low";
  bbox?: BBox;
  country_code?: string;
  /** 5-digit county FIPS (Census only): joins to FEMA declarations and NWS SAME codes. */
  county_fips?: string;
  /** Required attribution for the data source (OSM / ODbL for Nominatim). */
  attribution?: string;
}

export interface GeocodeOptions {
  /** Allow the paid Monid geocoder (~$0.02) when the free ones find nothing. Off by default. */
  allowPaid?: boolean;
  /**
   * The caller runs on a schedule (cron agents). Nominatim allows those 4 requests/min, so they get a 15 s
   * gap, and a lookup that would queue longer than that fails fast instead of holding the tool call.
   */
  periodic?: boolean;
  agent?: string;
  requestId?: string;
}

const CENSUS = "https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress";
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const OSM_ATTRIBUTION = "Data © OpenStreetMap contributors, ODbL 1.0. https://osm.org/copyright";
const NOMINATIM_GAP_MS = 1100;
const NOMINATIM_PERIODIC_GAP_MS = 15_000;
const MAX_PERIODIC_WAIT_MS = 15_000;
const CACHE_MAX = 500;

const US_STATE_CODES =
  "AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|PR";
const US_STATE_NAMES =
  "alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|district of columbia|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|puerto rico";
const US_HINTS = [
  new RegExp(`,\\s*(${US_STATE_CODES})\\b`),
  new RegExp(`,\\s*(${US_STATE_NAMES})\\b`, "i"),
  /\b\d{5}(-\d{4})?\s*(,?\s*(USA?|United States))?\s*$/i,
  /\b(USA|U\.S\.A?\.?|United States)\s*$/i,
];
const HOUSE_NUMBER = /^\s*\d+[A-Za-z]?(-\d+)?\s+(?=\S)/;

export const looksLikeUs = (text: string) => US_HINTS.some((r) => r.test(text));
export const isStreetAddress = (text: string) => HOUSE_NUMBER.test(text);
export const withoutHouseNumber = (text: string) => text.replace(HOUSE_NUMBER, "").trim();

/** "37.77, -122.42" (or space separated) → coordinates; null if not a valid pair. */
export function parseLatLon(text: string): GeocodeResult | null {
  const m = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(text);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon, display_name: `${lat}, ${lon}`, geocoder: "user", confidence: "high" };
}

// ---------------------------------------------------------------------------

interface CensusReply {
  result?: {
    addressMatches?: {
      matchedAddress: string;
      coordinates: { x: number; y: number };
      geographies?: { Counties?: { GEOID: string }[] };
    }[];
  };
}

export async function censusGeocode(address: string): Promise<GeocodeResult | null> {
  const url = new URL(CENSUS);
  url.search = new URLSearchParams({ address, benchmark: "Public_AR_Current", vintage: "Current_Current", layers: "Counties", format: "json" }).toString();
  const m = (await httpJson<CensusReply>(url.toString(), { timeoutMs: 15_000 })).result?.addressMatches?.[0];
  if (!m) return null;
  return {
    lat: m.coordinates.y,
    lon: m.coordinates.x,
    display_name: m.matchedAddress,
    geocoder: "census",
    confidence: "high", // interpolated along the TIGER address range, not rooftop
    country_code: "us",
    county_fips: m.geographies?.Counties?.[0]?.GEOID,
  };
}

interface NominatimPlace {
  lat: string;
  lon: string;
  display_name: string;
  place_rank: number;
  boundingbox?: [string, string, string, string]; // minLat, maxLat, minLon, maxLon
  address?: { country_code?: string };
}

let nextSlot = 0;
let nextPeriodicSlot = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for a Nominatim slot: scheduled callers first wait in their own 15 s lane (so they never hold up an
 * interactive lookup), then everyone shares the 1.1 s lane. Per process only; Vercel instances don't share it.
 */
async function nominatimTurn(periodic: boolean) {
  if (periodic) {
    const now = Date.now();
    const at = Math.max(now, nextPeriodicSlot);
    if (at - now > MAX_PERIODIC_WAIT_MS) {
      throw new Error(`Nominatim allows scheduled jobs 4 lookups/min; budget used, retry in ${Math.ceil((at - now) / 1000)} s`);
    }
    nextPeriodicSlot = at + NOMINATIM_PERIODIC_GAP_MS;
    if (at > now) await sleep(at - now);
  }
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + NOMINATIM_GAP_MS;
  if (at > now) await sleep(at - now);
}

export async function nominatimGeocode(q: string, opts: { streetOnly?: boolean; periodic?: boolean } = {}): Promise<GeocodeResult | null> {
  await nominatimTurn(!!opts.periodic);
  const url = new URL(NOMINATIM);
  url.search = new URLSearchParams({ q, format: "jsonv2", limit: "1", addressdetails: "1" }).toString();
  const [p] = await httpJson<NominatimPlace[]>(url.toString(), { timeoutMs: 15_000 });
  if (!p) return null;
  const rank = Number(p.place_rank);
  const confidence = rank >= 26 && !opts.streetOnly ? "high" : rank >= 16 ? "medium" : "low";
  const bb = p.boundingbox?.map(Number);
  return {
    lat: Number(p.lat),
    lon: Number(p.lon),
    display_name: p.display_name,
    geocoder: "nominatim",
    confidence,
    bbox: bb && bb.every(Number.isFinite) ? [bb[2], bb[0], bb[3], bb[1]] : undefined,
    country_code: p.address?.country_code,
    attribution: OSM_ATTRIBUTION,
  };
}

async function monidGeocode(q: string, opts: GeocodeOptions): Promise<GeocodeResult | null> {
  const run = await monidRun({
    provider: "api.kadec0.xyz",
    endpoint: "/v1/geocode",
    input: { q, maxItems: "1" },
    purpose: "geocode fallback (free geocoders found nothing)",
    agent: opts.agent,
    requestId: opts.requestId,
  });
  if (run.status !== "COMPLETED") throw new Error(`Monid geocode ${run.status}: ${run.reason ?? ""}`);
  const item = (run.output as { items?: { displayName?: string; lat?: number; lon?: number }[] } | null)?.items?.[0];
  const lat = Number(item?.lat);
  const lon = Number(item?.lon);
  if (!item || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon, display_name: item.displayName ?? q, geocoder: "monid", confidence: "medium" };
}

// ---------------------------------------------------------------------------

const cache = new Map<string, GeocodeResult | null>();

function remember(key: string, value: GeocodeResult | null) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
  return value;
}

/**
 * Resolve an address, place name or "lat, lon". Returns null when nothing matched; throws only when every
 * geocoder that was tried failed (network/HTTP errors), so callers can tell "not found" from "couldn't check".
 */
export async function geocode(text: string, opts: GeocodeOptions = {}): Promise<GeocodeResult | null> {
  const q = text.trim().replace(/\s+/g, " ");
  if (!q) return null;
  const direct = parseLatLon(q);
  if (direct) return direct;
  const key = `${opts.allowPaid ? "paid" : "free"}:${q.toLowerCase()}`;
  if (cache.has(key)) return cache.get(key)!;

  const street = isStreetAddress(q);
  const attempts: (() => Promise<GeocodeResult | null>)[] = [];
  if (street && looksLikeUs(q)) attempts.push(() => censusGeocode(q));
  attempts.push(() => nominatimGeocode(street ? withoutHouseNumber(q) : q, { streetOnly: street, periodic: opts.periodic }));
  if (opts.allowPaid) attempts.push(() => monidGeocode(q, opts));

  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      const hit = await attempt();
      if (hit) return remember(key, hit);
    } catch (err) {
      errors.push(errorMessage(err));
    }
  }
  if (errors.length === attempts.length) throw new Error(`geocoding failed: ${errors.join("; ")}`);
  return errors.length ? null : remember(key, null); // don't cache a miss that an outage may have caused
}

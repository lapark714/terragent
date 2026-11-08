/**
 * NWS active alerts (api.weather.gov), Severe/Extreme, land, actual. ~96% of alerts carry no polygon,
 * so zone-only alerts get the convex hull of their affected zones (fetched one by one, then cached in memory
 * and in the nws_zone_cache table, so cold starts don't refetch them).
 * Re-issued alerts (Update / segments of one product) share a VTEC event id and become one signal.
 */
import type { Polygon, SignalInput } from "../domain";
import { geometryPoints, hullPolygon, polygonCentroid, roundPolygon, type LonLat } from "./geometry";
import { errorMessage, httpJson, mapLimit } from "./http";
import { readZoneHulls, writeZoneHulls } from "./zone-cache";
import { isoTime, severityRank, truncate, type FeedOptions, type FeedResult } from "./types";

const ALERTS_URL =
  "https://api.weather.gov/alerts/active?status=actual&message_type=alert,update&region_type=land&severity=Severe,Extreme";

/** Events whose aftermath satellites can see (floods, storms, wind, fire weather). Freeze/heat/fog are skipped. */
const IMAGERY_RELEVANT =
  /flood|hurricane|typhoon|tropical storm|storm surge|tornado|severe thunderstorm|high wind|extreme wind|red flag|fire weather|fire warning|tsunami|ice storm|debris flow|dust storm|avalanche|volcan/i;

/** Zone GeoJSON is 50-700 KB each; cap fetches per poll. */
const MAX_ZONE_FETCHES = 120;
const ZONE_CONCURRENCY = 4;
const zoneHulls = new Map<string, LonLat[]>();

interface NwsProps {
  id: string;
  areaDesc: string;
  geocode?: { SAME?: string[]; UGC?: string[] };
  affectedZones: string[];
  references?: { identifier: string; sent: string }[];
  sent: string;
  effective?: string | null;
  onset?: string | null;
  expires?: string | null;
  ends?: string | null;
  messageType: string;
  severity: string;
  certainty?: string;
  urgency?: string;
  event: string;
  senderName?: string;
  headline?: string | null;
  description?: string | null;
  instruction?: string | null;
  response?: string;
  parameters?: { VTEC?: string[]; NWSheadline?: string[] };
}
interface NwsFeature {
  geometry: { type: string; coordinates: unknown } | null;
  properties: NwsProps;
}

/** "/O.EXT.KPSR.FA.W.0040.000000T0000Z-261109T0600Z/" → "KPSR.FA.W.0040:2026" (ETNs restart each year). */
export function vtecEventKey(vtec: string[] | undefined, sent: string): string | null {
  const parsed = (vtec ?? [])
    .map((v) => /^\/[OTEX]\.([A-Z]{3})\.([A-Z]{4})\.([A-Z]{2})\.([A-Z])\.(\d{4})\.(\d{6})T\d{4}Z-/.exec(v))
    .filter((m): m is RegExpExecArray => !!m);
  // An upgrade carries the cancelled watch first; prefer the segment that is still in effect.
  const m = parsed.find((p) => !["CAN", "EXP", "UPG"].includes(p[1])) ?? parsed[0];
  if (!m) return null;
  const year = m[6] === "000000" ? sent.slice(0, 4) : `20${m[6].slice(0, 2)}`;
  return `${m[2]}.${m[3]}.${m[4]}.${m[5]}:${year}`;
}

function eventKey(p: NwsProps): string {
  const vtec = vtecEventKey(p.parameters?.VTEC, p.sent);
  if (vtec) return `vtec:${vtec}`;
  // No VTEC: the oldest referenced message is the root of the update chain.
  const root = [...(p.references ?? [])].sort((a, b) => Date.parse(a.sent) - Date.parse(b.sent))[0];
  return `cap:${root?.identifier ?? p.id}`;
}

async function zoneHull(url: string): Promise<LonLat[]> {
  const cached = zoneHulls.get(url);
  if (cached) return cached;
  const zone = await httpJson<{ geometry: unknown }>(url, { headers: { Accept: "application/geo+json" }, timeoutMs: 15_000 });
  const hull = hullPolygon(geometryPoints(zone.geometry))?.coordinates[0] ?? [];
  if (hull.length) zoneHulls.set(url, hull as LonLat[]);
  return hull as LonLat[];
}

/** Fill the memory layer from the table; without a database the feed still works, it just refetches. */
async function loadStoredHulls(urls: string[], warnings: string[]) {
  try {
    for (const [u, hull] of await readZoneHulls(urls)) zoneHulls.set(u, hull);
  } catch (err) {
    warnings.push(`zone cache unavailable: ${errorMessage(err)}`);
  }
}

export async function fetchNws(opts: FeedOptions): Promise<FeedResult> {
  const warnings: string[] = [];
  const doc = await httpJson<{ features: NwsFeature[] }>(ALERTS_URL, { headers: { Accept: "application/geo+json" } });

  const groups = new Map<string, NwsFeature[]>();
  for (const f of doc.features ?? []) {
    const p = f.properties;
    if (p.messageType === "Cancel" || !IMAGERY_RELEVANT.test(p.event)) continue;
    const key = eventKey(p);
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }

  // `sent` carries the issuing office's UTC offset, so compare instants, not strings.
  const sentAt = (f: NwsFeature) => Date.parse(f.properties.sent);
  const latest = (fs: NwsFeature[]) => fs.reduce((a, b) => (sentAt(b) > sentAt(a) ? b : a));
  const ranked = [...groups.entries()]
    .sort(([, a], [, b]) =>
      severityRank(latest(b).properties.severity.toLowerCase()) - severityRank(latest(a).properties.severity.toLowerCase()) ||
      sentAt(latest(b)) - sentAt(latest(a)))
    .slice(0, opts.limit ?? Infinity);

  // Zone geometry only for groups without an alert polygon, within the fetch budget.
  const needZones = ranked.filter(([, fs]) => !fs.some((f) => f.geometry));
  const zoneUrls = [...new Set(needZones.flatMap(([, fs]) => fs.flatMap((f) => f.properties.affectedZones)))];
  await loadStoredHulls(zoneUrls.filter((u) => !zoneHulls.has(u)), warnings);
  const toFetch = zoneUrls.filter((u) => !zoneHulls.has(u)).slice(0, MAX_ZONE_FETCHES);
  const failed: string[] = [];
  await mapLimit(toFetch, ZONE_CONCURRENCY, (u) => zoneHull(u).catch((err) => void failed.push(`${u.split("/").pop()} (${errorMessage(err)})`)));
  if (failed.length) warnings.push(`zone geometry unavailable for ${failed.length} zone(s): ${failed.slice(0, 3).join("; ")}`);
  const fetched = new Map(toFetch.filter((u) => zoneHulls.has(u)).map((u) => [u, zoneHulls.get(u)!]));
  await writeZoneHulls(fetched).catch((err) => void warnings.push(`zone cache write failed: ${errorMessage(err)}`));
  const skipped = zoneUrls.filter((u) => !zoneHulls.has(u) && !toFetch.includes(u)).length;
  if (skipped) warnings.push(`zone fetch budget (${MAX_ZONE_FETCHES}) reached; ${skipped} zone(s) left without geometry`);

  const signals = ranked.map(([key, fs]) => toSignal(key, fs, latest(fs)));
  for (const s of signals) if (!s.geometry) warnings.push(`no geometry for ${s.external_id} (${s.title})`);
  return { signals, warnings };
}

function groupGeometry(fs: NwsFeature[]): { geometry: Polygon | null; source: "alert" | "zones" | null } {
  const own = fs.filter((f) => f.geometry);
  if (own.length === 1 && own[0].geometry!.type === "Polygon") return { geometry: roundPolygon(own[0].geometry as Polygon), source: "alert" };
  if (own.length) return { geometry: hullPolygon(own.flatMap((f) => geometryPoints(f.geometry))), source: "alert" };
  const pts = fs.flatMap((f) => f.properties.affectedZones).flatMap((u) => zoneHulls.get(u) ?? []);
  const geometry = hullPolygon(pts);
  return { geometry, source: geometry ? "zones" : null };
}

function toSignal(key: string, fs: NwsFeature[], head: NwsFeature): SignalInput {
  const p = head.properties;
  const { geometry, source } = groupGeometry(fs);
  const centre = geometry ? polygonCentroid(geometry) : null;
  const zones = [...new Set(fs.flatMap((f) => f.properties.affectedZones))];
  const ugc = [...new Set(fs.flatMap((f) => f.properties.geocode?.UGC ?? []))];
  const same = [...new Set(fs.flatMap((f) => f.properties.geocode?.SAME ?? []))];
  return {
    playbook: "disasters",
    feed: "nws",
    external_id: key,
    title: truncate(`${p.event}: ${p.areaDesc}`, 200)!,
    severity: p.severity.toLowerCase(),
    event_time: isoTime(p.onset) ?? isoTime(p.effective) ?? isoTime(p.sent),
    geometry,
    lat: centre?.lat ?? null,
    lon: centre?.lon ?? null,
    raw: {
      alert_id: p.id,
      event: p.event,
      area_desc: p.areaDesc,
      sender: p.senderName ?? null,
      sent: p.sent,
      onset: p.onset ?? null,
      expires: p.expires ?? null,
      ends: p.ends ?? null,
      certainty: p.certainty ?? null,
      urgency: p.urgency ?? null,
      response: p.response ?? null,
      headline: p.parameters?.NWSheadline?.[0] ?? p.headline ?? null,
      description: truncate(p.description, 1200),
      instruction: truncate(p.instruction, 500),
      vtec: p.parameters?.VTEC ?? [],
      ugc,
      county_fips: same.map((s) => s.slice(1)),
      affected_zones: zones,
      geometry_source: source,
      messages: fs.length,
    },
  };
}

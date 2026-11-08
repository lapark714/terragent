/**
 * River gauges in flood now. The NOAA riv_gauges MapServer answers "which gauges are at minor/moderate/major"
 * in ~0.3 s (the full NWPS list is 13 MB and slow); NWPS gauge detail then adds fresher readings and the
 * local impact statement ("25 homes at River Acres are impacted").
 */
import type { SignalInput } from "../domain";
import { errorMessage, httpJson, mapLimit } from "./http";
import { isoTime, isoWeek, type FeedOptions, type FeedResult, type Severity } from "./types";

const RIV_GAUGES = "https://mapservices.weather.noaa.gov/eventdriven/rest/services/water/riv_gauges/MapServer/0/query";
const NWPS = "https://api.water.noaa.gov/nwps/v1/gauges";
const MAX_DETAILS = 25;

const IN_FLOOD = ["minor", "moderate", "major"] as const;
type FloodCategory = (typeof IN_FLOOD)[number];
const SEVERITY: Record<FloodCategory, Severity> = { major: "extreme", moderate: "severe", minor: "moderate" };

interface GaugeFeature {
  geometry: { coordinates: [number, number] } | null;
  properties: {
    gaugelid: string;
    status: string;
    location: string;
    waterbody: string;
    state: string;
    obstime: string;
    observed: string;
    action: string;
    flood: string;
    moderate: string;
    major: string;
    units: string;
    url: string;
    latitude: number;
    longitude: number;
    wfo?: string;
  };
}

interface Reading {
  primary: number;
  primaryUnit: string;
  secondary: number;
  secondaryUnit: string;
  floodCategory: string;
  validTime: string;
}
interface GaugeDetail {
  usgsId?: string;
  name?: string;
  county?: string;
  status?: { observed?: Reading; forecast?: Reading };
  flood?: { impacts?: { stage: number; statement: string }[] };
}

const num = (s: string | number | undefined) => {
  const v = Number(s);
  return Number.isFinite(v) && v > -999 ? v : null;
};

/** The highest-stage impact statement at or below the observed stage. */
export function currentImpact(impacts: { stage: number; statement: string }[] | undefined, stage: number | null) {
  if (stage == null) return null;
  return [...(impacts ?? [])].filter((i) => i.stage <= stage).sort((a, b) => b.stage - a.stage)[0] ?? null;
}

export async function fetchNwpsFloods(opts: FeedOptions): Promise<FeedResult> {
  const warnings: string[] = [];
  const url = new URL(RIV_GAUGES);
  url.search = new URLSearchParams({
    where: `status IN ('${IN_FLOOD.join("','")}')`,
    outFields: "gaugelid,status,location,waterbody,state,obstime,observed,action,flood,moderate,major,units,url,latitude,longitude,wfo",
    f: "geojson",
  }).toString();
  const doc = await httpJson<{ features: GaugeFeature[] }>(url.toString());
  const gauges = (doc.features ?? [])
    .filter((g) => (IN_FLOOD as readonly string[]).includes(g.properties.status))
    .sort((a, b) => IN_FLOOD.indexOf(b.properties.status as FloodCategory) - IN_FLOOD.indexOf(a.properties.status as FloodCategory))
    .slice(0, opts.limit ?? Infinity);

  const details = await mapLimit(gauges.slice(0, MAX_DETAILS), 4, (g) =>
    httpJson<GaugeDetail>(`${NWPS}/${encodeURIComponent(g.properties.gaugelid)}`, { timeoutMs: 15_000 }).catch((err) => {
      warnings.push(`gauge detail ${g.properties.gaugelid}: ${errorMessage(err)}`);
      return null;
    }),
  );
  const signals = gauges.map((g, i) => toSignal(g, details[i] ?? null));
  for (const s of signals) if (!s.event_time) warnings.push(`${s.raw.lid}: no valid observation time`);
  return { signals, warnings };
}

function toSignal(g: GaugeFeature, d: GaugeDetail | null): SignalInput {
  const p = g.properties;
  const obs = d?.status?.observed;
  const detailCategory = obs && (IN_FLOOD as readonly string[]).includes(obs.floodCategory) ? obs.floodCategory : null;
  const category = (detailCategory ?? p.status) as FloodCategory;
  const stage = num(obs?.primary) ?? num(p.observed);
  // MapServer obstime has no zone; it matches NWPS validTime in UTC.
  const observedAt = isoTime(obs?.validTime) ?? isoTime(p.obstime ? `${p.obstime.replace(" ", "T")}Z` : null);
  const impact = currentImpact(d?.flood?.impacts, stage);
  const fc = d?.status?.forecast;
  return {
    playbook: "disasters",
    feed: "nwps_flood",
    // The gauge is in flood now, so a missing reading time still dates the event to this week.
    external_id: `${p.gaugelid}:${category}:${isoWeek(observedAt ? new Date(observedAt) : new Date())}`,
    title: `${category[0].toUpperCase()}${category.slice(1)} flooding: ${p.waterbody} at ${p.location}, ${p.state}`,
    severity: SEVERITY[category],
    event_time: observedAt,
    geometry: null,
    lat: p.latitude,
    lon: p.longitude,
    raw: {
      lid: p.gaugelid,
      usgs_id: d?.usgsId ?? null,
      name: d?.name ?? `${p.waterbody} at ${p.location}`,
      county: d?.county ?? null,
      state: p.state,
      wfo: p.wfo ?? null,
      flood_category: category,
      observed_stage: stage,
      stage_unit: obs?.primaryUnit ?? p.units,
      observed_flow: num(obs?.secondary),
      flow_unit: obs?.secondaryUnit ?? null,
      observed_at: observedAt,
      thresholds: { action: num(p.action), minor: num(p.flood), moderate: num(p.moderate), major: num(p.major) },
      forecast: fc ? { stage: num(fc.primary), category: fc.floodCategory, valid_time: fc.validTime } : null,
      impact: impact?.statement ?? null,
      impact_stage: impact?.stage ?? null,
      url: p.url,
    },
  };
}

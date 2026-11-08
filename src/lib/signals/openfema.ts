/**
 * OpenFEMA disaster declarations (v2, no key). One row per designated area per declaration; the area is
 * placed at its county's Census internal point (2025 Gazetteer). Statewide, tribal and territory rows the
 * Gazetteer doesn't cover get lat/lon null. Declarations lag incidents by days to weeks.
 */
import type { SignalInput } from "../domain";
import { countyCentroid } from "./counties";
import { httpJson } from "./http";
import { daysAgo, isoTime, type FeedOptions, type FeedResult, type Severity } from "./types";

const API = "https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries";

interface Declaration {
  femaDeclarationString: string;
  disasterNumber: number;
  state: string;
  declarationType: "DR" | "EM" | "FM" | string;
  declarationDate: string;
  incidentType: string;
  declarationTitle: string;
  ihProgramDeclared: boolean;
  iaProgramDeclared: boolean;
  paProgramDeclared: boolean;
  hmProgramDeclared: boolean;
  incidentBeginDate: string | null;
  incidentEndDate: string | null;
  fipsStateCode: string;
  fipsCountyCode: string;
  placeCode: string;
  designatedArea: string;
  incidentId: string;
  id: string;
}

const SEVERITY: Record<string, Severity> = { DR: "severe", EM: "moderate", FM: "moderate" };
const TYPE_LABEL: Record<string, string> = { DR: "major disaster", EM: "emergency", FM: "fire management" };

export async function fetchOpenFema(opts: FeedOptions): Promise<FeedResult> {
  const since = opts.since ?? daysAgo(14);
  const url = new URL(API);
  url.search = new URLSearchParams({
    $filter: `declarationDate ge '${since.toISOString()}'`,
    $orderby: "declarationDate desc",
    $top: "1000",
    $metadata: "off",
  }).toString();
  const doc = await httpJson<{ DisasterDeclarationsSummaries?: Declaration[] }>(url.toString(), { timeoutMs: 30_000 });
  return { signals: (doc.DisasterDeclarationsSummaries ?? []).map(toSignal), warnings: [] };
}

function toSignal(d: Declaration): SignalInput {
  const fips = `${d.fipsStateCode}${d.fipsCountyCode}`;
  const isCounty = d.fipsCountyCode !== "000";
  const centre = isCounty ? countyCentroid(fips) : null;
  return {
    playbook: "disasters",
    feed: "openfema",
    external_id: `${d.femaDeclarationString}:${d.placeCode || d.id}`,
    title: `${d.incidentType} ${TYPE_LABEL[d.declarationType] ?? "declaration"} ${d.femaDeclarationString}: ${d.designatedArea}, ${d.state}`,
    severity: SEVERITY[d.declarationType] ?? "moderate",
    event_time: isoTime(d.declarationDate),
    geometry: null,
    lat: centre?.lat ?? null,
    lon: centre?.lon ?? null,
    raw: {
      declaration: d.femaDeclarationString,
      disaster_number: d.disasterNumber,
      declaration_type: d.declarationType,
      incident_type: d.incidentType,
      declaration_title: d.declarationTitle,
      designated_area: d.designatedArea,
      state: d.state,
      county_fips: isCounty ? fips : null,
      incident_begin: d.incidentBeginDate,
      incident_end: d.incidentEndDate,
      incident_id: d.incidentId,
      programs: { ih: d.ihProgramDeclared, ia: d.iaProgramDeclared, pa: d.paProgramDeclared, hm: d.hmProgramDeclared },
      location_source: centre ? "census_gazetteer_2025_county_internal_point" : null,
      // Polygon for the county, if a consumer needs one (NWS county zones are {STATE}C{county FIPS}).
      county_zone_url: isCounty ? `https://api.weather.gov/zones/county/${d.state}C${d.fipsCountyCode}` : null,
      url: `https://www.fema.gov/disaster/${d.disasterNumber}`,
    },
  };
}

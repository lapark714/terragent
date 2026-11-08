/**
 * New BLM mining claims: MLRS data via the BLM ArcGIS Hub "Not Closed" layer (no key, refreshed ~daily,
 * docs/platform/signals.md §3.7b). A company staking ground files a block of adjacent claims at once
 * ("ROC 3001…3560"), so claims are clustered into one signal per block. Claimant names aren't in this layer;
 * the case numbers find them in MLRS. Registered in index.ts as the mining playbook's first feed.
 */
import type { SignalInput } from "../domain";
import { clusterPoints, meanPoint, radiusKm, type GeoPoint } from "./cluster";
import { geometryPoints, hullPolygon, type LonLat } from "./geometry";
import { httpJson } from "./http";
import { daysAgo, isoDate, isoTime, type FeedOptions, type Severity } from "./types";

const LAYER = "https://nlsdbpubgis.blm.gov/arcgishub/rest/services/HUB/BLM_Natl_MLRS_Mining_Claims_Not_Closed/FeatureServer/0/query";
const PAGE_SIZE = 2000; // the layer's maxRecordCount
const MAX_PAGES = 5;
const MAX_CASES_IN_RAW = 50;

export type BlmClaimsSignal = Omit<SignalInput, "feed"> & { feed: "blm_claims" };

interface ClaimFeature {
  geometry: { type: string; coordinates: unknown } | null;
  properties: {
    CSE_NR: string;
    CSE_NAME: string | null;
    BLM_PROD: string | null;
    CSE_DISP: string | null;
    RCRD_ACRS: number | null;
    Created: number | null;
  };
}
interface ClaimsPage {
  features?: ClaimFeature[];
  exceededTransferLimit?: boolean;
  properties?: { exceededTransferLimit?: boolean };
}

export interface Claim {
  caseNr: string;
  name: string;
  /** Claim name without its serial: "ROC 3560" → "ROC". */
  stem: string;
  state: string;
  kind: string;
  disposition: string;
  acres: number;
  created: number | null;
  ring: LonLat[];
  at: GeoPoint | null;
}

export const claimStem = (name: string) => name.replace(/[\s#-]*(no\.?\s*)?\d+[a-z]?$/i, "").trim() || name;

/** Size of the staking programme on the shared scale: a 100-claim block is a funded explorer. */
export function stakingSize(claims: number): Severity {
  return claims >= 100 ? "extreme" : claims >= 25 ? "severe" : claims >= 5 ? "moderate" : "minor";
}

export function parseClaims(features: ClaimFeature[]): Claim[] {
  return features.flatMap(({ geometry, properties: p }) => {
    if (!p?.CSE_NR) return [];
    const ring = geometryPoints(geometry);
    const name = p.CSE_NAME?.trim() || p.CSE_NR;
    return [{
      caseNr: p.CSE_NR,
      name,
      stem: claimStem(name),
      state: p.CSE_NR.slice(0, 2),
      kind: p.BLM_PROD ?? "unknown",
      disposition: p.CSE_DISP ?? "unknown",
      acres: Number(p.RCRD_ACRS) || 0,
      created: p.Created,
      ring,
      at: ring.length ? meanPoint(ring.map(([lon, lat]) => ({ lat, lon }))) : null,
    }];
  });
}

/** Located claims cluster by touching H3 cells; claims without a shape join a block of the same name, else stand alone. */
export function claimBlocks(claims: Claim[]): Claim[][] {
  const located = claims.filter((c) => c.at);
  const blocks = clusterPoints(located.map((c) => ({ ...c.at!, claim: c }))).map((b) => b.map((p) => p.claim));
  const nameKey = (c: Claim) => `${c.state}:${c.stem.toLowerCase()}`;
  const blockByName = new Map<string, Claim[]>();
  for (const block of [...blocks].sort((a, b) => a.length - b.length)) for (const c of block) blockByName.set(nameKey(c), block);
  const loose = new Map<string, Claim[]>();
  for (const c of claims.filter((x) => !x.at)) {
    const home = blockByName.get(nameKey(c)) ?? loose.get(nameKey(c));
    if (home) home.push(c);
    else loose.set(nameKey(c), [c]);
  }
  return [...blocks, ...loose.values()].sort((a, b) => b.length - a.length);
}

export async function fetchBlmClaims(opts: FeedOptions): Promise<{ signals: BlmClaimsSignal[]; warnings: string[] }> {
  const since = opts.since ?? daysAgo(7);
  const warnings: string[] = [];
  const features: ClaimFeature[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(LAYER);
    url.search = new URLSearchParams({
      where: `Created >= DATE '${isoDate(since)}'`, // Created is a UTC date, so the whole `since` day is included
      outFields: "CSE_NR,CSE_NAME,BLM_PROD,CSE_DISP,RCRD_ACRS,Created",
      orderByFields: "OBJECTID", // stable order for paging
      outSR: "4326",
      geometryPrecision: "5",
      resultOffset: String(page * PAGE_SIZE),
      resultRecordCount: String(PAGE_SIZE),
      f: "geojson",
    }).toString();
    const doc = await httpJson<ClaimsPage>(url.toString(), { timeoutMs: 30_000 });
    features.push(...(doc.features ?? []));
    if (!(doc.exceededTransferLimit ?? doc.properties?.exceededTransferLimit)) break;
    if (page === MAX_PAGES - 1) warnings.push(`stopped after ${features.length} claims created since ${isoDate(since)}; more exist`);
  }
  return { signals: claimBlocks(parseClaims(features)).map(toSignal), warnings };
}

const tally = (values: string[]) => Object.fromEntries([...new Set(values)].map((v) => [v, values.filter((x) => x === v).length]));

function toSignal(block: Claim[]): BlmClaimsSignal {
  const points = block.flatMap((c) => (c.at ? [c.at] : []));
  const centre = points.length ? meanPoint(points) : null;
  const cases = block.map((c) => c.caseNr).sort();
  const created = block.flatMap((c) => (c.created == null ? [] : [c.created]));
  const acres = Number(block.reduce((s, c) => s + c.acres, 0).toFixed(2));
  const stems = [...new Set(block.map((c) => c.stem))];
  const states = [...new Set(block.map((c) => c.state))];
  const n = block.length;
  return {
    playbook: "mining",
    feed: "blm_claims",
    external_id: `claims:${cases[0]}`, // serials rise over time, so the lowest case number names the block
    title: `New mining claims: ${n} claim${n === 1 ? "" : "s"} "${stems.slice(0, 2).join('", "')}"${stems.length > 2 ? " and others" : ""} (${Math.round(acres)} acres), ${states.join("/")}`,
    severity: stakingSize(n),
    event_time: created.length ? isoTime(Math.max(...created)) : null,
    geometry: hullPolygon(block.flatMap((c) => c.ring)),
    lat: centre?.lat ?? null,
    lon: centre?.lon ?? null,
    raw: {
      claims: n,
      located_claims: points.length,
      acres,
      name_stems: stems,
      states,
      kinds: tally(block.map((c) => c.kind)),
      dispositions: tally(block.map((c) => c.disposition)),
      case_numbers: cases.slice(0, MAX_CASES_IN_RAW),
      first_created: created.length ? isoTime(Math.min(...created)) : null,
      last_created: created.length ? isoTime(Math.max(...created)) : null,
      radius_km: centre ? radiusKm(centre, points) : null,
      source: "BLM MLRS mining claims, Not Closed layer (ArcGIS Hub)",
      note: "The claimant isn't in this layer; look a case number up in MLRS (mlrs.blm.gov) to find the business.",
    },
  };
}

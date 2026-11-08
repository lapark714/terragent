/** Test and simulator fixtures: an in-memory database plus a realistic burn-severity request (Eaton fire, Altadena). */
import { seedProviders } from "../../../db/seeds/providers";
import { createDb, type Db, setDb } from "../db/client";
import { migrate } from "../db/migrate";
import type { AcquisitionPlan, AnalysisResult, DataSpec, ReportDraft } from "../domain";
import { bboxAround, bboxToPolygon, pointCell } from "../geo/h3";

export const SITE = { lat: 34.185, lon: -118.135, text: "Altadena, CA" };

/** Fresh PGlite in memory, migrated and seeded, installed as the getDb() singleton. */
export async function setupMemoryDb(): Promise<Db> {
  const db = await createDb({ memory: true });
  await migrate(db);
  await seedProviders(db);
  setDb(db);
  return db;
}

const BEFORE = { collection: "sentinel-2-l2a", item_id: "S2A_MSIL2A_20250102T183751_R027_T11SLT_20250102T222059", datetime: "2025-01-02T18:44:31Z", cloud_pct: 0.1 };
const AFTER = { collection: "sentinel-2-l2a", item_id: "S2C_MSIL2A_20250201T183631_R027_T11SLT_20250201T214812", datetime: "2025-02-01T18:44:31Z", cloud_pct: 0.2 };

export function sampleSpec(requestId: string, over: Partial<DataSpec> = {}): DataSpec {
  return {
    request_id: requestId, playbook: "disasters",
    location: { text: SITE.text, lat: SITE.lat, lon: SITE.lon, geocoder: "user" },
    aoi: bboxToPolygon(bboxAround(SITE.lat, SITE.lon, 2)), area_km2: 4, h3_res: 8, recipe: "burn_severity", data_type: "optical",
    min_resolution_m: 10, max_cloud_pct: 30, before: { start: "2024-12-20", end: "2025-01-06" }, after: { start: "2025-01-25", end: "2025-02-10" },
    earth_index_hits: [], reuse_existing: false, assumptions: ["Fire perimeter from public news; burn checked with dNBR"], ...over,
  };
}

export function samplePlan(requestId: string, over: Partial<AcquisitionPlan> = {}): AcquisitionPlan {
  return {
    request_id: requestId, choice: "free",
    free_option: { provider_id: "pc-sentinel-2-l2a", before_scene: BEFORE, after_scene: AFTER, sufficient: true, why: "Clear 10 m scenes before and after" },
    paid_options: [], justification: "Free Sentinel-2 at 10 m resolves a neighbourhood-scale burn.", data_cost_usd: 0, quote_requests_sent: [], ...over,
  };
}

export function sampleAnalysis(over: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    recipe: "burn_severity", bbox: [-118.146, 34.176, -118.124, 34.194],
    before: { ...BEFORE, clear_fraction: 1 }, after: { ...AFTER, clear_fraction: 0.98 },
    indices: [
      { name: "nbr", before_mean: 0.236, after_mean: 0.052, delta: -0.184, unit: null, affected_area_km2: null, threshold: null },
      { name: "dnbr", before_mean: null, after_mean: 0.174, delta: 0.174, unit: null, affected_area_km2: 1.1, threshold: "dNBR >= 0.1" },
    ],
    images: [
      { role: "before", path: "before.png", caption: "True colour, 2 Jan 2025" },
      { role: "after", path: "after.png", caption: "True colour, 1 Feb 2025" },
      { role: "index", path: "dnbr.png", caption: "dNBR burn severity" },
    ],
    h3_metrics: [
      { h3_cell: pointCell(SITE.lat, SITE.lon, 8), h3_res: 8, metric: "dnbr_mean", value: 0.31 },
      { h3_cell: pointCell(SITE.lat + 0.006, SITE.lon, 8), h3_res: 8, metric: "dnbr_mean", value: 0.05 },
      { h3_cell: pointCell(SITE.lat, SITE.lon, 8), h3_res: 8, metric: "nbr_after_mean", value: 0.052 },
    ],
    timings_s: { total: 9.8 }, warnings: [], ...over,
  };
}

export const SAMPLE_FILE_IDS = { "before.png": "fil_before1", "after.png": "fil_after1", "dnbr.png": "fil_dnbr1" };

export function sampleDraft(requestId: string, over: Partial<ReportDraft> = {}): ReportDraft {
  return {
    request_id: requestId, title: "Burn check near Altadena, CA",
    answer: "Yes. Sentinel-2 imagery from 1 February 2025 shows a clear burn scar across about 1.1 km² of the area. The mean dNBR of 0.174 indicates low-severity burning on average, with stronger burns in the northern cells.",
    confidence: "medium",
    measurements: [{ metric: "dNBR (mean)", value: 0.174, unit: null, before: null, after: 0.174, note: "Key & Benson classes" }],
    images: [
      { role: "before", url: "fil_before1", caption: "Before, 2 Jan 2025", date: "2025-01-02", source: "Sentinel-2 L2A (Copernicus)" },
      { role: "after", url: "fil_after1", caption: "After, 1 Feb 2025", date: "2025-02-01", source: "Sentinel-2 L2A (Copernicus)" },
      { role: "index", url: "dnbr.png", caption: "dNBR", date: "2025-02-01", source: "Terragent analysis of Sentinel-2" },
    ],
    sources: [{ name: "Sentinel-2 L2A", collection: AFTER.collection, item_id: AFTER.item_id, datetime: AFTER.datetime, url: null, license: "Copernicus Sentinel data licence" }],
    limitations: "10 m pixels miss single structures; dNBR thresholds vary by vegetation; one clear scene per date.",
    human_review_recommended: false, paid_data_estimate: null, ...over,
  };
}

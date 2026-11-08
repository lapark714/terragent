/**
 * Earth index (spec §3.4): DERIVED results only, keyed by H3 cell, date, metric and source.
 * Written from the pipeline's h3_metrics; read by the planner before fetching anything.
 */
import { gridDisk } from "h3-js";
import type { AnalysisResult, EarthIndexHit, Layer, Polygon, Recipe } from "../domain";
import { pointCell, polygonCells } from "../geo/h3";
import { json, query } from "./db";

/**
 * |delta| at or above which a cell is flagged as changed, per recipe. dNBR 0.27 = moderate-low burn severity
 * (Key & Benson 2006, docs/platform/imagery.md §3.10); 0.2 is the conventional NDVI / water-index change cut.
 */
export const CHANGE_THRESHOLDS: Record<Recipe, number | null> = {
  true_color: null,
  vegetation_health: 0.2,
  flood_extent: 0.2,
  burn_severity: 0.27,
  forest_loss: 0.2,
  mining_indicators: 0.15,
  change_detection: 0.2,
};

/** Delta metrics: "ndvi_delta", "delta_mndwi", "dnbr", "dnbr_mean", "dndvi". */
export function isChangeMetric(metric: string): boolean {
  return /delta/i.test(metric) || /^d(nbr|ndvi|ndwi|mndwi)(_|$)/i.test(metric);
}

export function changeFlag(recipe: Recipe, metric: string, value: number): boolean {
  const t = CHANGE_THRESHOLDS[recipe];
  return t !== null && isChangeMetric(metric) && Math.abs(value) >= t;
}

export const sceneSource = (s: { collection: string; item_id: string }) => `${s.collection}:${s.item_id}`;

/** Replace this request's rows for the after scene with the analysis' per-cell metrics. */
export async function indexAnalysis(a: { requestId: string; layer: Layer; result: AnalysisResult }) {
  const { result } = a;
  if (!result.after) return { written: 0, changed: 0, warnings: ["No after scene, so nothing was written to the Earth index."] };
  if (!result.h3_metrics.length) return { written: 0, changed: 0, warnings: ["The analysis has no h3_metrics to index."] };

  const source = sceneSource(result.after);
  const observedAt = result.after.datetime.slice(0, 10);
  const unitFor = (metric: string) => result.indices.find((i) => metric.toLowerCase().startsWith(i.name.toLowerCase()))?.unit ?? null;
  const rows = result.h3_metrics.map((m) => ({ ...m, unit: unitFor(m.metric), flag: changeFlag(result.recipe, m.metric, m.value) }));

  await query("DELETE FROM earth_index WHERE request_id = $1 AND source = $2", [a.requestId, source]);
  await query(
    `INSERT INTO earth_index (h3_cell, h3_res, layer, metric, value, unit, observed_at, source, change_flag, request_id, meta)
     SELECT c, r, $7, m, v, u, $8::date, $9, f, $10, $11::jsonb
     FROM unnest($1::text[], $2::smallint[], $3::text[], $4::float8[], $5::text[], $6::bool[]) AS t(c, r, m, v, u, f)`,
    [
      rows.map((r) => r.h3_cell), rows.map((r) => r.h3_res), rows.map((r) => r.metric), rows.map((r) => r.value),
      rows.map((r) => r.unit), rows.map((r) => r.flag), a.layer, observedAt, source, a.requestId,
      json({ recipe: result.recipe, before: result.before ? sceneSource(result.before) : null }),
    ],
  );
  return { written: rows.length, changed: rows.filter((r) => r.flag).length, warnings: [] as string[] };
}

export async function attachReportToIndex(requestId: string, reportId: string) {
  await query("UPDATE earth_index SET report_id = $2 WHERE request_id = $1", [requestId, reportId]);
}

const MAX_CELLS = 2000;

/** Query cells for a point (cell + neighbours at res 7–9) or an AOI (res 7–8), unless `res` pins one resolution. */
export function lookupCells(q: { cells?: string[]; lat?: number; lon?: number; aoi?: Polygon; res?: number }): string[] {
  if (q.cells?.length) return q.cells.slice(0, MAX_CELLS);
  const resolutions = q.res ? [q.res] : q.aoi ? [7, 8] : [7, 8, 9];
  const out = new Set<string>();
  for (const res of resolutions) {
    if (q.aoi) polygonCells(q.aoi, res).forEach((c) => out.add(c));
    else if (q.lat !== undefined && q.lon !== undefined) gridDisk(pointCell(q.lat, q.lon, res), 1).forEach((c) => out.add(c));
  }
  return [...out].slice(0, MAX_CELLS);
}

interface IndexRow { h3_cell: string; metric: string; value: number; observed_at: string | Date; source: string; report_id: string | null; change_flag: boolean; layer: string }

export async function lookupEarthIndex(q: {
  cells?: string[]; lat?: number; lon?: number; aoi?: Polygon; res?: number; metric?: string; maxAgeDays?: number; limit?: number;
}) {
  const cells = lookupCells(q);
  if (!cells.length) throw new Error("Give lat/lon, an aoi or cells.");
  const rows = await query<IndexRow>(
    `SELECT h3_cell, metric, value, observed_at, source, report_id, change_flag, layer FROM earth_index
     WHERE h3_cell = ANY($1) AND ($2::text IS NULL OR metric = $2)
       AND ($3::int IS NULL OR observed_at >= (now() - make_interval(days => $3))::date)
     ORDER BY observed_at DESC, created_at DESC LIMIT $4`,
    [cells, q.metric ?? null, q.maxAgeDays ?? null, Math.min(q.limit ?? 100, 500)],
  );
  const hits: (EarthIndexHit & { change_flag: boolean; layer: string })[] = rows.map((r) => ({
    h3_cell: r.h3_cell, metric: r.metric, value: Number(r.value), observed_at: dateOnly(r.observed_at), source: r.source,
    report_id: r.report_id, change_flag: r.change_flag, layer: r.layer,
  }));
  const byMetric = new Map<string, { metric: string; n: number; sum: number; latest_observed_at: string; changed_cells: number }>();
  for (const h of hits) {
    const s = byMetric.get(h.metric) ?? { metric: h.metric, n: 0, sum: 0, latest_observed_at: h.observed_at, changed_cells: 0 };
    s.n += 1;
    s.sum += h.value;
    if (h.change_flag) s.changed_cells += 1;
    byMetric.set(h.metric, s);
  }
  const summary = [...byMetric.values()].map(({ sum, ...s }) => ({ ...s, mean: Math.round((sum / s.n) * 10000) / 10000 }));
  return { cells_queried: cells.length, hits, summary };
}

const dateOnly = (d: string | Date) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);

/** Brain 1 (Planner) output: validate the DataSpec, cover the AOI with H3 cells and store it on the request. */
import { CAPS } from "../config";
import { DataSpec } from "../domain";
import { logEvent } from "../events";
import { bboxAreaKm2, polygonBbox, polygonCells } from "../geo/h3";
import { json, query, round2 } from "./db";
import { isTerminal, requireRequest } from "./requests";

export const MAX_AOI_KM2 = 10 * CAPS.maxFreeAoiKm2;
/** Enough for the free-analysis AOI limit at h3_res 10 (~0.015 km² cells). */
export const MAX_CELLS = 10_000;

export async function saveDataSpec(input: DataSpec, actor: string) {
  const spec = DataSpec.parse(input);
  const req = await requireRequest(spec.request_id);
  if (isTerminal(req)) throw new Error(`Request ${req.id} is ${req.status}.`);
  const ring = spec.aoi.coordinates[0];
  if (!ring || ring.length < 4) throw new Error("aoi must be a closed polygon ring with at least 4 positions.");

  const bbox = polygonBbox(spec.aoi);
  const area = round2(bboxAreaKm2(bbox));
  if (area <= 0) throw new Error("aoi has zero area.");
  // Hard ceilings: the H3 cover is stored on the request row, so a region-sized AOI must never get that far.
  if (area > MAX_AOI_KM2) throw new Error(`AOI is ${area} km²; the limit is ${MAX_AOI_KM2} km². Shrink it to the site the question is about.`);
  const cells = polygonCells(spec.aoi, spec.h3_res);
  if (cells.length > MAX_CELLS) {
    throw new Error(`AOI needs ${cells.length} H3 cells at h3_res ${spec.h3_res} (limit ${MAX_CELLS}); use a coarser h3_res or a smaller AOI.`);
  }
  const stored: DataSpec = { ...spec, area_km2: area };

  await query(
    `UPDATE requests SET data_spec = $2, aoi = $3, h3_cells = $4, lat = COALESCE(lat, $5), lon = COALESCE(lon, $6),
       location_text = COALESCE(location_text, $7), updated_at = now() WHERE id = $1`,
    [req.id, json(stored), json(spec.aoi), cells, spec.location.lat, spec.location.lon, spec.location.text],
  );
  await logEvent("data_spec.saved", actor, { recipe: spec.recipe, data_type: spec.data_type, area_km2: area, cells: cells.length, reuse_existing: spec.reuse_existing }, req.id);

  const warnings: string[] = [];
  if (Math.abs(area - spec.area_km2) / area > 0.25) warnings.push(`area_km2 recomputed from the AOI: ${area} (you sent ${spec.area_km2}).`);
  if (area > CAPS.maxFreeAoiKm2) warnings.push(`AOI is ${area} km², above the ${CAPS.maxFreeAoiKm2} km² free-analysis limit; shrink it or justify paid/large processing.`);
  return { saved: true, area_km2: area, bbox, h3_cells: cells.length, warnings };
}

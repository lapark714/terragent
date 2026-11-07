/** OWNER: imagery builder. Free scene search on Microsoft Planetary Computer (TypeScript, no Python). */
import type { BBox, DateRange, SceneRef } from "../domain";

export interface FreeSceneQuery {
  bbox: BBox;
  before: DateRange | null;
  after: DateRange;
  maxCloudPct: number;
  collection?: "sentinel-2-l2a" | "landsat-c2-l2";
}

export interface FreeSceneResult {
  provider_id: string; // registry id, e.g. "pc-sentinel-2-l2a"
  collection: string;
  before: SceneRef | null;
  after: SceneRef | null;
  candidates: { before: SceneRef[]; after: SceneRef[] };
  notes: string[];
}

/** Best clear before/after scenes for an AOI. Never throws for "no scenes" — returns nulls + notes. */
export async function searchFreeScenes(q: FreeSceneQuery): Promise<FreeSceneResult> { throw new Error("not implemented yet"); }

/** Planetary Computer data API (TiTiler) PNG preview URL for a scene cropped to bbox. */
export function previewUrl(scene: SceneRef, bbox: BBox, kind: "true_color" | "ndvi"): string { throw new Error("not implemented yet"); }

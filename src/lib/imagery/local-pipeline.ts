/** OWNER: imagery builder. Run the Python pipeline locally (tests, simulator, local dev). Not used on Vercel. */
import type { AnalysisResult } from "../domain";

export interface PipelineJob {
  request_id: string; recipe: string; bbox: [number, number, number, number];
  before_window: { start: string; end: string } | null; after_window: { start: string; end: string };
  before_scene: unknown | null; after_scene: unknown | null; max_cloud_pct: number; h3_res: number; collection?: string;
}

/** Spawns pipeline/.venv python (see docs/ARCHITECTURE.md §10). Image paths in the result are relative to outDir. */
export async function runPipelineLocally(job: PipelineJob, outDir: string): Promise<AnalysisResult> { throw new Error("not implemented yet"); }

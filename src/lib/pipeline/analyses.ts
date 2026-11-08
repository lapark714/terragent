/** Analytics: the pipeline job description (ARCHITECTURE §10), saved AnalysisResults and their Earth index writes. */
import { customAlphabet } from "nanoid";
import { H3_DEFAULT_RES } from "../config";
import { type AcquisitionPlan, AnalysisResult, type DataSpec, type Playbook, playbookLayer, PLAYBOOKS } from "../domain";
import { logEvent } from "../events";
import { polygonBbox } from "../geo/h3";
import type { PipelineJob } from "../imagery/local-pipeline";
import { getSetting, SETTING } from "../settings";
import { json, query, queryOne } from "./db";
import { indexAnalysis } from "./earth-index";
import { assertPriceCleared } from "./gates";
import { isTerminal, requireRequest, type RequestRow } from "./requests";

// ids.ts has no analysis prefix yet; same alphabet as newId().
const analysisId = () => `ana_${customAlphabet("23456789abcdefghjkmnpqrstuvwxyz", 10)()}`;

export interface AnalysisRow { id: string; request_id: string; recipe: string; result: AnalysisResult; file_ids: Record<string, string>; created_by: string; created_at: string }

const COLLECTION_BY_PROVIDER: Record<string, string> = { "pc-sentinel-2-l2a": "sentinel-2-l2a", "pc-landsat-c2-l2": "landsat-c2-l2" };

export function buildJob(req: Pick<RequestRow, "id" | "data_spec" | "acquisition_plan">): PipelineJob & { collection: string } {
  const spec = req.data_spec as DataSpec | null;
  if (!spec) throw new Error("No data spec yet; the planner must save_data_spec first.");
  const free = (req.acquisition_plan as AcquisitionPlan | null)?.free_option ?? null;
  return {
    request_id: req.id, recipe: spec.recipe, bbox: polygonBbox(spec.aoi), before_window: spec.before, after_window: spec.after,
    before_scene: free?.before_scene ?? null, after_scene: free?.after_scene ?? null, max_cloud_pct: spec.max_cloud_pct,
    h3_res: spec.h3_res ?? H3_DEFAULT_RES, collection: COLLECTION_BY_PROVIDER[free?.provider_id ?? ""] ?? "sentinel-2-l2a",
  };
}

export async function getAnalysisJob(requestId: string) {
  const req = await requireRequest(requestId);
  if (isTerminal(req)) throw new Error(`Request ${req.id} is ${req.status}.`);
  const plan = req.acquisition_plan as AcquisitionPlan | null;
  if (plan?.choice === "existing_index") throw new Error("The plan reuses the Earth index; no pipeline run is needed. Hand off to interpreter.");
  await assertPriceCleared(req);
  const job = buildJob(req);
  const bundle = await getSetting<{ file_id?: string; sha256?: string } | null>(SETTING.pipelineBundle, null);
  const out = `~/out/${req.id}`;
  return {
    job,
    bundle_file_id: bundle?.file_id ?? null,
    steps: [
      "fetch_file file_ids [bundle_file_id] dir \"bundle\", then: cp <returned path> ~/bundle.tgz",
      "mkdir -p ~/tg && tar -xzf ~/bundle.tgz -C ~/tg && bash ~/tg/pipeline/bootstrap.sh   # idempotent; prints \"ready\"",
      "write the `job` object above as JSON to ~/job.json",
      `~/tg/pipeline/.venv/bin/python -m terragent_pipeline.run --job ~/job.json --out ${out}`,
      `stdout (and ${out}/result.json) is the AnalysisResult; image paths are relative to ${out}`,
      `publish_file each image (${out}/<path>), then save_analysis with result and file_ids { "<path>": "fil_…" }`,
    ],
    warnings: bundle?.file_id ? [] : ["Pipeline bundle not uploaded yet (setting pipeline.bundle is empty); a founder must run the bundle upload."],
  };
}

export async function saveAnalysis(a: { requestId: string; result: AnalysisResult; fileIds: Record<string, string> }, actor: string) {
  const result = AnalysisResult.parse(a.result);
  const req = await requireRequest(a.requestId);
  if (isTerminal(req)) throw new Error(`Request ${req.id} is ${req.status}.`);
  const missing = result.images.filter((img) => !a.fileIds[img.path]).map((img) => img.path);

  const id = analysisId();
  await query("INSERT INTO analyses (id, request_id, recipe, result, file_ids, created_by) VALUES ($1,$2,$3,$4,$5,$6)", [
    id, req.id, result.recipe, json(result), json(a.fileIds), actor,
  ]);
  const layer = playbookLayer[(PLAYBOOKS as readonly string[]).includes(req.playbook) ? (req.playbook as Playbook) : "inbound"];
  const indexed = await indexAnalysis({ requestId: req.id, layer, result });
  await logEvent("analysis.saved", actor, { analysis_id: id, recipe: result.recipe, images: result.images.length, indexed: indexed.written, changed: indexed.changed }, req.id);
  return {
    analysis_id: id, earth_index: { written: indexed.written, changed_cells: indexed.changed },
    warnings: [...result.warnings, ...indexed.warnings, ...missing.map((p) => `image ${p} has no published file id`)],
    next: { to: "interpreter", stage: "report" },
  };
}

export async function latestAnalysis(requestId: string): Promise<AnalysisRow | null> {
  return queryOne<AnalysisRow>("SELECT * FROM analyses WHERE request_id = $1 ORDER BY created_at DESC LIMIT 1", [requestId]);
}

/** Latest AnalysisResult with each image's published file id (use it as the report image url). */
export async function getAnalysisView(requestId: string) {
  await requireRequest(requestId);
  const row = await latestAnalysis(requestId);
  if (!row) throw new Error(`No analysis saved for ${requestId} yet.`);
  const images = row.result.images.map((img) => ({ ...img, file_id: row.file_ids[img.path] ?? null }));
  return { analysis_id: row.id, created_at: row.created_at, result: { ...row.result, images } };
}

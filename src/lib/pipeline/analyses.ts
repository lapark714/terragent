/** Analytics: the pipeline job description (ARCHITECTURE §10), saved AnalysisResults and their Earth index writes. */
import { customAlphabet } from "nanoid";
import { H3_DEFAULT_RES } from "../config";
import { type AcquisitionPlan, AnalysisResult, type DataSpec, type Playbook, playbookLayer, PLAYBOOKS, type Polygon, Recipe } from "../domain";
import { logEvent } from "../events";
import { polygonBbox } from "../geo/h3";
import type { PipelineJob } from "../imagery/local-pipeline";
import { getSetting, SETTING } from "../settings";
import { json, query, queryOne } from "./db";
import { indexAnalysis, isChangeMetric } from "./earth-index";
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

/** The computer is shared by every session of the Analytics agent: each run gets its own job file and out dir. */
const jobKey = (requestId: string, monitorId?: string) => (monitorId ? `${requestId}-${monitorId}` : requestId);
/**
 * One pipeline (and one bootstrap) at a time on the 1 vCPU / 1 GiB computer; the others wait for the lock. The wait
 * gives up before the agent's 600 s bash timeout, so a stuck lock surfaces as a "flock: timeout" error, not a hang.
 */
const LOCK = "flock -w 480 ~/tg.lock";

function pipelineSteps(key: string) {
  const out = `~/out/${key}`;
  const jobPath = `~/jobs/${key}.json`;
  return {
    out,
    job_path: jobPath,
    steps: [
      "fetch_file file_ids [bundle_file_id] dir \"bundle\" (skip it when ~/tg/pipeline/.venv exists and the next command prints \"ready\")",
      `${LOCK} bash -c 'cp <returned path> ~/bundle.tgz && mkdir -p ~/tg && tar -xzf ~/bundle.tgz -C ~/tg && bash ~/tg/pipeline/bootstrap.sh'   # idempotent; prints "ready" (without a fetched path: ${LOCK} bash ~/tg/pipeline/bootstrap.sh)`,
      `write the \`job\` object above as JSON to ${jobPath} (this run's own file: other sessions share this computer; mkdir -p ~/jobs first)`,
      `${LOCK} ~/tg/pipeline/.venv/bin/python -m terragent_pipeline.run --job ${jobPath} --out ${out}`,
      `stdout (and ${out}/result.json) is the AnalysisResult; image paths are relative to ${out}`,
    ],
  };
}

async function bundleInfo() {
  const bundle = await getSetting<{ file_id?: string; sha256?: string } | null>(SETTING.pipelineBundle, null);
  return {
    bundle_file_id: bundle?.file_id ?? null,
    warnings: bundle?.file_id ? [] : ["Pipeline bundle not uploaded yet (setting pipeline.bundle is empty); a founder must run the bundle upload."],
  };
}

/**
 * The pipeline job for a request (ARCHITECTURE §10). With `monitorId` it is a monitoring re-check instead: the watched
 * request has usually been delivered already, so the finished-request and price checks don't apply (see monitorJob).
 */
export async function getAnalysisJob(requestId: string, opts: { monitorId?: string; now?: Date } = {}) {
  const req = await requireRequest(requestId);
  if (opts.monitorId) return monitorJob(req, opts.monitorId, opts.now ?? new Date());
  if (isTerminal(req)) throw new Error(`Request ${req.id} is ${req.status}.`);
  const plan = req.acquisition_plan as AcquisitionPlan | null;
  if (plan?.choice === "existing_index") throw new Error("The plan reuses the Earth index; no pipeline run is needed. Hand off to interpreter.");
  await assertPriceCleared(req);
  const job = buildJob(req);
  const { bundle_file_id, warnings } = await bundleInfo();
  const run = pipelineSteps(jobKey(req.id));
  return {
    job,
    bundle_file_id,
    job_path: run.job_path,
    steps: [...run.steps, `publish_file each image (${run.out}/<path>), then save_analysis with result and file_ids { "<path>": "fil_…" }`],
    warnings,
  };
}

interface MonitorJobRow { id: string; request_id: string; aoi: Polygon | null; recipe: string; metric: string; status: string; last_scene_date: string | null }

/** How far back a re-check looks at most: the pipeline takes the newest clear scene in the window anyway. */
export const MONITOR_LOOKBACK_DAYS = 60;
/** The window when the monitor has never seen a scene. */
export const MONITOR_DEFAULT_WINDOW_DAYS = 14;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number) => isoDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000));

/** After window of a re-check: the day after the monitor's last scene up to today (at most MONITOR_LOOKBACK_DAYS back). */
export function monitorAfterWindow(lastSceneDate: string | null, now: Date): { start: string; end: string } {
  const end = isoDay(now);
  const floor = addDays(end, -MONITOR_LOOKBACK_DAYS);
  let start = lastSceneDate ? addDays(lastSceneDate.slice(0, 10), 1) : addDays(end, -MONITOR_DEFAULT_WINDOW_DAYS);
  if (start < floor) start = floor;
  if (start > end) start = end;
  return { start, end };
}

/**
 * A monitoring re-check (DoD 5): the watched request's job with the before side kept (the baseline) and the after side
 * re-opened — after_window from the monitor's last scene to today and no pinned after_scene, so the pipeline searches
 * for the newest clear scene. Nothing is saved on the request: the value goes to record_monitor_check.
 */
async function monitorJob(req: RequestRow, monitorId: string, now: Date) {
  const m = await queryOne<MonitorJobRow>(
    "SELECT id, request_id, aoi, recipe, metric, status, last_scene_date::text AS last_scene_date FROM monitors WHERE id = $1",
    [monitorId],
  );
  if (!m) throw new Error(`Unknown monitor ${monitorId}.`);
  if (m.request_id !== req.id && req.monitor_id !== m.id) throw new Error(`Monitor ${m.id} watches ${m.request_id}, not ${req.id}.`);
  if (m.status !== "active") throw new Error(`Monitor ${m.id} is ${m.status}; nothing to re-check.`);
  const watched = m.request_id === req.id ? req : await requireRequest(m.request_id);
  const base = buildJob(watched);
  const recipe = Recipe.safeParse(m.recipe).data ?? base.recipe;
  const job = {
    ...base, recipe, bbox: m.aoi ? polygonBbox(m.aoi) : base.bbox,
    after_window: monitorAfterWindow(m.last_scene_date, now), after_scene: null,
  };
  const { bundle_file_id, warnings } = await bundleInfo();
  const run = pipelineSteps(jobKey(watched.id, m.id));
  const field = isChangeMetric(m.metric) ? "delta" : "after_mean";
  return {
    mode: "monitor" as const,
    monitor_id: m.id,
    job,
    bundle_file_id,
    job_path: run.job_path,
    steps: [
      ...run.steps,
      `Do NOT save_analysis: a re-check is recorded on the monitor only. terragent.record_monitor_check { monitor_id: "${m.id}", value: the ${field} of the ` +
        `index named at the start of "${m.metric}", scene_date: result.after.datetime (YYYY-MM-DD), scene_id: "<after.collection>:<after.item_id>" }; ` +
        "if result.after is null (no clear scene), value null and scene_date null.",
    ],
    measure: { metric: m.metric, field, last_scene_date: m.last_scene_date },
    warnings,
  };
}

/** Degrees: the pipeline echoes the job's bbox, so anything beyond float noise means the result is another job's. */
const BBOX_TOLERANCE_DEG = 1e-3;

export async function saveAnalysis(a: { requestId: string; result: AnalysisResult; fileIds: Record<string, string> }, actor: string) {
  const result = AnalysisResult.parse(a.result);
  const req = await requireRequest(a.requestId);
  if (isTerminal(req)) throw new Error(`Request ${req.id} is ${req.status}.`);
  assertResultMatchesJob(req, result);
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

/**
 * Analytics sessions share one computer, so a result read from the wrong file could belong to another request's job.
 * The pipeline echoes the job's bbox and recipe, so a result that doesn't match this request's job is refused.
 */
function assertResultMatchesJob(req: RequestRow, result: AnalysisResult) {
  const job = buildJob(req);
  const off = result.bbox.some((v, i) => Math.abs(v - job.bbox[i]) > BBOX_TOLERANCE_DEG);
  if (off || result.recipe !== job.recipe) {
    throw new Error(
      `This result (${result.recipe}, bbox [${result.bbox.join(", ")}]) is not ${req.id}'s job (${job.recipe}, bbox [${job.bbox.join(", ")}]): ` +
        `it probably came from another session's run on the shared computer. Re-run with ~/jobs/${req.id}.json and save that result.`,
    );
  }
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

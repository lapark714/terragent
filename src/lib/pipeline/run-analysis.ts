/**
 * terragent.run_analysis: the Analytics agent's whole pipeline stage in one server-side call. The Naïve flag on our
 * agents refuses bash, so the backend runs the Python pipeline on its own Naïve computer (src/lib/naive/compute.ts),
 * uploads the images and saves the result. Monitor mode records the re-check on the monitor instead.
 */
import type { AnalysisResult } from "../domain";
import { runPipelineOnNaive, type NaiveRunResult } from "../naive/compute";
import { recordMonitorCheck } from "../outbound/monitors";
import { getAnalysisJob, saveAnalysis } from "./analyses";
import { isChangeMetric, sceneSource } from "./earth-index";

type Runner = (job: Record<string, unknown>, key: string) => Promise<NaiveRunResult>;

/** A monitor's reading from a pipeline result: the index named at the start of the metric (longest name wins). */
export function monitorReading(result: AnalysisResult, metric: string) {
  const m = metric.toLowerCase();
  const index = result.indices
    .filter((i) => m.startsWith(i.name.toLowerCase()))
    .sort((a, b) => b.name.length - a.name.length)[0];
  const after = result.after;
  const raw = (isChangeMetric(metric) ? index?.delta : index?.after_mean) ?? null;
  return {
    index: index?.name ?? null,
    value: after ? raw : null,
    scene_date: after ? after.datetime.slice(0, 10) : null,
    scene_id: after ? sceneSource(after) : undefined,
  };
}

const summary = (r: AnalysisResult) => ({
  recipe: r.recipe,
  before_date: r.before?.datetime.slice(0, 10) ?? null,
  after_date: r.after?.datetime.slice(0, 10) ?? null,
  indices: r.indices.map((i) => ({ name: i.name, before_mean: i.before_mean, after_mean: i.after_mean, delta: i.delta, affected_area_km2: i.affected_area_km2 })),
  images: r.images.length,
  warnings: r.warnings,
});

export async function runAnalysis(
  a: { requestId: string; monitorId?: string },
  actor: string,
  run: Runner = runPipelineOnNaive,
) {
  if (!a.monitorId) {
    const job = await getAnalysisJob(a.requestId);
    const out = await run(job.job as Record<string, unknown>, a.requestId);
    const saved = await saveAnalysis({ requestId: a.requestId, result: out.result, fileIds: out.fileIds }, actor);
    return {
      mode: "request" as const,
      saved,
      result: summary(out.result),
      timings_s: out.timings,
      next: "terragent.handoff to interpreter (stage report), naming any warnings above.",
    };
  }

  const job = await getAnalysisJob(a.requestId, { monitorId: a.monitorId });
  const metric = "measure" in job ? job.measure.metric : "";
  let out: NaiveRunResult;
  try {
    out = await run(job.job as Record<string, unknown>, `${a.requestId}-${a.monitorId}`);
  } catch (e) {
    const note = `pipeline error: ${(e as Error).message}`.slice(0, 1000);
    const check = await recordMonitorCheck({ monitorId: a.monitorId, value: null, sceneDate: null, note, actor });
    return { mode: "monitor" as const, monitor_id: a.monitorId, error: note, check };
  }
  const reading = monitorReading(out.result, metric);
  const note = out.result.warnings.length ? out.result.warnings.join("; ").slice(0, 1000) : undefined;
  const check = await recordMonitorCheck({
    monitorId: a.monitorId, value: reading.value, sceneDate: reading.scene_date, sceneId: reading.scene_id, note, actor,
  });
  return { mode: "monitor" as const, monitor_id: a.monitorId, metric, reading, result: summary(out.result), check, timings_s: out.timings };
}

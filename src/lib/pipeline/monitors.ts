/** Monitoring subscriptions: re-check a delivered site on a schedule (the Analytics cron runs list_due_monitors). */
import { PRICING } from "../config";
import type { DataSpec, Recipe } from "../domain";
import { env } from "../env";
import { logDecision } from "../events";
import { newId } from "../ids";
import { json, query, queryOne } from "./db";
import { latestAnalysis } from "./analyses";
import { CHANGE_THRESHOLDS, isChangeMetric } from "./earth-index";
import { requireRequest } from "./requests";

/**
 * Every 12 hours (UTC) unless MONITOR_DEFAULT_CADENCE says otherwise. A re-check with no new clear scene costs one scene
 * search, and the analytics-monitors cron fires every 6 h, so a monitor created during the event is re-checked the same
 * day (a weekly default would first come due after judging). Sentinel-2 revisits every few days.
 */
export const DEFAULT_MONITOR_CADENCE = "0 */12 * * *";
const CRON = /^(\S+\s+){4}\S+$/;

export function defaultMonitorCadence(): string {
  const v = env("MONITOR_DEFAULT_CADENCE")?.trim();
  return v && CRON.test(v) ? v : DEFAULT_MONITOR_CADENCE;
}

export async function createMonitor(a: { requestId: string; metric: string; threshold?: number | null; cadence?: string; recipe?: Recipe }, actor: string) {
  const req = await requireRequest(a.requestId);
  const spec = req.data_spec as DataSpec | null;
  if (!spec || req.lat === null || req.lon === null) throw new Error("The request needs a saved data spec with a location before it can be monitored.");
  const cadence = a.cadence ?? defaultMonitorCadence();
  if (!CRON.test(cadence.trim())) throw new Error(`cadence must be a 5-field cron expression, got "${cadence}".`);
  const recipe = a.recipe ?? spec.recipe;
  const threshold = a.threshold ?? CHANGE_THRESHOLDS[recipe];

  // A retry (or a second ask) updates the request's active monitor instead of watching the site twice.
  const existing = req.monitor_id
    ? await queryOne<{ id: string }>("SELECT id FROM monitors WHERE id = $1 AND status = 'active' AND metric = $2 AND recipe = $3", [req.monitor_id, a.metric, recipe])
    : null;
  if (existing) {
    await query("UPDATE monitors SET threshold = $2, cadence = $3 WHERE id = $1", [existing.id, threshold, cadence.trim()]);
    return { monitor_id: existing.id, recipe, metric: a.metric, threshold, cadence: cadence.trim(), price_per_month_usd: PRICING.monitoringPerSiteMonthlyUsd, updated: true };
  }

  const analysis = await latestAnalysis(req.id);
  const index = analysis?.result.indices.find((i) => a.metric.toLowerCase().startsWith(i.name.toLowerCase()));
  const lastValue = (isChangeMetric(a.metric) ? index?.delta : index?.after_mean) ?? null;
  const lastScene = analysis?.result.after?.datetime.slice(0, 10) ?? null;

  // last_checked_at stays NULL: the delivered analysis is the baseline, not a re-check, so the first cron run after the
  // cadence's next tick re-checks it (list_due_monitors counts from created_at until then).
  const id = newId("monitor");
  await query(
    `INSERT INTO monitors (id, request_id, lat, lon, aoi, recipe, metric, threshold, cadence, last_value, last_scene_date, last_checked_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NULL)`,
    [id, req.id, req.lat, req.lon, json(spec.aoi), recipe, a.metric, threshold, cadence.trim(), lastValue, lastScene],
  );
  await query("UPDATE requests SET monitor_id = $2, updated_at = now() WHERE id = $1", [req.id, id]);
  await logDecision({
    requestId: req.id, kind: "monitoring", agent: actor, choice: `monitor ${id}: ${recipe}/${a.metric} on "${cadence.trim()}"`,
    reasoning: `Re-check and follow up when |change| ≥ ${threshold ?? "any"}; baseline ${lastValue ?? "none"} from ${lastScene ?? "no scene"}.`,
  });
  return { monitor_id: id, recipe, metric: a.metric, threshold, cadence: cadence.trim(), price_per_month_usd: PRICING.monitoringPerSiteMonthlyUsd };
}

/** Verifier verdicts: pass releases the report for delivery; fail loops back to Brain 2 up to CAPS.maxReportRevisions. */
import { CAPS } from "../config";
import { type AnalysisResult, VERIFIER_CHECKS, Verdict } from "../domain";
import { logDecision, logEvent } from "../events";
import { latestAnalysis } from "./analyses";
import { errorMessage, json, query, queryOne } from "./db";
import { attachReportToIndex, isChangeMetric } from "./earth-index";
import { assertPriceCleared } from "./gates";
import { createMonitor } from "./monitors";
import { requireReport } from "./reports";
import { addNote, handoff, isTerminal, requireRequest, setStatus, type RequestRow } from "./requests";
import { checkReportRules } from "./rules";

export async function saveVerdict(input: Verdict, actor: string) {
  const v = Verdict.parse(input);
  const report = await requireReport(v.report_id);
  const req = await requireRequest(report.request_id);
  if (isTerminal(req)) throw new Error(`Request ${req.id} is ${req.status}.`);
  await assertPriceCleared(req); // pricing v2: no review work before the customer accepted an option
  if (report.verifier_status !== "pending") throw new Error(`Report ${report.id} was already graded (${report.verifier_status}).`);
  if (req.report_id && req.report_id !== report.id) throw new Error(`Report ${report.id} is not the latest draft (${req.report_id}).`);
  const missing = VERIFIER_CHECKS.filter((id) => !v.checks.some((c) => c.id === id));
  if (missing.length) throw new Error(`The verdict must cover every check; missing: ${missing.join(", ")}.`);
  if (!v.pass && !v.required_fixes.length) throw new Error("A failing verdict needs required_fixes for the Interpreter.");

  const rules = await checkReportRules(report.id);
  if (v.pass && rules.hard_failures.length) {
    throw new Error(`Can't pass: rule checks fail (${rules.hard_failures.join(", ")}). Fail it with required_fixes instead.`);
  }

  const failing = v.checks.filter((c) => !c.pass).map((c) => `${c.id}: ${c.note}`);
  const notes = `${v.pass ? "PASS" : "FAIL"} ${v.score}/100${v.required_fixes.length ? ` — fixes: ${v.required_fixes.join("; ")}` : ""}`;
  await query("UPDATE reports SET verifier_status = $2, verifier_score = $3, verifier_notes = $4, meta = meta || $5::jsonb, updated_at = now() WHERE id = $1", [
    report.id, v.pass ? "pass" : "fail", v.score, notes, json({ verdict: v, rule_score: rules.score }),
  ]);
  await logDecision({
    requestId: req.id, kind: "verification", agent: actor, choice: `${v.pass ? "pass" : "fail"} (${v.score}/100)`,
    reasoning: v.pass ? (failing.length ? `Passed with notes: ${failing.join(" | ")}` : "All checks passed.") : `Fixes: ${v.required_fixes.join(" | ")}`,
  });

  if (v.pass) {
    await attachReportToIndex(req.id, report.id);
    const monitorId = req.is_free_sample ? await monitorSample(req) : null;
    const next = req.is_free_sample
      ? { to: "comms-outreach" as const, stage: "outreach", instructions: `Verified free sample report ${report.id} is ready. Use get_outreach_context to make the first touch` }
      : { to: "comms-customer" as const, stage: "delivery", instructions: `Verified report ${report.id} is ready. Deliver it with deliver_report in the customer's thread` };
    return { saved: true, pass: true, ...(monitorId ? { monitor_id: monitorId } : {}), ...(await tryHandoff(req.id, actor, next)) };
  }

  const revisions = req.revisions + 1;
  await query("UPDATE requests SET revisions = $2, updated_at = now() WHERE id = $1", [req.id, revisions]);
  if (revisions > CAPS.maxReportRevisions) {
    await setStatus(req.id, "failed", actor, `Report failed verification ${revisions} times`);
    await logEvent("coordinator.attention", actor, { reason: "max_report_revisions", report_id: report.id, revisions }, req.id);
    await addNote(req.id, actor, `Coordinator: report failed verification ${revisions} times (cap ${CAPS.maxReportRevisions}); request marked failed.`);
    return { saved: true, pass: false, status: "failed", revisions };
  }
  return {
    saved: true, pass: false, revisions,
    ...(await tryHandoff(req.id, actor, {
      to: "interpreter", stage: "revision",
      instructions: `Report ${report.id} failed verification (revision ${revisions} of ${CAPS.maxReportRevisions}). Fix: ${v.required_fixes.join("; ")}. Save a new draft, then hand back to verifier`,
    })),
  };
}

/** The verdict is already saved, so a lane failure is reported (the agent can retry handoff) instead of thrown. */
async function tryHandoff(requestId: string, from: string, next: { to: "comms-customer" | "comms-outreach" | "interpreter"; stage: string; instructions: string }) {
  try {
    return { handed_off_to: next.to, ...(await handoff({ requestId, from, ...next })) };
  } catch (e) {
    return { handoff_error: errorMessage(e), next };
  }
}

/** Channels a monitor follow-up can reach (outbound/monitors.ts followupTarget): contact forms get one touch only. */
const FOLLOWUP_CHANNELS = ["email_warm", "email_direct"];

/** The metric a site monitor watches: an index that is itself a change (dNBR), else the first index with a before/after delta. */
export function monitorMetricFor(result: Pick<AnalysisResult, "indices"> | null | undefined): string | null {
  const indices = result?.indices ?? [];
  const change = indices.find((i) => isChangeMetric(i.name) && (i.delta ?? i.after_mean) !== null);
  if (change) return change.name;
  const delta = indices.find((i) => i.delta !== null);
  return delta ? `${delta.name}_delta` : null;
}

/**
 * A verified free sample for a prospect we can follow up by email gets a site monitor straight away, so a new clear
 * scene or a change becomes a follow-up with new information (spec §3.1/§8) without anyone asking. Best effort.
 */
async function monitorSample(req: RequestRow): Promise<string | null> {
  if (!req.prospect_id || req.monitor_id) return null;
  try {
    const p = await queryOne<{ channel: string | null }>("SELECT channel FROM prospects WHERE id = $1", [req.prospect_id]);
    if (!FOLLOWUP_CHANNELS.includes(p?.channel ?? "")) return null;
    const metric = monitorMetricFor((await latestAnalysis(req.id))?.result);
    if (!metric) return null;
    return (await createMonitor({ requestId: req.id, metric }, "system")).monitor_id;
  } catch (e) {
    await logEvent("monitor.auto_failed", "system", { error: errorMessage(e) }, req.id);
    return null;
  }
}

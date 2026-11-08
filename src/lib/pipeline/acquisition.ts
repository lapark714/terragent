/** Orchestrator output: the AcquisitionPlan. Free first; paid only with a written reason and logged decisions. */
import { AcquisitionPlan, type DecisionKind } from "../domain";
import { logEvent } from "../events";
import { json, query } from "./db";
import { isTerminal, requireRequest } from "./requests";

const REQUIRED_DECISIONS: DecisionKind[] = ["free_vs_paid", "source_selection"];
const MIN_PAID_JUSTIFICATION = 40;

export async function saveAcquisitionPlan(input: AcquisitionPlan, actor: string) {
  const plan = AcquisitionPlan.parse(input);
  const req = await requireRequest(plan.request_id);
  if (isTerminal(req)) throw new Error(`Request ${req.id} is ${req.status}.`);
  if (!req.data_spec) throw new Error("No data spec yet; the planner must save_data_spec first.");

  const logged = await query<{ kind: string }>(
    "SELECT DISTINCT kind FROM decisions WHERE request_id = $1 AND kind = ANY($2)",
    [req.id, REQUIRED_DECISIONS],
  );
  const missing = REQUIRED_DECISIONS.filter((k) => !logged.some((d) => d.kind === k));
  if (missing.length) {
    throw new Error(`Log your reasoning first: log_decision kind ${missing.join(" and ")} (choice, reasoning, alternatives with cost).`);
  }

  if (plan.choice === "paid") {
    if (req.is_free_sample) throw new Error("Free samples use free data only; put the paid estimate in the report instead.");
    if (plan.justification.trim().length < MIN_PAID_JUSTIFICATION) {
      throw new Error("choice=paid needs a written justification of why free data is not enough.");
    }
    if (plan.free_option?.sufficient) throw new Error("free_option.sufficient is true, so choose free (we never buy what free data answers).");
    if (!plan.paid_options.length) throw new Error("choice=paid needs at least one entry in paid_options.");
  }
  if (plan.choice === "free" && !plan.free_option) throw new Error("choice=free needs free_option (provider and scenes).");

  const warnings: string[] = [];
  const stored = { ...plan };
  if (plan.choice !== "paid" && plan.data_cost_usd > 0) {
    stored.data_cost_usd = 0;
    warnings.push("data_cost_usd set to 0: only a paid choice carries a data cost.");
  }

  await query("UPDATE requests SET acquisition_plan = $2, updated_at = now() WHERE id = $1", [req.id, json(stored)]);
  await logEvent("acquisition_plan.saved", actor, { choice: plan.choice, data_cost_usd: stored.data_cost_usd, paid_options: plan.paid_options.length }, req.id);

  const next = req.is_free_sample
    ? plan.choice === "existing_index" ? { to: "interpreter", stage: "report" } : { to: "analytics", stage: "analysis" }
    : { to: "pricing", stage: "pricing" };
  return { saved: true, choice: plan.choice, data_cost_usd: stored.data_cost_usd, warnings, next };
}

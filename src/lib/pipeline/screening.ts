/** Comms 2 misuse screen. Every screen is a `screening` decision; refusals end the request. */
import { ScreeningResult } from "../domain";
import { logDecision } from "../events";
import { isTerminal, mergeMeta, requireRequest, setStatus } from "./requests";
import { query } from "./db";

export async function recordScreening(requestId: string, input: ScreeningResult, actor: string) {
  const result = ScreeningResult.parse(input);
  const req = await requireRequest(requestId);
  if (isTerminal(req)) throw new Error(`Request ${requestId} is ${req.status}; screening is closed.`);
  if (result.allowed && result.category !== "ok") throw new Error("allowed=true requires category 'ok'.");

  const outcome = result.allowed ? "allowed" : result.category === "unclear_needs_clarification" ? "clarify" : "refused";
  await mergeMeta(requestId, { screening: { ...result, outcome, by: actor, at: new Date().toISOString() } });
  const decision_id = await logDecision({
    requestId, kind: "screening", agent: actor, choice: `${outcome}: ${result.category}`, reasoning: result.reason,
  });

  if (outcome === "refused") {
    await query("UPDATE requests SET refusal_reason = $2 WHERE id = $1", [requestId, result.reason]);
    await setStatus(requestId, "refused", actor, `Refused at screening (${result.category})`);
    return { outcome, decision_id, next: "Send the customer a short refusal with send_customer_message kind refusal. Do not hand off." };
  }
  if (outcome === "clarify") {
    await setStatus(requestId, "clarifying", actor, "Waiting on the customer");
    return { outcome, decision_id, next: "Ask one clarifying question with send_customer_message kind clarifying_question." };
  }
  return { outcome, decision_id, next: "Hand off to planner with stage planning." };
}

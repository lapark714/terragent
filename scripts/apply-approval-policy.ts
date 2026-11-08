/**
 * Run Terragent's approval policy on parked sessions now (normally the Naïve webhook does this).
 *   npx tsx scripts/apply-approval-policy.ts <ses_id>:<agent>[:<request_id>] [...]   (needs AUTO_APPROVE_GATEWAY_TOOLS=true)
 *
 * This CONFIRMS real parked calls on real Naïve sessions: a founder runs it by hand only (never an agent, cron or CI).
 * It confirms in the policy's order (confirmOrder: turn-ending and outbound calls such as terragent.handoff first, then
 * the saves, then terragent.log_decision, each with scope "call"), and prints `allowed` in that order. Naïve's allow
 * does not run a call; the model re-issues it (see src/lib/pipeline/approval-policy.ts).
 */
import "dotenv/config";
import { applyApprovalPolicy } from "../src/lib/pipeline/approval-policy";

for (const spec of process.argv.slice(2)) {
  const [sessionId, agent, requestId] = spec.split(":");
  const out = await applyApprovalPolicy(sessionId, agent ?? null, requestId ?? null);
  console.log(sessionId, "allowed:", out.allowed.join(", ") || "none", "| held:", out.held.join(", ") || "none");
}

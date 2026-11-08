/**
 * Run Terragent's approval policy on parked sessions now (normally the Naïve webhook does this).
 *   npx tsx scripts/apply-approval-policy.ts <ses_id>:<agent>[:<request_id>] [...]   (needs AUTO_APPROVE_GATEWAY_TOOLS=true)
 */
import "dotenv/config";
import { applyApprovalPolicy } from "../src/lib/pipeline/approval-policy";

for (const spec of process.argv.slice(2)) {
  const [sessionId, agent, requestId] = spec.split(":");
  const out = await applyApprovalPolicy(sessionId, agent ?? null, requestId ?? null);
  console.log(sessionId, "allowed:", out.allowed.join(", ") || "none", "| held:", out.held.join(", ") || "none");
}

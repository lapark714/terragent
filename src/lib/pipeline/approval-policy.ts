/**
 * Terragent's approval policy for parked Naïve tool calls.
 *
 * Why: Naïve parks every MCP call of a chat it judges to have "read people's data", even calls set to `allow`. Six
 * live probes (2026-11-08) could not isolate a trigger we control — real pipeline sessions are flagged, diagnostic ones
 * with the same tool outputs are not — so without a policy the whole unattended pipeline stalls on human approvals.
 *
 * What it allows (only when AUTO_APPROVE_GATEWAY_TOOLS=true, a founder decision):
 *   - calls to OUR gateway (`terragent.<tool>`), whose catalog permission is `allow`, made by an agent the catalog lists
 *     for that tool. Those tools can only touch our own records or email a request's own customer / an approved
 *     prospect through the code gates (suppression, caps, approved templates), so the flag's exfiltration risk is
 *     already contained server-side.
 * What it never allows: `place_paid_order` (permission `ask`: always a human), any Naïve built-in (email.send,
 * web_fetch, browser, data_run, …), any other MCP server, questions. Those stay parked for a founder.
 * Auto-allowed calls are logged as `approval.auto_allowed` events — they are not human interventions.
 */
import { AgentName } from "../domain";
import { envFlag } from "../env";
import { logEvent } from "../events";
import { TERRAGENT_MCP_SERVER, toolSpec } from "../mcp/catalog";
import { getNaive } from "../naive/client";

export interface PolicyOutcome { allowed: string[]; held: string[] }

export function policyAllows(agent: string | null | undefined, actionName: string, kind = "tool"): boolean {
  if (kind !== "tool") return false;
  const prefix = `${TERRAGENT_MCP_SERVER}.`;
  if (!actionName.startsWith(prefix)) return false;
  const spec = toolSpec(actionName.slice(prefix.length));
  const who = AgentName.safeParse(agent);
  return !!spec && spec.permission === "allow" && who.success && spec.agents.includes(who.data);
}

export async function applyApprovalPolicy(sessionId: string, agent: string | null, requestId: string | null): Promise<PolicyOutcome> {
  const out: PolicyOutcome = { allowed: [], held: [] };
  if (!envFlag("AUTO_APPROVE_GATEWAY_TOOLS")) return out;
  const client = await getNaive();
  const session = await client.sessions.get(sessionId);
  for (const a of session.pending_actions ?? []) {
    const name = String(a.name ?? "");
    if (!policyAllows(agent, name, a.kind ?? "tool")) {
      out.held.push(name);
      continue;
    }
    await client.sessions.confirmTool(sessionId, {
      tool_call_id: a.tool_call_id,
      decision: "allow",
      reason: `Terragent approval policy: own gateway tool, catalog-allowed for ${agent}.`,
    });
    out.allowed.push(name);
    await logEvent("approval.auto_allowed", "policy", { session_id: sessionId, agent, tool: name }, requestId);
  }
  return out;
}

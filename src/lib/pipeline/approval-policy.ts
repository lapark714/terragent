/**
 * Terragent's approval policy for parked Naïve tool calls.
 *
 * Why: Naïve parks every MCP call of a chat it judges to have "read people's data", even calls set to `allow`. Six
 * live probes (2026-11-08) could not isolate a trigger we control — real pipeline sessions are flagged, diagnostic ones
 * with the same tool outputs are not — so without a policy the whole unattended pipeline stalls on human approvals.
 *
 * What it allows (only when AUTO_APPROVE_GATEWAY_TOOLS=true, a founder decision — on since 2026-11-08):
 *   - calls to OUR gateway (`terragent.<tool>`), whose catalog permission is `allow`, made by an agent the catalog lists
 *     for that tool. Those tools can only touch our own records or email a request's own customer / an approved
 *     prospect through the code gates (suppression, caps, approved templates), so the flag's exfiltration risk is
 *     already contained server-side.
 *   - Naïve built-ins and other MCP servers ONLY when the agent's own Naïve config already sets that tool to `allow`
 *     (browser for contact forms, web_fetch, data_run, SkyWatch pricing, …) — see policyAllows.
 * What it never allows: `place_paid_order` (buying data needs a founder — spec §0), the NEVER list (email.send, wallet,
 * cards, payments, trading, social posting, phone, vault, …), questions. Those stay parked for a founder.
 * Auto-allowed calls are logged as `approval.auto_allowed` events — they are not human interventions.
 */
import { AgentName } from "../domain";
import { envFlag } from "../env";
import { logEvent } from "../events";
import { TERRAGENT_MCP_SERVER, toolSpec } from "../mcp/catalog";
import { getNaive } from "../naive/client";

export interface PolicyOutcome { allowed: string[]; held: string[] }

/** Never cleared by policy, whatever an agent's config says: money, identity, public posting, secrets, raw email. */
const NEVER = [/^email\.send$/, /^(wallet|card|trading|legal|company)\./, /^payments/, /^social\./, /^phone\./, /^vault\./, /^mobile$/,
  /^(list_as_template|pay_out_earnings|apps\.request_access|operator\.request)$/, new RegExp(`^${TERRAGENT_MCP_SERVER}\\.place_paid_order$`)];

/**
 * Laurence (2026-11-08): "nothing should require human approval" — except the spec's hard rule that buying data
 * needs a founder (and there is no payment method connected; a purchase is a manual founder step anyway).
 *   - terragent.* : the catalog must allow the tool for this agent;
 *   - anything else (Naïve built-ins like browser / web_fetch / data_run, or the SkyWatch MCP): the agent's own Naïve
 *     config must already set that tool to `allow` — the policy only re-applies decisions already made in config.
 */
export function policyAllows(agent: string | null | undefined, actionName: string, kind = "tool", configured?: Record<string, { permission?: string; enabled?: boolean }>): boolean {
  if (kind !== "tool") return false;
  if (NEVER.some((re) => re.test(actionName))) return false;
  const who = AgentName.safeParse(agent);
  if (!who.success) return false;
  const prefix = `${TERRAGENT_MCP_SERVER}.`;
  if (actionName.startsWith(prefix)) {
    const spec = toolSpec(actionName.slice(prefix.length));
    return !!spec && spec.permission === "allow" && spec.agents.includes(who.data);
  }
  const cfg = configured?.[actionName];
  return !!cfg && cfg.enabled !== false && cfg.permission === "allow";
}

export async function applyApprovalPolicy(sessionId: string, agent: string | null, requestId: string | null): Promise<PolicyOutcome> {
  const out: PolicyOutcome = { allowed: [], held: [] };
  if (!envFlag("AUTO_APPROVE_GATEWAY_TOOLS")) return out;
  const client = await getNaive();
  const session = await client.sessions.get(sessionId);
  const configured = ((await client.agents.get(session.agent_id)).tools?.configs ?? {}) as Record<string, { permission?: string; enabled?: boolean }>;
  for (const a of session.pending_actions ?? []) {
    const name = String(a.name ?? "");
    if (!policyAllows(agent, name, a.kind ?? "tool", configured)) {
      out.held.push(name);
      continue;
    }
    await client.sessions.confirmTool(sessionId, {
      tool_call_id: a.tool_call_id,
      decision: "allow",
      reason: `Terragent approval policy: allowed for ${agent} by the catalog or its own Naïve config.`,
    });
    out.allowed.push(name);
    await logEvent("approval.auto_allowed", "policy", { session_id: sessionId, agent, tool: name }, requestId);
  }
  return out;
}

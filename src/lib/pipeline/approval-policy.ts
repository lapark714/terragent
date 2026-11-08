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
 *     (browser for contact forms, web_fetch, data_run, SkyWatch pricing, …) — see policyAllows. A browser call also
 *     needs an action that its config's ask_actions doesn't reserve for a person — see browserActionCleared.
 * What it never allows: `place_paid_order` (buying data needs a founder — spec §0), the NEVER list (email.send, wallet,
 * cards, payments, trading, social posting, phone, vault, …), browser signup and login (humans create accounts),
 * questions. Those stay parked for a founder.
 * Auto-allowed calls are logged as `approval.auto_allowed` events — they are not human interventions.
 *
 * What confirmTool actually does (observed 2026-11-08, ses_nb14t9050y73z5j5mkbfyg7r6n, ses_2c8a0rtfaqkwr56ph9y6f0s0hn,
 * probe ses_fbp7vg8waqzwzqmagsndsv2rtt; docs/platform/naive-orchestration.md §3.6):
 *   - `allow` does NOT run the parked call. The model already got "terragent.X is waiting for approval" as its result.
 *   - On resume Naïve replays every confirmed call to the model as "APPROVED, issue X again byte for byte", in the
 *     order we confirmed them, and the model must re-issue each call itself.
 *   - The model usually re-issues the LAST-confirmed call first (9 of 11 production batches). When that was
 *     terragent.handoff ("Your part is done; end your turn") the model ended its turn and the saves before it in the
 *     batch never ran.
 * Ordering rule: because the last-confirmed call is re-issued first, a call that others depend on is confirmed last.
 * Three groups, each in pending order: CONFIRM_FIRST calls (turn-ending or outbound), then the other allowed calls, then
 * terragent.log_decision, so a decision is re-issued before the save_acquisition_plan that refuses to run without it.
 * The server-side handoff preconditions (requests.ts) are what make a lost save safe; this order only makes it rarer.
 */
import { AgentName } from "../domain";
import { envFlag } from "../env";
import { logEvent } from "../events";
import { TERRAGENT_MCP_SERVER, toolSpec } from "../mcp/catalog";
import { getNaive } from "../naive/client";
import { NEVER_APPROVED_BROWSER_ACTIONS } from "../naive/sessions";
import { errorMessage } from "./db";

export interface PolicyOutcome { allowed: string[]; held: string[] }

/** The part of an agent's Naïve tool configs the policy reads. */
type ToolConfigs = Record<string, { permission?: string; enabled?: boolean; config?: { ask_actions?: string[] } }>;

/** Never cleared by policy, whatever an agent's config says: money, identity, public posting, secrets, raw email. */
const NEVER = [/^email\.send$/, /^(wallet|card|trading|legal|company)\./, /^payments/, /^social\./, /^phone\./, /^vault\./, /^mobile$/,
  /^(list_as_template|pay_out_earnings|apps\.request_access|operator\.request)$/, new RegExp(`^${TERRAGENT_MCP_SERVER}\\.place_paid_order$`)];

/**
 * Calls that end the agent's turn or report or send something outward. They are confirmed first so that the newest
 * APPROVED message Naïve replays never names one of them: the model re-issues the last-confirmed call first.
 */
export const CONFIRM_FIRST: ReadonlySet<string> = new Set([
  "terragent.handoff", "terragent.set_status", "terragent.send_customer_message", "terragent.send_quote",
  "terragent.deliver_report", "terragent.send_outreach_email", "terragent.record_contact_form_touch",
  "terragent.send_supplier_email", "submit_output",
]);

/** Confirmed last, so re-issued first: saveAcquisitionPlan refuses until this run's decisions are logged. */
const CONFIRM_LAST = "terragent.log_decision";

/** Stable partition: CONFIRM_FIRST rows, then all other rows, then CONFIRM_LAST rows, each group in its original pending order. */
export function confirmOrder<T extends { name?: string | null }>(rows: readonly T[]): T[] {
  const first = (r: T) => CONFIRM_FIRST.has(String(r.name ?? ""));
  const last = (r: T) => r.name === CONFIRM_LAST;
  return [...rows.filter(first), ...rows.filter((r) => !first(r) && !last(r)), ...rows.filter(last)];
}

/**
 * Laurence (2026-11-08): "nothing should require human approval" — except the spec's hard rule that buying data
 * needs a founder (and there is no payment method connected; a purchase is a manual founder step anyway).
 *   - terragent.* : the catalog must allow the tool for this agent;
 *   - anything else (Naïve built-ins like browser / web_fetch / data_run, or the SkyWatch MCP): the agent's own Naïve
 *     config must already set that tool to `allow`. This checks the tool name only, so it does not honour a browser
 *     config's ask_actions; applyApprovalPolicy holds those calls separately (browserActionCleared).
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

/**
 * A browser row names its action in args, and its config is `allow` with ask_actions listing what must wait for a person
 * (signup, login, and contact-form writes until OUTREACH_CONTACT_FORM_APPROVED). It clears only with a string action on
 * neither that list nor NEVER_APPROVED_BROWSER_ACTIONS. Any other shape is held: this row has not been observed live.
 */
function browserActionCleared(name: string, args: Record<string, unknown> | undefined, configured: ToolConfigs): boolean {
  if (name !== "browser") return true;
  const action = args?.action;
  if (typeof action !== "string") return false;
  return !NEVER_APPROVED_BROWSER_ACTIONS.has(action) && !configured.browser?.config?.ask_actions?.includes(action);
}

/**
 * Confirm the session's parked calls that policyAllows clears, in confirmOrder, one at a time; hold the rest.
 * `allowed` lists names in confirm order. A call whose confirm fails is still parked, so it goes to `held` (naive-events
 * lists it in approval.pending for a founder) and the loop carries on with the next one. Audit events are best-effort:
 * nothing retries this pass, so a failed event write must not leave the rest of the batch parked.
 */
export async function applyApprovalPolicy(sessionId: string, agent: string | null, requestId: string | null): Promise<PolicyOutcome> {
  const out: PolicyOutcome = { allowed: [], held: [] };
  if (!envFlag("AUTO_APPROVE_GATEWAY_TOOLS")) return out;
  const client = await getNaive();
  const session = await client.sessions.get(sessionId);
  const configured = ((await client.agents.get(session.agent_id)).tools?.configs ?? {}) as ToolConfigs;
  const pending = session.pending_actions ?? [];
  const cleared: typeof pending = [];
  for (const a of pending) {
    const name = String(a.name ?? "");
    if (policyAllows(agent, name, a.kind ?? "tool", configured) && browserActionCleared(name, a.args, configured)) cleared.push(a);
    else out.held.push(name);
  }
  const audit = (type: string, payload: Record<string, unknown>) =>
    logEvent(type, "policy", payload, requestId).catch((e) => console.error("[approval-policy] event log failed:", type, errorMessage(e)));
  const ordered = confirmOrder(cleared);
  for (const [i, a] of ordered.entries()) {
    const name = String(a.name ?? "");
    // Never log args: they can carry customer text.
    const meta = { session_id: sessionId, agent, tool: name, tool_call_id: a.tool_call_id };
    try {
      await client.sessions.confirmTool(sessionId, {
        tool_call_id: a.tool_call_id,
        decision: "allow",
        // Always "call", never "session": read_people cards offer no session grant; a grant would cover every future
        // args of that tool name; NEVER-list tools and place_paid_order must never be granted.
        scope: "call",
        reason: `Terragent approval policy: allowed for ${agent} by the catalog or its own Naïve config.`,
      });
    } catch (e) {
      out.held.push(name);
      await audit("approval.policy_failed", { ...meta, error: errorMessage(e).slice(0, 300) });
      continue;
    }
    out.allowed.push(name);
    await audit("approval.auto_allowed", { ...meta, position: i + 1, of: ordered.length });
  }
  return out;
}

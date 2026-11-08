/** Runtime helpers over @usenaive-sdk/managed-agents sessions (agent ids from settings). */
import { AGENT_BUDGETS, usd } from "../config";
import type { AgentName } from "../domain";
import { getNaive } from "./client";
import { agentId, agentNamesById } from "./registry";

export interface StartSessionOpts {
  requestId?: string;
  budgetUsd?: number;
  metadata?: Record<string, string>;
  window?: "immediate" | "priority" | "loose";
  /** Same key → same session (safe to retry a webhook that already started one). */
  idempotencyKey?: string;
}

/** Start a top-level session of a provisioned agent. Returns the ses_ id. */
export async function startAgentSession(agent: AgentName, message: string, opts: StartSessionOpts = {}): Promise<{ session_id: string }> {
  const naive = await getNaive();
  const metadata: Record<string, string> = { ...opts.metadata, agent };
  if (opts.requestId) metadata.request_id = opts.requestId;
  const session = await naive.sessions.create(
    {
      agent_id: await agentId(agent),
      message,
      metadata,
      ...(opts.window ? { window: opts.window } : {}),
      // A session budget may not exceed the agent's cap; omitted → the agent's per-task ceiling.
      ...(opts.budgetUsd !== undefined ? { budget_micro_usd: Math.min(usd(opts.budgetUsd), usd(AGENT_BUDGETS[agent].capUsdPerDay)) } : {}),
    },
    opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {},
  );
  return { session_id: session.id };
}

export interface PendingApproval {
  session_id: string;
  agent: string;
  tool_call_id: string;
  tool: string;
  args: Record<string, unknown>;
  parked_at: string | null;
  /** False → a founder may only deny it (see APPROVABLE_TOOLS). Always set by listPendingApprovals. */
  approvable?: boolean;
}

/**
 * Parked calls a founder may ALLOW, by tool → the agents allowed to park it. Any other parked call of
 * ours can only be denied, and calls parked by agents that are not Terragent's (the org is shared) are
 * neither listed nor decided here.
 */
export const APPROVABLE_TOOLS: Record<string, readonly AgentName[]> = {
  "terragent.place_paid_order": ["acquisition"],
  browser: ["comms-outreach"], // contact-form writes, until OUTREACH_CONTACT_FORM_APPROVED
};
/** Agents never sign up or log in anywhere: humans create accounts. */
const NEVER_APPROVED_BROWSER_ACTIONS = new Set(["signup", "login"]);

export function isApprovable(agent: AgentName, tool: string, args: Record<string, unknown>): boolean {
  if (!APPROVABLE_TOOLS[tool]?.includes(agent)) return false;
  return !(tool === "browser" && NEVER_APPROVED_BROWSER_ACTIONS.has(String(args.action)));
}

/** Tool calls Terragent's agents parked for a human (e.g. terragent.place_paid_order), newest sessions first. */
export async function listPendingApprovals(): Promise<PendingApproval[]> {
  const naive = await getNaive();
  const names = await agentNamesById();
  const out: PendingApproval[] = [];
  let after: string | undefined;
  do {
    const page = await naive.sessions.list({ stop_reason: "awaiting_approval", limit: 100, ...(after ? { after } : {}) });
    for (const s of page.data) {
      const agent = names.get(s.agent_id);
      if (!agent) continue; // another team's agent in the same org
      for (const a of s.pending_actions) {
        if (a.kind !== "tool") continue; // "question" rows are answered, not approved
        out.push({
          session_id: s.id,
          agent,
          tool_call_id: a.tool_call_id,
          tool: a.name,
          args: a.args,
          parked_at: s.ended_at, // the parked turn's end; the API has no per-action timestamp
          approvable: isApprovable(agent, a.name, a.args),
        });
      }
    }
    after = page.has_more && page.next_cursor ? page.next_cursor : undefined;
  } while (after);
  return out;
}

/**
 * Approve or deny one parked call of one of our agents. Allowing is limited to APPROVABLE_TOOLS; denying
 * is always possible. The session resumes once its last pending action is decided.
 */
export async function decideApproval(sessionId: string, toolCallId: string, decision: "allow" | "deny", reason: string): Promise<void> {
  const naive = await getNaive();
  const session = await naive.sessions.get(sessionId);
  const agent = (await agentNamesById()).get(session.agent_id);
  if (!agent) throw new Error(`Session ${sessionId} does not belong to a Terragent agent; decide it in the Naïve console.`);
  const action = session.pending_actions.find((a) => a.kind === "tool" && a.tool_call_id === toolCallId);
  if (!action) throw new Error(`Session ${sessionId} has no pending tool call ${toolCallId}.`);
  if (decision === "allow" && !isApprovable(agent, action.name, action.args)) {
    throw new Error(`${action.name} from ${agent} cannot be approved here, only denied.`);
  }
  await naive.sessions.confirmTool(sessionId, { tool_call_id: toolCallId, decision, reason, scope: "call" });
}

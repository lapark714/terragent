/** OWNER: naive builder. Runtime helpers over @usenaive-sdk/managed-agents (agent ids from settings). */
import type { AgentName } from "../domain";

export interface StartSessionOpts { requestId?: string; budgetUsd?: number; metadata?: Record<string, string>; window?: "immediate" | "priority" | "loose" }

/** Start a top-level session of a provisioned agent. Returns the ses_ id. */
export async function startAgentSession(agent: AgentName, message: string, opts: StartSessionOpts = {}): Promise<{ session_id: string }> { throw new Error("not implemented yet"); }

export interface PendingApproval { session_id: string; agent: string; tool_call_id: string; tool: string; args: Record<string, unknown>; parked_at: string | null }
export async function listPendingApprovals(): Promise<PendingApproval[]> { throw new Error("not implemented yet"); }
export async function decideApproval(sessionId: string, toolCallId: string, decision: "allow" | "deny", reason: string): Promise<void> { throw new Error("not implemented yet"); }

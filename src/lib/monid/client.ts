/** OWNER: signals builder. Monid REST wrapper: allowlist + per-call/per-day caps + spend ledger. */
export interface MonidEndpoint { provider: string; endpoint: string; price_usd: number | null; description: string }
export interface MonidRunResult { status: "COMPLETED" | "BLOCKED" | "FAILED" | "TIMED_OUT" | "REFUSED"; output: unknown; cost_usd: number; run_id: string | null; reason?: string }

export async function monidDiscover(q: string, limit = 5): Promise<MonidEndpoint[]> { throw new Error("not implemented yet"); }
export async function monidRun(args: { provider: string; endpoint: string; input: Record<string, unknown>; purpose: string; requestId?: string; agent?: string }): Promise<MonidRunResult> { throw new Error("not implemented yet"); }

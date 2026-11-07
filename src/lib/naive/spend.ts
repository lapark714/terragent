/** OWNER: naive builder. Spend from the Naïve ledger (micro-USD → USD). */
export interface SpendSummary { total_usd: number; by_agent: Record<string, number>; by_session?: Record<string, number>; balance_usd: number | null }
export async function getSpendSummary(opts: { from?: Date; to?: Date } = {}): Promise<SpendSummary> { throw new Error("not implemented yet"); }
export async function sessionCostUsd(sessionId: string): Promise<number> { throw new Error("not implemented yet"); }

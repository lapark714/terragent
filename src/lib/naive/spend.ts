/** Spend from the Naïve ledger (micro-USD → USD). Needs a key with billing:read. */
import { getNaive } from "./client";
import { agentNamesById } from "./registry";

export interface SpendSummary { total_usd: number; by_agent: Record<string, number>; by_session?: Record<string, number>; balance_usd: number | null }

const toUsd = (micro: number) => micro / 1_000_000;

/**
 * Server-summed spend over [from, to) (whole history when omitted), keyed by agent NAME where known.
 * by_agent includes computer time (billed to the agent, never to a session); by_session is the top 50.
 */
export async function getSpendSummary(opts: { from?: Date; to?: Date } = {}): Promise<SpendSummary> {
  const naive = await getNaive();
  const [spend, balance, names] = await Promise.all([
    naive.credits.spend({
      ...(opts.from ? { from: opts.from.toISOString() } : {}),
      ...(opts.to ? { to: opts.to.toISOString() } : {}),
    }),
    naive.credits.show().catch(() => null), // balance is nice-to-have; never fail the summary on it
    agentNamesById(),
  ]);
  const by_agent: Record<string, number> = {};
  for (const a of spend.by_agent) by_agent[names.get(a.agent_id) ?? a.agent_id] = toUsd(a.spent_micro_usd);
  const by_session: Record<string, number> = {};
  for (const s of spend.by_session) by_session[s.session_id] = toUsd(s.spent_micro_usd);
  return {
    total_usd: toUsd(spend.spent_micro_usd),
    by_agent,
    by_session,
    balance_usd: balance ? toUsd(balance.balance_micro_usd) : null,
  };
}

/** What one session cost so far (model + tools; computer time is billed to the agent, not here). */
export async function sessionCostUsd(sessionId: string): Promise<number> {
  const naive = await getNaive();
  return toUsd((await naive.credits.spend({ session_id: sessionId })).spent_micro_usd);
}

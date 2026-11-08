/** Spend vs revenue, overall and per request (spec §6: show real cost vs price per request). */
import { getDb } from "../db/client";
import type { RequestStatus } from "../domain";
import { getSpendSummary } from "../naive/spend";
import { asPlaybook } from "./board";
import { shortId } from "./mask";
import { live, num, numOrNull } from "./rows";
import type { Money } from "./types";

export async function getMoney(): Promise<Money> {
  const db = await getDb();
  const [spendRows, agentRows, revenueRows, requestRows, ledger] = await Promise.all([
    db.query<{ service: string; usd: number }>("SELECT service, sum(amount_usd)::float8 AS usd FROM spend GROUP BY service"),
    db.query<{ agent: string; usd: number }>(
      "SELECT agent, sum(amount_usd)::float8 AS usd FROM spend WHERE agent IS NOT NULL GROUP BY agent",
    ),
    db.query<{ kind: string; usd: number; n: number }>(
      "SELECT kind, sum(amount_usd)::float8 AS usd, count(*)::int AS n FROM revenue GROUP BY kind",
    ),
    db.query<{ id: string; playbook: string; status: RequestStatus; is_free_sample: boolean; cost_usd: unknown; price_usd: unknown; spend: number; paid: number }>(
      `SELECT r.id, r.playbook, r.status, r.is_free_sample, r.cost_usd, r.price_usd,
              COALESCE((SELECT sum(s.amount_usd) FROM spend s WHERE s.request_id = r.id), 0)::float8 AS spend,
              COALESCE((SELECT sum(v.amount_usd) FROM revenue v WHERE v.request_id = r.id AND v.kind = 'paid'), 0)::float8 AS paid
       FROM requests r ORDER BY r.created_at DESC LIMIT 25`,
    ),
    // The Naïve ledger is the source of truth for agent spend when the key can read it.
    live("naive.spend", 60_000, () => getSpendSummary()),
  ]);

  const byService = Object.fromEntries(spendRows.map((r) => [r.service, num(r.usd)]));
  const naive = ledger.state === "ok" ? ledger.data.total_usd : (byService.naive ?? 0);
  const monid = byService.monid ?? 0;
  const data = byService.data ?? 0;
  const other = Object.entries(byService)
    .filter(([s]) => !["naive", "monid", "data"].includes(s))
    .reduce((a, [, v]) => a + v, 0);

  const byAgentSource = ledger.state === "ok" ? Object.entries(ledger.data.by_agent) : agentRows.map((r) => [r.agent, num(r.usd)] as const);
  const revenue = (kind: string) => revenueRows.find((r) => r.kind === kind);

  return {
    spend: { total: naive + monid + data + other, naive, monid, data, other, naiveSource: ledger.state === "ok" ? "ledger" : "table" },
    naiveBalanceUsd: ledger.state === "ok" ? ledger.data.balance_usd : null,
    revenue: {
      paid: num(revenue("paid")?.usd),
      committed: num(revenue("committed")?.usd),
      stated: num(revenue("stated_willingness")?.usd),
      paidCount: num(revenue("paid")?.n),
      committedCount: num(revenue("committed")?.n),
      statedCount: num(revenue("stated_willingness")?.n),
    },
    byAgent: byAgentSource
      .map(([agent, usd]) => ({ agent, usd: num(usd) }))
      .filter((a) => a.usd > 0)
      .sort((a, b) => b.usd - a.usd),
    perRequest: requestRows.map((r) => ({
      id: shortId(r.id),
      playbook: asPlaybook(r.playbook),
      status: r.status,
      sample: r.is_free_sample,
      // cost_usd is maintained by the pipeline; fall back to attributed spend rows until it is.
      cost: num(r.cost_usd) || num(r.spend),
      price: numOrNull(r.price_usd),
      paid: num(r.paid),
    })),
  };
}

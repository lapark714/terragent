/** Spend vs revenue for the coordinator and pricing: Naïve ledger, Monid and data spend rows, revenue, per request. */
import { AGENT_BUDGETS, CAPS } from "../config";
import { getDb } from "../db/client";
import { AGENT_NAMES, type AgentName } from "../domain";
import { naiveSpend, requestCost } from "./metrics";
import { num, round2, startOfUtcDay } from "./util";

export async function getSpendOverview(f: { topRequests?: number } = {}) {
  const db = await getDb();
  const today = startOfUtcDay();
  const [allTime, sinceMidnight] = await Promise.all([naiveSpend(), naiveSpend({ from: today })]);
  const warnings = [...new Set([allTime.warning, sinceMidnight.warning].filter((w): w is string => !!w))];

  const agents = Object.fromEntries(
    Object.entries(sinceMidnight.summary?.by_agent ?? {}).map(([agent, spent]) => {
      const cap = (AGENT_NAMES as readonly string[]).includes(agent) ? AGENT_BUDGETS[agent as AgentName].capUsdPerDay : null;
      return [agent, { spent_today_usd: round2(spent), cap_per_day_usd: cap, remaining_today_usd: cap === null ? null : round2(cap - spent) }];
    }),
  );

  const byService = await db.query<{ service: string; total: unknown; today: unknown }>(
    `SELECT service, sum(amount_usd) AS total, sum(amount_usd) FILTER (WHERE recorded_at >= $1) AS today
     FROM spend GROUP BY service ORDER BY service`, [today]);
  const service = (name: string) => byService.find((s) => s.service === name);
  const monidToday = num(service("monid")?.today);

  const revenue = await db.query<{ kind: string; usd: unknown }>("SELECT kind, sum(amount_usd) AS usd FROM revenue GROUP BY kind");
  const rev = (kind: string) => round2(num(revenue.find((r) => r.kind === kind)?.usd));

  const requests = await db.query<{ id: string; playbook: string; status: string; is_free_sample: boolean; price_usd: unknown; cost_usd: unknown; spend_usd: unknown }>(
    `SELECT q.id, q.playbook, q.status, q.is_free_sample, q.price_usd, q.cost_usd,
       (SELECT sum(amount_usd) FROM spend s WHERE s.request_id = q.id) AS spend_usd
     FROM requests q ORDER BY q.created_at DESC LIMIT 500`);
  const perRequest = requests
    .map((r) => ({ id: r.id, playbook: r.playbook, status: r.status, free_sample: r.is_free_sample,
      cost_usd: round2(requestCost(r)), price_usd: r.price_usd === null ? null : num(r.price_usd) }))
    .sort((a, b) => b.cost_usd - a.cost_usd)
    .slice(0, f.topRequests ?? 10);

  const otherSpend = byService.filter((s) => s.service !== "naive").reduce((a, s) => a + num(s.total), 0);
  const naiveTotal = allTime.summary?.total_usd ?? num(service("naive")?.total);
  const totalSpend = round2(naiveTotal + otherSpend);
  const value = rev("paid") + rev("committed");

  return {
    naive: {
      total_usd: round2(naiveTotal),
      today_usd: sinceMidnight.summary ? round2(sinceMidnight.summary.total_usd) : null,
      balance_usd: allTime.summary?.balance_usd ?? null,
      by_agent_today: agents,
      source: allTime.summary ? "naive ledger" : "spend table (Naïve unavailable)",
    },
    monid: {
      total_usd: round2(num(service("monid")?.total)),
      today_usd: round2(monidToday),
      cap_per_day_usd: CAPS.monidMaxUsdPerDay,
      remaining_today_usd: round2(Math.max(0, CAPS.monidMaxUsdPerDay - monidToday)),
    },
    other_spend_by_service: Object.fromEntries(byService.filter((s) => !["naive", "monid"].includes(s.service)).map((s) => [s.service, round2(num(s.total))])),
    revenue: { paid_usd: rev("paid"), committed_usd: rev("committed"), stated_willingness_usd: rev("stated_willingness") },
    total_spend_usd: totalSpend,
    margin_usd: round2(value - totalSpend),
    top_requests_by_cost: perRequest,
    warnings,
  };
}

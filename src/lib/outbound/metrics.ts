/**
 * Coordinator metrics: the outbound funnel per playbook (cohort = prospects created in the window) plus the inbound
 * lane, with reply rate, cost per verified free report and value. Feeds set_playbook_allocation (spec §3.1, §10.6).
 */
import { PRICING } from "../config";
import { getDb } from "../db/client";
import { getSpendSummary, type SpendSummary } from "../naive/spend";
import { getAllocation, type Weights } from "./allocation";
import { num, OUTBOUND_PLAYBOOKS, ratio, round2, type OutboundPlaybook } from "./util";

export interface PlaybookFunnel {
  signals: number;
  signals_matched: number;
  prospects: number;
  samples_started: number;
  free_reports_verified: number;
  first_touches: number;
  /**
   * Prospects whose first touch AgentMail refused (sending limits such as the new-org recipient ramp, block list,
   * suspension) and that no other first touch reached. Not in first_touches: a volume problem, not a playbook result.
   */
  blocked_by_provider: number;
  touches_by_channel: Record<string, number>;
  replies: number;
  /** Spec §8: replies tracked by signal type and message version. */
  by_signal_feed: Record<string, { touches: number; replies: number }>;
  by_message_version: Record<string, { touches: number; replies: number }>;
  quotes: number;
  revenue_paid_usd: number;
  revenue_committed_usd: number;
  stated_willingness_usd: number;
  cost_usd: number;
  reply_rate: number | null;
  cost_per_report_usd: number | null;
  value_usd: number;
}

/** Naïve ledger, or null with a warning when it can't be reached (no key locally, API down). */
export async function naiveSpend(opts: { from?: Date } = {}): Promise<{ summary: SpendSummary | null; warning?: string }> {
  try {
    return { summary: await getSpendSummary(opts) };
  } catch (e) {
    return { summary: null, warning: `Naïve spend unavailable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export const emptyFunnel = (): PlaybookFunnel => ({
  signals: 0, signals_matched: 0, prospects: 0, samples_started: 0, free_reports_verified: 0, first_touches: 0,
  blocked_by_provider: 0, touches_by_channel: {}, replies: 0, by_signal_feed: {}, by_message_version: {}, quotes: 0,
  revenue_paid_usd: 0, revenue_committed_usd: 0, stated_willingness_usd: 0,
  cost_usd: 0, reply_rate: null, cost_per_report_usd: null, value_usd: 0,
});

/**
 * Real cost of a request: max(requests.cost_usd, its spend rows). Core mirrors each Naïve session's cost into spend
 * (service 'naive') and rolls it up into requests.cost_usd; taking the max never counts a session twice.
 */
export function requestCost(r: { cost_usd: unknown; spend_usd: unknown }) {
  return Math.max(num(r.cost_usd), num(r.spend_usd));
}

/**
 * Transparent starting point for the coordinator: smoothed reply rate (prior 1 reply in 4 touches) × value lift,
 * divided by cost per report; normalised with a 10% exploration floor per playbook.
 */
export function suggestAllocation(funnels: Record<OutboundPlaybook, PlaybookFunnel>): Weights {
  const score = (f: PlaybookFunnel) =>
    ((f.replies + 1) / (f.first_touches + 4)) * (1 + f.value_usd / 100) / Math.max(f.cost_per_report_usd ?? PRICING.defaultAnalysisCostUsd, 0.25);
  const raw = OUTBOUND_PLAYBOOKS.map((p) => score(funnels[p]));
  const total = raw.reduce((a, b) => a + b, 0);
  const floor = 0.1;
  const shares = raw.map((s) => floor + (1 - floor * raw.length) * (s / total));
  const rounded = shares.map((s) => round2(s));
  const drift = round2(1 - rounded.reduce((a, b) => a + b, 0));
  rounded[rounded.indexOf(Math.max(...rounded))] = round2(Math.max(...rounded) + drift);
  return Object.fromEntries(OUTBOUND_PLAYBOOKS.map((p, i) => [p, rounded[i]])) as Weights;
}

type Grouped = { playbook: string; n: number }[];

/** blocked_reason of a send AgentMail itself refused (src/lib/email/send.ts): provider_limit:<code> | provider_rejected:<code>. */
export const PROVIDER_BLOCK_RE = "^provider_(limit|rejected):";

/**
 * First touches refused by the provider, per playbook (cohort = prospects created since `since`): prospects with a
 * blocked outreach email whose reason is a provider refusal and no first touch sent on any channel. `by_reason` uses
 * each prospect's latest refusal. The dashboard can show the same numbers.
 */
export async function blockedByProvider(since: Date): Promise<{ by_playbook: Record<string, number>; by_reason: Record<string, number>; total: number }> {
  const db = await getDb();
  const rows = await db.query<{ playbook: string; reason: string; n: number }>(
    `SELECT p.playbook, b.reason, count(*)::int AS n FROM prospects p
     JOIN LATERAL (SELECT m.blocked_reason AS reason FROM messages m
                   WHERE m.prospect_id = p.id AND m.direction = 'outbound' AND m.kind = 'outreach' AND m.status = 'blocked'
                     AND m.blocked_reason ~ $2
                   ORDER BY m.created_at DESC LIMIT 1) b ON true
     WHERE p.created_at >= $1
       AND NOT EXISTS (SELECT 1 FROM messages s WHERE s.prospect_id = p.id AND s.direction = 'outbound' AND s.kind = 'outreach' AND s.status = 'sent')
     GROUP BY p.playbook, b.reason`,
    [since, PROVIDER_BLOCK_RE],
  );
  const out = { by_playbook: {} as Record<string, number>, by_reason: {} as Record<string, number>, total: 0 };
  for (const r of rows) {
    out.by_playbook[r.playbook] = (out.by_playbook[r.playbook] ?? 0) + num(r.n);
    out.by_reason[r.reason] = (out.by_reason[r.reason] ?? 0) + num(r.n);
    out.total += num(r.n);
  }
  return out;
}

export async function getMetrics(f: { sinceHours?: number } = {}) {
  const db = await getDb();
  const since = f.sinceHours ? new Date(Date.now() - f.sinceHours * 3_600_000) : new Date(0);
  const funnels = Object.fromEntries(OUTBOUND_PLAYBOOKS.map((p) => [p, emptyFunnel()])) as Record<OutboundPlaybook, PlaybookFunnel>;
  const at = (playbook: string) => funnels[playbook as OutboundPlaybook];
  const fill = (rows: Grouped, key: keyof PlaybookFunnel) => {
    for (const r of rows) if (at(r.playbook)) (at(r.playbook)[key] as number) = num(r.n);
  };

  const signals = await db.query<{ playbook: string; n: number; matched: number }>(
    `SELECT playbook, count(*)::int AS n, (count(*) FILTER (WHERE status = 'matched'))::int AS matched
     FROM signals WHERE created_at >= $1 GROUP BY playbook`, [since]);
  for (const r of signals) if (at(r.playbook)) Object.assign(at(r.playbook), { signals: num(r.n), signals_matched: num(r.matched) });

  fill(await db.query("SELECT playbook, count(*)::int AS n FROM prospects WHERE created_at >= $1 GROUP BY playbook", [since]), "prospects");

  const samples = await db.query<{ playbook: string; started: number; verified: number }>(
    `SELECT q.playbook, count(*)::int AS started,
       (count(*) FILTER (WHERE EXISTS (SELECT 1 FROM reports r WHERE r.request_id = q.id AND r.verifier_status = 'pass')))::int AS verified
     FROM requests q WHERE q.is_free_sample AND q.source = 'signal' AND q.created_at >= $1 GROUP BY q.playbook`, [since]);
  for (const r of samples) if (at(r.playbook)) Object.assign(at(r.playbook), { samples_started: num(r.started), free_reports_verified: num(r.verified) });

  // Each prospect counts once, under the channel of its first touch.
  const touches = await db.query<{ playbook: string; channel: string; n: number }>(
    `SELECT p.playbook, t.channel, count(*)::int AS n FROM prospects p
     JOIN LATERAL (SELECT channel FROM messages m WHERE m.prospect_id = p.id AND m.direction = 'outbound' AND m.kind = 'outreach'
                   AND m.status = 'sent' ORDER BY m.created_at LIMIT 1) t ON true
     WHERE p.created_at >= $1 GROUP BY p.playbook, t.channel`, [since]);
  for (const r of touches) {
    const fu = at(r.playbook);
    if (!fu) continue;
    fu.touches_by_channel[r.channel] = num(r.n);
    fu.first_touches += num(r.n);
  }

  const providerBlocks = await blockedByProvider(since);
  for (const [playbook, n] of Object.entries(providerBlocks.by_playbook)) if (at(playbook)) at(playbook).blocked_by_provider = n;

  // A reply = they answered (inbound message) or moved on to a quote / payment. Every prospect has one feed,
  // so the per-feed rows also give the playbook's reply total.
  const breakdown = await db.query<{ playbook: string; dim: "feed" | "version"; key: string; touches: number; replies: number }>(
    `WITH pp AS (
       SELECT p.playbook, coalesce(s.feed, 'unknown') AS feed, coalesce(p.message_version, 'none') AS version,
         EXISTS (SELECT 1 FROM messages m WHERE m.prospect_id = p.id AND m.direction = 'outbound' AND m.kind = 'outreach' AND m.status = 'sent') AS touched,
         (p.status IN ('replied', 'quoted', 'paid') OR EXISTS (SELECT 1 FROM messages m WHERE m.prospect_id = p.id AND m.direction = 'inbound')) AS replied
       FROM prospects p LEFT JOIN signals s ON s.id = p.signal_id WHERE p.created_at >= $1)
     SELECT playbook, 'feed' AS dim, feed AS key, (count(*) FILTER (WHERE touched))::int AS touches, (count(*) FILTER (WHERE replied))::int AS replies
       FROM pp GROUP BY playbook, feed
     UNION ALL
     SELECT playbook, 'version', version, (count(*) FILTER (WHERE touched))::int, (count(*) FILTER (WHERE replied))::int
       FROM pp WHERE touched GROUP BY playbook, version`, [since]);
  for (const r of breakdown) {
    const fu = at(r.playbook);
    if (!fu) continue;
    (r.dim === "feed" ? fu.by_signal_feed : fu.by_message_version)[r.key] = { touches: num(r.touches), replies: num(r.replies) };
    if (r.dim === "feed") fu.replies += num(r.replies);
  }

  fill(await db.query(
    `SELECT playbook, count(*)::int AS n FROM prospects p WHERE created_at >= $1 AND (status IN ('quoted', 'paid')
       OR EXISTS (SELECT 1 FROM quotes q JOIN requests r ON r.id = q.request_id WHERE r.prospect_id = p.id))
     GROUP BY playbook`, [since]), "quotes");

  const revenueByKey: Record<string, keyof PlaybookFunnel> = {
    paid: "revenue_paid_usd", committed: "revenue_committed_usd", stated_willingness: "stated_willingness_usd",
  };
  const revenue = await db.query<{ playbook: string; kind: string; usd: unknown }>(
    `SELECT p.playbook, v.kind, sum(v.amount_usd) AS usd FROM revenue v
     LEFT JOIN quotes q ON q.id = v.quote_id
     JOIN requests r ON r.id = coalesce(v.request_id, q.request_id)
     JOIN prospects p ON p.id = r.prospect_id
     WHERE p.created_at >= $1 GROUP BY p.playbook, v.kind`, [since]);
  for (const r of revenue) if (at(r.playbook) && revenueByKey[r.kind]) (at(r.playbook)[revenueByKey[r.kind]] as number) = round2(num(r.usd));

  const costs = await db.query<{ playbook: string; cost_usd: unknown; spend_usd: unknown }>(
    `SELECT q.playbook, q.cost_usd, (SELECT sum(amount_usd) FROM spend s WHERE s.request_id = q.id) AS spend_usd
     FROM requests q WHERE q.is_free_sample AND q.created_at >= $1`, [since]);
  for (const r of costs) if (at(r.playbook)) at(r.playbook).cost_usd += requestCost(r);

  for (const fu of Object.values(funnels)) {
    fu.cost_usd = round2(fu.cost_usd);
    fu.reply_rate = ratio(fu.replies, fu.first_touches);
    fu.cost_per_report_usd = fu.free_reports_verified ? round2(fu.cost_usd / fu.free_reports_verified) : null;
    fu.value_usd = round2(fu.revenue_paid_usd + fu.revenue_committed_usd);
  }

  const [inbound] = await db.query<Record<string, unknown>>(
    `SELECT count(*)::int AS requests, (count(*) FILTER (WHERE status = 'delivered'))::int AS delivered,
       (count(*) FILTER (WHERE status = 'refused'))::int AS refused,
       (SELECT count(*)::int FROM quotes q JOIN requests r ON r.id = q.request_id
          WHERE r.prospect_id IS NULL AND r.source IN ('portal', 'email', 'api') AND r.created_at >= $1) AS quotes,
       (SELECT coalesce(sum(v.amount_usd), 0) FROM revenue v LEFT JOIN quotes q ON q.id = v.quote_id
          JOIN requests r ON r.id = coalesce(v.request_id, q.request_id)
          WHERE r.prospect_id IS NULL AND r.source IN ('portal', 'email', 'api') AND r.created_at >= $1 AND v.kind IN ('paid', 'committed')) AS value_usd
     FROM requests WHERE prospect_id IS NULL AND source IN ('portal', 'email', 'api') AND created_at >= $1`, [since]);

  const [totals] = await db.query<{ revenue_paid: unknown; revenue_committed: unknown; stated: unknown; spend_naive: unknown; spend_other: unknown }>(
    `SELECT (SELECT sum(amount_usd) FROM revenue WHERE kind = 'paid' AND recorded_at >= $1) AS revenue_paid,
            (SELECT sum(amount_usd) FROM revenue WHERE kind = 'committed' AND recorded_at >= $1) AS revenue_committed,
            (SELECT sum(amount_usd) FROM revenue WHERE kind = 'stated_willingness' AND recorded_at >= $1) AS stated,
            (SELECT sum(amount_usd) FROM spend WHERE service = 'naive' AND recorded_at >= $1) AS spend_naive,
            (SELECT sum(amount_usd) FROM spend WHERE service <> 'naive' AND recorded_at >= $1) AS spend_other`, [since]);
  // The Naïve ledger also holds work outside requests (sourcing, coordinator); it is all-time, so use it only without a window.
  const naive = f.sinceHours ? null : await naiveSpend();
  const naiveTotal = naive?.summary ? naive.summary.total_usd : num(totals.spend_naive);
  const spend = round2(naiveTotal + num(totals.spend_other));
  const value = round2(num(totals.revenue_paid) + num(totals.revenue_committed));

  return {
    since: since.toISOString(),
    by_playbook: funnels,
    inbound: {
      requests: num(inbound?.requests), delivered: num(inbound?.delivered), refused: num(inbound?.refused),
      quotes: num(inbound?.quotes), value_usd: round2(num(inbound?.value_usd)),
    },
    overall: {
      spend_usd: spend,
      revenue_paid_usd: round2(num(totals.revenue_paid)),
      revenue_committed_usd: round2(num(totals.revenue_committed)),
      stated_willingness_usd: round2(num(totals.stated)),
      value_usd: value,
      margin_usd: round2(value - spend),
      blocked_by_provider: providerBlocks.total,
      blocked_by_provider_reasons: providerBlocks.by_reason,
    },
    allocation: await getAllocation(),
    suggested_allocation: suggestAllocation(funnels),
    suggestion_method: "weight ∝ ((replies+1)/(touches+4)) × (1 + value/$100) / cost_per_report, 10% floor each; a starting point, not a rule",
    warnings: [
      ...(naive?.warning ? [naive.warning] : []),
      ...(providerBlocks.total
        ? [`${providerBlocks.total} first touch(es) refused by AgentMail (${Object.keys(providerBlocks.by_reason).join(", ")}): ` +
          "a sending-limit problem, not a playbook result; don't shift allocation because of them."]
        : []),
    ],
  };
}

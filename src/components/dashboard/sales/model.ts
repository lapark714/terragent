/**
 * The business side, derived from the same dashboard endpoints mission control reads (no new queries).
 * Pure functions: the sales console calls them on every poll, and the tests feed them fixtures.
 */
import type { Approvals, Board, BoardRequest, Decisions, MarketPrices, Money, RequestMoney } from "@/lib/dashboard/types";
import type { Playbook, RequestStatus } from "@/lib/domain";

/** Where a customer request stands as a deal. Order is the order founders should look at them. */
export const DEAL_STAGES = ["founder", "owed", "quoted", "unpriced", "paid", "lost"] as const;
export type DealStage = (typeof DEAL_STAGES)[number];

export const DEAL_STAGE_LABEL: Record<DealStage, string> = {
  founder: "Quote waiting on a founder",
  owed: "Delivered, not paid",
  quoted: "Quoted",
  unpriced: "Not priced yet",
  paid: "Paid",
  lost: "Lost",
};

const LOST: ReadonlySet<RequestStatus> = new Set(["refused", "failed", "cancelled"]);

export interface Deal {
  id: string;
  playbook: Playbook;
  stage: DealStage;
  status: RequestStatus;
  customer: string | null;
  question: string | null;
  location: string | null;
  owner: string | null;
  price: number | null;
  cost: number;
  paid: number;
  /** Price minus what it cost us to make so far; null until there is a price. */
  margin: number | null;
  updatedAt: string | null;
}

export function dealStage(r: RequestMoney, heldQuotes: ReadonlySet<string>): DealStage {
  if (r.paid > 0) return "paid";
  if (LOST.has(r.status)) return "lost";
  if (heldQuotes.has(r.id)) return "founder";
  if (r.price === null) return "unpriced";
  if (r.status === "delivered") return "owed";
  return "quoted";
}

const byId = (board: Board | null) => new Map<string, BoardRequest>((board?.requests ?? []).map((b) => [b.id, b]));

/** Customer requests (free samples are outreach, not deals), most urgent stage first, newest first within a stage. */
export function deals(money: Money, board: Board | null, approvals: Approvals | null): Deal[] {
  const cards = byId(board);
  const held = new Set((approvals?.quotes ?? []).map((q) => q.request));
  return money.perRequest
    .filter((r) => !r.sample)
    .map((r): Deal => {
      const b = cards.get(r.id);
      return {
        id: r.id,
        playbook: r.playbook,
        stage: dealStage(r, held),
        status: r.status,
        customer: b?.customer ?? null,
        question: b?.question ?? null,
        location: b?.location ?? null,
        owner: b?.owner ?? null,
        price: r.price,
        cost: r.cost,
        paid: r.paid,
        margin: r.price === null ? null : r.price - r.cost,
        updatedAt: b?.updatedAt ?? null,
      };
    })
    .sort((a, b) => DEAL_STAGES.indexOf(a.stage) - DEAL_STAGES.indexOf(b.stage) || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

export interface DealTotals {
  byStage: Record<DealStage, { n: number; value: number }>;
  /** Quoted, waiting on a founder, or delivered but unpaid: money we expect but don't have. */
  open: number;
  owed: number;
}

export function dealTotals(list: Deal[]): DealTotals {
  const byStage = Object.fromEntries(DEAL_STAGES.map((s) => [s, { n: 0, value: 0 }])) as DealTotals["byStage"];
  for (const d of list) {
    byStage[d.stage].n += 1;
    byStage[d.stage].value += d.stage === "paid" ? d.paid : (d.price ?? 0);
  }
  return { byStage, open: byStage.founder.value + byStage.quoted.value + byStage.owed.value, owed: byStage.owed.value };
}

export interface Product {
  id: string;
  playbook: Playbook;
  sample: boolean;
  customer: string | null;
  question: string | null;
  location: string | null;
  cost: number;
  price: number | null;
  paid: number;
}

/** Everything delivered: answers to customers and free samples sent to prospects. */
export function products(money: Money, board: Board | null): Product[] {
  const cards = byId(board);
  return money.perRequest
    .filter((r) => r.status === "delivered")
    .map((r) => {
      const b = cards.get(r.id);
      return { id: r.id, playbook: r.playbook, sample: r.sample, customer: b?.customer ?? null, question: b?.question ?? null, location: b?.location ?? null, cost: r.cost, price: r.price, paid: r.paid };
    });
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Prices we have actually quoted to customers, for the comparison with the market. */
export function ourPrices(money: Money) {
  const p = money.perRequest.filter((r) => !r.sample && r.price !== null).map((r) => r.price as number);
  return { n: p.length, low: p.length ? Math.min(...p) : null, median: median(p), high: p.length ? Math.max(...p) : null };
}

/** Market rows grouped by playbook, in a fixed playbook order. */
export function marketByPlaybook(m: MarketPrices) {
  const order: Playbook[] = ["disasters", "deforestation", "mining", "inbound"];
  return order.map((p) => ({ playbook: p, rows: m.rows.filter((r) => r.playbook === p) })).filter((g) => g.rows.length);
}

/** "Sentinel-2 L2A, 2026-09-20 (clear) vs …" → "Sentinel-2 L2A". The agents write the source first, then detail. */
export function sourceName(choice: string): string {
  const cut = choice.search(/[,:;(]| searched| vs /);
  return (cut > 0 ? choice.slice(0, cut) : choice).trim();
}

export interface SourceUse { name: string; requests: number; last: string }
export interface PaidOptionDeclined { option: string; times: number; low: number; high: number }

/** What the acquisition agent chose, and what paid data it considered and passed over, in the recent decision log. */
export function dataSources(d: Decisions) {
  const used = new Map<string, SourceUse>();
  const declined = new Map<string, PaidOptionDeclined>();
  for (const row of d.rows) {
    if (row.kind === "source_selection") {
      const name = sourceName(row.choice);
      const u = used.get(name) ?? { name, requests: 0, last: row.at };
      u.requests += 1;
      if (row.at > u.last) u.last = row.at;
      used.set(name, u);
    }
    if (row.kind === "free_vs_paid" && row.choice === "free") {
      for (const alt of row.alternatives) {
        if (!alt.cost_usd || alt.cost_usd <= 0) continue;
        const x = declined.get(alt.option) ?? { option: alt.option, times: 0, low: alt.cost_usd, high: alt.cost_usd };
        x.times += 1;
        x.low = Math.min(x.low, alt.cost_usd);
        x.high = Math.max(x.high, alt.cost_usd);
        declined.set(alt.option, x);
      }
    }
  }
  return {
    used: [...used.values()].sort((a, b) => b.requests - a.requests || a.name.localeCompare(b.name)),
    declined: [...declined.values()].sort((a, b) => b.times - a.times),
    free: d.freeVsPaid.find((x) => x.choice === "free")?.n ?? 0,
    paid: d.freeVsPaid.find((x) => x.choice === "paid")?.n ?? 0,
  };
}

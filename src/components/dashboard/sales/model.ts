/**
 * The Operations tab, derived from the same dashboard endpoints the Signal Engine reads (no new queries).
 * Pure functions: the console calls them on every poll, and the tests feed them fixtures.
 */
import type { Board, BoardRequest, Decisions, MarketPrices, Money } from "@/lib/dashboard/types";
import type { Playbook, RequestStatus } from "@/lib/domain";

/** The four sections of the Deals panel, in the order a request moves through them. */
export const DEAL_STAGES = ["outreach", "negotiation", "fulfillment", "completed"] as const;
export type DealStage = (typeof DEAL_STAGES)[number];

export const DEAL_STAGE_LABEL: Record<DealStage, string> = {
  outreach: "Outreach pending",
  negotiation: "In negotiation",
  fulfillment: "Pending fulfillment",
  completed: "Completed",
};

const STAGE_OF: Partial<Record<RequestStatus, DealStage>> = {
  received: "outreach",
  screening: "outreach",
  clarifying: "outreach",
  planning: "outreach",
  acquiring: "outreach",
  pricing: "outreach",
  quoted: "negotiation",
  awaiting_approval: "negotiation",
  fetching: "fulfillment",
  analyzing: "fulfillment",
  verifying: "fulfillment",
  revising: "fulfillment",
  delivering: "fulfillment",
  delivered: "completed",
};

/** Refused, failed and cancelled requests are not deals; they get no stage. */
export const dealStage = (status: RequestStatus): DealStage | null => STAGE_OF[status] ?? null;

export interface Deal {
  id: string;
  playbook: Playbook;
  stage: DealStage;
  status: RequestStatus;
  customer: string | null;
  question: string | null;
  location: string | null;
  owner: string | null;
  /** The quote to the customer; null until priced. */
  price: number | null;
  /** What the agents and data have cost us on this request so far. */
  cost: number;
  paid: number;
  /** Quote minus cost; null until priced. */
  profit: number | null;
  /** Data sources the acquisition agent chose for it, from the recent decision log. */
  sources: string[];
  /** Whether paid imagery was chosen; null when no free-vs-paid decision is in the recent log. */
  paidData: boolean | null;
  updatedAt: string | null;
}

const byId = (board: Board | null) => new Map<string, BoardRequest>((board?.requests ?? []).map((b) => [b.id, b]));

/** Per request: the sources chosen and the free-vs-paid call, from the recent decision log. */
export function requestSources(d: Decisions | null): Map<string, { sources: string[]; paidData: boolean | null }> {
  const m = new Map<string, { sources: string[]; paidData: boolean | null }>();
  for (const row of d?.rows ?? []) {
    if (!row.request) continue;
    const e = m.get(row.request) ?? { sources: [], paidData: null };
    if (row.kind === "source_selection") {
      const name = sourceName(row.choice);
      if (!e.sources.includes(name)) e.sources.push(name);
    }
    if (row.kind === "free_vs_paid") e.paidData = row.choice === "paid";
    m.set(row.request, e);
  }
  return m;
}

/** Customer requests sorted into the four sections (free samples are outreach to prospects, not deals), newest first. */
export function deals(money: Money, board: Board | null, decisions: Decisions | null): Deal[] {
  const cards = byId(board);
  const src = requestSources(decisions);
  const out: Deal[] = [];
  for (const r of money.perRequest) {
    const stage = dealStage(r.status);
    if (r.sample || !stage) continue;
    const b = cards.get(r.id);
    const s = src.get(r.id);
    out.push({
      id: r.id,
      playbook: r.playbook,
      stage,
      status: r.status,
      customer: b?.customer ?? null,
      question: b?.question ?? null,
      location: b?.location ?? null,
      owner: b?.owner ?? null,
      price: r.price,
      cost: r.cost,
      paid: r.paid,
      profit: r.price === null ? null : r.price - r.cost,
      sources: s?.sources ?? [],
      paidData: s?.paidData ?? null,
      updatedAt: b?.updatedAt ?? null,
    });
  }
  return out.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

export function byStage(list: Deal[]): Record<DealStage, Deal[]> {
  const g = { outreach: [], negotiation: [], fulfillment: [], completed: [] } as Record<DealStage, Deal[]>;
  for (const d of list) g[d.stage].push(d);
  return g;
}

/** Money we expect but don't have: open quotes, work in progress, and delivered-but-unpaid. */
export function openValue(list: Deal[]): { open: number; owed: number; owedCount: number } {
  let open = 0, owed = 0, owedCount = 0;
  for (const d of list) {
    if (d.price === null || d.paid >= d.price) continue;
    open += d.price - d.paid;
    if (d.stage === "completed") {
      owed += d.price - d.paid;
      owedCount += 1;
    }
  }
  return { open, owed, owedCount };
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

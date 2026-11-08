/**
 * Shapes the dashboard API returns. Client components import these types only (no server code),
 * so everything here is plain JSON: ISO date strings, numbers, masked text.
 */
import type { DecisionKind, Inbox, Layer, Playbook, RequestStatus } from "../domain";

/** One panel's data, or why it is missing. Panels fail independently. */
export type Panel<T> = { ok: true; data: T } | { ok: false; error: string };
/** Data from Naïve or another service that may not be configured yet. */
export type Live<T> = { state: "ok"; data: T } | { state: "not_configured" } | { state: "error"; message: string };

export interface GlobeCell {
  h3: string;
  lat: number;
  lng: number;
  /** Dominant layer of the measurements inside this display cell. */
  layer: Layer;
  n: number;
  changed: boolean;
}
export interface GlobeSignal { id: string; lat: number; lng: number; layer: Layer; title: string; feed: string; severity: string | null; at: string }
export interface GlobeRequest { id: string; lat: number; lng: number; layer: Layer; status: RequestStatus; active: boolean; sample: boolean; at: string }
export interface GlobeData {
  /** Earth index aggregated for the world view and for zoomed-in regions, at these H3 resolutions. */
  cells: { world: GlobeCell[]; region: GlobeCell[] };
  resolutions: { world: number; region: number };
  signals: GlobeSignal[];
  requests: GlobeRequest[];
}

export interface Overview {
  inbound: number;
  samples: number;
  active: number;
  delivered: number;
  refused: number;
  verifiedReports: number;
  indexCells: number;
  interventions: number;
  /** Median seconds from request to delivery, inbound requests only. */
  medianAnswerSeconds: number | null;
  lastEventAt: string | null;
}

export const FUNNEL_STAGES = ["signals", "prospects", "reports", "touches", "replies", "quotes", "paid"] as const;
export type FunnelStageKey = (typeof FUNNEL_STAGES)[number];
export interface FunnelStage { key: FunnelStageKey; total: number; byPlaybook: Record<Playbook, number> }

export interface BoardRequest {
  id: string;
  playbook: Playbook;
  status: RequestStatus;
  owner: string | null;
  source: string;
  sample: boolean;
  question: string;
  location: string | null;
  customer: string | null;
  updatedAt: string;
}
export interface NaiveCard { id: string; title: string; status: "todo" | "doing" | "blocked" | "done"; assignee: string | null; updatedAt: string }
export interface Board { requests: BoardRequest[]; naive: Live<NaiveCard[]> }

export interface DecisionRow {
  id: string;
  request: string | null;
  playbook: Playbook | null;
  kind: DecisionKind;
  choice: string;
  reasoning: string;
  alternatives: { option: string; cost_usd?: number | null; why_not: string }[];
  agent: string;
  at: string;
}
export interface Decisions { rows: DecisionRow[]; freeVsPaid: { choice: string; n: number }[] }

export interface RequestMoney { id: string; playbook: Playbook; status: RequestStatus; sample: boolean; cost: number; price: number | null; paid: number }
export interface Money {
  spend: { total: number; naive: number; monid: number; data: number; other: number; naiveSource: "ledger" | "table" };
  naiveBalanceUsd: number | null;
  revenue: { paid: number; committed: number; stated: number; paidCount: number; committedCount: number; statedCount: number };
  byAgent: { agent: string; usd: number }[];
  perRequest: RequestMoney[];
}

export interface InterventionRow { id: string; actor: string; action: string; reason: string; request: string | null; at: string }
export interface Interventions { total: number; rows: InterventionRow[] }

export type OutboundPlaybook = Exclude<Playbook, "inbound">;
export interface AllocationPoint { at: string | null; weights: Record<OutboundPlaybook, number>; reason: string; by: string }

export interface ActivityRow { id: string; type: string; actor: string; request: string | null; at: string }

export interface LiveSnapshot {
  generatedAt: string;
  overview: Panel<Overview>;
  funnel: Panel<FunnelStage[]>;
  board: Panel<Board>;
  decisions: Panel<Decisions>;
  money: Panel<Money>;
  interventions: Panel<Interventions>;
  allocation: Panel<AllocationPoint[]>;
  activity: Panel<ActivityRow[]>;
}

export interface PendingNaiveApproval { sessionId: string; agent: string; toolCallId: string; tool: string; args: unknown; parkedAt: string | null }
export interface PendingOrder {
  id: string;
  request: string | null;
  provider: string;
  product: string;
  areaKm2: number | null;
  estCostUsd: number;
  supplierQuoteUsd: number | null;
  justification: string;
  at: string;
}
export interface PendingQuote {
  id: string;
  request: string;
  question: string;
  priceUsd: number;
  dataCostUsd: number;
  analysisCostUsd: number;
  lineItems: { label: string; amountUsd: number }[];
  at: string;
}
export interface DraftTemplate { id: string; playbook: string; version: string; subject: string; body: string; at: string }
export interface InboxState { role: Inbox; address: string; armed: boolean }
export interface Approvals {
  naive: Live<PendingNaiveApproval[]>;
  orders: PendingOrder[];
  /** Quotes above the auto-approve cap, held until a founder approves them. */
  quotes: PendingQuote[];
  templates: DraftTemplate[];
  inboxes: InboxState[];
}

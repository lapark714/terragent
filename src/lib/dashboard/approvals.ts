/** What is waiting on a founder: Naïve tool approvals, held paid orders, quotes above the cap, draft templates, unarmed inboxes. */
import { inboxes } from "../agentmail/config";
import { getDb } from "../db/client";
import { INBOXES, type Inbox } from "../domain";
import { listPendingApprovals } from "../naive/sessions";
import { getSetting, SETTING } from "../settings";
import { scrubText, scrubValue, shortId } from "./mask";
import { iso, isoOrNull, live, num, numOrNull } from "./rows";
import type { Approvals, PendingQuote } from "./types";

export const NAIVE_APPROVALS_CACHE_KEY = "naive.approvals";

export async function getInboxArmed(): Promise<Record<Inbox, boolean>> {
  const stored = await getSetting<Partial<Record<Inbox, boolean>>>(SETTING.inboxArmed, {});
  return Object.fromEntries(INBOXES.map((i) => [i, stored[i] === true])) as Record<Inbox, boolean>;
}

function lineItems(v: unknown): PendingQuote["lineItems"] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 8).map((i: Record<string, unknown>) => ({ label: scrubText(String(i?.label ?? "")).slice(0, 80), amountUsd: num(i?.amount_usd) }));
}

export async function getApprovals(): Promise<Approvals> {
  const db = await getDb();
  const [orders, templates, quotes, armed, naive] = await Promise.all([
    db.query<{ id: string; request_id: string; provider_id: string; product: string; area_km2: unknown; est_cost_usd: unknown; supplier_quote_usd: unknown; justification: string; created_at: unknown }>(
      `SELECT id, request_id, provider_id, product, area_km2, est_cost_usd, supplier_quote_usd, justification, created_at
       FROM orders WHERE status = 'awaiting_approval' ORDER BY created_at ASC LIMIT 50`,
    ),
    db.query<{ id: string; playbook: string; version: string; subject: string; body: string; created_at: unknown }>(
      "SELECT id, playbook, version, subject, body, created_at FROM templates WHERE status = 'draft' ORDER BY created_at DESC LIMIT 20",
    ),
    db.query<{ id: string; request_id: string; question: string | null; price_usd: unknown; data_cost_usd: unknown; analysis_cost_usd: unknown; line_items: unknown; created_at: unknown }>(
      `SELECT q.id, q.request_id, r.question, q.price_usd, q.data_cost_usd, q.analysis_cost_usd, q.line_items, q.created_at
       FROM quotes q LEFT JOIN requests r ON r.id = q.request_id
       WHERE q.status = 'needs_approval' ORDER BY q.created_at ASC LIMIT 50`,
    ),
    getInboxArmed(),
    live(NAIVE_APPROVALS_CACHE_KEY, 10_000, async () =>
      (await listPendingApprovals()).map((a) => ({
        sessionId: a.session_id,
        agent: a.agent,
        toolCallId: a.tool_call_id,
        tool: a.tool,
        args: scrubValue(a.args),
        parkedAt: isoOrNull(a.parked_at),
        // Not on the approvable list (or a signup/login): the panel offers Deny only, and the server refuses Allow.
        approvable: a.approvable !== false,
      })),
    ),
  ]);
  const addresses = inboxes();
  return {
    naive,
    orders: orders.map((o) => ({
      id: o.id,
      request: shortId(o.request_id),
      provider: o.provider_id,
      product: o.product,
      areaKm2: numOrNull(o.area_km2),
      estCostUsd: num(o.est_cost_usd),
      supplierQuoteUsd: numOrNull(o.supplier_quote_usd),
      justification: scrubText(o.justification),
      at: iso(o.created_at),
    })),
    quotes: quotes.map((q) => ({
      id: q.id,
      request: shortId(q.request_id),
      question: scrubText(q.question).slice(0, 180),
      priceUsd: num(q.price_usd),
      dataCostUsd: num(q.data_cost_usd),
      analysisCostUsd: num(q.analysis_cost_usd),
      lineItems: lineItems(q.line_items),
      at: iso(q.created_at),
    })),
    templates: templates.map((t) => ({ id: t.id, playbook: t.playbook, version: t.version, subject: t.subject, body: t.body, at: iso(t.created_at) })),
    inboxes: INBOXES.map((role) => ({ role, address: addresses[role].address, armed: armed[role] })),
  };
}

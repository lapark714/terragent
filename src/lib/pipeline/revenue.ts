/**
 * Revenue rows (spec §6, DoD 6–7): what the coordinator's value input, the dashboard's spend-vs-revenue panel and the
 * funnel read. `committed` = a customer accepted a quote; `stated_willingness` = a customer or prospect named a price
 * they would pay; `paid` comes from a founder confirming a payment (dashboard).
 */
import { logEvent } from "../events";
import { num, query, queryOne, round2 } from "./db";
import { requireRequest } from "./requests";

/** A quote the customer accepted becomes committed revenue at its price. Idempotent per quote. */
export async function recordCommittedRevenue(a: { requestId: string; quoteId: string; actor: string }): Promise<number | null> {
  const quote = await queryOne<{ price_usd: string | number }>("SELECT price_usd FROM quotes WHERE id = $1", [a.quoteId]);
  const amount = num(quote?.price_usd);
  if (amount === null) return null;
  const rows = await query(
    `INSERT INTO revenue (request_id, quote_id, amount_usd, kind, note)
     SELECT $1, $2, $3, 'committed', 'Customer accepted the quote'
     WHERE NOT EXISTS (SELECT 1 FROM revenue WHERE quote_id = $2 AND kind = 'committed') RETURNING id`,
    [a.requestId, a.quoteId, amount],
  );
  if (rows.length) await logEvent("revenue.committed", a.actor, { quote_id: a.quoteId, amount_usd: amount }, a.requestId);
  return amount;
}

/**
 * A customer or prospect said what they would pay (e.g. "we'd pay $200 a month for this"). One figure per request: a
 * later statement replaces the earlier one, so a repeated note never double-counts.
 */
export async function recordStatedWillingness(a: { requestId: string; amountUsd: number; note: string; actor: string }) {
  const req = await requireRequest(a.requestId);
  if (!(a.amountUsd > 0)) throw new Error("stated_willingness_usd must be a positive amount in USD.");
  const amount = round2(a.amountUsd);
  const note = a.note.slice(0, 500);
  const updated = await query(
    "UPDATE revenue SET amount_usd = $2, note = $3, recorded_at = now() WHERE request_id = $1 AND kind = 'stated_willingness' RETURNING id",
    [req.id, amount, note],
  );
  if (!updated.length) {
    await query("INSERT INTO revenue (request_id, quote_id, amount_usd, kind, note) VALUES ($1, $2, $3, 'stated_willingness', $4)", [
      req.id, req.quote_id, amount, note,
    ]);
  }
  await logEvent("revenue.stated_willingness", a.actor, { amount_usd: amount, note }, req.id);
  return { request_id: req.id, stated_willingness_usd: amount, replaced: updated.length > 0 };
}

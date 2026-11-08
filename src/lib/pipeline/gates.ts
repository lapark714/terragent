/**
 * Price gate (spec §3.2, §9; CLAUDE.md "gates in code"): customer work starts and reports go out only once the
 * price is cleared — auto-approved under the cap, or approved by a founder, sent, and accepted by the customer.
 * Free samples and monitoring follow-ups are never quoted.
 */
import { logEvent } from "../events";
import { query, queryOne } from "./db";

export interface QuoteState { id: string; status: string; auto_approved: boolean }
interface GatedRequest { id: string; source: string; is_free_sample: boolean; quote_id: string | null }

export const needsQuote = (req: Pick<GatedRequest, "source" | "is_free_sample">) => !req.is_free_sample && req.source !== "monitor";

export const isPriceCleared = (q: QuoteState) => q.status === "accepted" || (q.status === "approved" && q.auto_approved);

/** Why the request's price isn't cleared yet (null when it is, or when no quote is needed). */
export function priceBlockedReason(req: GatedRequest, quote: QuoteState | null): string | null {
  if (!needsQuote(req)) return null;
  if (!quote) return `Request ${req.id} has no quote yet; pricing must create_quote first.`;
  if (isPriceCleared(quote)) return null;
  switch (quote.status) {
    case "needs_approval":
      return `Quote ${quote.id} is above the auto-approve cap and waits for a founder. Add a note and stop; nothing starts until a founder approves it.`;
    case "approved":
      return `Quote ${quote.id} was approved by a founder but not sent: comms-customer sends it with send_quote and waits for the customer to accept.`;
    case "sent":
      return `Quote ${quote.id} was sent; when the customer accepts it in the thread, comms-customer hands off with quote_accepted=true.`;
    default:
      return `Quote ${quote.id} is ${quote.status}; the work can't go ahead on it.`;
  }
}

export async function getQuoteState(quoteId: string | null): Promise<QuoteState | null> {
  return quoteId ? queryOne<QuoteState>("SELECT id, status, auto_approved FROM quotes WHERE id = $1", [quoteId]) : null;
}

export async function assertPriceCleared(req: GatedRequest): Promise<void> {
  const reason = priceBlockedReason(req, await getQuoteState(req.quote_id));
  if (reason) throw new Error(reason);
}

/** Comms 2 read the customer's acceptance in the thread: a sent quote becomes accepted. Idempotent. */
export async function markQuoteAccepted(req: GatedRequest, actor: string): Promise<void> {
  if (actor !== "comms-customer") throw new Error("Only comms-customer can record that the customer accepted the quote.");
  const quote = await getQuoteState(req.quote_id);
  if (!quote) throw new Error(`Request ${req.id} has no quote to accept.`);
  if (quote.status === "accepted") return;
  if (quote.status !== "sent") throw new Error(`Quote ${quote.id} is ${quote.status}; only a quote sent to the customer can be accepted.`);
  await query("UPDATE quotes SET status = 'accepted', updated_at = now() WHERE id = $1", [quote.id]);
  await logEvent("quote.accepted", actor, { quote_id: quote.id }, req.id);
}

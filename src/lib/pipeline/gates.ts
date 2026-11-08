/**
 * Price gate (spec §3.2, §9; CLAUDE.md "gates in code"), pricing v2: customer work starts and reports go out only
 * once the customer has ACCEPTED one of the quote's options (accept_quote, or the accept link; pipeline/acceptance.ts).
 * There is no price under which work starts by itself any more: PRICING.autoApproveCapUsd is display-only.
 * Free samples (our marketing cost) and monitoring follow-ups are never quoted.
 */
import { queryOne } from "./db";

export interface QuoteState {
  id: string; status: string;
  /** Pre-v2 field; ignored by the gate (no auto-approval since pricing v2). */
  auto_approved?: boolean;
  accepted_option_id?: string | null;
}
interface GatedRequest { id: string; source: string; is_free_sample: boolean; quote_id: string | null }

export const needsQuote = (req: Pick<GatedRequest, "source" | "is_free_sample">) => !req.is_free_sample && req.source !== "monitor";

/** Cleared = the customer accepted an option (a pre-v2 quote accepted in the thread counts too). */
export const isPriceCleared = (q: QuoteState) => q.status === "accepted";

/** Why the request's price isn't cleared yet (null when it is, or when no quote is needed). */
export function priceBlockedReason(req: GatedRequest, quote: QuoteState | null): string | null {
  if (!needsQuote(req)) return null;
  if (!quote) return `Request ${req.id} has no quote yet; pricing must price_options and create_quote first.`;
  if (isPriceCleared(quote)) return null;
  const waiting = "nothing beyond the investigation runs until the customer accepts an option (accept_quote, or the accept link).";
  switch (quote.status) {
    case "approved":
      return `Quote ${quote.id} is priced but not accepted: comms-customer sends it with send_quote; ${waiting}`;
    case "sent":
      return `Quote ${quote.id} was sent and waits for the customer: when they choose, comms-customer calls accept_quote with that option; ${waiting}`;
    case "needs_approval":
      return `Quote ${quote.id} is a pre-v2 quote held for a founder; pricing should re-quote with price_options and create_quote. ${waiting}`;
    case "superseded":
      return `Quote ${quote.id} was replaced by a newer quote; ${waiting}`;
    case "expired":
      return `Quote ${quote.id} expired before the customer accepted it; pricing must create a fresh quote. ${waiting}`;
    default:
      return `Quote ${quote.id} is ${quote.status}; the work can't go ahead on it.`;
  }
}

export async function getQuoteState(quoteId: string | null): Promise<QuoteState | null> {
  return quoteId ? queryOne<QuoteState>("SELECT id, status, auto_approved, accepted_option_id FROM quotes WHERE id = $1", [quoteId]) : null;
}

export async function assertPriceCleared(req: GatedRequest): Promise<void> {
  const reason = priceBlockedReason(req, await getQuoteState(req.quote_id));
  if (reason) throw new Error(reason);
}

/**
 * handoff(quote_accepted=true) from comms-customer. Since pricing v2 it no longer accepts anything by itself: the
 * customer chooses an OPTION, recorded with accept_quote (which also starts the work). Passes when an option was
 * already accepted, so a repeated handoff stays harmless.
 */
export async function markQuoteAccepted(req: GatedRequest, actor: string): Promise<void> {
  if (actor !== "comms-customer") throw new Error("Only comms-customer can record that the customer accepted the quote.");
  const quote = await getQuoteState(req.quote_id);
  if (!quote) throw new Error(`Request ${req.id} has no quote to accept.`);
  if (isPriceCleared(quote)) return;
  throw new Error(
    `Record the customer's choice with accept_quote (request_id, option_id A/B/C, evidence): quote_accepted=true alone no longer ` +
      `accepts quote ${quote.id}, and accept_quote starts the work itself.`,
  );
}

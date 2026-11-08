/**
 * Pure helpers for "Your choice" (QuoteChoice.tsx), the pricing v2 quote on the status page. No "use client" and no
 * DOM, so they are tested on their own (quote.test.ts). Only types come from src/lib, so nothing server-side reaches
 * the browser bundle.
 */
import { dateUtc, usd } from "@/components/format";
import type { PublicQuote, PublicQuoteOption, QuoteClosedReason } from "@/lib/dashboard/public";
import type { Confidence, QuoteOptionId, QuoteOptionKind } from "@/lib/domain";

type Priced = Pick<PublicQuoteOption, "price_usd" | "price_range_usd">;

/** "$29", or "$450–$700" while a supplier's exact price is unconfirmed (exactly one of the two is set). */
export function priceText(o: Priced): string {
  if (o.price_usd !== null) return usd(o.price_usd);
  if (o.price_range_usd) {
    const [lo, hi] = o.price_range_usd;
    return lo === hi ? usd(lo) : `${usd(lo)}–${usd(hi)}`;
  }
  return "price by email";
}

/** A range is an estimate until the supplier confirms its price. */
export const isEstimate = (o: Priced) => o.price_usd === null && o.price_range_usd !== null;
export const ESTIMATE_NOTE = "Estimate: the supplier's exact price isn't confirmed yet.";

/** "Accept option B · $85". The visible text is also the button's accessible name. */
export const acceptLabel = (o: Pick<PublicQuoteOption, "option_id"> & Priced) => `Accept option ${o.option_id} · ${priceText(o)}`;

/** 10 → "10 m", 1.5 → "1.5 m", 0.5 → "50 cm", 0.3 → "30 cm". Null when unknown. */
export function resolutionText(m: number | null): string | null {
  if (m === null || !Number.isFinite(m) || m <= 0) return null;
  return m < 1 ? `${Math.round(m * 100)} cm` : `${Number(m.toFixed(1))} m`;
}

/** Where the data comes from, in the customer's words (paid data is only ever bought after acceptance). */
export const SOURCE_TEXT: Record<QuoteOptionKind, string> = {
  free_data: "Free public satellite data; you pay for the analysis and verified report",
  archive: "Archive imagery, bought after you accept",
  tasking: "A new satellite capture, ordered after you accept",
  mixed: "Free and paid data combined",
};

const DATA_TYPE_TEXT: Record<string, string> = {
  optical: "optical", radar: "radar", thermal: "thermal", hyperspectral: "hyperspectral", elevation: "elevation", alerts: "deforestation alerts",
};

/** "A", "A or B", "A, B or C" (also used for data types: "optical and radar"). */
export function listText(items: readonly string[], last = "or"): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} ${last} ${items.at(-1)}`;
}

/** "Optical, 2 dates"; "Optical and radar"; null when neither is known. */
export function dataText(o: Pick<PublicQuoteOption, "data_types" | "epochs">): string | null {
  const types = o.data_types.map((t) => DATA_TYPE_TEXT[t] ?? t.replace(/_/g, " "));
  const parts = [types.length ? listText(types, "and") : "", o.epochs ? `${o.epochs} date${o.epochs === 1 ? "" : "s"}` : ""].filter(Boolean);
  if (!parts.length) return null;
  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const CONFIDENCE_TEXT: Record<Confidence, { filled: number; label: string }> = {
  high: { filled: 3, label: "High" },
  medium: { filled: 2, label: "Medium" },
  low: { filled: 1, label: "Low" },
};

/** The recommended option: the quote's own pick, else the option flagged recommended, else none. */
export function recommendedId(q: Pick<PublicQuote, "recommended_option_id" | "options">): QuoteOptionId | null {
  return q.recommended_option_id ?? q.options.find((o) => o.recommended)?.option_id ?? null;
}

/** Recommended first, then A, B, C. Never mutates the input. */
export function orderOptions<T extends Pick<PublicQuoteOption, "option_id" | "recommended">>(options: readonly T[], recommended: QuoteOptionId | null): T[] {
  const rec = (o: T) => (o.recommended || o.option_id === recommended ? 1 : 0);
  return [...options].sort((a, b) => rec(b) - rec(a) || a.option_id.localeCompare(b.option_id));
}

const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

/** The accept token: the last path segment of quote.accept_url (https://…/quote/<token>). Null if it isn't one. */
export function acceptToken(acceptUrl: string | null | undefined): string | null {
  if (!acceptUrl) return null;
  try {
    const last = new URL(acceptUrl, "http://localhost").pathname.split("/").filter(Boolean).pop() ?? "";
    const token = decodeURIComponent(last);
    return TOKEN_RE.test(token) ? token : null;
  } catch {
    return null;
  }
}

/** The quote page on this site (same page as accept_url, without depending on PUBLIC_BASE_URL matching the host). */
export const quotePath = (token: string) => `/quote/${encodeURIComponent(token)}`;

/**
 * "Prefer email? Reply “yes” to the quote email for option B, or name A, B or C." Without Accept buttons (`buttons`
 * false) email is the only way, so the "Prefer email?" lead-in goes.
 */
export function emailHint(ids: readonly QuoteOptionId[], recommended: QuoteOptionId | null, buttons = true): string {
  const lead = buttons ? "Prefer email? Reply" : "Reply";
  if (ids.length <= 1) return `${lead} “yes” to the quote email.`;
  return `${lead} “yes” to the quote email for option ${recommended ?? ids[0]}, or name ${listText(ids)}.`;
}

/** The quote's opening line. With no usable accept link there are no buttons, so it points at the email reply instead. */
export function introText(buttons: boolean): string {
  return buttons
    ? "Checking which data can answer your question was free. Choose an option to go ahead: nothing is bought or charged until you do."
    : "Checking which data can answer your question was free. To go ahead, reply to the quote email with the option you want: nothing is bought or charged until you do.";
}

export const validUntilText = (iso: string | null) => (iso ? `Valid until ${dateUtc(iso)}.` : null);

/** "You chose option B (Sharp archive image) on Nov 8, 2026" */
export function chosenText(q: Pick<PublicQuote, "options">, optionId: QuoteOptionId, at: string | null): string {
  const label = q.options.find((o) => o.option_id === optionId)?.label.trim();
  return `You chose option ${optionId}${label ? ` (${label})` : ""}${at ? ` on ${dateUtc(at)}` : ""}`;
}

/** /demo's version of the paid-option line: the live demo leaves the purchase step unnarrated. */
export const DEMO_PAID_AFTER_CHOICE = "The imagery is being ordered, and the analysis starts as soon as it arrives. This page updates on its own.";

/** What happens after the choice: paid data waits while a founder buys it by hand; free data goes straight to analysis. */
export function afterChoiceText(kind: QuoteOptionKind | undefined): string {
  return kind && kind !== "free_data"
    ? "A founder buys the imagery by hand, and the analysis starts as soon as it arrives. This page updates on its own."
    : "The agents start on the analysis now. This page updates on its own, and the answer also arrives by email.";
}

export type QuoteState =
  | { kind: "open"; token: string | null }
  | { kind: "accepted"; optionId: QuoteOptionId; at: string | null }
  | { kind: "closed"; reason: Exclude<QuoteClosedReason, "accepted"> };

/** Open (buttons when there's a token), accepted, or closed for good (expired, replaced, request closed). */
export function quoteState(q: Pick<PublicQuote, "accepted_option_id" | "accepted_at" | "closed_reason" | "accept_url">): QuoteState {
  if (q.accepted_option_id) return { kind: "accepted", optionId: q.accepted_option_id, at: q.accepted_at };
  if (q.closed_reason && q.closed_reason !== "accepted") return { kind: "closed", reason: q.closed_reason };
  return { kind: "open", token: acceptToken(q.accept_url) };
}

/** Same words as QUOTE_ACCEPT_ERRORS (src/lib/dashboard/public.ts), which this client file can't import. */
export const CLOSED_TEXT: Record<Exclude<QuoteClosedReason, "accepted">, string> = {
  expired: "This quote has expired. Reply to the quote email and we'll price it again.",
  superseded: "A newer quote replaced this one. Check your email for it.",
  closed: "This request is closed, so its quote can't be accepted.",
};

export const NETWORK_ERROR = "We couldn't reach Terragent just now. Check your connection and try again, or reply to the quote email with the option you want.";
const FALLBACK_ERROR = "We couldn't record that just now. Try again in a minute, or reply to the quote email with the option you want.";
const RATE_LIMITED = "Too many tries from your network. Wait a minute and try again, or reply to the quote email.";

const isOptionId = (v: unknown): v is QuoteOptionId => v === "A" || v === "B" || v === "C";

export type AcceptResult =
  | { ok: true; optionId: QuoteOptionId; already: boolean }
  | { ok: false; message: string; acceptedOptionId: QuoteOptionId | null };

/**
 * POST /api/quotes/accept's answer. 200 is success, already_accepted (a double click or retry) included. Every error
 * carries a customer-ready `message`; a body without one (proxy error page, empty 502) gets a plain fallback.
 */
export function readAcceptResponse(status: number, body: unknown, asked: QuoteOptionId): AcceptResult {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (status === 200) return { ok: true, optionId: isOptionId(b.accepted_option_id) ? b.accepted_option_id : asked, already: b.already_accepted === true };
  const message = typeof b.message === "string" && b.message.trim() ? b.message.trim() : status === 429 ? RATE_LIMITED : FALLBACK_ERROR;
  return { ok: false, message, acceptedOptionId: isOptionId(b.accepted_option_id) ? b.accepted_option_id : null };
}

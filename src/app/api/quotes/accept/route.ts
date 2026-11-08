/**
 * POST /api/quotes/accept { token, option_id } — the customer picks one option of their quote from the accept link
 * (/quote/<token>) or the status page. Same service as comms-customer's accept_quote tool (acceptQuoteByToken →
 * acceptQuote), with actor "customer (link)". JSON in → JSON out; a plain form post (the quote page) → 303 back to the
 * quote page.
 *
 * - The token (quotes.accept_token) is the only credential, and it can only ever accept that one quote.
 * - Idempotent: the same option again answers 200 with already_accepted; a different option after acceptance is 409
 *   (the customer replies to the email to change it). Posts for one token are serialised per instance, so a
 *   double-click can't start the work twice.
 * - Rate-limited per IP in memory (no database write per hit, NOTES H4c); malformed tokens never reach the database.
 * - There is no GET: link prefetchers and scanners must never accept a quote.
 */
import { isFormPost, json, readBody } from "@/app/_lib/http";
import { clientIp, hitMemoryLimit } from "@/lib/api-keys";
import { invalidateDashboard } from "@/lib/dashboard/cache";
import { getQuoteByToken, QUOTE_ACCEPT_ERRORS, QUOTE_TOKEN_RE } from "@/lib/dashboard/public";
import { QuoteOptionId } from "@/lib/domain";
import { acceptQuoteByToken, type AcceptErrorCode, LINK_ACTOR, QuoteAcceptError } from "@/lib/pipeline/acceptance";

/** Accept posts per IP per minute: a person clicks once or twice; this still covers a shared venue NAT. */
const ACCEPTS_PER_MINUTE = 20;

interface Outcome { status: number; body: Record<string, unknown> }

/** acceptQuote's refusals → HTTP status and the public error code (QUOTE_ACCEPT_ERRORS has the customer's wording). */
const REFUSALS: Record<AcceptErrorCode, [number, string]> = {
  not_found: [404, "not_found"],
  no_quote: [404, "not_found"],
  free_sample: [404, "not_found"],
  bad_option: [400, "unknown_option"],
  superseded: [409, "superseded"],
  expired: [410, "expired"],
  already_accepted: [409, "already_accepted"],
  not_acceptable: [409, "not_acceptable"],
  closed: [409, "closed"],
};

const inFlight = new Map<string, Promise<Outcome>>();

export async function POST(req: Request) {
  const form = isFormPost(req);
  const body = await readBody(req);
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  const limit = hitMemoryLimit(`quote-accept:${clientIp(req)}`, ACCEPTS_PER_MINUTE, 60_000);
  if (!limit.allowed) {
    return respond(form, token, { status: 429, body: { error: "rate_limited", retry_after_s: limit.resetSeconds } }, { "Retry-After": String(limit.resetSeconds) });
  }
  const option = QuoteOptionId.safeParse(typeof body?.option_id === "string" ? body.option_id.trim().toUpperCase() : body?.option_id);
  if (!QUOTE_TOKEN_RE.test(token) || !option.success) return json({ error: "invalid_request", message: "Send token and option_id (A, B or C)." }, 400);

  // One acceptance at a time per token on this instance (acceptQuote's atomic claim covers other instances): a second
  // click waits for the first, then gets already_accepted instead of racing it.
  const run = (inFlight.get(token) ?? Promise.resolve(null)).catch(() => null).then(() => accept(token, option.data));
  inFlight.set(token, run);
  try {
    return respond(form, token, await run);
  } finally {
    if (inFlight.get(token) === run) inFlight.delete(token);
  }
}

async function accept(token: string, optionId: QuoteOptionId): Promise<Outcome> {
  try {
    const r = await acceptQuoteByToken({ token, optionId, actor: LINK_ACTOR, evidence: `Chose option ${optionId} on the quote page (accept link).` });
    if (!r.already_accepted) invalidateDashboard(); // the status page and dashboard show it on their next poll
    return { status: 200, body: { request_id: r.request_id, status: r.status, accepted_option_id: r.option_id, already_accepted: r.already_accepted } };
  } catch (e) {
    if (e instanceof QuoteAcceptError) {
      const [status, error] = REFUSALS[e.code] ?? [409, "not_acceptable"];
      // The refusal's own message is written for agents; the customer gets QUOTE_ACCEPT_ERRORS. Say which option won.
      const accepted = e.code === "already_accepted" ? (await getQuoteByToken(token).catch(() => null))?.quote.accepted_option_id : undefined;
      return { status, body: { error, ...(accepted ? { accepted_option_id: accepted } : {}) } };
    }
    console.error("[quotes/accept] accept failed:", e);
    return { status: 503, body: { error: "unavailable" } };
  }
}

/** A form post goes back to the quote page (which shows the accepted state or the error); JSON callers get JSON. */
function respond(form: boolean, token: string, o: Outcome, headers: Record<string, string> = {}): Response {
  const error = typeof o.body.error === "string" ? o.body.error : null;
  if (form && QUOTE_TOKEN_RE.test(token)) {
    const location = `/quote/${encodeURIComponent(token)}${error ? `?error=${encodeURIComponent(error)}` : ""}`;
    return new Response(null, { status: 303, headers: { location, "cache-control": "no-store", ...headers } });
  }
  const message = error ? QUOTE_ACCEPT_ERRORS[error] : undefined;
  return json(message ? { ...o.body, message } : o.body, o.status, headers);
}

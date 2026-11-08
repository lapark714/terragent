/**
 * Status of an API request: its quote once priced, and once delivered the answer summary and the report link. Only
 * the creating key may read it.
 *
 * Pricing v2: nothing beyond the free investigation runs until the client ACCEPTS one of the quote's options. An API
 * request usually has no email, so this response is where the client finds the options and how to accept:
 * `quote.accept_url` (the quote page) and `quote.accept` ({ method, url, body } for POST /api/quotes/accept). The
 * legacy single-price fields (price_usd = the recommended option, line_items, payment_link) stay for older clients.
 */
import { json } from "@/app/_lib/http";
import { apiKeyFromRequest, hitRateLimit, rateLimitHeaders, verifyApiKey } from "@/lib/api-keys";
import { type ApiQuote, getApiRequest, getRequestProgress, type PublicQuote } from "@/lib/dashboard/public";
import { publicBaseUrl } from "@/lib/env";

/** The quote as the API shows it: legacy fields, the options (PublicQuote) and a ready-to-send accept call while open. */
function apiQuote(legacy: ApiQuote | null, options: PublicQuote | null | undefined) {
  if (!legacy) return null;
  if (!options) {
    // A quote from before options (pricing v1): no accept link; such quotes are re-priced before anything runs.
    return {
      ...legacy, options: [], recommended_option_id: null, accepted_option_id: null, accepted_at: null, valid_until: null, closed_reason: null,
      accept_url: null, accept: null,
    };
  }
  const token = options.accept_url ? decodeURIComponent(new URL(options.accept_url).pathname.split("/").pop() ?? "") : null;
  return {
    ...legacy,
    status: options.status,
    options: options.options,
    recommended_option_id: options.recommended_option_id,
    accepted_option_id: options.accepted_option_id,
    accepted_at: options.accepted_at,
    valid_until: options.valid_until,
    closed_reason: options.closed_reason,
    accept_url: options.accept_url,
    /** Accept by API: send this body with option_id set to the option you choose (the recommended one is marked). */
    accept: token
      ? { method: "POST", url: `${publicBaseUrl()}/api/quotes/accept`, body: { token, option_id: options.recommended_option_id ?? options.options[0]?.option_id ?? "A" } }
      : null,
  };
}

/** Polling is cheap but not free: allow far more reads than writes per key. */
const POLLS_PER_REQUEST = 20;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const key = await verifyApiKey(apiKeyFromRequest(req));
  if (!key) return json({ error: "invalid_api_key" }, 401);
  const limit = await hitRateLimit(`poll:${key.id}`, key.rate_per_hour * POLLS_PER_REQUEST);
  const headers = rateLimitHeaders(limit);
  if (!limit.allowed) return json({ error: "rate_limited", retry_after_s: limit.resetSeconds }, 429, headers);

  const { id } = await params;
  const api = await getApiRequest(id);
  const progress = api && api.keyId === key.id ? await getRequestProgress(id) : null;
  if (!api || !progress) return json({ error: "not_found" }, 404, headers);
  return json(
    {
      request_id: progress.id,
      status: progress.status,
      done: progress.terminal,
      created_at: progress.createdAt,
      updated_at: progress.updatedAt,
      refusal_reason: progress.refusalReason,
      quote: apiQuote(api.quote, progress.quote),
      report: progress.report && {
        url: progress.report.url,
        title: progress.report.title,
        answer: progress.report.answer,
        confidence: progress.report.confidence,
        limitations: progress.report.limitations,
        human_review_recommended: progress.report.humanReview,
      },
    },
    200,
    headers,
  );
}

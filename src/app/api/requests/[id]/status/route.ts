/**
 * Progress of one request for its status page. The request id is the capability. Public and polled by every open
 * status tab, so it reads through the dashboard cache (one read per id per window, misses included) and the
 * database-paused breaker, and an in-memory per-IP cap stops a flood of made-up ids from reaching Neon
 * (NOTES H4c) without a database write per hit.
 *
 * Once priced (pricing v2) the body carries `quote`: the customer-facing options, `recommended_option_id`,
 * `accepted_option_id` and `accept_url` (the quote page, null once it can't be accepted). Accepting goes through
 * POST /api/quotes/accept, never through this GET. Shape: PublicQuote in src/lib/dashboard/public.ts.
 */
import { json } from "@/app/_lib/http";
import { clientIp, hitMemoryLimit } from "@/lib/api-keys";
import { cachedRequestProgress, isCachedFresh, statusCacheKey } from "@/lib/dashboard/cache";
import { REQUEST_ID_RE } from "@/lib/dashboard/public";
import { DbPausedError } from "@/lib/dashboard/rows";

/** Reads that miss the cache, per IP per minute: a status tab polls 6–8 times a minute, so this covers a busy venue NAT. */
const STATUS_MISSES_PER_MINUTE = 240;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!REQUEST_ID_RE.test(id)) return json({ error: "not_found" }, 404);
  if (!isCachedFresh(statusCacheKey(id))) {
    const limit = hitMemoryLimit(`status:${clientIp(req)}`, STATUS_MISSES_PER_MINUTE, 60_000);
    if (!limit.allowed) return json({ error: "rate_limited", retry_after_s: limit.resetSeconds }, 429, { "Retry-After": String(limit.resetSeconds) });
  }
  try {
    const progress = await cachedRequestProgress(id);
    return progress ? json(progress) : json({ error: "not_found" }, 404);
  } catch (e) {
    if (e instanceof DbPausedError) return json({ error: "db_suspended" }, 503, { "Retry-After": "60" });
    console.error("[status] request progress failed:", e);
    return json({ error: "unavailable" }, 503);
  }
}

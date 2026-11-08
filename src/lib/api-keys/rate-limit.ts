/**
 * Fixed hourly window counter in `rate_limits`, one atomic upsert per hit (safe under concurrency).
 * Buckets: `key:<api key id>` for the public API, `ip:<address>` for the portal form.
 */
import { getDb } from "../db/client";

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  count: number;
  remaining: number;
  /** Seconds until the current window ends. */
  resetSeconds: number;
}

export async function hitRateLimit(bucket: string, limit: number): Promise<RateLimitResult> {
  const db = await getDb();
  const [row] = await db.query<{ count: number; reset_s: number }>(
    `INSERT INTO rate_limits (bucket, window_start, count) VALUES ($1, date_trunc('hour', now()), 1)
     ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limits.count + 1
     RETURNING count, ceil(extract(epoch FROM (window_start + interval '1 hour' - now())))::int AS reset_s`,
    [bucket],
  );
  const count = Number(row.count);
  // First hit of a new window: drop this bucket's old windows so the table stays small.
  if (count === 1) {
    await db.query("DELETE FROM rate_limits WHERE bucket = $1 AND window_start < date_trunc('hour', now())", [bucket]);
  }
  return {
    allowed: count <= limit,
    limit,
    count,
    remaining: Math.max(0, limit - count),
    resetSeconds: Math.max(0, Number(row.reset_s)),
  };
}

export function rateLimitHeaders(r: RateLimitResult): Record<string, string> {
  const h: Record<string, string> = {
    "RateLimit-Limit": String(r.limit),
    "RateLimit-Remaining": String(r.remaining),
    "RateLimit-Reset": String(r.resetSeconds),
  };
  if (!r.allowed) h["Retry-After"] = String(r.resetSeconds);
  return h;
}

/** Caller's IP as seen by Vercel (first x-forwarded-for hop), or "unknown". */
export function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.headers.get("x-real-ip")?.trim() || "unknown";
}

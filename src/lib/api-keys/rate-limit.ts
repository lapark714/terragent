/**
 * Fixed hourly window counter in `rate_limits`, one atomic upsert per hit (safe under concurrency).
 * Buckets: `key:<api key id>` for the public API, `ip:<address>` for the portal form.
 * `hitMemoryLimit` is the cheap per-instance variant for public read endpoints, where a database write per hit
 * would cost more than the read it protects (Neon $250 rule, NOTES H4c).
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

interface MemoryWindow { start: number; count: number }
const memoryWindows = new Map<string, MemoryWindow>();
/** Buckets kept per instance; past this, finished windows are dropped first, then the oldest. */
const MAX_MEMORY_BUCKETS = 5_000;

/**
 * Fixed-window counter in this server instance's memory: no database write, so it can guard unauthenticated polling.
 * Per instance only (a determined caller spread over instances gets more), which is enough to stop one client
 * from hammering the database through a cache miss per request.
 */
export function hitMemoryLimit(bucket: string, limit: number, windowMs: number, now = Date.now()): RateLimitResult {
  let w = memoryWindows.get(bucket);
  if (!w || now - w.start >= windowMs) {
    if (memoryWindows.size >= MAX_MEMORY_BUCKETS) {
      for (const [k, v] of memoryWindows) if (now - v.start >= windowMs) memoryWindows.delete(k);
      for (const k of memoryWindows.keys()) {
        if (memoryWindows.size < MAX_MEMORY_BUCKETS) break;
        memoryWindows.delete(k);
      }
    }
    w = { start: now, count: 0 };
    memoryWindows.delete(bucket);
    memoryWindows.set(bucket, w);
  }
  w.count++;
  return {
    allowed: w.count <= limit,
    limit,
    count: w.count,
    remaining: Math.max(0, limit - w.count),
    resetSeconds: Math.max(0, Math.ceil((w.start + windowMs - now) / 1000)),
  };
}

/** Test hook. */
export function resetMemoryLimits() {
  memoryWindows.clear();
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

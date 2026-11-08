/**
 * Small helpers shared by the dashboard queries: value coercion, a TTL cache for remote calls, and the
 * database-paused circuit breaker (Neon suspends compute when a quota is hit; NOTES H4c).
 */
import { env, isOffline } from "../env";
import type { Live, Panel } from "./types";

/** Postgres numeric/bigint arrive as strings from Neon; normalise to numbers. */
export function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : num(v);
}

/** timestamptz arrives as a Date (PGlite, Neon) or a string; always return ISO 8601. */
export function iso(v: unknown): string {
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

export function isoOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : iso(v);
}

// ---------------------------------------------------------------------------
// Database paused (Neon quota hit): stop querying for a while instead of retrying on every poll.
// ---------------------------------------------------------------------------

/** How long dashboard reads stay off after Neon says the compute is suspended or a quota is used up. */
export const DB_PAUSE_MS = 60_000;
export const DB_PAUSED_MESSAGE = "Database paused: a Neon quota was hit (NOTES H4c).";

/**
 * Neon's wording when a project hits a quota: "Your account or project has exceeded the compute time quota",
 * "compute is suspended until the next billing period", "data transfer quota", "endpoint is disabled".
 */
const SUSPENDED_RE =
  /compute (?:is |has been )?suspended|suspended until|\bquotas?\b|(?:has|have) exceeded|exceeded (?:the|your|its|our)\b|endpoint (?:is|has been) disabled|project (?:is |has been )?suspended/i;

export function isDbSuspendedError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.message} ${e.cause instanceof Error ? e.cause.message : ""}` : String(e);
  return SUSPENDED_RE.test(msg);
}

export class DbPausedError extends Error {
  readonly suspended = true;
  constructor(cause?: unknown) {
    super(DB_PAUSED_MESSAGE, cause === undefined ? undefined : { cause });
    this.name = "DbPausedError";
  }
}

let pausedUntil = 0;

export const isDbPaused = () => Date.now() < pausedUntil;

/** Test hook. */
export function resetDbPause() {
  pausedUntil = 0;
}

/**
 * Runs one dashboard read. While the breaker is open it throws DbPausedError without touching the database;
 * a suspension error opens it for DB_PAUSE_MS (no retry loop, whatever the number of viewers).
 */
export async function dbRead<T>(fn: () => Promise<T>): Promise<T> {
  if (isDbPaused()) throw new DbPausedError();
  try {
    return await fn();
  } catch (e) {
    if (e instanceof DbPausedError) throw e;
    if (isDbSuspendedError(e)) {
      pausedUntil = Date.now() + DB_PAUSE_MS;
      throw new DbPausedError(e);
    }
    throw e;
  }
}

/** Runs a panel query; a failure becomes `{ ok: false }` so the other panels still render. */
export async function panel<T>(fn: () => Promise<T>): Promise<Panel<T>> {
  try {
    return { ok: true, data: await dbRead(fn) };
  } catch (e) {
    if (e instanceof DbPausedError) return { ok: false, error: e.message, suspended: true };
    console.error("[dashboard] panel query failed:", e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** True if any of these panels failed because the database is paused. */
export const anySuspended = (...panels: Panel<unknown>[]) => panels.some((p) => !p.ok && p.suspended === true);

const cache = new Map<string, { expires: number; value: Promise<unknown> }>();

/**
 * Calls a remote service (Naïve) at most once per `ttlMs` per server instance, so a room full of
 * dashboards polling every few seconds doesn't hammer the API. Missing credentials → not_configured;
 * offline mode (npm run dev:local) → offline, with no network call at all.
 */
export async function live<T>(key: string, ttlMs: number, fn: () => Promise<T>, requiredEnv = "NAIVE_API_KEY"): Promise<Live<T>> {
  if (isOffline()) return { state: "offline" };
  if (!env(requiredEnv)) return { state: "not_configured" };
  const hit = cache.get(key);
  if (!hit || hit.expires < Date.now()) cache.set(key, { expires: Date.now() + ttlMs, value: fn() });
  try {
    return { state: "ok", data: (await cache.get(key)!.value) as T };
  } catch (e) {
    return { state: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

/** Drops cached remote results, e.g. after an admin action changed them. */
export function invalidateLive(key?: string) {
  if (key) cache.delete(key);
  else cache.clear();
}

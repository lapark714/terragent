/** Small helpers shared by the dashboard queries: value coercion and a TTL cache for remote calls. */
import { env } from "../env";
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

/** Runs a panel query; a failure becomes `{ ok: false }` so the other panels still render. */
export async function panel<T>(fn: () => Promise<T>): Promise<Panel<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    console.error("[dashboard] panel query failed:", e);
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const cache = new Map<string, { expires: number; value: Promise<unknown> }>();

/**
 * Calls a remote service (Naïve) at most once per `ttlMs` per server instance, so a room full of
 * dashboards polling every few seconds doesn't hammer the API. Missing credentials → not_configured.
 */
export async function live<T>(key: string, ttlMs: number, fn: () => Promise<T>, requiredEnv = "NAIVE_API_KEY"): Promise<Live<T>> {
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

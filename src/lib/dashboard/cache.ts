/**
 * Server-side cache for the dashboard reads (Neon $250 rule, NOTES H4c). Every viewer polls every few seconds;
 * this keeps it to ONE database read per window per server instance, however many people are watching:
 * concurrent requests share the in-flight read, and the result is reused until it expires. No timers, no
 * keep-alive polling: a window is only refreshed when someone asks after it expired.
 *
 * Per-instance on purpose (plain memory, like `live()` in rows.ts): results are public, PII-masked JSON, and an
 * admin action can drop them at once (invalidateDashboard) so founders see their decision on the next poll.
 */
import { getApprovals } from "./approvals";
import { getGlobeData } from "./globe";
import { getOverview } from "./overview";
import { anySuspended, DB_PAUSE_MS, dbRead, panel } from "./rows";
import { getLiveSnapshot } from "./snapshot";
import type { Approvals, GlobeData, LiveSnapshot, OverviewResponse } from "./types";

/** One read per this window. Viewers poll every 6–10 s, so 5 s keeps the board feeling live. */
export const DASHBOARD_TTL_MS = 5_000;
/** A read that is still running after this long no longer blocks a fresh one. */
const IN_FLIGHT_MAX_MS = 30_000;

interface Entry { expires: number; value: Promise<unknown> }
const entries = new Map<string, Entry>();

/**
 * Returns the cached value for `key`, or runs `fn` once and shares it. A failed read is cached too (for
 * DASHBOARD_TTL_MS), so a broken database is not hit again by every viewer. `ttlFor` may lengthen the window.
 */
export function cached<T>(key: string, fn: () => Promise<T>, ttlFor: (value: T) => number = () => DASHBOARD_TTL_MS): Promise<T> {
  const hit = entries.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as Promise<T>;
  const entry: Entry = { expires: Date.now() + IN_FLIGHT_MAX_MS, value: Promise.resolve() };
  entry.value = fn().then(
    (v) => {
      entry.expires = Date.now() + ttlFor(v);
      return v;
    },
    (e: unknown) => {
      entry.expires = Date.now() + DASHBOARD_TTL_MS;
      throw e;
    },
  );
  entries.set(key, entry);
  return entry.value as Promise<T>;
}

/** Drops every cached dashboard read (after a founder action, or in tests). */
export function invalidateDashboard() {
  entries.clear();
}

const pausedTtl = (suspended: boolean) => (suspended ? DB_PAUSE_MS : DASHBOARD_TTL_MS);

export const cachedLiveSnapshot = (): Promise<LiveSnapshot> => cached("live", getLiveSnapshot, (s) => pausedTtl(s.dbSuspended));

export const cachedOverview = (): Promise<OverviewResponse> =>
  cached(
    "overview",
    async () => {
      const p = await panel(getOverview);
      return { ...p, dbSuspended: anySuspended(p) };
    },
    (o) => pausedTtl(o.dbSuspended),
  );

export const cachedGlobe = (): Promise<GlobeData> => cached("globe", () => dbRead(getGlobeData));

export const cachedApprovals = (): Promise<Approvals> => cached("approvals", () => dbRead(getApprovals));

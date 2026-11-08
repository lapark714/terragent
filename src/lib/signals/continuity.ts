/**
 * Ongoing fires and clearing fronts keep the external_id they were first stored under. Pixel clusters are
 * rebuilt on every poll, and a computed key can't follow an event whose centre drifts as it grows or whose
 * first-seen date slides with the poll window. So a cluster that lies within reach of a recently stored signal
 * of the same feed takes that signal's id, and the (feed, external_id) dedupe on insert treats it as known.
 */
import { greatCircleDistance, UNITS } from "h3-js";
import { getDb } from "../db/client";
import type { SignalFeed, SignalInput } from "../domain";
import { DAY_MS } from "./types";

/** Feeds whose signals are point clusters (cluster.ts); blm_claims is pending its SIGNAL_FEEDS entry. */
export const CLUSTERED_FEEDS: ReadonlySet<string> = new Set(["firms", "gfw", "blm_claims"]);
const WINDOW_DAYS = 14;
/** Slack on top of both footprints: the gap that clusterPoints would still have chained (~2-3 km). */
const MARGIN_KM = 2;

interface Prior {
  external_id: string;
  lat: number;
  lon: number;
  radius_km: string | null;
}

export async function carryForwardIds(feed: SignalFeed, signals: SignalInput[], now = new Date()): Promise<SignalInput[]> {
  if (!signals.some((s) => s.lat !== null && s.lon !== null)) return signals;
  const db = await getDb();
  const prior = await db.query<Prior>(
    `SELECT external_id, lat, lon, raw->>'radius_km' AS radius_km FROM signals
     WHERE feed = $1 AND lat IS NOT NULL AND lon IS NOT NULL AND event_time >= $2`,
    [feed, new Date(now.getTime() - WINDOW_DAYS * DAY_MS).toISOString()],
  );
  if (!prior.length) return signals;
  return signals.map((s) => {
    if (s.lat === null || s.lon === null) return s;
    const reach = Number(s.raw.radius_km ?? 0) + MARGIN_KM;
    let best: { id: string; km: number } | null = null;
    for (const p of prior) {
      const km = greatCircleDistance([s.lat, s.lon], [p.lat, p.lon], UNITS.km);
      if (km <= reach + Number(p.radius_km ?? 0) && (!best || km < best.km)) best = { id: p.external_id, km };
    }
    return best ? { ...s, external_id: best.id } : s;
  });
}

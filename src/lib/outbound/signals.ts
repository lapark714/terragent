/**
 * Signal engine storage: poll a playbook's feeds, store new events (deduped on feed + external_id),
 * list them, and record the sourcing agent's triage (matched / ignored).
 */
import { getHexagonAreaAvg, UNITS } from "h3-js";
import { getDb } from "../db/client";
import { SignalInput, type Polygon } from "../domain";
import { logDecision, logEvent } from "../events";
import { bboxAreaKm2, pointCell, polygonBbox, polygonCells } from "../geo/h3";
import { newId } from "../ids";
import { FEEDS_BY_PLAYBOOK, pollFeed } from "../signals";
import { fail } from "./errors";
import { hoursAgo, iso, truncate, type OutboundPlaybook } from "./util";

/** Big alert polygons (counties, states) are stored at a coarser H3 resolution to stay under this. */
const MAX_SIGNAL_CELLS = 300;
const MAX_RETURNED = 40;

export interface CompactSignal {
  id: string;
  playbook: string;
  feed: string;
  title: string;
  severity: string | null;
  event_time: string | null;
  lat: number | null;
  lon: number | null;
  h3_cells: number;
}

/** H3 cells for a signal: finest resolution (8 → 4) whose estimated cell count fits, else its point. */
export function signalCells(s: Pick<SignalInput, "geometry" | "lat" | "lon">): string[] {
  if (s.geometry) {
    const area = bboxAreaKm2(polygonBbox(s.geometry));
    const res = [8, 7, 6, 5, 4].find((r) => area / getHexagonAreaAvg(r, UNITS.km2) <= MAX_SIGNAL_CELLS) ?? 4;
    try {
      return polygonCells(s.geometry, res).slice(0, MAX_SIGNAL_CELLS);
    } catch {
      // malformed ring → fall through to the point
    }
  }
  return s.lat !== null && s.lon !== null ? [pointCell(s.lat, s.lon)] : [];
}

function centre(g: Polygon): { lat: number; lon: number } {
  const [minLon, minLat, maxLon, maxLat] = polygonBbox(g);
  return { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 };
}

/**
 * The feed gets the polling playbook (firms picks forest-watch regions for deforestation, the US otherwise) and the
 * agent (spend attribution). Paid feeds (news via Monid) run unless `allowPaid` is false; monidRun enforces the caps.
 */
export async function pollSignals(a: { playbook: OutboundPlaybook; sinceHours?: number; limitPerFeed?: number; allowPaid?: boolean; actor: string }) {
  const feeds = FEEDS_BY_PLAYBOOK[a.playbook];
  if (!feeds) fail(`playbook ${a.playbook} has no signal feeds`);
  const db = await getDb();
  const since = a.sinceHours ? hoursAgo(a.sinceHours) : undefined;
  const warnings: string[] = [];
  const perFeed: { feed: string; fetched: number; new: number }[] = [];
  const fresh: CompactSignal[] = [];

  // Fetch every feed at once (the MCP call has to finish well inside Vercel's 300 s), then store in feed order.
  const results = await Promise.all(
    feeds.map((feed) =>
      pollFeed(feed, { since, limit: a.limitPerFeed ?? 50, playbook: a.playbook, agent: a.actor, allowPaid: a.allowPaid ?? true }).catch((e: unknown) => ({
        signals: [] as SignalInput[],
        warnings: [e instanceof Error ? e.message : String(e)],
      })),
    ),
  );
  for (const [i, feed] of feeds.entries()) {
    const fetched = results[i].signals;
    warnings.push(...results[i].warnings.map((w) => `${feed}: ${w}`));
    // Most alerts persist across polls: skip known ones before computing cells (the insert still dedupes races).
    const known = new Set(
      (await db.query<{ external_id: string }>("SELECT external_id FROM signals WHERE feed = $1 AND external_id = ANY($2)",
        [feed, fetched.map((f) => String(f?.external_id))])).map((r) => r.external_id),
    );
    let added = 0;
    for (const candidate of fetched) {
      if (known.has(String(candidate?.external_id))) continue;
      const parsed = SignalInput.safeParse({ ...candidate, playbook: a.playbook });
      if (!parsed.success) {
        warnings.push(`${feed}: skipped invalid signal ${candidate?.external_id ?? "?"}`);
        continue;
      }
      const s = parsed.data;
      const point = s.lat !== null && s.lon !== null ? { lat: s.lat, lon: s.lon } : s.geometry ? centre(s.geometry) : null;
      const cells = signalCells(s);
      const id = newId("signal");
      const rows = await db.query<{ id: string }>(
        `INSERT INTO signals (id, playbook, feed, external_id, title, severity, event_time, geometry, lat, lon, h3_cells, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (feed, external_id) DO NOTHING RETURNING id`,
        [id, s.playbook, s.feed, s.external_id, s.title, s.severity, s.event_time, s.geometry ? JSON.stringify(s.geometry) : null,
          point?.lat ?? null, point?.lon ?? null, cells, JSON.stringify(s.raw)],
      );
      if (!rows.length) continue;
      added++;
      fresh.push({ id, playbook: s.playbook, feed: s.feed, title: s.title, severity: s.severity, event_time: s.event_time,
        lat: point?.lat ?? null, lon: point?.lon ?? null, h3_cells: cells.length });
    }
    perFeed.push({ feed, fetched: fetched.length, new: added });
  }

  await logEvent("signals.polled", a.actor, { playbook: a.playbook, feeds: perFeed, new: fresh.length });
  return {
    playbook: a.playbook,
    feeds: perFeed,
    new_count: fresh.length,
    signals: fresh.slice(0, MAX_RETURNED),
    more: Math.max(0, fresh.length - MAX_RETURNED),
    warnings,
  };
}

export async function listSignals(f: { playbook?: string; status?: string; feed?: string; sinceHours?: number; limit?: number; includeRaw?: boolean }) {
  const db = await getDb();
  const rows = await db.query<Record<string, unknown>>(
    `SELECT id, playbook, feed, title, severity, event_time, lat, lon, cardinality(h3_cells) AS cells, status, status_reason, created_at, raw
     FROM signals
     WHERE ($1::text IS NULL OR playbook = $1) AND ($2::text IS NULL OR status = $2) AND ($3::text IS NULL OR feed = $3)
       AND created_at >= $4
     ORDER BY created_at DESC LIMIT $5`,
    [f.playbook ?? null, f.status ?? null, f.feed ?? null, f.sinceHours ? hoursAgo(f.sinceHours) : new Date(0), f.limit ?? 30],
  );
  return rows.map((r) => ({
    id: r.id as string,
    playbook: r.playbook as string,
    feed: r.feed as string,
    title: r.title as string,
    severity: (r.severity as string | null) ?? null,
    event_time: iso(r.event_time),
    lat: (r.lat as number | null) ?? null,
    lon: (r.lon as number | null) ?? null,
    h3_cells: Number(r.cells),
    status: r.status as string,
    status_reason: (r.status_reason as string | null) ?? null,
    created_at: iso(r.created_at),
    ...(f.includeRaw ? { raw: truncate(JSON.stringify(r.raw), 2000) } : {}),
  }));
}

/** Matches are judgement calls (decision log); ignores are routine triage (event only). */
export async function updateSignals(a: { ids: string[]; status: "matched" | "ignored"; reason: string; actor: string }) {
  const db = await getDb();
  const rows = await db.query<{ id: string }>(
    "UPDATE signals SET status = $1, status_reason = $2, updated_at = now() WHERE id = ANY($3) RETURNING id",
    [a.status, a.reason, a.ids],
  );
  const updated = rows.map((r) => r.id);
  const notFound = a.ids.filter((id) => !updated.includes(id));
  if (!updated.length) fail(`no signals found for ${a.ids.join(", ")}`);
  if (a.status === "matched") {
    await logDecision({ kind: "outreach", choice: `matched signal${updated.length > 1 ? "s" : ""} ${updated.join(", ")}`, reasoning: a.reason, agent: a.actor });
  } else {
    await logEvent("signals.ignored", a.actor, { ids: updated, reason: a.reason });
  }
  return { updated: updated.length, not_found: notFound };
}

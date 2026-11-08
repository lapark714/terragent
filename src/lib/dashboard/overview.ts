/** Headline counters and the recent activity feed. */
import { getDb } from "../db/client";
import { shortId } from "./mask";
import { iso, isoOrNull, num, numOrNull } from "./rows";
import type { ActivityRow, Overview } from "./types";

export async function getOverview(): Promise<Overview> {
  const db = await getDb();
  const [r] = await db.query<Record<string, unknown>>(
    `SELECT
       (SELECT count(*) FROM requests WHERE NOT is_free_sample)::int AS inbound,
       (SELECT count(*) FROM requests WHERE is_free_sample)::int AS samples,
       (SELECT count(*) FROM requests WHERE status NOT IN ('delivered', 'refused', 'failed', 'cancelled'))::int AS active,
       (SELECT count(*) FROM requests WHERE status = 'delivered')::int AS delivered,
       (SELECT count(*) FROM requests WHERE status = 'refused')::int AS refused,
       (SELECT count(*) FROM reports WHERE verifier_status = 'pass')::int AS verified_reports,
       (SELECT count(DISTINCT h3_cell) FROM earth_index)::int AS index_cells,
       (SELECT count(*) FROM interventions)::int AS interventions,
       (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (COALESCE(
            (SELECT min(e.created_at) FROM events e
             WHERE e.request_id = q.id AND e.type = 'status.changed' AND e.payload->>'to' = 'delivered'),
            q.updated_at) - q.created_at)))
          FROM requests q WHERE q.status = 'delivered' AND NOT q.is_free_sample)::float8 AS median_answer_s,
       (SELECT max(created_at) FROM events) AS last_event_at`,
  );
  return {
    inbound: num(r.inbound),
    samples: num(r.samples),
    active: num(r.active),
    delivered: num(r.delivered),
    refused: num(r.refused),
    verifiedReports: num(r.verified_reports),
    indexCells: num(r.index_cells),
    interventions: num(r.interventions),
    medianAnswerSeconds: numOrNull(r.median_answer_s),
    lastEventAt: isoOrNull(r.last_event_at),
  };
}

/** Latest events, without payloads (they may hold customer text). */
export async function getActivity(limit = 14): Promise<ActivityRow[]> {
  const db = await getDb();
  const rows = await db.query<{ id: string; type: string; actor: string; request_id: string | null; created_at: unknown }>(
    "SELECT id::text AS id, type, actor, request_id, created_at FROM events ORDER BY created_at DESC, id DESC LIMIT $1",
    [limit],
  );
  return rows.map((e) => ({ id: e.id, type: e.type, actor: e.actor, request: e.request_id ? shortId(e.request_id) : null, at: iso(e.created_at) }));
}

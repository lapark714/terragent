/** Headline counters and the recent activity feed. */
import { getDb } from "../db/client";
import { AgentName, DecisionKind, RequestStatus } from "../domain";
import { asPlaybook } from "./board";
import { shortId } from "./mask";
import { iso, isoOrNull, num, numOrNull } from "./rows";
import type { ActivityDetail, ActivityRow, Overview } from "./types";

/** First touches: prospects reached at least once, on any channel (same rule as the funnel). */
const SENT_TOUCH = "m.direction = 'outbound' AND m.kind = 'outreach' AND m.status = 'sent'";

export async function getOverview(): Promise<Overview> {
  const db = await getDb();
  const [r] = await db.query<Record<string, unknown>>(
    `SELECT
       (SELECT count(*) FROM requests WHERE NOT is_free_sample)::int AS inbound,
       (SELECT count(*) FROM requests WHERE is_free_sample)::int AS samples,
       (SELECT count(*) FROM requests WHERE NOT is_free_sample AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::int AS inbound_today,
       (SELECT count(*) FROM requests WHERE is_free_sample AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::int AS samples_today,
       (SELECT count(*) FROM requests WHERE status NOT IN ('delivered', 'refused', 'failed', 'cancelled'))::int AS active,
       (SELECT count(*) FROM requests WHERE status = 'delivered')::int AS delivered,
       (SELECT count(*) FROM requests q WHERE q.status = 'delivered'
          AND EXISTS (SELECT 1 FROM reports rp WHERE rp.request_id = q.id AND rp.verifier_status = 'pass'))::int AS reports_delivered,
       (SELECT count(*) FROM requests WHERE status = 'refused')::int AS refused,
       (SELECT count(*) FROM reports WHERE verifier_status = 'pass')::int AS verified_reports,
       (SELECT count(DISTINCT m.prospect_id) FROM messages m WHERE ${SENT_TOUCH})::int AS first_touches,
       (SELECT count(DISTINCT b.prospect_id) FROM messages b
          WHERE b.direction = 'outbound' AND b.kind = 'outreach' AND b.status = 'blocked' AND b.prospect_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.prospect_id = b.prospect_id AND ${SENT_TOUCH}))::int AS touches_held,
       (SELECT count(*) FROM prospects p WHERE p.status IN ('replied', 'quoted', 'paid')
          OR EXISTS (SELECT 1 FROM messages m WHERE m.prospect_id = p.id AND m.direction = 'inbound'))::int AS replies,
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
    inboundToday: num(r.inbound_today),
    samplesToday: num(r.samples_today),
    active: num(r.active),
    delivered: num(r.delivered),
    reportsDelivered: num(r.reports_delivered),
    refused: num(r.refused),
    verifiedReports: num(r.verified_reports),
    firstTouches: num(r.first_touches),
    touchesHeld: num(r.touches_held),
    replies: num(r.replies),
    indexCells: num(r.index_cells),
    interventions: num(r.interventions),
    medianAnswerSeconds: numOrNull(r.median_answer_s),
    lastEventAt: isoOrNull(r.last_event_at),
  };
}

/** Lower-case identifiers only (stage names, intervention actions, service names): never free text. */
const WORD = /^[a-z][a-z0-9_.-]{0,39}$/;
const word = (v: unknown) => (typeof v === "string" && WORD.test(v) ? v : undefined);

interface ActivityQueryRow {
  id: string; type: string; actor: string; request_id: string | null; playbook: string | null; created_at: unknown;
  p_to: string | null; p_agent: string | null; p_stage: string | null; p_kind: string | null; p_action: string | null; p_service: string | null;
}

/**
 * The enumerated bits of an event's payload worth showing ("→ planner, planning"). Payloads can carry customer
 * text, so only values that parse as a status, agent, decision kind or a lower-case identifier get through.
 */
export function activityDetail(type: string, p: Omit<ActivityQueryRow, "id" | "type" | "actor" | "request_id" | "playbook" | "created_at">): ActivityDetail | null {
  const d: ActivityDetail = {};
  const to = RequestStatus.safeParse(p.p_to);
  if (to.success) d.to = to.data;
  // A handoff's `to` is the next agent; offline.skipped and others name it `agent`.
  const agent = AgentName.safeParse(type === "handoff" ? p.p_to : p.p_agent);
  if (agent.success) d.agent = agent.data;
  const kind = DecisionKind.safeParse(p.p_kind);
  if (kind.success && type === "decision.logged") d.kind = kind.data;
  const stage = word(p.p_stage);
  if (stage) d.stage = stage;
  const action = word(p.p_action);
  if (action) d.action = action;
  const service = word(p.p_service);
  if (service) d.service = service;
  return Object.keys(d).length ? d : null;
}

/** Latest events, without payloads (they may hold customer text): only the safe, enumerated details above. */
export async function getActivity(limit = 14): Promise<ActivityRow[]> {
  const db = await getDb();
  const rows = await db.query<ActivityQueryRow>(
    `SELECT e.id::text AS id, e.type, e.actor, e.request_id, r.playbook, e.created_at,
            e.payload->>'to' AS p_to, e.payload->>'agent' AS p_agent, e.payload->>'stage' AS p_stage,
            e.payload->>'kind' AS p_kind, e.payload->>'action' AS p_action, e.payload->>'service' AS p_service
     FROM events e LEFT JOIN requests r ON r.id = e.request_id
     ORDER BY e.created_at DESC, e.id DESC LIMIT $1`,
    [limit],
  );
  return rows.map((e) => ({
    id: e.id,
    type: e.type,
    actor: e.actor,
    request: e.request_id ? shortId(e.request_id) : null,
    playbook: e.playbook ? asPlaybook(e.playbook) : null,
    detail: activityDetail(e.type, e),
    at: iso(e.created_at),
  }));
}

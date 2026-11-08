/**
 * Requests the coordinator should look at: stale (no update for N minutes), recently failed, waiting on a human, or a
 * dropped handoff: the customer or a founder did their part and the status still reads as waiting, but nobody is
 * working on it. A dropped handoff carries a `hint` naming the one call that recovers it; the gates in handoff() still
 * decide whether that call goes through.
 */
import { getDb } from "../db/client";
import { TERMINAL_STATUSES } from "../domain";
import { acceptedOptionBuysData } from "../pipeline/gates";
import { iso } from "./util";

/**
 * Failed is terminal: the coordinator can read why but not change it. So a failed request is listed only for this
 * long after it failed, or every review would re-read it and old failures would push newly stuck requests out of
 * the list.
 */
const FAILED_WITHIN_HOURS = 24;

const HINT_TOUCH_SENT =
  "first touch already sent: handoff to comms-outreach (stage outreach) once; its get_outreach_context closes it as delivered";

const HINT_QUOTE_NOT_SENT = "the quote was saved but never emailed: terragent.handoff once to comms-customer (stage quote) to call send_quote";
const HINT_QUOTE_EXPIRED = "the quote expired before it was ever sent: terragent.handoff once to pricing (stage pricing) for a fresh quote";
const HINT_QUESTION_NOT_SENT =
  "screening needs a clarifying question but none went out: terragent.handoff once to comms-customer (stage clarifying) to send_customer_message kind clarifying_question";
/** A successful handoff doesn't change either status (only a real send does), so without this every review would start another session. */
const HINT_ALREADY_RESENT =
  "you already handed this to comms-customer and it still hasn't gone out, so the send is probably blocked: don't hand off again; " +
  "terragent.add_note once saying a founder needs to look, and leave it";
const HINT_ACCEPTED_FREE = "the customer accepted a free-data option but the work never started: terragent.handoff once to analytics (stage analysis)";
const HINT_ACCEPTED_INDEX = "the customer accepted but the report never started, and the Earth index answers it: terragent.handoff once to interpreter (stage report)";
const HINT_ACCEPTED_PAID =
  "the customer accepted a paid-data option but its orders were never held for a founder: terragent.handoff once to acquisition (stage acquisition) " +
  "saying no order was held. Never analytics: the analysis waits for data a founder buys";
const HINT_DATA_DELIVERED =
  "a founder bought this data and marked it delivered, but the analysis never started: terragent.handoff once to acquisition (stage acquisition) saying " +
  "the paid data arrived but the analysis did not start, with the order ids. Nothing gets approved or bought by this";

interface StuckRow {
  id: string; status: string; owner_agent: string | null; stage: string | null; priority: string; playbook: string;
  is_free_sample: boolean; updated_at: unknown; touch_sent: boolean; reachable: boolean; screening_outcome: string | null; plan_choice: string | null;
  quote_status: string | null; accepted_option_id: string | null; quote_options: unknown; quote_expired: boolean;
  data_ready: boolean; question_asked: boolean; comms_resends: number;
}

/** Why this request is listed, and for a dropped handoff the call that recovers it. */
function diagnose(r: StuckRow): { reason: string; hint?: string } {
  const waiting = { reason: "waiting_on_customer" };
  switch (r.status) {
    case "failed":
      return { reason: "failed" };
    case "awaiting_approval":
      return r.data_ready ? { reason: "data_delivered_not_started", hint: HINT_DATA_DELIVERED } : { reason: "awaiting_approval" };
    case "quoted":
      if (r.quote_status === "accepted") return { reason: "accepted_not_started", hint: acceptedHint(r) };
      // With no email or thread (API) nobody has to send it: the client reads the quote from its status response.
      if (r.quote_status !== "approved" || !r.reachable) return waiting;
      return { reason: "quote_not_sent", hint: r.quote_expired ? HINT_QUOTE_EXPIRED : r.comms_resends ? HINT_ALREADY_RESENT : HINT_QUOTE_NOT_SENT };
    case "clarifying":
      if (r.question_asked || !r.reachable) return waiting;
      return questionNotSent(r);
    case "received":
    case "screening":
      return r.screening_outcome === "clarify" && r.reachable ? questionNotSent(r) : { reason: "stale" };
    default:
      return { reason: "stale" };
  }
}

const questionNotSent = (r: StuckRow) => ({ reason: "clarifying_not_sent", hint: r.comms_resends ? HINT_ALREADY_RESENT : HINT_QUESTION_NOT_SENT });

function acceptedHint(r: StuckRow): string {
  if (acceptedOptionBuysData({ accepted_option_id: r.accepted_option_id, options: r.quote_options }, r.plan_choice)) return HINT_ACCEPTED_PAID;
  return r.plan_choice === "existing_index" ? HINT_ACCEPTED_INDEX : HINT_ACCEPTED_FREE;
}

export async function listStuckRequests(f: { staleMinutes?: number; failedWithinHours?: number; limit?: number } = {}) {
  const db = await getDb();
  const cutoff = new Date(Date.now() - (f.staleMinutes ?? 60) * 60_000);
  const failedSince = new Date(Date.now() - (f.failedWithinHours ?? FAILED_WITHIN_HOURS) * 3_600_000);
  const rows = await db.query<StuckRow>(
    // Ones the coordinator can act on first (oldest first), then the recent failures.
    // data_ready: every paid order is delivered, the last of them long enough ago that markOrderDelivered's own handoff
    // has finished. A rejected or still-waiting order keeps the request with a founder; a supplier quote request is no order.
    // question_asked and comms_resends count from the request's latest status change (event ids, so no clock involved).
    `SELECT r.id, r.status, r.owner_agent, r.stage, r.priority, r.playbook, r.is_free_sample, r.updated_at,
            r.is_free_sample AND EXISTS (SELECT 1 FROM messages m WHERE m.request_id = r.id AND m.direction = 'outbound'
              AND m.kind = 'outreach' AND m.status = 'sent') AS touch_sent,
            NOT r.is_free_sample AND (r.customer_email IS NOT NULL OR r.thread_id IS NOT NULL) AS reachable,
            r.meta->'screening'->>'outcome' AS screening_outcome,
            r.acquisition_plan->>'choice' AS plan_choice,
            q.status AS quote_status, q.accepted_option_id, q.options AS quote_options,
            COALESCE(q.valid_until < now(), false) AS quote_expired,
            EXISTS (SELECT 1 FROM orders o WHERE o.request_id = r.id AND o.status = 'delivered')
              AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.request_id = r.id
                AND (o.status NOT IN ('delivered', 'quote_requested') OR (o.status = 'delivered' AND o.updated_at >= $2))) AS data_ready,
            EXISTS (SELECT 1 FROM events e WHERE e.request_id = r.id AND e.type = 'customer_message.sent'
              AND e.payload->>'kind' = 'clarifying_question' AND e.payload->>'status' = 'sent' AND e.id > changed.id) AS question_asked,
            (SELECT count(*)::int FROM events e WHERE e.request_id = r.id AND e.type = 'handoff' AND e.actor = 'coordinator'
              AND e.payload->>'to' = 'comms-customer' AND e.id > changed.id) AS comms_resends
     FROM requests r
     LEFT JOIN quotes q ON q.id = r.quote_id
     CROSS JOIN LATERAL (SELECT COALESCE(max(e.id), 0) AS id FROM events e WHERE e.request_id = r.id AND e.type = 'status.changed') changed
     WHERE (r.status = 'failed' AND r.updated_at >= $4) OR r.status = 'awaiting_approval'
        OR (NOT (r.status = ANY($1)) AND r.updated_at < $2)
     ORDER BY (r.status = 'failed'), r.updated_at ASC LIMIT $3`,
    [[...TERMINAL_STATUSES], cutoff, f.limit ?? 50, failedSince],
  );
  return rows.map((r) => {
    const { reason, hint } = diagnose(r);
    const shown = hint ?? (r.touch_sent && r.status !== "failed" ? HINT_TOUCH_SENT : undefined);
    return {
      id: r.id,
      reason,
      status: r.status,
      owner_agent: r.owner_agent,
      stage: r.stage,
      priority: r.priority,
      playbook: r.playbook,
      free_sample: r.is_free_sample,
      minutes_since_update: Math.round((Date.now() - new Date(String(iso(r.updated_at))).getTime()) / 60_000),
      ...(shown ? { hint: shown } : {}),
    };
  });
}

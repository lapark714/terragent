/** Requests the coordinator should look at: stale (no update for N minutes), recently failed, or waiting on a human. */
import { getDb } from "../db/client";
import { TERMINAL_STATUSES } from "../domain";
import { iso } from "./util";

/** Statuses where we are waiting on the customer, not on ourselves. */
const WAITING_ON_CUSTOMER = ["quoted", "clarifying"];

/**
 * Failed is terminal: the coordinator can read why but not change it. So a failed request is listed only for this
 * long after it failed, or every review would re-read it and old failures would push newly stuck requests out of
 * the list.
 */
const FAILED_WITHIN_HOURS = 24;

const HINT_TOUCH_SENT =
  "first touch already sent: handoff to comms-outreach (stage outreach) once; its get_outreach_context closes it as delivered";

export async function listStuckRequests(f: { staleMinutes?: number; failedWithinHours?: number; limit?: number } = {}) {
  const db = await getDb();
  const cutoff = new Date(Date.now() - (f.staleMinutes ?? 60) * 60_000);
  const failedSince = new Date(Date.now() - (f.failedWithinHours ?? FAILED_WITHIN_HOURS) * 3_600_000);
  const rows = await db.query<{
    id: string; status: string; owner_agent: string | null; stage: string | null; priority: string; playbook: string;
    is_free_sample: boolean; updated_at: unknown; touch_sent: boolean;
  }>(
    // Ones the coordinator can act on first (oldest first), then the recent failures.
    `SELECT r.id, r.status, r.owner_agent, r.stage, r.priority, r.playbook, r.is_free_sample, r.updated_at,
            r.is_free_sample AND EXISTS (SELECT 1 FROM messages m WHERE m.request_id = r.id AND m.direction = 'outbound'
              AND m.kind = 'outreach' AND m.status = 'sent') AS touch_sent
     FROM requests r
     WHERE (r.status = 'failed' AND r.updated_at >= $4) OR r.status = 'awaiting_approval'
        OR (NOT (r.status = ANY($1)) AND r.updated_at < $2)
     ORDER BY (r.status = 'failed'), r.updated_at ASC LIMIT $3`,
    [[...TERMINAL_STATUSES], cutoff, f.limit ?? 50, failedSince],
  );
  return rows.map((r) => ({
    id: r.id,
    reason:
      r.status === "failed" ? "failed"
      : r.status === "awaiting_approval" ? "awaiting_approval"
      : WAITING_ON_CUSTOMER.includes(r.status) ? "waiting_on_customer"
      : "stale",
    status: r.status,
    owner_agent: r.owner_agent,
    stage: r.stage,
    priority: r.priority,
    playbook: r.playbook,
    free_sample: r.is_free_sample,
    minutes_since_update: Math.round((Date.now() - new Date(String(iso(r.updated_at))).getTime()) / 60_000),
    ...(r.touch_sent && r.status !== "failed" ? { hint: HINT_TOUCH_SENT } : {}),
  }));
}

/** Requests the coordinator should look at: stale (no update for N minutes), failed, or waiting on a human. */
import { getDb } from "../db/client";
import { TERMINAL_STATUSES } from "../domain";
import { iso } from "./util";

/** Statuses where we are waiting on the customer, not on ourselves. */
const WAITING_ON_CUSTOMER = ["quoted", "clarifying"];

export async function listStuckRequests(f: { staleMinutes?: number; limit?: number } = {}) {
  const db = await getDb();
  const cutoff = new Date(Date.now() - (f.staleMinutes ?? 60) * 60_000);
  const rows = await db.query<{ id: string; status: string; owner_agent: string | null; stage: string | null; priority: string; playbook: string; is_free_sample: boolean; updated_at: unknown }>(
    `SELECT id, status, owner_agent, stage, priority, playbook, is_free_sample, updated_at FROM requests
     WHERE status IN ('failed', 'awaiting_approval') OR (NOT (status = ANY($1)) AND updated_at < $2)
     ORDER BY updated_at ASC LIMIT $3`,
    [[...TERMINAL_STATUSES], cutoff, f.limit ?? 50],
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
  }));
}

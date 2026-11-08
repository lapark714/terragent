/** Intervention log: every human action with time and reason (judges score how few there are). */
import { getDb } from "../db/client";
import { scrubText, shortId } from "./mask";
import { iso, num } from "./rows";
import type { Interventions } from "./types";

export async function getInterventions(limit = 50): Promise<Interventions> {
  const db = await getDb();
  const [rows, [count]] = await Promise.all([
    db.query<{ id: string; actor: string; action: string; reason: string; request_id: string | null; created_at: unknown }>(
      `SELECT id::text AS id, actor, action, reason, request_id, created_at FROM interventions
       ORDER BY created_at DESC LIMIT $1`,
      [limit],
    ),
    db.query<{ n: number }>("SELECT count(*)::int AS n FROM interventions"),
  ]);
  return {
    total: num(count.n),
    rows: rows.map((r) => ({
      id: r.id,
      actor: r.actor,
      action: r.action,
      reason: scrubText(r.reason).slice(0, 300),
      request: r.request_id ? shortId(r.request_id) : null,
      at: iso(r.created_at),
    })),
  };
}

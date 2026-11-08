/** Monid spend in our `spend` table: the per-day cap is summed from here, so every run gets a row. */
import { getDb } from "../db/client";

/** USD booked for Monid since 00:00 UTC today. */
export async function monidSpentTodayUsd(now = new Date()): Promise<number> {
  const db = await getDb();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [row] = await db.query<{ total: string | number | null }>(
    "SELECT COALESCE(SUM(amount_usd), 0) AS total FROM spend WHERE service = 'monid' AND recorded_at >= $1",
    [dayStart.toISOString()],
  );
  return Number(row?.total ?? 0);
}

export async function recordMonidSpend(e: {
  amountUsd: number;
  isEstimate: boolean;
  agent?: string;
  requestId?: string;
  meta: Record<string, unknown>;
}): Promise<void> {
  const db = await getDb();
  await db.query(
    "INSERT INTO spend (service, agent, request_id, component, amount_usd, is_estimate, meta) VALUES ('monid', $1, $2, 'tools', $3, $4, $5)",
    [e.agent ?? null, e.requestId ?? null, e.amountUsd, e.isEstimate, JSON.stringify(e.meta)],
  );
}

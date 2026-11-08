/** Per-session Naïve spend, written when a session goes idle (webhook) and rolled up into requests.cost_usd. */
import { sessionCostUsd } from "../naive/spend";
import { errorMessage, query } from "./db";
import { requestForSession } from "./requests";

export async function recordSessionIdle(a: { sessionId: string; stopReason: string | null }) {
  const { request_id, agent } = await requestForSession(a.sessionId);
  let cost: number | null = null;
  let warning: string | null = null;
  try {
    cost = await sessionCostUsd(a.sessionId);
  } catch (e) {
    warning = `spend unavailable: ${errorMessage(e)}`;
  }

  await query(
    `INSERT INTO agent_sessions (session_id, agent, request_id, lane, stop_reason, cost_usd) VALUES ($1,$2,$3,'background',$4,$5)
     ON CONFLICT (session_id) DO UPDATE SET stop_reason = EXCLUDED.stop_reason,
       cost_usd = COALESCE(EXCLUDED.cost_usd, agent_sessions.cost_usd), updated_at = now()`,
    [a.sessionId, agent ?? "unknown", request_id, a.stopReason, cost],
  );
  if (cost !== null) {
    const updated = await query(
      "UPDATE spend SET amount_usd = $2, recorded_at = now() WHERE service = 'naive' AND session_id = $1 AND component = 'session' RETURNING id",
      [a.sessionId, cost],
    );
    if (!updated.length) {
      await query(
        "INSERT INTO spend (service, agent, session_id, request_id, component, amount_usd) VALUES ('naive', $1, $2, $3, 'session', $4)",
        [agent, a.sessionId, request_id, cost],
      );
    }
    if (request_id) {
      await query("UPDATE requests SET cost_usd = (SELECT COALESCE(SUM(amount_usd), 0) FROM spend WHERE request_id = $1) WHERE id = $1", [request_id]);
    }
  }
  return { request_id, agent, cost_usd: cost, warning };
}

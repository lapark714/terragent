/** Per-session Naïve spend, written when a session goes idle (webhook) and rolled up into requests.cost_usd. */
import { isOffline } from "../env";
import { getNaive } from "../naive/client";
import { agentNamesById } from "../naive/registry";
import { OFFLINE_SESSION_PREFIX } from "../naive/sessions";
import { sessionCostUsd } from "../naive/spend";
import { errorMessage, query, queryOne } from "./db";
import { requestForSession } from "./requests";

interface SessionLink { request_id: string | null; agent: string | null; stage: string | null; via: string | null }

/**
 * Sessions our handoff started are in agent_sessions. Everything else (sessions the board woke for a card — the whole
 * background lane — and cron runs) is resolved once: the card in the session's metadata.board → the handoff (or
 * supplier order) that created it, else our own metadata.request_id, else the run summary's request_id; the agent
 * name comes from the session's agent_id. Best effort: no Naïve access (offline, outage) falls back to the summary.
 */
async function resolveSession(sessionId: string, summaryRequestId: string | null): Promise<SessionLink> {
  const out: SessionLink = { request_id: null, agent: null, stage: null, via: null };
  if (!isOffline() && !sessionId.startsWith(OFFLINE_SESSION_PREFIX)) {
    try {
      const naive = await getNaive();
      const s = await naive.sessions.get(sessionId);
      out.agent = (await agentNamesById()).get(s.agent_id) ?? null;
      const meta = (s.metadata ?? {}) as { board?: { card_id?: unknown }; request_id?: unknown; stage?: unknown };
      const cardId = typeof meta.board?.card_id === "string" ? meta.board.card_id : null;
      if (cardId) {
        const byCard = await requestForCard(cardId);
        if (byCard) Object.assign(out, byCard, { via: "card" });
      }
      if (!out.request_id && typeof meta.request_id === "string" && (await requestExists(meta.request_id))) {
        Object.assign(out, { request_id: meta.request_id, stage: typeof meta.stage === "string" ? meta.stage : null, via: "metadata" });
      }
    } catch {
      // fall through to the run summary
    }
  }
  if (!out.request_id && summaryRequestId && (await requestExists(summaryRequestId))) {
    Object.assign(out, { request_id: summaryRequestId, via: "structured_output" });
  }
  return out;
}

const requestExists = async (id: string) => !!(await queryOne("SELECT 1 FROM requests WHERE id = $1", [id]));

/** The request a board card belongs to: the background handoff that created it, the request's current card, or a supplier order's card. */
async function requestForCard(cardId: string): Promise<{ request_id: string; stage: string | null } | null> {
  const handoff = await queryOne<{ request_id: string; stage: string | null }>(
    `SELECT request_id, payload->>'stage' AS stage FROM events
     WHERE type = 'handoff' AND request_id IS NOT NULL AND payload->>'card_id' = $1 ORDER BY id DESC LIMIT 1`,
    [cardId],
  );
  if (handoff) return handoff;
  const req = await queryOne<{ id: string; stage: string | null }>("SELECT id, stage FROM requests WHERE card_id = $1 LIMIT 1", [cardId]);
  if (req) return { request_id: req.id, stage: req.stage };
  const order = await queryOne<{ request_id: string }>("SELECT request_id FROM orders WHERE meta->'card'->>'id' = $1 LIMIT 1", [cardId]);
  return order ? { request_id: order.request_id, stage: "supplier_reply" } : null;
}

export async function recordSessionIdle(a: { sessionId: string; stopReason: string | null; summaryRequestId?: string | null }) {
  const known = await requestForSession(a.sessionId);
  let request_id = known.request_id;
  let agent = known.agent && known.agent !== "unknown" ? known.agent : null;
  let stage: string | null = null;
  let via: string | null = null;
  if (!agent) {
    const link = await resolveSession(a.sessionId, a.summaryRequestId ?? null);
    agent = link.agent;
    request_id ??= link.request_id;
    stage = link.stage;
    via = link.via;
  }

  let cost: number | null = null;
  let warning: string | null = null;
  try {
    cost = await sessionCostUsd(a.sessionId);
  } catch (e) {
    warning = `spend unavailable: ${errorMessage(e)}`;
  }

  await query(
    `INSERT INTO agent_sessions (session_id, agent, request_id, stage, lane, stop_reason, cost_usd) VALUES ($1,$2,$3,$4,'background',$5,$6)
     ON CONFLICT (session_id) DO UPDATE SET stop_reason = EXCLUDED.stop_reason,
       cost_usd = COALESCE(EXCLUDED.cost_usd, agent_sessions.cost_usd),
       agent = CASE WHEN agent_sessions.agent = 'unknown' THEN EXCLUDED.agent ELSE agent_sessions.agent END,
       request_id = COALESCE(agent_sessions.request_id, EXCLUDED.request_id),
       stage = COALESCE(agent_sessions.stage, EXCLUDED.stage), updated_at = now()`,
    [a.sessionId, agent ?? "unknown", request_id, stage, a.stopReason, cost],
  );
  if (request_id) {
    await query(
      "UPDATE requests SET naive_session_ids = array_append(naive_session_ids, $2) WHERE id = $1 AND NOT ($2 = ANY(naive_session_ids))",
      [request_id, a.sessionId],
    );
  }
  if (cost !== null) {
    const updated = await query(
      `UPDATE spend SET amount_usd = $2, recorded_at = now(), request_id = COALESCE(request_id, $3), agent = COALESCE(agent, $4)
       WHERE service = 'naive' AND session_id = $1 AND component = 'session' RETURNING id`,
      [a.sessionId, cost, request_id, agent],
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
  return { request_id, agent, cost_usd: cost, warning, ...(via ? { linked_via: via } : {}) };
}

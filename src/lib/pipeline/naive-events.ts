/** Naïve webhook events → spend, approval queue signals and coordinator-visible alerts (route: /api/webhooks/naive). */
import { logEvent } from "../events";
import type { NaiveWebhookEnvelope } from "../naive/webhooks";
import { errorMessage, query } from "./db";
import { addNote } from "./requests";
import { recordSessionIdle } from "./spend";

/** Insert-or-skip on the envelope id. False means we already have it (Naïve retries and redeliveries reuse ids). */
export async function claimWebhookEvent(evt: Pick<NaiveWebhookEnvelope, "id" | "type">): Promise<boolean> {
  const rows = await query(
    "INSERT INTO webhook_events (id, source, type) VALUES ($1, 'naive', $2) ON CONFLICT (id) DO NOTHING RETURNING id",
    [`naive:${evt.id}`, evt.type],
  );
  return rows.length > 0;
}

interface IdleData { session_id?: string; stop_reason?: string; pending_actions?: { name?: string; kind?: string }[]; error?: unknown; code?: string; deployment_id?: string }

const ATTENTION = new Set(["error", "budget_paused"]);

export async function processNaiveEvent(evt: NaiveWebhookEnvelope): Promise<void> {
  try {
    if (evt.type === "session.idle") await onSessionIdle(evt.data as IdleData);
    else if (evt.type === "budget.exceeded") await logEvent("budget.exceeded", "naive", evt.data);
    await query("UPDATE webhook_events SET processed_at = now() WHERE id = $1", [`naive:${evt.id}`]);
  } catch (e) {
    await query("UPDATE webhook_events SET error = $2 WHERE id = $1", [`naive:${evt.id}`, errorMessage(e).slice(0, 500)]);
    throw e;
  }
}

async function onSessionIdle(d: IdleData) {
  if (!d.session_id) return;
  const stop = d.stop_reason ?? null;
  const spend = await recordSessionIdle({ sessionId: d.session_id, stopReason: stop });
  const base = { session_id: d.session_id, agent: spend.agent, stop_reason: stop, cost_usd: spend.cost_usd, deployment_id: d.deployment_id ?? null };

  if (stop === "awaiting_approval") {
    const tools = (d.pending_actions ?? []).filter((a) => (a.kind ?? "tool") === "tool").map((a) => a.name);
    await logEvent("approval.pending", "naive", { ...base, tools }, spend.request_id);
  } else if (stop && ATTENTION.has(stop)) {
    await logEvent("session.attention", "naive", { ...base, code: d.code ?? null, error: d.error ?? null }, spend.request_id);
    if (spend.request_id) {
      await addNote(spend.request_id, "system",
        `Coordinator: ${spend.agent ?? "an agent"} session ${d.session_id} stopped (${stop}${d.code ? `, ${d.code}` : ""}). Retry or reassign this stage.`);
    }
  } else {
    await logEvent("session.idle", "naive", base, spend.request_id);
  }
}

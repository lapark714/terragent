/**
 * Append-only event log (feeds the dashboard board timeline and funnel) and the decision log.
 * Every state change in the company should leave an event; every judgement call a decision.
 */
import { getDb } from "./db/client";
import type { DecisionKind } from "./domain";
import { newId } from "./ids";

export type Actor = string; // AgentName | `human:${string}` | "system"

export async function logEvent(type: string, actor: Actor, payload: Record<string, unknown> = {}, requestId?: string | null) {
  const db = await getDb();
  await db.query("INSERT INTO events (request_id, type, actor, payload) VALUES ($1, $2, $3, $4)", [
    requestId ?? null,
    type,
    actor,
    JSON.stringify(payload),
  ]);
}

export interface DecisionInput {
  requestId?: string | null;
  kind: DecisionKind;
  choice: string;
  reasoning: string;
  alternatives?: { option: string; cost_usd?: number | null; why_not: string }[];
  agent: Actor;
}

export async function logDecision(d: DecisionInput): Promise<string> {
  const db = await getDb();
  const id = newId("decision");
  await db.query(
    "INSERT INTO decisions (id, request_id, kind, choice, reasoning, alternatives, agent) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [id, d.requestId ?? null, d.kind, d.choice, d.reasoning, JSON.stringify(d.alternatives ?? []), d.agent],
  );
  await logEvent("decision.logged", d.agent, { decision_id: id, kind: d.kind, choice: d.choice }, d.requestId);
  return id;
}

/** A human action. Only call when a person actually acted (spec §6: approvals count only if a human acts). */
export async function logIntervention(i: { actor: string; action: string; reason: string; requestId?: string | null; refId?: string | null }) {
  const db = await getDb();
  await db.query("INSERT INTO interventions (actor, action, reason, request_id, ref_id) VALUES ($1,$2,$3,$4,$5)", [
    i.actor,
    i.action,
    i.reason,
    i.requestId ?? null,
    i.refId ?? null,
  ]);
  await logEvent("human.intervention", `human:${i.actor}`, { action: i.action, reason: i.reason, ref_id: i.refId }, i.requestId);
}

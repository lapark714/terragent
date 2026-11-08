/**
 * Agent Armor verdicts. A message Agent Armor flags (`review`) or couldn't scan (`unavailable`) makes its request
 * untrusted (requests.meta.untrusted), so Comms 2 treats the sender's words as data and acts with extra care.
 */
import { roleForAddress } from "../agentmail/config";
import { getDb } from "../db/client";
import { logEvent } from "../events";
import type { InboundEmail, SecurityVerdict } from "./inbound-parse";

export function isUntrusted(verdict: SecurityVerdict | string | null | undefined): boolean {
  return verdict === "review" || verdict === "unavailable";
}

/** Idempotent: the first untrusted message is recorded on the request; later ones don't repeat the event. */
export async function markUntrusted(requestId: string, security: InboundEmail["security"], messageId: string) {
  const db = await getDb();
  const flag = { untrusted: true, security: { verdict: security.verdict, reason: security.reason, message_id: messageId } };
  const changed = await db.query(
    "UPDATE requests SET meta = meta || $2::jsonb, updated_at = now() WHERE id = $1 AND (meta->>'untrusted') IS DISTINCT FROM 'true' RETURNING id",
    [requestId, JSON.stringify(flag)],
  );
  if (changed.length) await logEvent("email.untrusted", "system", { message_id: messageId, verdict: security.verdict, reason: security.reason }, requestId);
}

/**
 * Store a (late) verdict on the inbound message row; flag its request if needed. A row not linked to a request yet
 * (the request is being created) falls back to the request on its thread. Supplier mail never flags the customer's
 * request: Comms 1 gets the caution on its card instead.
 * Returns false when we have no row for the message yet (verdict arrived before message.received).
 */
export async function recordVerdict(inboxAddress: string, messageId: string, security: InboundEmail["security"]): Promise<boolean> {
  const inbox = roleForAddress(inboxAddress);
  if (!inbox) return false;
  const db = await getDb();
  const rows = await db.query<{ request_id: string | null; thread_id: string | null; kind: string | null; previous: string | null }>(
    `UPDATE messages m SET security_verdict = $3, security_reason = $4
     FROM (SELECT id, security_verdict AS previous FROM messages WHERE agentmail_message_id = $1 AND inbox = $2 AND direction = 'inbound') old
     WHERE m.id = old.id
     RETURNING m.request_id, m.thread_id, m.kind, old.previous`,
    [messageId, inbox, security.verdict, security.reason],
  );
  if (!rows.length) return false;
  for (const r of rows) {
    if (!isUntrusted(security.verdict) || isUntrusted(r.previous) || r.kind === "supplier_quote") continue;
    const requestId = r.request_id ?? (await requestOnThread(r.thread_id));
    if (requestId) await markUntrusted(requestId, security, messageId);
  }
  return true;
}

async function requestOnThread(threadId: string | null): Promise<string | null> {
  if (!threadId) return null;
  const db = await getDb();
  const [r] = await db.query<{ id: string }>(
    "SELECT id FROM requests WHERE thread_id = $1 AND NOT is_free_sample ORDER BY created_at DESC LIMIT 1", [threadId]);
  return r?.id ?? null;
}

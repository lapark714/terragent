/**
 * Reads replies to cold email from the Naïve inbox into the normal inbound flow: opt-outs, prospect replies and the
 * record of every response. Naïve has no inbound webhook for us, so the Naïve webhook route calls this, throttled.
 * The opt-out duty lasts 30 days after the last send, so this keeps running even if cold email is turned off.
 */
import { coldInbox } from "../agentmail/config";
import { getDb } from "../db/client";
import { logEvent } from "../events";
import { getNaive } from "../naive/client";
import { naiveThreadId } from "../naive/email";
import { parseAddress } from "./address";
import { handleInboundEmail } from "./inbound";
import type { InboundEmail } from "./inbound-parse";

const THROTTLE_KEY = "email.naive_inbox_synced";

/** Only what they wrote: quoted history and our own footer (which contains the word "stop") would trip opt-out checks. */
export function newTextOf(text: string): string {
  const cut = text.search(/^(>|On .+ wrote:|--\s*$|-{2,} ?Original Message)/m);
  return (cut >= 0 ? text.slice(0, cut) : text).trim();
}

export function toInbound(m: { id: string; from: string; to: string; subject: string | null; text: string }, address: string): InboundEmail {
  return {
    source: "naive", inboxId: address, threadId: naiveThreadId(parseAddress(m.from).email), messageId: m.id, from: m.from, replyTo: [], to: [m.to],
    subject: m.subject, replyText: newTextOf(m.text), fullText: m.text, headers: {}, labels: [], inReplyTo: null, attachments: [],
    security: { verdict: "unavailable", reason: "naive_inbox_unscanned" }, needsBody: false,
  };
}

export async function syncNaiveInbox(): Promise<{ read: number; failed: number }> {
  const { identityId, address } = coldInbox();
  const client = await getNaive();
  const { data } = await client.emails.messages(identityId, { channel: "email", limit: 100 });
  const unread = data.filter((m) => !m.read_at && m.guard_reason !== "own_persona").reverse();
  let read = 0, failed = 0;
  for (const m of unread) {
    try {
      // Naïve already judged it an auto-reply and our headers check can't see that: keep it out of the funnel.
      if (m.guard_reason === "auto_reply") await logEvent("email.auto_reply", "system", { inbox: "outreach", message_id: m.id });
      else await handleInboundEmail(toInbound(m, address));
      await client.emails.markRead(identityId, m.id, true);
      read++;
    } catch (e) {
      failed++;
      console.error("[naive-inbox] could not process", m.id, e);
    }
  }
  return { read, failed };
}

/** At most one sync every 3 minutes, however many webhooks arrive. */
export async function syncNaiveInboxThrottled(): Promise<void> {
  const db = await getDb();
  const won = await db.query(
    `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, '{}'::jsonb, 'system', now())
     ON CONFLICT (key) DO UPDATE SET updated_at = now() WHERE settings.updated_at < now() - interval '3 minutes' RETURNING key`,
    [THROTTLE_KEY],
  );
  if (won.length) await syncNaiveInbox();
}

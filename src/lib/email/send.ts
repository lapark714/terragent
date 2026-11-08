/**
 * Every outbound email goes through here. Gates (enforced in code, in this order), each leaving a messages row:
 *   idempotency → recipient sanity → inbox armed (or recipient in TEAM_EMAILS) → suppression list → org daily cap
 *   → outreach/followup: approved template, allowed channel (email_direct only if OUTREACH_DIRECT_EMAIL_APPROVED),
 *     outreach daily cap, postal address, public https opt-out link → content (no unfilled placeholders, size)
 *   → AI disclosure + opt-out footer.
 * A row that was blocked or failed is re-checked when retried with the same key (e.g. after a founder arms the
 * inbox); a row that was sent is returned as-is, so a retry never sends twice (AgentMail also gets the key).
 */
import { createHash } from "node:crypto";
import type { AgentMail } from "agentmail";
import { inboxAddress, isOwnAddress } from "../agentmail/config";
import { agentmailErrorCode, mailApi, type SentIds } from "../agentmail/client";
import { CAPS } from "../config";
import { getDb } from "../db/client";
import type { Inbox } from "../domain";
import { envFlag, publicBaseUrl } from "../env";
import { logEvent } from "../events";
import { newId } from "../ids";
import { getSetting, SETTING } from "../settings";
import { isValidEmail, normalizeEmail, parseAddress, teamEmails } from "./address";
import { isSuppressed, optOutUrl } from "./optout";
import { ensureCompliance, hasPlaceholder, postalAddress } from "./templates";

export interface Attachment { filename: string; contentType: string; contentBase64?: string; url?: string }
export interface SendResult { status: "sent" | "blocked"; message_id: string; agentmail_message_id?: string; thread_id?: string; blocked_reason?: string }

export interface SendEmailArgs {
  inbox: Inbox;
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: Attachment[];
  kind: "customer" | "supplier_quote" | "outreach" | "followup";
  channel?: "email" | "email_warm" | "email_direct";
  requestId?: string;
  prospectId?: string;
  orderId?: string;
  templateId?: string;
  /** Required: stable per logical message so retries never double-send. */
  idempotencyKey: string;
  actor: string;
}

/** A "sending" row older than this crashed mid-send; AgentMail's idempotency key makes re-sending it safe. */
const STALE_SENDING = "10 minutes";
/** AgentMail: whole request ≤ 6 MB (base64 inflates attachments by a third). Keep headroom. */
const MAX_REQUEST_BYTES = 5_500_000;

export async function sendEmail(args: SendEmailArgs): Promise<SendResult> {
  return deliver(args, null);
}

/** Reply in an existing AgentMail thread (threading headers automatic). Same gates as sendEmail. */
export async function replyInThread(args: Omit<SendEmailArgs, "to" | "subject"> & { inReplyToMessageId: string }): Promise<SendResult> {
  const original = await findOriginal(args.inbox, args.inReplyToMessageId);
  const subject = original?.subject ? (/^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`) : "Re:";
  return deliver({ ...args, to: original?.recipient ?? "", subject }, { messageId: args.inReplyToMessageId, threadId: original?.threadId ?? null });
}

// ---------------------------------------------------------------------------

interface ReplyTarget { messageId: string; threadId: string | null }
interface MessageRow { id: string; status: string; blocked_reason: string | null; agentmail_message_id: string | null; thread_id: string | null; stale: boolean }

async function deliver(args: SendEmailArgs, reply: ReplyTarget | null): Promise<SendResult> {
  const db = await getDb();
  const to = normalizeEmail(args.to);

  const existing = await findByKey(args.idempotencyKey);
  if (existing && (existing.status === "sent" || (existing.status === "sending" && !existing.stale))) return toResult(existing);

  const optOut = (args.kind === "outreach" || args.kind === "followup") && isValidEmail(to) ? await optOutUrl(to) : null;
  const content = ensureCompliance({ text: args.text, html: args.html }, { optOutUrl: optOut });
  const reason = await gate(args, to, content);

  const row = {
    id: existing?.id ?? newId("message"),
    to, subject: args.subject, text: content.text, threadId: reply?.threadId ?? null,
  };
  const claimed = await writeRow(args, row, reason);
  if (!claimed) return toResult((await findByKey(args.idempotencyKey))!);

  if (reason) {
    await logEvent("email.blocked", args.actor, { message_id: row.id, inbox: args.inbox, to, kind: args.kind, reason }, args.requestId);
    return { status: "blocked", message_id: row.id, blocked_reason: reason };
  }

  let ids: SentIds;
  try {
    ids = await callAgentMail(args, to, content, reply);
  } catch (e) {
    const failure = `send_failed:${agentmailErrorCode(e)}`;
    await db.query("UPDATE messages SET status = 'failed', blocked_reason = $2 WHERE id = $1", [row.id, failure]);
    await logEvent("email.failed", args.actor, { message_id: row.id, inbox: args.inbox, to, kind: args.kind, reason: failure }, args.requestId);
    return { status: "blocked", message_id: row.id, blocked_reason: failure };
  }

  await db.query(
    "UPDATE messages SET status = 'sent', sent_at = now(), agentmail_message_id = $2, thread_id = $3, blocked_reason = NULL WHERE id = $1",
    [row.id, ids.messageId, ids.threadId],
  );
  await linkThread(args, ids.threadId);
  await logEvent("email.sent", args.actor, {
    message_id: row.id, inbox: args.inbox, to, kind: args.kind, channel: args.channel ?? "email", subject: args.subject,
    template_id: args.templateId ?? null, agentmail_message_id: ids.messageId, thread_id: ids.threadId,
  }, args.requestId);
  return { status: "sent", message_id: row.id, agentmail_message_id: ids.messageId, thread_id: ids.threadId };
}

/** Returns the first gate that blocks the send, or null. */
async function gate(args: SendEmailArgs, to: string, content: { text: string; html: string }): Promise<string | null> {
  if (!isValidEmail(to)) return "invalid_recipient";
  if (isOwnAddress(to)) return "recipient_is_own_inbox";

  const armed = await getSetting<Partial<Record<Inbox, boolean>>>(SETTING.inboxArmed, {});
  if (armed[args.inbox] !== true && !teamEmails().has(to)) return "inbox_not_armed";

  if (await isSuppressed(to)) return "suppressed";
  if ((await sentToday()) >= CAPS.emailsPerDayTotal) return "daily_cap_reached";

  if (args.kind === "outreach" || args.kind === "followup") {
    const blocked = await outreachGate(args, to);
    if (blocked) return blocked;
  }

  if (!args.text.trim()) return "empty_body";
  if (hasPlaceholder(args.subject) || hasPlaceholder(content.text) || hasPlaceholder(content.html)) return "unfilled_placeholder";
  if (requestBytes(args, content) > MAX_REQUEST_BYTES) return "attachments_too_large";
  return null;
}

async function outreachGate(args: SendEmailArgs, to: string): Promise<string | null> {
  if (!args.templateId) return "template_required";
  const db = await getDb();
  const [tpl] = await db.query<{ status: string; kind: string }>("SELECT status, kind FROM templates WHERE id = $1", [args.templateId]);
  if (!tpl || tpl.status !== "approved" || tpl.kind !== args.kind) return "template_not_approved";

  if (args.channel === "email_direct") {
    if (!envFlag("OUTREACH_DIRECT_EMAIL_APPROVED")) return "direct_email_not_approved";
  } else if (args.channel !== "email_warm") {
    return "channel_not_allowed";
  }
  if (args.kind === "outreach" && (await sentToday("outreach")) >= CAPS.outreachTouchesPerDay) return "outreach_daily_cap_reached";
  if (!postalAddress()) return "missing_postal_address";
  // A localhost opt-out link is dead for the recipient (CAN-SPAM); team test sends may still go out.
  if (!publicBaseUrl().startsWith("https://") && !teamEmails().has(to)) return "optout_url_not_public";
  return null;
}

/**
 * Send attempts since 00:00 UTC, org-wide or for one kind. sent_at is set only when a send is attempted, and a
 * later bounce/complaint/reject doesn't give the AgentMail quota back, so status doesn't matter.
 */
async function sentToday(kind?: string): Promise<number> {
  const db = await getDb();
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const [row] = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM messages
     WHERE direction = 'outbound' AND sent_at >= $1 AND ($2::text IS NULL OR kind = $2)`,
    [midnight.toISOString(), kind ?? null],
  );
  return row.n;
}

function requestBytes(args: SendEmailArgs, content: { text: string; html: string }): number {
  const attachments = (args.attachments ?? []).reduce((n, a) => n + (a.contentBase64?.length ?? 0), 0);
  return attachments + Buffer.byteLength(content.text) + Buffer.byteLength(content.html);
}

/**
 * Insert or re-claim the row for this idempotency key. A row already sent (or being sent) belongs to another
 * attempt: returns false so the caller reports that attempt's result instead.
 */
async function writeRow(args: SendEmailArgs, row: { id: string; to: string; subject: string; text: string; threadId: string | null }, reason: string | null): Promise<boolean> {
  const db = await getDb();
  const status = reason ? "blocked" : "sending";
  const claimed = await db.query(
    `INSERT INTO messages (id, direction, inbox, request_id, prospect_id, order_id, counterpart_email, subject, body_text,
       template_id, thread_id, status, blocked_reason, channel, kind, idempotency_key, sent_at)
     VALUES ($1, 'outbound', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, CASE WHEN $11 = 'sending' THEN now() END)
     ON CONFLICT (idempotency_key) DO UPDATE SET
       counterpart_email = EXCLUDED.counterpart_email, subject = EXCLUDED.subject, body_text = EXCLUDED.body_text,
       template_id = EXCLUDED.template_id, status = EXCLUDED.status, blocked_reason = EXCLUDED.blocked_reason,
       channel = EXCLUDED.channel, sent_at = EXCLUDED.sent_at
     WHERE messages.status IN ('blocked', 'failed') OR (messages.status = 'sending' AND messages.sent_at < now() - interval '${STALE_SENDING}')
     RETURNING id`,
    [row.id, args.inbox, args.requestId ?? null, args.prospectId ?? null, args.orderId ?? null, row.to || null, row.subject, row.text,
      args.templateId ?? null, row.threadId, status, reason, args.channel ?? "email", args.kind, args.idempotencyKey],
  );
  return claimed.length > 0;
}

async function callAgentMail(args: SendEmailArgs, to: string, content: { text: string; html: string }, reply: ReplyTarget | null): Promise<SentIds> {
  const attachments: AgentMail.SendAttachment[] = (args.attachments ?? []).map((a) => ({
    filename: a.filename, contentType: a.contentType, content: a.contentBase64, url: a.url,
  }));
  const labels = [`kind-${args.kind}`];
  const key = agentmailIdempotencyKey(args.idempotencyKey);
  const from = inboxAddress(args.inbox);
  if (reply) return mailApi().reply(from, reply.messageId, { to: [to], text: content.text, html: content.html, attachments, labels }, key);
  return mailApi().send(from, { to: [to], subject: args.subject, text: content.text, html: content.html, attachments, labels }, key);
}

/** AgentMail keys: 1–256 chars of A-Z a-z 0-9 - . _ ~ — hash anything else. */
function agentmailIdempotencyKey(key: string): string {
  return /^[A-Za-z0-9._~-]{1,256}$/.test(key) ? key : `tg-${createHash("sha256").update(key).digest("hex")}`;
}

/**
 * First email of a conversation starts its thread: remember it on the record that owns that conversation, so
 * replies route back. Only that record: a supplier quote carries the customer's requestId and outreach the free
 * sample's, and linking those would send the customer's next email into the supplier's or prospect's thread.
 */
async function linkThread(args: SendEmailArgs, threadId: string) {
  const db = await getDb();
  if (args.kind === "customer" && args.requestId) {
    await db.query(
      "UPDATE requests SET thread_id = $2, inbox = $3, updated_at = now() WHERE id = $1 AND thread_id IS NULL AND NOT is_free_sample",
      [args.requestId, threadId, args.inbox],
    );
  }
  if (args.kind === "supplier_quote" && args.orderId) {
    await db.query("UPDATE orders SET quote_thread_id = $2 WHERE id = $1 AND quote_thread_id IS NULL", [args.orderId, threadId]);
  }
  if ((args.kind === "outreach" || args.kind === "followup") && args.prospectId) {
    await db.query("UPDATE prospects SET outreach_thread_id = $2 WHERE id = $1 AND outreach_thread_id IS NULL", [args.prospectId, threadId]);
  }
}

async function findByKey(key: string): Promise<MessageRow | null> {
  const db = await getDb();
  const [row] = await db.query<MessageRow>(
    `SELECT id, status, blocked_reason, agentmail_message_id, thread_id,
       (status = 'sending' AND sent_at < now() - interval '${STALE_SENDING}') AS stale
     FROM messages WHERE idempotency_key = $1`,
    [key],
  );
  return row ?? null;
}

function toResult(row: MessageRow): SendResult {
  if (row.status === "sent") {
    return { status: "sent", message_id: row.id, agentmail_message_id: row.agentmail_message_id ?? undefined, thread_id: row.thread_id ?? undefined };
  }
  return { status: "blocked", message_id: row.id, blocked_reason: row.status === "sending" ? "in_flight" : (row.blocked_reason ?? row.status) };
}

/** Who a reply goes to: the counterpart of the message we're replying to (DB first, then AgentMail). */
async function findOriginal(inbox: Inbox, messageId: string): Promise<{ recipient: string; subject: string | null; threadId: string } | null> {
  const db = await getDb();
  const [row] = await db.query<{ counterpart_email: string | null; subject: string | null; thread_id: string | null; meta: { reply_to?: string } }>(
    "SELECT counterpart_email, subject, thread_id, meta FROM messages WHERE agentmail_message_id = $1 AND inbox = $2 ORDER BY created_at DESC LIMIT 1",
    [messageId, inbox],
  );
  if (row?.counterpart_email && row.thread_id) {
    return { recipient: row.meta?.reply_to ?? row.counterpart_email, subject: row.subject, threadId: row.thread_id };
  }
  try {
    const m = await mailApi().getMessage(inboxAddress(inbox), messageId);
    const sender = parseAddress(m.from).email;
    const recipient = isOwnAddress(sender) ? parseAddress(m.to[0] ?? "").email : parseAddress(m.replyTo?.[0] ?? m.from).email;
    return { recipient, subject: m.subject ?? null, threadId: m.threadId };
  } catch {
    return null;
  }
}

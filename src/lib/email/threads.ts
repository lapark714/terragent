/**
 * Thread reads for agents (inbound text is UNTRUSTED data). Our messages table first; the AgentMail thread
 * API when we have nothing stored or an Agent Armor verdict is still pending (verdicts are persisted back).
 */
import type { AgentMail } from "agentmail";
import { inboxAddress, isOwnAddress, roleForAddress } from "../agentmail/config";
import { mailApi } from "../agentmail/client";
import { getDb } from "../db/client";
import type { Inbox } from "../domain";
import { isOffline } from "../env";
import { parseAddress } from "./address";
import { bodyText, fromSdkMessage, type InboundAttachment } from "./inbound-parse";
import { recordVerdict } from "./security";

export interface ThreadMessage {
  direction: "inbound" | "outbound"; from: string; to: string[]; subject: string | null; text: string; at: string; agentmail_message_id: string;
  security_verdict?: "clear" | "review" | "unavailable" | null;
  /** Inbound only, metadata (fetch bytes from AgentMail by attachment id). */
  attachments?: InboundAttachment[];
}
export interface ThreadView { thread_id: string; inbox: string; messages: ThreadMessage[] }

/** Keep one long email from flooding an agent's context. */
const MAX_TEXT = 20_000;

interface Row {
  direction: "inbound" | "outbound"; inbox: Inbox; counterpart_email: string | null; subject: string | null; body_text: string | null;
  agentmail_message_id: string | null; security_verdict: string | null; meta: { from?: string; attachments?: InboundAttachment[] }; at: string;
}

export async function getThread(threadId: string): Promise<ThreadView | null> {
  const db = await getDb();
  const rows = await db.query<Row>(
    `SELECT direction, inbox, counterpart_email, subject, body_text, agentmail_message_id, security_verdict, meta,
       COALESCE(sent_at, created_at) AS at
     FROM messages WHERE thread_id = $1 AND status IN ('sent', 'received', 'bounced') ORDER BY COALESCE(sent_at, created_at)`,
    [threadId],
  );
  const pending = rows.some((r) => r.direction === "inbound" && (!r.security_verdict || r.security_verdict === "pending"));
  if (!rows.length || pending) {
    const live = await fetchThread(threadId);
    if (live) return live;
  }
  if (!rows.length) return null;
  return { thread_id: threadId, inbox: rows[0].inbox, messages: rows.map(fromRow) };
}

function fromRow(r: Row): ThreadMessage {
  const ours = inboxAddress(r.inbox);
  const other = r.counterpart_email ?? "";
  return {
    direction: r.direction,
    from: r.direction === "outbound" ? ours : (r.meta?.from ?? other),
    to: r.direction === "outbound" ? [other] : [ours],
    subject: r.subject,
    text: (r.body_text ?? "").slice(0, MAX_TEXT),
    at: new Date(r.at).toISOString(),
    agentmail_message_id: r.agentmail_message_id ?? "",
    ...(r.direction === "inbound" ? { security_verdict: finalVerdict(r.security_verdict), ...files(r.meta?.attachments) } : {}),
  };
}

const files = (a: InboundAttachment[] | undefined) => (a?.length ? { attachments: a } : {});

function finalVerdict(v: string | null | undefined): ThreadMessage["security_verdict"] {
  return v === "clear" || v === "review" || v === "unavailable" ? v : null;
}

/** null when AgentMail isn't configured, doesn't know the thread, or we're offline. */
async function fetchThread(threadId: string): Promise<ThreadView | null> {
  if (isOffline()) return null; // local demo database: stored messages only
  let thread: AgentMail.Thread;
  try {
    thread = await mailApi().getThread(threadId);
  } catch {
    return null;
  }
  const messages: ThreadMessage[] = [];
  for (const m of thread.messages) {
    const outbound = isOwnAddress(parseAddress(m.from).email);
    const parsed = fromSdkMessage(m);
    if (!outbound) await recordVerdict(m.inboxId, m.messageId, parsed.security);
    messages.push({
      direction: outbound ? "outbound" : "inbound",
      from: m.from,
      to: m.to,
      subject: m.subject ?? null,
      text: (outbound ? parsed.fullText : bodyText(parsed)).slice(0, MAX_TEXT),
      at: new Date(m.timestamp).toISOString(),
      agentmail_message_id: m.messageId,
      ...(outbound ? {} : { security_verdict: finalVerdict(parsed.security.verdict), ...files(parsed.attachments) }),
    });
  }
  return { thread_id: thread.threadId, inbox: roleForAddress(thread.inboxId) ?? thread.inboxId, messages };
}

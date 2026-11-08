/**
 * One normalised shape for an inbound email, whether it came from a webhook (snake_case wire JSON) or from
 * the SDK (camelCase, used by the poller and thread reads). Parsing is lenient: AgentMail adds keys
 * (organization_id, pod_id, smtp_id …) that the SDK's strict parser rejects.
 */
import type { AgentMail } from "agentmail";
import { z } from "zod";

export type SecurityVerdict = "pending" | "clear" | "review" | "unavailable";

/** Metadata only: bytes stay in AgentMail (fetch with the attachment id). */
export interface InboundAttachment { attachmentId: string; filename: string | null; contentType: string | null; size: number }

export interface InboundEmail {
  inboxId: string; // the receiving inbox's address
  threadId: string;
  messageId: string; // RFC Message-ID, angle brackets included
  from: string; // raw "Name <addr>"
  replyTo: string[];
  to: string[];
  subject: string | null;
  /** Only the new part of a reply (extracted_text), falling back to the full text. */
  replyText: string;
  fullText: string;
  /** Lower-case header names. */
  headers: Record<string, string>;
  labels: string[];
  inReplyTo: string | null;
  attachments: InboundAttachment[];
  security: { verdict: SecurityVerdict; reason: string | null };
  /** Body was too large for the webhook (body_url instead): fetch it with the API. */
  needsBody: boolean;
}

/** Agent Armor result on a message → our verdict. Missing = not scanned = unavailable (treated as untrusted). */
export function securityFrom(armor: { status?: string; verdict?: string; reason?: string; unavailableReason?: string } | null | undefined): InboundEmail["security"] {
  if (!armor?.status) return { verdict: "unavailable", reason: "not_scanned" };
  if (armor.status === "pending") return { verdict: "pending", reason: null };
  if (armor.status === "complete") return { verdict: armor.verdict === "clear" ? "clear" : "review", reason: armor.reason ?? null };
  return { verdict: "unavailable", reason: armor.unavailableReason ?? armor.status };
}

const FORWARD_SUBJECT = /^\s*(fwd?|fw)\s*:/i;

/**
 * The text we store and route on: the new part of a reply, but the full text for a thread's first message or a
 * forward, where extraction can drop the content ("see below").
 */
export function bodyText(m: Pick<InboundEmail, "subject" | "inReplyTo" | "replyText" | "fullText">): string {
  return !m.inReplyTo || FORWARD_SUBJECT.test(m.subject ?? "") ? m.fullText || m.replyText : m.replyText;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function lowerKeys(h: Record<string, unknown> | null | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
}

function bodies(m: { text?: string | null; html?: string | null; extracted_text?: string | null; extracted_html?: string | null }) {
  const fullText = m.text?.trim() || (m.html ? htmlToText(m.html) : "");
  const replyText = m.extracted_text?.trim() || (m.extracted_html ? htmlToText(m.extracted_html) : "") || fullText;
  return { fullText, replyText };
}

// ---------------------------------------------------------------------------
// Webhook wire format (snake_case)
// ---------------------------------------------------------------------------

const WireArmor = z.object({
  status: z.string(),
  verdict: z.string().nullish(),
  reason: z.string().nullish(),
  unavailable_reason: z.string().nullish(),
});

export const WireMessage = z.object({
  inbox_id: z.string(),
  thread_id: z.string(),
  message_id: z.string(),
  labels: z.array(z.string()).nullish(),
  from: z.string(),
  reply_to: z.array(z.string()).nullish(),
  to: z.array(z.string()).nullish(),
  subject: z.string().nullish(),
  text: z.string().nullish(),
  html: z.string().nullish(),
  extracted_text: z.string().nullish(),
  extracted_html: z.string().nullish(),
  in_reply_to: z.string().nullish(),
  headers: z.record(z.string(), z.unknown()).nullish(),
  agent_armor: WireArmor.nullish(),
  attachments: z.array(z.object({
    attachment_id: z.string(), filename: z.string().nullish(), content_type: z.string().nullish(), size: z.number().nullish(),
  })).nullish().catch(null), // an odd attachment entry must never drop the message
  body_url: z.string().nullish(),
});

export function fromWireMessage(raw: unknown): InboundEmail {
  const m = WireMessage.parse(raw);
  const a = m.agent_armor;
  return {
    inboxId: m.inbox_id.toLowerCase(),
    threadId: m.thread_id,
    messageId: m.message_id,
    from: m.from,
    replyTo: m.reply_to ?? [],
    to: m.to ?? [],
    subject: m.subject ?? null,
    ...bodies(m),
    headers: lowerKeys(m.headers),
    labels: m.labels ?? [],
    inReplyTo: m.in_reply_to ?? null,
    attachments: (m.attachments ?? []).map((x) => ({ attachmentId: x.attachment_id, filename: x.filename ?? null, contentType: x.content_type ?? null, size: x.size ?? 0 })),
    security: securityFrom(a ? { status: a.status, verdict: a.verdict ?? undefined, reason: a.reason ?? undefined, unavailableReason: a.unavailable_reason ?? undefined } : null),
    needsBody: !!m.body_url && !m.text && !m.html,
  };
}

// ---------------------------------------------------------------------------
// SDK format (camelCase)
// ---------------------------------------------------------------------------

export function fromSdkMessage(m: AgentMail.Message): InboundEmail {
  const armor = m.agentArmor;
  return {
    inboxId: m.inboxId.toLowerCase(),
    threadId: m.threadId,
    messageId: m.messageId,
    from: m.from,
    replyTo: m.replyTo ?? [],
    to: m.to,
    subject: m.subject ?? null,
    ...bodies({ text: m.text, html: m.html, extracted_text: m.extractedText, extracted_html: m.extractedHtml }),
    headers: lowerKeys(m.headers),
    labels: m.labels,
    inReplyTo: m.inReplyTo ?? null,
    attachments: (m.attachments ?? []).map((x) => ({ attachmentId: x.attachmentId, filename: x.filename ?? null, contentType: x.contentType ?? null, size: x.size })),
    security: securityFrom(armor && {
      status: armor.status,
      verdict: armor.status === "complete" ? armor.verdict : undefined,
      reason: armor.status === "complete" ? armor.reason : undefined,
      unavailableReason: armor.status === "unavailable" ? armor.unavailableReason : undefined,
    }),
    needsBody: false,
  };
}

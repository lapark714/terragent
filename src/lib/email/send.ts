/**
 * OWNER: email builder. Every outbound email goes through here. Gates (enforced in code):
 * inbox armed (or recipient in TEAM_EMAILS), suppression list, daily cap, approved template for outreach,
 * outreach channel flags (email_direct only if OUTREACH_DIRECT_EMAIL_APPROVED), AI disclosure + opt-out footer.
 */
import type { Inbox } from "../domain";

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

export async function sendEmail(args: SendEmailArgs): Promise<SendResult> { throw new Error("not implemented yet"); }

/** Reply in an existing AgentMail thread (threading headers automatic). Same gates as sendEmail. */
export async function replyInThread(args: Omit<SendEmailArgs, "to" | "subject"> & { inReplyToMessageId: string }): Promise<SendResult> { throw new Error("not implemented yet"); }

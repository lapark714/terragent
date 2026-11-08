/**
 * The only place the app talks to AgentMail. A narrow interface (MailApi) over the SDK so the email
 * module can be tested with a fake and so every send carries an idempotency key.
 * TS SDK fields are camelCase; webhook JSON is snake_case (see docs/platform/agentmail.md).
 */
import { AgentMailClient, AgentMailError, type AgentMail } from "agentmail";
import { requireEnv } from "../env";

export interface SentIds { messageId: string; threadId: string }

export interface MailApi {
  send(inboxId: string, req: AgentMail.SendMessageRequest, idempotencyKey: string): Promise<SentIds>;
  reply(inboxId: string, messageId: string, req: AgentMail.ReplyToMessageRequest, idempotencyKey: string): Promise<SentIds>;
  getMessage(inboxId: string, messageId: string): Promise<AgentMail.Message>;
  getThread(threadId: string): Promise<AgentMail.Thread>;
  listMessages(inboxId: string, req: AgentMail.inboxes.ListMessagesRequest): Promise<AgentMail.ListMessagesResponse>;
  /** Org-wide send block list (opt-outs). */
  blockSend(entry: string, reason: string): Promise<void>;
}

let sdk: AgentMailClient | null = null;
let override: MailApi | null = null;

/** Raw SDK client for provisioning scripts. App code uses mailApi(). */
export function agentmailSdk(): AgentMailClient {
  sdk ??= new AgentMailClient({ apiKey: requireEnv("AGENTMAIL_API_KEY") });
  return sdk;
}

export function mailApi(): MailApi {
  if (override) return override;
  const am = agentmailSdk();
  return {
    send: (inboxId, req, idempotencyKey) => am.inboxes.messages.send(inboxId, req, { idempotencyKey }),
    reply: (inboxId, messageId, req, idempotencyKey) => am.inboxes.messages.reply(inboxId, messageId, req, { idempotencyKey }),
    getMessage: (inboxId, messageId) => am.inboxes.messages.get(inboxId, messageId),
    getThread: (threadId) => am.threads.get(threadId, { limit: 100 }),
    listMessages: (inboxId, req) => am.inboxes.messages.list(inboxId, req),
    async blockSend(entry, reason) {
      await am.lists.create("send", "block", { entry, reason });
    },
  };
}

/** Test hook: replace the AgentMail client with a fake (null restores the real one). */
export function setMailApi(api: MailApi | null) {
  override = api;
}

/** Stable short code for an AgentMail failure, e.g. "message_rejected" or "http_429". Never includes bodies. */
export function agentmailErrorCode(e: unknown): string {
  if (e instanceof AgentMailError) {
    const code = (e.body as { code?: string } | undefined)?.code;
    return code ?? `http_${e.statusCode ?? "unknown"}`;
  }
  return e instanceof Error ? e.name : "unknown_error";
}

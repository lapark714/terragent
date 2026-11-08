/**
 * AgentMail webhook: verify the Svix signature, dedupe on svix-id (webhook_events), ack fast, then process.
 * The route calls receiveWebhook() and runs `process` in after(), so AgentMail gets its 2xx well inside 15 s.
 * svix 2.x verify() returns undefined, so we JSON.parse the raw body ourselves (docs/platform/agentmail.md §3.5).
 */
import type { AgentMail } from "agentmail";
import { Webhook } from "svix";
import { z } from "zod";
import { mailApi } from "../agentmail/client";
import { getDb } from "../db/client";
import { env } from "../env";
import { logEvent } from "../events";
import { getSetting, SETTING } from "../settings";
import { handleInboundEmail } from "./inbound";
import { fromSdkMessage, fromWireMessage, securityFrom } from "./inbound-parse";
import { suppress } from "./optout";
import { recordVerdict } from "./security";

/** What scripts/provision-agentmail-webhook.ts subscribes to; dispatchEvent handles each. */
export const WEBHOOK_EVENT_TYPES: AgentMail.EventType[] = [
  "message.received",
  "message.security.completed",
  "message.bounced",
  "message.complained",
  "message.rejected",
];

export interface WebhookReceipt { status: number; body: string; process?: () => Promise<void> }

/** Provisioning stores { id, secret } in settings; AGENTMAIL_WEBHOOK_SECRET is the fallback (e.g. set in Vercel). */
export async function webhookSecret(): Promise<string | null> {
  const stored = await getSetting<{ secret?: string } | null>(SETTING.agentmailWebhook, null);
  return stored?.secret ?? env("AGENTMAIL_WEBHOOK_SECRET") ?? null;
}

const Envelope = z.object({ event_type: z.string(), event_id: z.string().optional() });

export async function receiveWebhook(raw: string, headers: Headers): Promise<WebhookReceipt> {
  const secret = await webhookSecret();
  if (!secret) return { status: 503, body: "webhook secret not configured" };

  const svixHeaders = {
    "svix-id": headers.get("svix-id") ?? "",
    "svix-timestamp": headers.get("svix-timestamp") ?? "",
    "svix-signature": headers.get("svix-signature") ?? "",
  };
  try {
    new Webhook(secret).verify(raw, svixHeaders);
  } catch {
    return { status: 400, body: "invalid signature" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { status: 400, body: "invalid json" };
  }
  const envelope = Envelope.safeParse(payload);
  if (!envelope.success) return { status: 200, body: "ignored" };

  const id = `agentmail:${svixHeaders["svix-id"]}`;
  const db = await getDb();
  const fresh = await db.query(
    "INSERT INTO webhook_events (id, source, type) VALUES ($1, 'agentmail', $2) ON CONFLICT (id) DO NOTHING RETURNING id",
    [id, envelope.data.event_type],
  );
  if (!fresh.length) return { status: 200, body: "duplicate" };

  return { status: 200, body: "ok", process: () => processEvent(id, payload) };
}

async function processEvent(id: string, payload: unknown) {
  const db = await getDb();
  try {
    await dispatchEvent(payload);
    await db.query("UPDATE webhook_events SET processed_at = now(), error = NULL WHERE id = $1", [id]);
  } catch (e) {
    const error = e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 500) : String(e);
    await db.query("UPDATE webhook_events SET error = $2 WHERE id = $1", [id, error]);
    console.error(`[agentmail webhook] ${id} failed: ${error}`);
  }
}

// ---------------------------------------------------------------------------
// Event handlers (wire JSON is snake_case)
// ---------------------------------------------------------------------------

const SecurityEvent = z.object({
  message: z.object({
    inbox_id: z.string(),
    message_id: z.string(),
    agent_armor: z.object({ status: z.string(), verdict: z.string().nullish(), reason: z.string().nullish() }),
  }),
});
const BouncedEvent = z.object({
  bounce: z.object({ message_id: z.string(), type: z.string(), recipients: z.array(z.object({ address: z.string() })) }),
});
const ComplainedEvent = z.object({ complaint: z.object({ message_id: z.string(), recipients: z.array(z.string()) }) });
const RejectedEvent = z.object({ reject: z.object({ message_id: z.string(), reason: z.string().nullish() }) });

export async function dispatchEvent(payload: unknown): Promise<void> {
  const type = Envelope.parse(payload).event_type;
  const p = payload as Record<string, unknown>;
  switch (type) {
    case "message.received":
      await handleInboundEmail(fromWireMessage(p.message));
      return;
    case "message.security.completed":
      return onSecurityCompleted(SecurityEvent.parse(p));
    case "message.bounced":
      return onBounced(BouncedEvent.parse(p));
    case "message.complained":
      return onComplained(ComplainedEvent.parse(p));
    case "message.rejected":
      return onRejected(RejectedEvent.parse(p));
    default:
      return;
  }
}

async function onSecurityCompleted(ev: z.infer<typeof SecurityEvent>) {
  const { inbox_id, message_id, agent_armor: a } = ev.message;
  const security = securityFrom({ status: a.status, verdict: a.verdict ?? undefined, reason: a.reason ?? undefined });
  if (await recordVerdict(inbox_id, message_id, security)) return;
  // Events are unordered: the verdict beat message.received. Fetch the message (it carries the verdict) and route it now.
  await handleInboundEmail(fromSdkMessage(await mailApi().getMessage(inbox_id, message_id)));
}

async function onBounced(ev: z.infer<typeof BouncedEvent>) {
  const permanent = /^permanent$/i.test(ev.bounce.type);
  await markOutbound(ev.bounce.message_id, "bounced", `bounce:${ev.bounce.type}`);
  for (const r of ev.bounce.recipients) {
    if (permanent) await suppress(r.address, "bounce");
    else await logEvent("email.bounced_transient", "system", { email: r.address.toLowerCase(), message_id: ev.bounce.message_id });
  }
}

async function onComplained(ev: z.infer<typeof ComplainedEvent>) {
  await markOutbound(ev.complaint.message_id, "bounced", "complaint");
  for (const address of ev.complaint.recipients) await suppress(address, "complaint");
}

async function onRejected(ev: z.infer<typeof RejectedEvent>) {
  await markOutbound(ev.reject.message_id, "failed", `rejected:${ev.reject.reason ?? "unknown"}`);
}

async function markOutbound(agentmailMessageId: string, status: "bounced" | "failed", reason: string) {
  const db = await getDb();
  const rows = await db.query<{ id: string; request_id: string | null; counterpart_email: string | null }>(
    "UPDATE messages SET status = $2, blocked_reason = $3 WHERE agentmail_message_id = $1 AND direction = 'outbound' RETURNING id, request_id, counterpart_email",
    [agentmailMessageId, status, reason],
  );
  for (const r of rows) await logEvent(`email.${status}`, "system", { message_id: r.id, to: r.counterpart_email, reason }, r.request_id);
}

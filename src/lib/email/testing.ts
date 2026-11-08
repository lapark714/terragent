/** Test helpers for the email module: an in-memory database and a fake AgentMail. Never used by app code. */
import type { AgentMail } from "agentmail";
import { vi } from "vitest";
import { setMailApi, type MailApi } from "../agentmail/client";
import { createDb, setDb, type Db } from "../db/client";
import { migrate } from "../db/migrate";

export async function memoryDb(): Promise<Db> {
  const db = await createDb({ memory: true });
  await migrate(db);
  setDb(db);
  return db;
}

const TABLES = ["messages", "suppression", "optout_tokens", "templates", "settings", "events", "requests", "prospects", "orders", "webhook_events"];

export async function resetDb(db: Db) {
  await db.query(`TRUNCATE ${TABLES.join(", ")}`);
}

export type FakeMail = { [K in keyof MailApi]: ReturnType<typeof vi.fn<MailApi[K]>> };

/** Every call is a vi.fn; send/reply return deterministic ids. Installed as the active MailApi. */
export function fakeMail(): FakeMail {
  let n = 0;
  const fake: FakeMail = {
    send: vi.fn<MailApi["send"]>(async () => ({ messageId: `<out-${++n}@agentmail.to>`, threadId: `thr-out-${n}` })),
    reply: vi.fn<MailApi["reply"]>(async () => ({ messageId: `<reply-${++n}@agentmail.to>`, threadId: "thr-reply" })),
    getMessage: vi.fn<MailApi["getMessage"]>(async () => { throw new Error("getMessage not stubbed"); }),
    getThread: vi.fn<MailApi["getThread"]>(async () => { throw new Error("getThread not stubbed"); }),
    listMessages: vi.fn<MailApi["listMessages"]>(async () => ({ count: 0, messages: [] })),
    blockSend: vi.fn<MailApi["blockSend"]>(async () => {}),
  };
  setMailApi(fake);
  return fake;
}

/** An SDK-shaped received message (camelCase), as messages.get returns it. */
export function sdkMessage(o: Partial<AgentMail.Message> = {}): AgentMail.Message {
  const now = new Date("2026-11-07T12:00:00Z");
  return {
    inboxId: "terragent@agentmail.to", threadId: "thr-1", messageId: "<m1@mail.example.com>", labels: ["received", "unread"],
    timestamp: now, from: "Pat Doe <pat@acme.com>", to: ["terragent@agentmail.to"], subject: "Flooding at our warehouse?",
    text: "Did our warehouse at 1 Main St flood last week?", extractedText: "Did our warehouse at 1 Main St flood last week?",
    agentArmor: { status: "complete", verdict: "clear", reason: "ok", model: "m", completedAt: now },
    size: 100, updatedAt: now, createdAt: now,
    ...o,
  };
}

/** A webhook-shaped message.received payload (snake_case, with the extra keys AgentMail really sends). */
export function wireReceived(o: Record<string, unknown> = {}) {
  return {
    type: "event",
    event_type: "message.received",
    event_id: "evt_1",
    message: {
      organization_id: "org_x", pod_id: "pod_x", smtp_id: "smtp_x",
      inbox_id: "terragent@agentmail.to", thread_id: "thr-1", message_id: "<m1@mail.example.com>",
      labels: ["received", "unread"], timestamp: "2026-11-07T12:00:00Z", from: "Pat Doe <pat@acme.com>",
      to: ["terragent@agentmail.to"], subject: "Flooding at our warehouse?",
      text: "Did our warehouse flood?\n\n> quoted history", extracted_text: "Did our warehouse flood?",
      headers: { "X-Mailer": "test" },
      agent_armor: { status: "pending", started_at: "2026-11-07T12:00:00Z", deadline_at: "2026-11-07T12:15:00Z" },
      size: 100, updated_at: "2026-11-07T12:00:00Z", created_at: "2026-11-07T12:00:00Z",
      ...o,
    },
    thread: { inbox_id: "terragent@agentmail.to", thread_id: "thr-1" },
  };
}

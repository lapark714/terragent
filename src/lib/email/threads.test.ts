import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setMailApi } from "../agentmail/client";
import type { Db } from "../db/client";
import { fromSdkMessage, fromWireMessage, htmlToText } from "./inbound-parse";
import { getThread } from "./threads";
import { fakeMail, memoryDb, resetDb, sdkMessage, wireReceived, type FakeMail } from "./testing";

let db: Db;
let mail: FakeMail;

beforeAll(async () => {
  db = await memoryDb();
});
beforeEach(async () => {
  await resetDb(db);
  mail = fakeMail();
});
afterAll(async () => {
  setMailApi(null);
  await db.close();
});

async function store(o: { id: string; direction: string; status: string; verdict?: string | null; at: string; text: string }) {
  await db.query(
    `INSERT INTO messages (id, direction, inbox, counterpart_email, subject, body_text, agentmail_message_id, thread_id, status, security_verdict, created_at, sent_at, meta)
     VALUES ($1, $2, 'hello', 'pat@acme.com', 'Flood?', $3, $4, 'thr-1', $5, $6, $7, $8, $9)`,
    [o.id, o.direction, o.text, `<${o.id}>`, o.status, o.verdict ?? null, o.at, o.direction === "outbound" ? o.at : null,
      JSON.stringify(o.direction === "inbound" ? { from: "Pat Doe <pat@acme.com>" } : {})],
  );
}

describe("getThread", () => {
  it("reads the conversation from our messages table, oldest first, without blocked drafts", async () => {
    await store({ id: "m2", direction: "outbound", status: "sent", at: "2026-11-07T10:05:00Z", text: "Here's your quote" });
    await store({ id: "m1", direction: "inbound", status: "received", verdict: "clear", at: "2026-11-07T10:00:00Z", text: "Did it flood?" });
    await store({ id: "m3", direction: "outbound", status: "blocked", at: "2026-11-07T10:06:00Z", text: "never sent" });

    const t = await getThread("thr-1");
    expect(mail.getThread).not.toHaveBeenCalled();
    expect(t?.inbox).toBe("hello");
    expect(t?.messages).toEqual([
      { direction: "inbound", from: "Pat Doe <pat@acme.com>", to: ["terragent@agentmail.to"], subject: "Flood?", text: "Did it flood?", at: "2026-11-07T10:00:00.000Z", agentmail_message_id: "<m1>", security_verdict: "clear" },
      { direction: "outbound", from: "terragent@agentmail.to", to: ["pat@acme.com"], subject: "Flood?", text: "Here's your quote", at: "2026-11-07T10:05:00.000Z", agentmail_message_id: "<m2>" },
    ]);
  });

  it("asks AgentMail when a verdict is still pending, and stores the final verdict", async () => {
    await store({ id: "m1", direction: "inbound", status: "received", verdict: "pending", at: "2026-11-07T10:00:00Z", text: "Did it flood?" });
    await db.query("INSERT INTO requests (id, source, question) VALUES ('req_1', 'email', 'q?')");
    await db.query("UPDATE messages SET request_id = 'req_1'");
    const now = new Date("2026-11-07T10:00:00Z");
    mail.getThread.mockResolvedValueOnce({
      inboxId: "terragent@agentmail.to", threadId: "thr-1", labels: [], timestamp: now, senders: [], recipients: [], lastMessageId: "<m1>",
      messageCount: 2, size: 1, updatedAt: now, createdAt: now, count: 2,
      messages: [
        sdkMessage({ messageId: "<m1>", extractedText: "Did it flood?", agentArmor: { status: "complete", verdict: "review", reason: "injection", model: "m", completedAt: now } }),
        sdkMessage({ messageId: "<m2>", from: "Terragent <terragent@agentmail.to>", to: ["pat@acme.com"], text: "Quote", extractedText: undefined, agentArmor: undefined }),
      ],
    });
    const t = await getThread("thr-1");
    expect(t?.messages.map((m) => [m.direction, m.security_verdict])).toEqual([["inbound", "review"], ["outbound", undefined]]);
    const [m] = await db.query<{ security_verdict: string }>("SELECT security_verdict FROM messages WHERE id = 'm1'");
    expect(m.security_verdict).toBe("review");
    const [r] = await db.query<{ meta: { untrusted?: boolean } }>("SELECT meta FROM requests WHERE id = 'req_1'");
    expect(r.meta.untrusted).toBe(true);
  });

  it("lists inbound attachment metadata so agents know a file came with the email", async () => {
    await store({ id: "m1", direction: "inbound", status: "received", verdict: "clear", at: "2026-11-07T10:00:00Z", text: "KML attached" });
    const attachments = [{ attachmentId: "att_1", filename: "site.kml", contentType: "application/vnd.google-earth.kml+xml", size: 2048 }];
    await db.query("UPDATE messages SET meta = meta || $1::jsonb", [JSON.stringify({ attachments })]);
    expect((await getThread("thr-1"))?.messages[0].attachments).toEqual(attachments);
  });

  it("offline (local demo database) reads stored messages only and never calls AgentMail", async () => {
    vi.stubEnv("TERRAGENT_DB", "local");
    try {
      await store({ id: "m1", direction: "inbound", status: "received", verdict: "pending", at: "2026-11-07T10:00:00Z", text: "hi" });
      expect((await getThread("thr-1"))?.messages[0]).toMatchObject({ text: "hi", security_verdict: null });
      expect(await getThread("thr-unknown")).toBeNull();
      expect(mail.getThread).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("returns null for an unknown thread, and DB rows when AgentMail is unreachable", async () => {
    expect(await getThread("thr-unknown")).toBeNull();
    await store({ id: "m1", direction: "inbound", status: "received", verdict: "pending", at: "2026-11-07T10:00:00Z", text: "hi" });
    const t = await getThread("thr-1");
    expect(t?.messages[0]).toMatchObject({ text: "hi", security_verdict: null });
  });
});

describe("inbound parsing", () => {
  it("reads webhook JSON leniently (extra keys) and keeps only the new reply text", () => {
    const m = fromWireMessage(wireReceived({ headers: { "X-Mailer": "test", "Auto-Submitted": "no" } }).message);
    expect(m).toMatchObject({
      inboxId: "terragent@agentmail.to", threadId: "thr-1", messageId: "<m1@mail.example.com>", from: "Pat Doe <pat@acme.com>",
      replyText: "Did our warehouse flood?", headers: { "x-mailer": "test", "auto-submitted": "no" }, security: { verdict: "pending", reason: null }, needsBody: false,
    });
    expect(m.fullText).toContain("quoted history");
  });

  it("reads attachment metadata; a malformed attachment entry never drops the message", () => {
    const ok = fromWireMessage(wireReceived({ attachments: [{ attachment_id: "a1", filename: "x.pdf", content_type: "application/pdf", size: 10, inline: false }] }).message);
    expect(ok.attachments).toEqual([{ attachmentId: "a1", filename: "x.pdf", contentType: "application/pdf", size: 10 }]);
    expect(fromWireMessage(wireReceived({ attachments: [{ weird: true }] }).message).attachments).toEqual([]);
    const sdk = fromSdkMessage(sdkMessage({ attachments: [{ attachmentId: "a2", size: 5 }] }));
    expect(sdk.attachments).toEqual([{ attachmentId: "a2", filename: null, contentType: null, size: 5 }]);
  });

  it("falls back to HTML when a message has no text part (as real mail from NASA FIRMS did)", () => {
    const m = fromSdkMessage(sdkMessage({ text: undefined, extractedText: undefined, html: "<p>Your key:&nbsp;<b>abc</b></p><p>Thanks &amp; bye</p>", extractedHtml: undefined }));
    expect(m.replyText).toBe("Your key: abc\nThanks & bye");
  });

  it("maps Agent Armor results", () => {
    const at = new Date();
    expect(fromSdkMessage(sdkMessage({ agentArmor: { status: "unavailable", unavailableReason: "deadline_exceeded" } })).security).toEqual({ verdict: "unavailable", reason: "deadline_exceeded" });
    expect(fromSdkMessage(sdkMessage({ agentArmor: { status: "pending", startedAt: at, deadlineAt: at } })).security.verdict).toBe("pending");
    expect(fromSdkMessage(sdkMessage({ agentArmor: undefined })).security).toEqual({ verdict: "unavailable", reason: "not_scanned" });
  });

  it("htmlToText drops style blocks", () => {
    expect(htmlToText("<style>p{color:red}</style><div>a</div><div>b</div>")).toBe("a\nb");
  });
});

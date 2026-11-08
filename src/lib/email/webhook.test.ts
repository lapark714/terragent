import { Webhook } from "svix";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setMailApi } from "../agentmail/client";
import type { Db } from "../db/client";
import { setSetting, SETTING } from "../settings";
import { isSuppressed } from "./optout";
import { fakeMail, memoryDb, resetDb, sdkMessage, wireReceived, type FakeMail } from "./testing";
import { receiveWebhook } from "./webhook";

const mocks = vi.hoisted(() => ({ handoff: vi.fn(), createRequest: vi.fn(), addNote: vi.fn() }));
vi.mock("../pipeline/requests", () => mocks);
vi.mock("../naive/board", () => ({ upsertCard: vi.fn() }));

const SECRET = `whsec_${Buffer.from("terragent-test-secret-32-bytes!!").toString("base64")}`;
let db: Db;
let mail: FakeMail;
let svixSeq = 0;

function signed(payload: unknown, o: { secret?: string; id?: string; at?: Date; tamper?: boolean } = {}) {
  const raw = JSON.stringify(payload);
  const id = o.id ?? `msg_svix_${++svixSeq}`;
  const at = o.at ?? new Date();
  const signature = new Webhook(o.secret ?? SECRET).sign(id, at, raw);
  const headers = new Headers({ "svix-id": id, "svix-timestamp": String(Math.floor(at.getTime() / 1000)), "svix-signature": signature });
  return { raw: o.tamper ? raw.replace("Flooding", "Flooded!") : raw, headers };
}

async function deliver(payload: unknown, o: Parameters<typeof signed>[1] = {}) {
  const { raw, headers } = signed(payload, o);
  const receipt = await receiveWebhook(raw, headers);
  await receipt.process?.();
  return receipt;
}

beforeAll(async () => {
  db = await memoryDb();
});
beforeEach(async () => {
  await resetDb(db);
  mail = fakeMail();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.createRequest.mockResolvedValue({ id: "req_new" });
  await setSetting(SETTING.agentmailWebhook, { id: "wh_1", secret: SECRET });
});
afterAll(async () => {
  setMailApi(null);
  await db.close();
});

const count = async (table: string) => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`))[0].n;

describe("verification", () => {
  it("accepts a valid signature, acks before processing, then routes", async () => {
    const { raw, headers } = signed(wireReceived());
    const receipt = await receiveWebhook(raw, headers);
    expect(receipt).toMatchObject({ status: 200, body: "ok" });
    expect(await count("messages")).toBe(0); // nothing heavy before the ack
    await receipt.process!();
    expect(await count("messages")).toBe(1);
    expect(mocks.createRequest).toHaveBeenCalledOnce();
    const [ev] = await db.query<{ processed_at: string | null; type: string }>("SELECT processed_at, type FROM webhook_events");
    expect(ev.type).toBe("message.received");
    expect(ev.processed_at).not.toBeNull();
  });

  it("rejects a bad signature, a tampered body, a wrong secret and a stale timestamp", async () => {
    const good = signed(wireReceived());
    expect((await receiveWebhook(good.raw, new Headers({ ...Object.fromEntries(good.headers), "svix-signature": "v1,AAAA" }))).status).toBe(400);
    const tampered = signed(wireReceived(), { tamper: true });
    expect((await receiveWebhook(tampered.raw, tampered.headers)).status).toBe(400);
    const wrong = signed(wireReceived(), { secret: `whsec_${Buffer.from("another-secret-another-secret!!").toString("base64")}` });
    expect((await receiveWebhook(wrong.raw, wrong.headers)).status).toBe(400);
    const stale = signed(wireReceived(), { at: new Date(Date.now() - 10 * 60_000) });
    expect((await receiveWebhook(stale.raw, stale.headers)).status).toBe(400);
    expect(await count("webhook_events")).toBe(0);
  });

  it("falls back to AGENTMAIL_WEBHOOK_SECRET, and refuses to run without any secret", async () => {
    await db.query("DELETE FROM settings");
    const { raw, headers } = signed(wireReceived());
    expect((await receiveWebhook(raw, headers)).status).toBe(503);
    vi.stubEnv("AGENTMAIL_WEBHOOK_SECRET", SECRET);
    expect((await receiveWebhook(raw, headers)).status).toBe(200);
  });

  it("dedupes retries on svix-id", async () => {
    const payload = wireReceived();
    expect((await deliver(payload, { id: "msg_same" })).body).toBe("ok");
    expect((await deliver(payload, { id: "msg_same" })).body).toBe("duplicate");
    expect(await count("webhook_events")).toBe(1);
    expect(mocks.createRequest).toHaveBeenCalledOnce();
  });

  it("records processing errors on the webhook event", async () => {
    mocks.handoff.mockRejectedValueOnce(new Error("naive down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await deliver(wireReceived());
    const [ev] = await db.query<{ error: string | null; processed_at: string | null }>("SELECT error, processed_at FROM webhook_events");
    expect(ev.error).toContain("naive down");
    expect(ev.processed_at).toBeNull();
  });
});

describe("events", () => {
  const security = (verdict: string) => ({
    type: "event", event_type: "message.security.completed", event_id: "evt_s",
    message: { organization_id: "org", inbox_id: "terragent@agentmail.to", message_id: "<m1@mail.example.com>",
      agent_armor: { status: "complete", verdict, reason: "looks like an injection", model: "m", completed_at: "2026-11-07T12:00:03Z" } },
  });

  it("message.security.completed after the message: stores the verdict and flags its request", async () => {
    await db.query("INSERT INTO requests (id, source, question, thread_id) VALUES ('req_1', 'email', 'q?', 'thr-1')");
    await deliver(wireReceived()); // pending at receive time
    await deliver(security("review"));
    const [m] = await db.query<{ security_verdict: string; security_reason: string }>("SELECT security_verdict, security_reason FROM messages");
    expect(m).toEqual({ security_verdict: "review", security_reason: "looks like an injection" });
    const [r] = await db.query<{ meta: { untrusted?: boolean } }>("SELECT meta FROM requests WHERE id = 'req_1'");
    expect(r.meta.untrusted).toBe(true);
  });

  it("message.security.completed before the message: fetches and routes it", async () => {
    mail.getMessage.mockResolvedValueOnce(sdkMessage());
    await deliver(security("clear"));
    expect(mail.getMessage).toHaveBeenCalledWith("terragent@agentmail.to", "<m1@mail.example.com>");
    expect(mocks.createRequest).toHaveBeenCalledOnce();
    // The late message.received is now a duplicate.
    await deliver(wireReceived());
    expect(mocks.createRequest).toHaveBeenCalledOnce();
  });

  it("fetches the body when the webhook omitted it (> 64 KiB)", async () => {
    mail.getMessage.mockResolvedValueOnce(sdkMessage({ text: "big body", extractedText: "big body" }));
    await deliver(wireReceived({ text: undefined, extracted_text: undefined, body_url: "https://signed.example/body" }));
    expect(mail.getMessage).toHaveBeenCalledOnce();
    const [m] = await db.query<{ body_text: string }>("SELECT body_text FROM messages");
    expect(m.body_text).toBe("big body");
  });

  it("permanent bounce → suppression + message bounced; transient bounce → no suppression", async () => {
    await db.query("INSERT INTO messages (id, direction, inbox, counterpart_email, agentmail_message_id, status) VALUES ('msg_b', 'outbound', 'outreach', 'gone@acme.com', '<out-9@agentmail.to>', 'sent')");
    const bounce = (type: string, address: string) => ({
      type: "event", event_type: "message.bounced", event_id: `evt_b_${address}`,
      bounce: { inbox_id: "terragent-outreach@agentmail.to", thread_id: "t", message_id: "<out-9@agentmail.to>", timestamp: "2026-11-07T12:00:00Z", type, sub_type: "General", recipients: [{ address, status: "failed" }] },
    });
    await deliver(bounce("Transient", "full@acme.com"));
    expect(await isSuppressed("full@acme.com")).toBe(false);
    await deliver(bounce("Permanent", "Gone@acme.com"));
    expect(await isSuppressed("gone@acme.com")).toBe(true);
    const [m] = await db.query<{ status: string }>("SELECT status FROM messages WHERE id = 'msg_b'");
    expect(m.status).toBe("bounced");
  });

  it("complaint → suppression (reason complaint) and the prospect opted out", async () => {
    await db.query("INSERT INTO prospects (id, playbook, company, contact_email, status) VALUES ('pro_c', 'mining', 'Ore', 'angry@ore.com', 'emailed')");
    await deliver({
      type: "event", event_type: "message.complained", event_id: "evt_c",
      complaint: { inbox_id: "terragent-outreach@agentmail.to", thread_id: "t", message_id: "<out-1@agentmail.to>", timestamp: "2026-11-07T12:00:00Z", type: "abuse", sub_type: "", recipients: ["angry@ore.com"] },
    });
    const [s] = await db.query<{ reason: string }>("SELECT reason FROM suppression WHERE email = 'angry@ore.com'");
    expect(s.reason).toBe("complaint");
    const [p] = await db.query<{ status: string }>("SELECT status FROM prospects WHERE id = 'pro_c'");
    expect(p.status).toBe("opted_out");
  });

  it("ignores event types it doesn't handle", async () => {
    const receipt = await deliver({ type: "event", event_type: "message.delivered", event_id: "evt_d", delivery: {} });
    expect(receipt.status).toBe(200);
    expect(await count("messages")).toBe(0);
  });
});

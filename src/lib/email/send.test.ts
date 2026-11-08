import { AgentMailError } from "agentmail";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setMailApi } from "../agentmail/client";
import { CAPS } from "../config";
import type { Db } from "../db/client";
import { setSetting, SETTING } from "../settings";
import { suppress } from "./optout";
import { replyInThread, sendEmail, type SendEmailArgs } from "./send";
import { AI_DISCLOSURE } from "./templates";
import { fakeMail, memoryDb, resetDb, type FakeMail } from "./testing";

vi.mock("../naive/email", () => ({ sendColdEmail: vi.fn(async (m: { to: string }) => ({ messageId: null, threadId: `naive:${m.to}` })) }));

let db: Db;
let mail: FakeMail;
let seq = 0;

beforeAll(async () => {
  db = await memoryDb();
});
beforeEach(async () => {
  await resetDb(db);
  mail = fakeMail();
  vi.unstubAllEnvs();
  vi.stubEnv("PUBLIC_BASE_URL", "https://terragent.test");
  vi.stubEnv("TEAM_EMAILS", "Founder@Team.com, other@team.com");
});
afterAll(async () => {
  setMailApi(null);
  vi.unstubAllEnvs();
  await db.close();
});

const arm = (inboxes: Record<string, boolean>) => setSetting(SETTING.inboxArmed, inboxes);

function args(o: Partial<SendEmailArgs> = {}): SendEmailArgs {
  return { inbox: "hello", to: "pat@acme.com", subject: "Your quote", text: "Hello Pat", kind: "customer", idempotencyKey: `k-${++seq}`, actor: "comms-customer", ...o };
}

async function template(kind: "outreach" | "followup", status = "approved") {
  const id = `tpl_${kind}_${status}`;
  await db.query("INSERT INTO templates (id, playbook, version, kind, subject, body, status) VALUES ($1, 'disasters', $1, $2, 's', 'b', $3)", [id, kind, status]);
  return id;
}

async function row(messageId: string) {
  const [r] = await db.query<{ status: string; blocked_reason: string | null; counterpart_email: string; body_text: string; thread_id: string | null }>(
    "SELECT status, blocked_reason, counterpart_email, body_text, thread_id FROM messages WHERE id = $1", [messageId]);
  return r;
}

describe("gates", () => {
  it("blocks when the inbox is not armed and records why", async () => {
    const r = await sendEmail(args());
    expect(r).toMatchObject({ status: "blocked", blocked_reason: "inbox_not_armed" });
    expect(mail.send).not.toHaveBeenCalled();
    expect(await row(r.message_id)).toMatchObject({ status: "blocked", blocked_reason: "inbox_not_armed" });
    const [ev] = await db.query<{ type: string }>("SELECT type FROM events");
    expect(ev.type).toBe("email.blocked");
  });

  it("lets TEAM_EMAILS through an unarmed inbox, normalising the address", async () => {
    const r = await sendEmail(args({ to: "  FOUNDER@team.com " }));
    expect(r.status).toBe("sent");
    expect(mail.send).toHaveBeenCalledOnce();
    const [inbox, req] = mail.send.mock.calls[0];
    expect(inbox).toBe("terragent@agentmail.to");
    expect(req.to).toEqual(["founder@team.com"]);
    expect((await row(r.message_id)).counterpart_email).toBe("founder@team.com");
  });

  it("an armed inbox sends to anyone; other inboxes stay blocked", async () => {
    await arm({ hello: true });
    expect((await sendEmail(args())).status).toBe("sent");
    expect((await sendEmail(args({ inbox: "data", kind: "supplier_quote" }))).blocked_reason).toBe("inbox_not_armed");
  });

  it("blocks suppressed recipients, even team members", async () => {
    await arm({ hello: true });
    await suppress("pat@acme.com", "opt_out");
    await suppress("founder@team.com", "bounce");
    expect((await sendEmail(args({ to: "PAT@acme.com" }))).blocked_reason).toBe("suppressed");
    expect((await sendEmail(args({ to: "founder@team.com" }))).blocked_reason).toBe("suppressed");
  });

  it("enforces the org-wide daily cap on today's sends only", async () => {
    await arm({ hello: true });
    const insert = (prefix: string, when: string) => db.query(
      `INSERT INTO messages (id, direction, inbox, counterpart_email, status, sent_at, idempotency_key)
       SELECT 'msg_' || $1 || g, 'outbound', 'hello', 'x@y.com', 'sent', ${when}, $1 || g FROM generate_series(1, $2) g`,
      [prefix, CAPS.emailsPerDayTotal]);
    await insert("old", "now() - interval '2 days'");
    expect((await sendEmail(args())).status).toBe("sent");
    await insert("today", "now()");
    expect((await sendEmail(args())).blocked_reason).toBe("daily_cap_reached");
  });

  it("the daily cap still counts sends that later bounced or failed (AgentMail's quota was used)", async () => {
    await arm({ hello: true });
    await db.query(
      `INSERT INTO messages (id, direction, inbox, counterpart_email, status, sent_at, idempotency_key)
       SELECT 'msg_b' || g, 'outbound', 'hello', 'x@y.com', CASE WHEN g % 2 = 0 THEN 'bounced' ELSE 'failed' END, now(), 'b' || g
       FROM generate_series(1, $1) g`,
      [CAPS.emailsPerDayTotal]);
    expect((await sendEmail(args())).blocked_reason).toBe("daily_cap_reached");
  });

  it("rejects invalid recipients and our own inboxes", async () => {
    await arm({ hello: true });
    expect((await sendEmail(args({ to: "not an email" }))).blocked_reason).toBe("invalid_recipient");
    expect((await sendEmail(args({ to: "terragent-data@agentmail.to" }))).blocked_reason).toBe("recipient_is_own_inbox");
  });

  it("blocks unfilled placeholders instead of shipping {{x}}", async () => {
    await arm({ hello: true });
    expect((await sendEmail(args({ text: "Hi {{contact_name}}" }))).blocked_reason).toBe("unfilled_placeholder");
    expect((await sendEmail(args({ subject: "About {{company}}" }))).blocked_reason).toBe("unfilled_placeholder");
    expect((await sendEmail(args({ text: "Hi {{ name | there }}" }))).blocked_reason).toBe("unfilled_placeholder");
    expect(mail.send).not.toHaveBeenCalled();
  });

  it("stray braces in a customer's own words (pasted JSON) don't block their email", async () => {
    await arm({ hello: true });
    expect((await sendEmail(args({ text: 'You asked: "is {"site": {"id": 4}} flooded?"' }))).status).toBe("sent");
  });
});

describe("outreach gates", () => {
  const outreach = (o: Partial<SendEmailArgs> = {}) => args({ inbox: "outreach", kind: "outreach", channel: "email_warm", actor: "comms-outreach", ...o });

  beforeEach(async () => {
    await arm({ outreach: true });
    vi.stubEnv("COMPANY_POSTAL_ADDRESS", "1 Test Way, Testville, CA 90000");
  });

  it("requires an approved template of the same kind", async () => {
    expect((await sendEmail(outreach())).blocked_reason).toBe("template_required");
    expect((await sendEmail(outreach({ templateId: await template("outreach", "draft") }))).blocked_reason).toBe("template_not_approved");
    expect((await sendEmail(outreach({ templateId: "tpl_missing" }))).blocked_reason).toBe("template_not_approved");
    const approved = await template("outreach");
    expect((await sendEmail(outreach({ kind: "followup", templateId: approved }))).blocked_reason).toBe("template_not_approved");
    expect((await sendEmail(outreach({ templateId: approved }))).status).toBe("sent");
  });

  it("allows email_warm; email_direct only with OUTREACH_DIRECT_EMAIL_APPROVED; nothing else", async () => {
    const templateId = await template("outreach");
    expect((await sendEmail(outreach({ templateId, channel: undefined }))).blocked_reason).toBe("channel_not_allowed");
    expect((await sendEmail(outreach({ templateId, channel: "email" }))).blocked_reason).toBe("channel_not_allowed");
    expect((await sendEmail(outreach({ templateId, channel: "email_direct" }))).blocked_reason).toBe("direct_email_not_approved");
    vi.stubEnv("OUTREACH_DIRECT_EMAIL_APPROVED", "true");
    expect((await sendEmail(outreach({ templateId, channel: "email_direct" }))).status).toBe("sent");
  });

  it("needs a postal address (CAN-SPAM)", async () => {
    vi.stubEnv("COMPANY_POSTAL_ADDRESS", "");
    expect((await sendEmail(outreach({ templateId: await template("outreach") }))).blocked_reason).toBe("missing_postal_address");
  });

  it("needs a public https opt-out link, except for team test sends", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "");
    const templateId = await template("outreach");
    expect((await sendEmail(outreach({ templateId }))).blocked_reason).toBe("optout_url_not_public");
    expect((await sendEmail(outreach({ templateId, to: "founder@team.com" }))).status).toBe("sent");
  });

  it("injects identity, AI disclosure and the recipient's opt-out link", async () => {
    const r = await sendEmail(outreach({ templateId: await template("outreach"), text: "We looked at your warehouse." }));
    expect(r.status).toBe("sent");
    const sent = mail.send.mock.calls[0][1];
    expect(sent.text).toContain(AI_DISCLOSURE);
    expect(sent.text).toMatch(/Opt out here: https:\/\/terragent\.test\/unsubscribe\?t=\w+/);
    expect(sent.text).toContain("1 Test Way");
    expect(sent.html).toMatch(/unsubscribe\?t=/);
    expect((await row(r.message_id)).body_text).toContain(AI_DISCLOSURE);
  });

  it("customer email gets the AI disclosure but no opt-out", async () => {
    await arm({ hello: true });
    await sendEmail(args());
    const sent = mail.send.mock.calls[0][1];
    expect(sent.text).toContain(AI_DISCLOSURE);
    expect(sent.text).not.toContain("unsubscribe");
  });
});

describe("idempotency", () => {
  it("returns the earlier result without sending twice", async () => {
    await arm({ hello: true });
    const a = await sendEmail(args({ idempotencyKey: "deliver:req_1" }));
    const b = await sendEmail(args({ idempotencyKey: "deliver:req_1" }));
    expect(b).toEqual(a);
    expect(mail.send).toHaveBeenCalledOnce();
    expect(mail.send.mock.calls[0][2]).toMatch(/^tg-[0-9a-f]{64}$/); // ":" isn't allowed in AgentMail keys
    const [{ n }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM messages");
    expect(n).toBe(1);
  });

  it("re-checks a blocked message on retry (e.g. after a founder arms the inbox)", async () => {
    const blocked = await sendEmail(args({ idempotencyKey: "quote-req_2" }));
    expect(blocked.status).toBe("blocked");
    await arm({ hello: true });
    const sent = await sendEmail(args({ idempotencyKey: "quote-req_2" }));
    expect(sent).toMatchObject({ status: "sent", message_id: blocked.message_id });
    expect(mail.send.mock.calls[0][2]).toBe("quote-req_2");
  });

  it("records AgentMail failures without throwing, and a retry can still send", async () => {
    await arm({ hello: true });
    mail.send.mockRejectedValueOnce(new AgentMailError({ message: "boom", statusCode: 500, body: { code: "internal_error" } }));
    const failed = await sendEmail(args({ idempotencyKey: "k-fail" }));
    expect(failed).toMatchObject({ status: "blocked", blocked_reason: "send_failed:internal_error" });
    expect((await row(failed.message_id)).status).toBe("failed");
    expect((await sendEmail(args({ idempotencyKey: "k-fail" }))).status).toBe("sent");
  });
});

describe("provider refusals", () => {
  const limit = (message: string, code: string | null = "rate_limit_exceeded") =>
    new AgentMailError({ message: "limited", statusCode: 429, body: code ? { name: "RateLimitError", code, message } : { message } });
  const rejected = (code: string) => new AgentMailError({ message: "rejected", statusCode: 403, body: { name: "MessageRejectedError", code, message: "no" } });
  const providerEvents = () =>
    db.query<{ actor: string; request_id: string | null; payload: { reason: string; limit: string | null; http_status: number; to: string } }>(
      "SELECT actor, request_id, payload FROM events WHERE type = 'email.blocked_by_provider' ORDER BY id");
  let templates: Record<"outreach" | "followup", string>;
  const outreachArgs = (o: Partial<SendEmailArgs> = {}) =>
    args({ inbox: "outreach", kind: "outreach", channel: "email_warm", actor: "comms-outreach", templateId: templates.outreach, ...o });

  beforeEach(async () => {
    vi.stubEnv("COMPANY_POSTAL_ADDRESS", "1 Test Way, Testville, CA 90000");
    templates = { outreach: await template("outreach"), followup: await template("followup") };
  });

  it("the new-org recipient ramp (429) blocks the message as provider_limit, logs it, and never throws or retries", async () => {
    await arm({ hello: true });
    mail.send.mockRejectedValueOnce(limit("Recipient limit exceeded for new organization"));
    await db.query("INSERT INTO requests (id, source, question) VALUES ('req_l', 'portal', 'Did it flood?')");
    const r = await sendEmail(args({ requestId: "req_l" }));
    expect(r).toEqual({ status: "blocked", message_id: r.message_id, blocked_reason: "provider_limit:rate_limit_exceeded" });
    expect(mail.send).toHaveBeenCalledOnce();
    const [stored] = await db.query<{ status: string; blocked_reason: string; sent_at: Date | null }>(
      "SELECT status, blocked_reason, sent_at FROM messages WHERE id = $1", [r.message_id]);
    expect(stored).toEqual({ status: "blocked", blocked_reason: "provider_limit:rate_limit_exceeded", sent_at: null }); // no quota used
    const [ev] = await providerEvents();
    expect(ev).toMatchObject({ actor: "comms-customer", request_id: "req_l", payload: { reason: "provider_limit:rate_limit_exceeded", limit: "recipient", http_status: 429, to: "pat@acme.com" } });
    expect(JSON.stringify(ev.payload)).not.toContain("new organization"); // never the provider's message body
  });

  it("403 block list and suspension responses become provider_rejected:<code>", async () => {
    await arm({ hello: true });
    mail.send.mockRejectedValueOnce(rejected("message_rejected")).mockRejectedValueOnce(rejected("account_suspended"));
    expect((await sendEmail(args())).blocked_reason).toBe("provider_rejected:message_rejected");
    expect((await sendEmail(args())).blocked_reason).toBe("provider_rejected:account_suspended");
    expect((await providerEvents()).map((e) => [e.payload.reason, e.payload.limit])).toEqual([
      ["provider_rejected:message_rejected", null], ["provider_rejected:account_suspended", null],
    ]);
  });

  it("a 429 without a code is still a provider limit; a bare API rate limit doesn't pause outreach", async () => {
    await arm({ hello: true, outreach: true });
    mail.send.mockRejectedValueOnce(limit("Too many requests", null));
    expect((await sendEmail(args())).blocked_reason).toBe("provider_limit:http_429");
    expect((await providerEvents())[0].payload.limit).toBe("rate");
    expect((await sendEmail(outreachArgs())).status).toBe("sent");
  });

  it("a retry with the same key re-checks a provider-blocked message and can send it", async () => {
    await arm({ hello: true });
    mail.send.mockRejectedValueOnce(limit("Daily send limit exceeded"));
    const blocked = await sendEmail(args({ idempotencyKey: "deliver:req_7" }));
    expect(blocked.blocked_reason).toBe("provider_limit:rate_limit_exceeded");
    const sent = await sendEmail(args({ idempotencyKey: "deliver:req_7" }));
    expect(sent).toMatchObject({ status: "sent", message_id: blocked.message_id });
    expect(mail.send.mock.calls[0][2]).toBe(mail.send.mock.calls[1][2]); // AgentMail sees the same idempotency key
  });

  it("after a recipient/daily limit, first touches pause for an hour without calling AgentMail; customer mail still tries", async () => {
    await arm({ hello: true, outreach: true });
    mail.send.mockRejectedValueOnce(limit("Recipient limit exceeded"));
    expect((await sendEmail(outreachArgs({ to: "a@one.com" }))).blocked_reason).toBe("provider_limit:rate_limit_exceeded");

    const paused = await sendEmail(outreachArgs({ to: "b@two.com" }));
    expect(paused.blocked_reason).toBe("provider_limit:cooldown");
    expect(mail.send).toHaveBeenCalledOnce();
    expect((await providerEvents()).length).toBe(1); // a local pause isn't a provider refusal, so it can't extend itself

    expect((await sendEmail(args({ to: "customer@three.com" }))).status).toBe("sent");
    expect((await sendEmail(outreachArgs({ to: "c@four.com", kind: "followup", templateId: templates.followup }))).status).toBe("sent");

    await db.query("UPDATE events SET created_at = now() - interval '61 minutes' WHERE type = 'email.blocked_by_provider'");
    expect((await sendEmail(outreachArgs({ to: "b@two.com", idempotencyKey: paused.message_id }))).status).toBe("sent");
  });
});

describe("offline mode", () => {
  it("TERRAGENT_OFFLINE records the message as blocked offline and never calls AgentMail", async () => {
    vi.stubEnv("TERRAGENT_OFFLINE", "1");
    await arm({ hello: true });
    const r = await sendEmail(args({ to: "founder@team.com" }));
    expect(r).toMatchObject({ status: "blocked", blocked_reason: "offline" });
    expect(await row(r.message_id)).toMatchObject({ status: "blocked", blocked_reason: "offline", counterpart_email: "founder@team.com" });
    expect(mail.send).not.toHaveBeenCalled();
  });

  it("the local demo database is offline too, including replies to messages we don't have", async () => {
    vi.stubEnv("TERRAGENT_DB", "local");
    const r = await replyInThread({ inbox: "hello", inReplyToMessageId: "<unknown>", text: "Hi", kind: "customer", idempotencyKey: "reply-off", actor: "comms-customer" });
    expect(r.blocked_reason).toBe("offline");
    expect(mail.getMessage).not.toHaveBeenCalled();
    expect(mail.reply).not.toHaveBeenCalled();
  });

  it("is never on in production", async () => {
    vi.stubEnv("TERRAGENT_OFFLINE", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    await arm({ hello: true });
    expect((await sendEmail(args())).status).toBe("sent");
  });
});

describe("threads", () => {
  const threadOf = async (id: string) =>
    (await db.query<{ thread_id: string | null; inbox: string | null }>("SELECT thread_id, inbox FROM requests WHERE id = $1", [id]))[0];

  it("first customer email for a request links its thread", async () => {
    await arm({ hello: true });
    await db.query("INSERT INTO requests (id, source, question) VALUES ('req_9', 'portal', 'Did it flood?')");
    const r = await sendEmail(args({ requestId: "req_9" }));
    expect(await threadOf("req_9")).toEqual({ thread_id: r.thread_id, inbox: "hello" });
  });

  it("a supplier quote links the order's thread, never the customer request's", async () => {
    await arm({ data: true });
    await db.query("INSERT INTO requests (id, source, question) VALUES ('req_p', 'portal', 'Did my field flood?')");
    await db.query("INSERT INTO orders (id, request_id, provider_id, product, est_cost_usd, justification) VALUES ('ord_1', 'req_p', 'up42', 'archive', 100, 'clouds')");
    const r = await sendEmail(args({ inbox: "data", to: "sales@up42.com", kind: "supplier_quote", requestId: "req_p", orderId: "ord_1" }));
    expect(r.status).toBe("sent");
    expect(await threadOf("req_p")).toEqual({ thread_id: null, inbox: null });
    const [o] = await db.query<{ quote_thread_id: string }>("SELECT quote_thread_id FROM orders WHERE id = 'ord_1'");
    expect(o.quote_thread_id).toBe(r.thread_id);
  });

  it("outreach links the prospect's thread, never the free sample request's", async () => {
    await arm({ outreach: true });
    vi.stubEnv("COMPANY_POSTAL_ADDRESS", "1 Test Way, Testville, CA 90000");
    await db.query("INSERT INTO requests (id, source, question, is_free_sample) VALUES ('req_s', 'signal', 'Flood at Acme?', true)");
    await db.query("INSERT INTO prospects (id, playbook, company, contact_email) VALUES ('pro_1', 'disasters', 'Acme', 'pat@acme.com')");
    const r = await sendEmail(args({
      inbox: "outreach", kind: "outreach", channel: "email_warm", templateId: await template("outreach"), requestId: "req_s", prospectId: "pro_1",
    }));
    expect(r.status).toBe("sent");
    expect((await threadOf("req_s")).thread_id).toBeNull();
    const [p] = await db.query<{ outreach_thread_id: string }>("SELECT outreach_thread_id FROM prospects WHERE id = 'pro_1'");
    expect(p.outreach_thread_id).toBe(r.thread_id);
  });

  it("replyInThread answers the sender of the stored message, through the same gates", async () => {
    await arm({ hello: true });
    await db.query(
      `INSERT INTO messages (id, direction, inbox, counterpart_email, subject, agentmail_message_id, thread_id, status, idempotency_key)
       VALUES ('msg_in', 'inbound', 'hello', 'pat@acme.com', 'Flood?', '<in-1@acme.com>', 'thr-1', 'received', 'in:hello:<in-1@acme.com>')`);
    const r = await replyInThread({ inbox: "hello", inReplyToMessageId: "<in-1@acme.com>", text: "Here's your answer", kind: "customer", idempotencyKey: "reply-1", actor: "comms-customer" });
    expect(r.status).toBe("sent");
    const [inbox, messageId, req] = mail.reply.mock.calls[0];
    expect([inbox, messageId]).toEqual(["terragent@agentmail.to", "<in-1@acme.com>"]);
    expect(req.to).toEqual(["pat@acme.com"]);
    const [stored] = await db.query<{ subject: string }>("SELECT subject FROM messages WHERE id = $1", [r.message_id]);
    expect(stored.subject).toBe("Re: Flood?");

    await suppress("pat@acme.com", "opt_out");
    const blocked = await replyInThread({ inbox: "hello", inReplyToMessageId: "<in-1@acme.com>", text: "One more thing", kind: "customer", idempotencyKey: "reply-2", actor: "comms-customer" });
    expect(blocked.blocked_reason).toBe("suppressed");
  });

  it("replyInThread blocks when the original message can't be found", async () => {
    await arm({ hello: true });
    const r = await replyInThread({ inbox: "hello", inReplyToMessageId: "<nope>", text: "Hi", kind: "customer", idempotencyKey: "reply-3", actor: "comms-customer" });
    expect(r.blocked_reason).toBe("invalid_recipient");
    expect(mail.reply).not.toHaveBeenCalled();
  });
});

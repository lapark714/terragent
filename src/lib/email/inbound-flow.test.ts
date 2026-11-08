/**
 * Inbound routing against the real core request services (pipeline/requests, TERRAGENT_LANES=off): the unit tests
 * mock handoff, so these catch handoffs core would refuse (finished requests, unscreened requests).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setMailApi } from "../agentmail/client";
import type { Db } from "../db/client";
import { getRequest } from "../pipeline/requests";
import { setSetting, SETTING } from "../settings";
import { handleInboundEmail } from "./inbound";
import { fromWireMessage } from "./inbound-parse";
import { sendEmail } from "./send";
import { fakeMail, memoryDb, resetDb, wireReceived } from "./testing";

vi.mock("../naive/sessions", () => ({ startAgentSession: vi.fn(async () => { throw new Error("lanes are off: no sessions"); }) }));
vi.mock("../naive/board", () => ({ upsertCard: vi.fn(async () => ({ id: "crd_x" })) }));

let db: Db;

beforeAll(async () => {
  db = await memoryDb();
});
beforeEach(async () => {
  await resetDb(db);
  fakeMail();
  vi.stubEnv("TERRAGENT_LANES", "off");
});
afterAll(async () => {
  setMailApi(null);
  vi.unstubAllEnvs();
  await db.close();
});

const reply = (text: string, o: Record<string, unknown> = {}) =>
  fromWireMessage(wireReceived({ text: `${text}\n\n> earlier`, extracted_text: text, in_reply_to: "<out-1@agentmail.to>", ...o }).message);

const handoffs = (requestId: string) =>
  db.query<{ payload: { to: string; stage: string } }>("SELECT payload FROM events WHERE type = 'handoff' AND request_id = $1", [requestId]);

describe("routing with the real handoff", () => {
  it("a payment reply to a delivered report opens a follow-up request that Comms 2 receives", async () => {
    await db.query("INSERT INTO requests (id, source, question, thread_id, inbox, status) VALUES ('req_d', 'email', 'Did it flood?', 'thr-1', 'hello', 'delivered')");
    const out = await handleInboundEmail(reply("Thanks, how do I pay?"));
    const followUp = await getRequest(out.requestId!);
    expect(followUp).toMatchObject({ thread_id: "thr-1", inbox: "hello", status: "screening", owner_agent: "comms-customer", meta: { follows: "req_d" } });
    expect((await handoffs(followUp!.id)).map((e) => e.payload)).toMatchObject([{ to: "comms-customer", stage: "screening" }]);
    const [m] = await db.query<{ request_id: string; meta: { route_error?: string } }>("SELECT request_id, meta FROM messages");
    expect(m.request_id).toBe(followUp!.id);
    expect(m.meta.route_error).toBeUndefined();
  });

  it("a reply on an open request is handed to Comms 2", async () => {
    await db.query("INSERT INTO requests (id, source, question, thread_id, inbox, status) VALUES ('req_c', 'email', 'Did it flood?', 'thr-1', 'hello', 'clarifying')");
    expect((await handleInboundEmail(reply("It's the warehouse at 1 Main St"))).requestId).toBe("req_c");
    expect((await handoffs("req_c")).map((e) => e.payload)).toMatchObject([{ to: "comms-customer", stage: "customer_reply" }]);
  });

  it("a new email becomes a request in screening with Comms 2", async () => {
    const out = await handleInboundEmail(fromWireMessage(wireReceived().message));
    expect(await getRequest(out.requestId!)).toMatchObject({ source: "email", status: "screening", owner_agent: "comms-customer", thread_id: "thr-1" });
  });

  it("a prospect's reply to a real outreach send becomes a sales request, and the sample is left alone", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://terragent.test");
    vi.stubEnv("COMPANY_POSTAL_ADDRESS", "1 Test Way, Testville, CA 90000");
    await setSetting(SETTING.inboxArmed, { outreach: true });
    await db.query("INSERT INTO templates (id, playbook, version, kind, subject, body, status) VALUES ('tpl_o', 'disasters', 'v1', 'outreach', 's', 'b', 'approved')");
    await db.query("INSERT INTO prospects (id, playbook, company, contact_email, status, sample_request_id) VALUES ('pro_1', 'disasters', 'Acme', 'pat@acme.com', 'emailed', 'req_s')");
    await db.query("INSERT INTO requests (id, source, question, status, is_free_sample, prospect_id) VALUES ('req_s', 'signal', 'Flood at Acme?', 'delivered', true, 'pro_1')");
    const sent = await sendEmail({
      inbox: "outreach", to: "pat@acme.com", subject: "Your depot after the flood", text: "We looked at your depot.", kind: "outreach",
      channel: "email_warm", templateId: "tpl_o", requestId: "req_s", prospectId: "pro_1", idempotencyKey: "outreach-pro_1", actor: "comms-outreach",
    });

    const out = await handleInboundEmail(reply("What would monitoring cost?", { inbox_id: "terragent-outreach@agentmail.to", thread_id: sent.thread_id }));
    expect(out.route.kind).toBe("prospect");
    expect(await getRequest(out.requestId!)).toMatchObject({ prospect_id: "pro_1", is_free_sample: false, owner_agent: "comms-customer", playbook: "disasters" });
    expect(await getRequest("req_s")).toMatchObject({ status: "delivered", thread_id: null });
    const [p] = await db.query<{ status: string; warm: boolean }>("SELECT status, warm FROM prospects WHERE id = 'pro_1'");
    expect(p).toEqual({ status: "replied", warm: true });
  });
});

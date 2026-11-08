/** Customer group (Comms 2) through runTool(): update messages, monitoring follow-ups that close, and opt-outs. */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../../db/client";
import type { AgentName } from "../../domain";
import { isSuppressed } from "../../email/optout";
import { replyInThread, sendEmail } from "../../email/send";
import { fakeMail, type FakeMail } from "../../email/testing";
import { createRequest, getRequest } from "../../pipeline/requests";
import { setupMemoryDb } from "../../pipeline/testing";
import { runTool } from "../server";

vi.mock("../../naive/sessions", () => ({ startAgentSession: vi.fn(async () => ({ session_id: "ses_t" })) }));
vi.mock("../../naive/board", () => ({ upsertCard: vi.fn(async () => ({ id: "crd_t" })) }));
vi.mock("../../email/send", () => ({
  sendEmail: vi.fn(async () => ({ status: "sent", message_id: "msg_1", thread_id: "thd_new" })),
  replyInThread: vi.fn(async () => ({ status: "sent", message_id: "msg_2", thread_id: "thd_1" })),
}));
vi.mock("../../email/threads", () => ({
  getThread: vi.fn(async (threadId: string) => ({
    thread_id: threadId, inbox: "hello", messages: [{ direction: "inbound", agentmail_message_id: `<in@${threadId}>` }],
  })),
}));

const call = (agent: AgentName, tool: string, args: Record<string, unknown>) => runTool(tool, args, { agent }) as Promise<Record<string, unknown>>;
const sql = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await getDb()).query<T>(text, params);
const sentText = () => (vi.mocked(replyInThread).mock.calls.at(-1)?.[0] ?? vi.mocked(sendEmail).mock.calls.at(-1)?.[0])!.text;

let mail: FakeMail;
let n = 0;
beforeAll(async () => {
  await setupMemoryDb();
});
beforeEach(() => {
  vi.clearAllMocks();
  mail = fakeMail();
  n++;
});

async function customerRequest(o: { email?: string; thread?: string; status?: string; question?: string } = {}) {
  const req = await createRequest({
    question: o.question ?? "Did the river flood our warehouse?", source: "portal", email: o.email ?? `pat${n}@acme.com`, name: "Pat",
    threadId: o.thread,
  });
  if (o.status) await sql("UPDATE requests SET status = $2 WHERE id = $1", [req.id, o.status]);
  return req;
}

/** A delivered request with a verified report, and the monitor follow-up record_monitor_check would create for it. */
async function monitorFollowup() {
  const parent = await customerRequest({ question: "Is the vineyard recovering?", thread: `thd_p${n}`, status: "delivered" });
  await sql(
    `INSERT INTO reports (id, request_id, title, answer, confidence, limitations, verifier_status, public_token)
     VALUES ($1, $2, 'Vineyard', 'Greener', 'medium', 'Clouds', 'pass', $3)`,
    [`rpt_${n}`, parent.id, `tok${n}`]);
  const followup = await createRequest({
    question: "Monitoring update (ndvi_mean) for: Is the vineyard recovering?", source: "monitor", priority: "background",
    email: parent.customer_email!, name: "Pat", threadId: parent.thread_id!,
    meta: { monitor_id: `mon_${n}`, parent_request_id: parent.id, new_info: "new clear scene 2026-11-06" },
  });
  await sql("UPDATE requests SET status = 'delivering', stage = 'delivery', owner_agent = 'comms-customer' WHERE id = $1", [followup.id]);
  return { parent, followup };
}

describe("send_customer_message kind update", () => {
  it("a status update goes out in the request's thread and leaves the request where it was", async () => {
    const req = await customerRequest({ thread: "thd_c", status: "analyzing" });
    const res = await call("comms-customer", "send_customer_message", {
      request_id: req.id, kind: "update", text: "The latest pass was cloudy; the next clear one is due Nov 9.",
    });
    expect(res).toEqual({ status: "sent", message_id: "msg_2", thread_id: "thd_1", blocked_reason: null });
    expect(vi.mocked(replyInThread).mock.calls[0][0]).toMatchObject({
      inbox: "hello", kind: "customer", requestId: req.id, inReplyToMessageId: "<in@thd_c>", idempotencyKey: expect.stringMatching(new RegExp(`^${req.id}:update:`)),
    });
    expect(sentText()).toMatch(/An update on your request: "Did the river flood our warehouse\?"[\s\S]*next clear one is due Nov 9/);
    expect(sentText()).not.toMatch(/keep watching/);
    expect((await getRequest(req.id))?.status).toBe("analyzing");
  });

  it("delivers a monitoring follow-up: quotes the watched question, links its report, and closes the follow-up", async () => {
    const { parent, followup } = await monitorFollowup();
    const res = await call("comms-customer", "send_customer_message", {
      request_id: followup.id, kind: "update", text: "NDVI rose from 0.41 to 0.52 between Oct 3 and Nov 6 (clear scenes).",
    });
    expect(res).toMatchObject({ status: "sent", request_status: "delivered", next: expect.stringMatching(/closed/) });
    expect(vi.mocked(replyInThread).mock.calls[0][0]).toMatchObject({ requestId: followup.id, inReplyToMessageId: `<in@${parent.thread_id}>` });
    expect(sentText()).toContain('We re-checked the site you asked us to watch: "Is the vineyard recovering?"');
    expect(sentText()).toContain(`/r/tok${n}`);
    expect(sentText()).toContain("NDVI rose from 0.41 to 0.52");
    expect(sentText()).toMatch(/keep watching/);
    expect((await getRequest(followup.id))?.status).toBe("delivered");
    expect((await getRequest(parent.id))?.status).toBe("delivered");
    // It's finished now: nothing more goes out on it.
    expect((await call("comms-customer", "send_customer_message", { request_id: followup.id, kind: "update", text: "Again?" })).error).toMatch(/delivered/);
  });

  it("a blocked monitoring update (e.g. a provider limit) leaves the follow-up open, without throwing", async () => {
    const { followup } = await monitorFollowup();
    vi.mocked(replyInThread).mockResolvedValueOnce({ status: "blocked", message_id: "msg_b", blocked_reason: "provider_limit:rate_limit_exceeded" });
    const res = await call("comms-customer", "send_customer_message", { request_id: followup.id, kind: "update", text: "NDVI rose to 0.52." });
    expect(res).toMatchObject({ status: "blocked", blocked_reason: "provider_limit:rate_limit_exceeded", request_status: "delivering", next: expect.stringMatching(/Not sent/) });
    expect((await getRequest(followup.id))?.status).toBe("delivering");
  });

  it("set_status still can't deliver it, and finished requests and free samples get no update", async () => {
    const { followup } = await monitorFollowup();
    expect((await call("comms-customer", "set_status", { request_id: followup.id, status: "delivered" })).error).toMatch(/deliver_report/);
    const done = await customerRequest({ status: "cancelled" });
    expect((await call("comms-customer", "send_customer_message", { request_id: done.id, kind: "update", text: "Some news." })).error).toMatch(/cancelled/);
    const sample = await createRequest({ question: "Flood at Acme?", source: "signal", isFreeSample: true, priority: "background" });
    expect((await call("comms-customer", "send_customer_message", { request_id: sample.id, kind: "update", text: "Some news." })).error).toMatch(/comms-outreach/);
    expect(replyInThread).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("a monitor follow-up of a free sample (the prospect replied, so comms-customer has it) goes out from hello@", async () => {
    const followup = await createRequest({
      question: "Monitoring update (dnbr) for: Free sample: burn at the depot", source: "monitor", priority: "background", isFreeSample: true,
      email: `ops${n}@depot.test`, meta: { monitor_id: `mon_s${n}`, new_info: "new clear scene 2026-11-06" },
    });
    await sql("UPDATE requests SET status = 'delivering', stage = 'delivery', owner_agent = 'comms-customer' WHERE id = $1", [followup.id]);
    const res = await call("comms-customer", "send_customer_message", { request_id: followup.id, kind: "update", text: "dNBR fell from 0.17 to 0.09: regrowth." });
    expect(res).toMatchObject({ status: "sent", request_status: "delivered" });
    expect(vi.mocked(sendEmail).mock.calls[0][0]).toMatchObject({ inbox: "hello", to: `ops${n}@depot.test` });
    // Only that update: no clarifying questions on samples from hello@.
    expect((await call("comms-customer", "send_customer_message", { request_id: followup.id, kind: "clarifying_question", text: "Which depot?" })).error).toMatch(/comms-outreach/);
  });
});

describe("record_opt_out", () => {
  it("suppresses the customer, notes and cancels the open request, and stops monitors that would email them", async () => {
    const email = `Opt${n}@Acme.com`;
    const earlier = await customerRequest({ email, status: "delivered" });
    await sql(
      "INSERT INTO monitors (id, request_id, lat, lon, recipe, metric, cadence) VALUES ($1, $2, 34.1, -118.1, 'ndvi_change', 'ndvi_mean', '0 14 * * 1')",
      [`mon_o${n}`, earlier.id]);
    const req = await customerRequest({ email, status: "quoted" });

    const res = await call("comms-customer", "record_opt_out", { request_id: req.id, reason: "replied: please stop emailing me" });
    const addr = email.toLowerCase();
    expect(res).toMatchObject({ email: addr, suppressed: true, request_status: "cancelled", monitors_stopped: [`mon_o${n}`], other_open_requests: [] });
    expect(await isSuppressed(addr)).toBe(true);
    expect(mail.blockSend).toHaveBeenCalledWith(addr, "opted out");
    expect((await getRequest(req.id))?.status).toBe("cancelled");
    expect((await getRequest(earlier.id))?.status).toBe("delivered");
    const [m] = await sql<{ status: string }>("SELECT status FROM monitors WHERE id = $1", [`mon_o${n}`]);
    expect(m.status).toBe("cancelled");
    const notes = await sql<{ payload: { note: string } }>("SELECT payload FROM events WHERE request_id = $1 AND type = 'note'", [req.id]);
    expect(notes.map((e) => e.payload.note)).toContainEqual(expect.stringContaining(`Opted out of all email (${addr}): replied: please stop emailing me`));
    const [ev] = await sql<{ actor: string }>("SELECT actor FROM events WHERE request_id = $1 AND type = 'customer.opted_out'", [req.id]);
    expect(ev.actor).toBe("comms-customer");
    // Nothing more goes out on it.
    expect((await call("comms-customer", "send_customer_message", { request_id: req.id, kind: "update", text: "One more thing" })).error).toMatch(/cancelled/);
  });

  it("can opt out someone who wrote in the request's thread, never an address only mentioned in an email", async () => {
    const req = await customerRequest({ thread: `thd_o${n}`, status: "analyzing" });
    await sql(
      "INSERT INTO messages (id, direction, inbox, counterpart_email, thread_id, status) VALUES ($1, 'inbound', 'hello', $2, $3, 'received')",
      [`msg_i${n}`, `ops${n}@acme.com`, `thd_o${n}`]);
    const stranger = await call("comms-customer", "record_opt_out", { request_id: req.id, email: "someone@else.com", reason: "they said to remove someone@else.com" });
    expect(stranger.error).toMatch(/not the customer/);
    expect(await isSuppressed("someone@else.com")).toBe(false);
    expect((await getRequest(req.id))?.status).toBe("analyzing");

    const colleague = await call("comms-customer", "record_opt_out", { request_id: req.id, email: `OPS${n}@acme.com `, reason: "colleague asked to stop" });
    expect(colleague).toMatchObject({ email: `ops${n}@acme.com`, request_status: "cancelled" });
    expect(await isSuppressed(`ops${n}@acme.com`)).toBe(true);
    expect(await isSuppressed(req.customer_email!)).toBe(false);
  });

  it("on a finished request it suppresses and notes without changing the status, and lists their other open requests", async () => {
    const email = `fin${n}@acme.com`;
    const done = await customerRequest({ email, status: "delivered" });
    const open = await customerRequest({ email, status: "planning" });
    const res = await call("comms-customer", "record_opt_out", { request_id: done.id, reason: "unsubscribe" });
    expect(res).toMatchObject({ request_status: "delivered", other_open_requests: [open.id] });
    expect((await getRequest(done.id))?.status).toBe("delivered");
    expect(await isSuppressed(email)).toBe(true);
  });

  it("needs an address and is comms-customer's alone", async () => {
    const req = await createRequest({ question: "Did the river flood?", source: "api" });
    expect((await call("comms-customer", "record_opt_out", { request_id: req.id, reason: "stop" })).error).toMatch(/no customer email/);
    expect((await call("comms-outreach", "record_opt_out", { request_id: req.id, reason: "stop" })).error).toMatch(/not allowed/);
  });
});

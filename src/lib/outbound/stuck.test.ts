/**
 * list_stuck_requests on dropped handoffs: the customer or a founder did their part, the status looks like waiting, and
 * nobody is working on it. Each state is reached through the real pipeline with Naïve failing at the handoff, and each
 * recovery is the handoff the coordinator would make, through the same gates.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../db/client";
import { sendEmail } from "../email/send";
import { logDecision } from "../events";
import { startAgentSession } from "../naive/sessions";
import { acceptQuote } from "../pipeline/acceptance";
import { saveAcquisitionPlan } from "../pipeline/acquisition";
import { sendCustomerMessage, sendQuote } from "../pipeline/deliver";
import { getOrder, markOrderDelivered, prepareOrder } from "../pipeline/orders";
import { createQuote, type CreateQuoteResult, type CreateQuoteSaved, getQuote } from "../pipeline/quotes";
import { createRequest, getRequest, handoff, mergeMeta, setStatus, startInboundRequest } from "../pipeline/requests";
import { recordScreening } from "../pipeline/screening";
import { saveDataSpec } from "../pipeline/specs";
import { samplePlan, sampleSpec, setupMemoryDb, SITE } from "../pipeline/testing";
import { listStuckRequests } from "./stuck";

vi.mock("../naive/sessions", () => ({ startAgentSession: vi.fn(async () => ({ session_id: `ses_${Math.random().toString(36).slice(2, 10)}` })) }));
vi.mock("../naive/board", () => ({ upsertCard: vi.fn(async () => ({ id: "crd_x" })) }));
vi.mock("../naive/spend", () => ({ sessionCostUsd: vi.fn(async () => 0.2) }));
vi.mock("../email/send", () => ({
  sendEmail: vi.fn(async () => ({ status: "sent", message_id: "msg_1", thread_id: "thd_1" })),
  replyInThread: vi.fn(async () => ({ status: "sent", message_id: "msg_2", thread_id: "thd_1" })),
}));
vi.mock("../email/threads", () => ({ getThread: vi.fn(async () => null) }));

beforeAll(async () => {
  await setupMemoryDb();
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PUBLIC_BASE_URL", "https://terragent.test");
});
afterAll(() => {
  vi.unstubAllEnvs();
});

const sql = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await getDb()).query<T>(text, params);

/** The next agent session fails to start, as when Naïve is unreachable at the moment of the handoff. */
const naiveDownOnce = () => vi.mocked(startAgentSession).mockRejectedValueOnce(new Error("naive unavailable"));
/** Three hours pass with nothing happening on the request. */
const age = (requestId: string) => sql("UPDATE requests SET updated_at = now() - interval '3 hours' WHERE id = $1", [requestId]);
const ageOrders = (requestId: string) => sql("UPDATE orders SET updated_at = now() - interval '3 hours' WHERE request_id = $1", [requestId]);
const stuck = async (id: string) => (await listStuckRequests({ staleMinutes: 60, limit: 100 })).find((r) => r.id === id);
const coordinatorHands = (requestId: string, to: Parameters<typeof handoff>[0]["to"], stage: string) =>
  handoff({ requestId, from: "coordinator", to, stage, instructions: "The earlier handoff was dropped; please carry on" });

function saved(r: CreateQuoteResult): CreateQuoteSaved {
  if ("error" in r) throw new Error(r.error);
  return r;
}

const ROOF_PLAN: Parameters<typeof samplePlan>[1] = {
  choice: "paid", data_cost_usd: 225,
  free_option: { provider_id: "pc-sentinel-2-l2a", before_scene: null, after_scene: null, sufficient: false, why: "10 m can't see individual roofs" },
  paid_options: [{ provider_id: "sw-pneo-30cm", product: "archive 30 cm", resolution_m: 0.3, est_cost_usd: 225, min_order_km2: 5, delivery_time: null, license_terms: null, preview_available: true, why: "roofs" }],
  justification: "Roof-level damage needs sub-metre imagery; Sentinel-2 at 10 m cannot resolve individual buildings.",
};

/** A screened customer request with a spec and a plan, ready for create_quote. */
async function planned(plan: Parameters<typeof samplePlan>[1] = {}, o: { email?: string | null } = {}) {
  const req = await createRequest({
    question: "Did the fire reach our warehouse?", lat: SITE.lat, lon: SITE.lon, source: "portal", email: o.email === null ? undefined : (o.email ?? "ops@depot.test"),
  });
  await mergeMeta(req.id, { screening: { allowed: true } });
  await saveDataSpec(sampleSpec(req.id), "planner");
  for (const kind of ["free_vs_paid", "source_selection"] as const) {
    await logDecision({ requestId: req.id, kind, choice: "compared", reasoning: "free vs sub-metre archive", agent: "acquisition" });
  }
  await saveAcquisitionPlan(samplePlan(req.id, plan), "acquisition");
  return req;
}

/** The customer accepted the paid option: its order is held for a founder and the request is awaiting_approval. */
async function acceptedPaid() {
  const req = await planned(ROOF_PLAN);
  const quote = saved(await createQuote({ requestId: req.id }, "pricing")).quote;
  const paid = quote.options.find((o) => o.kind !== "free_data")!;
  const accepted = await acceptQuote({ requestId: req.id, optionId: paid.option_id, actor: "comms-customer", evidence: "Yes, the sharper one" });
  expect(accepted).toMatchObject({ next: "awaiting_data_purchase", status: "awaiting_approval" });
  expect(accepted.order_ids).toHaveLength(1);
  return { req, quote, orderId: accepted.order_ids[0] };
}

describe("quote saved but never sent", () => {
  async function unsentQuote(o: { email?: string | null } = {}) {
    const req = await planned({}, o);
    if (o.email !== null) naiveDownOnce(); // an API request has no handoff to fail
    const first = saved(await createQuote({ requestId: req.id }, "pricing"));
    return { req, first };
  }

  it("is quote_not_sent, not waiting_on_customer, when the handoff to comms-customer failed", async () => {
    const { req, first } = await unsentQuote();
    expect(first.handoff).toBeNull();
    expect(first.warnings.join(" ")).toMatch(/Handoff to comms-customer failed/);
    expect(await getRequest(req.id)).toMatchObject({ status: "quoted" });
    await age(req.id);
    expect(await stuck(req.id)).toMatchObject({ reason: "quote_not_sent", hint: expect.stringMatching(/handoff once to comms-customer \(stage quote\)/) });
  });

  it("gives the normal handoff time: a quote saved just now is not listed", async () => {
    const { req } = await unsentQuote();
    expect(await stuck(req.id)).toBeUndefined();
  });

  it("recovers by the coordinator's handoff, then really waits on the customer", async () => {
    const { req, first } = await unsentQuote();
    await age(req.id);
    await coordinatorHands(req.id, "comms-customer", "quote");
    expect(vi.mocked(startAgentSession).mock.calls.at(-1)?.[0]).toBe("comms-customer");

    expect((await sendQuote(req.id, "comms-customer")).status).toBe("sent");
    expect((await getQuote(first.quote.id))?.status).toBe("sent");
    await age(req.id);
    expect(await stuck(req.id)).toMatchObject({ reason: "waiting_on_customer" });
    expect(await stuck(req.id)).not.toHaveProperty("hint");
  });

  it("stops asking for handoffs once the coordinator's one resend hasn't got it out", async () => {
    const { req } = await unsentQuote();
    await age(req.id);
    await coordinatorHands(req.id, "comms-customer", "quote");
    await age(req.id);
    expect(await stuck(req.id)).toMatchObject({ reason: "quote_not_sent", hint: expect.stringMatching(/don't hand off again/) });
  });

  it("sends an expired unsent quote back to pricing, the only handoff that can succeed", async () => {
    const { req, first } = await unsentQuote();
    await sql("UPDATE quotes SET valid_until = now() - interval '1 hour' WHERE id = $1", [first.quote.id]);
    await age(req.id);
    expect(await stuck(req.id)).toMatchObject({ reason: "quote_not_sent", hint: expect.stringMatching(/handoff once to pricing \(stage pricing\)/) });
    await expect(coordinatorHands(req.id, "comms-customer", "quote")).rejects.toThrow(/no quote ready to send/);
    await coordinatorHands(req.id, "pricing", "pricing");
    expect(await getRequest(req.id)).toMatchObject({ status: "pricing", owner_agent: "pricing" });
  });

  it("leaves an API request alone: with no email or thread the client reads the quote from its status response", async () => {
    const { req, first } = await unsentQuote({ email: null });
    expect(first.quote.status).toBe("approved");
    await age(req.id);
    expect(await stuck(req.id)).toMatchObject({ reason: "waiting_on_customer" });
  });
});

describe("create_quote's idempotent repeat", () => {
  it("re-attempts the handoff while the identical quote is still unsent", async () => {
    const req = await planned();
    naiveDownOnce();
    const first = saved(await createQuote({ requestId: req.id }, "pricing"));
    expect(first.handoff).toBeNull();

    const retry = saved(await createQuote({ requestId: req.id }, "pricing"));
    expect(retry.quote.id).toBe(first.quote.id);
    expect(retry.handoff).toMatchObject({ session_id: expect.any(String) });
    expect(retry.next).toMatch(/comms-customer sends the quote/);
    expect(await getRequest(req.id)).toMatchObject({ owner_agent: "comms-customer", stage: "quote" });
    expect(await sql("SELECT id FROM quotes WHERE request_id = $1", [req.id])).toHaveLength(1);
  });

  it("says so when the retried handoff fails too", async () => {
    const req = await planned();
    naiveDownOnce();
    saved(await createQuote({ requestId: req.id }, "pricing"));
    naiveDownOnce();
    const retry = saved(await createQuote({ requestId: req.id }, "pricing"));
    expect(retry.handoff).toBeNull();
    expect(retry.warnings.join(" ")).toMatch(/Handoff to comms-customer failed/);
    expect(retry.next).toMatch(/the handoff failed/);
  });

  it("doesn't start a second session for a retry right after a handoff that worked", async () => {
    const req = await planned();
    saved(await createQuote({ requestId: req.id }, "pricing"));
    const calls = vi.mocked(startAgentSession).mock.calls.length;
    const retry = saved(await createQuote({ requestId: req.id }, "pricing"));
    expect(retry.handoff).toMatchObject({ deduped: true });
    expect(vi.mocked(startAgentSession).mock.calls.length).toBe(calls);
  });

  it("starts nothing once the quote has been sent", async () => {
    const req = await planned();
    saved(await createQuote({ requestId: req.id }, "pricing"));
    await sendQuote(req.id, "comms-customer");
    vi.mocked(startAgentSession).mockClear();
    const retry = saved(await createQuote({ requestId: req.id }, "pricing"));
    expect(retry.handoff).toBeNull();
    expect(retry.next).toMatch(/Nothing more to do/);
    expect(startAgentSession).not.toHaveBeenCalled();
  });

  it("starts nothing for an API request", async () => {
    const req = await planned({}, { email: null });
    saved(await createQuote({ requestId: req.id }, "pricing"));
    const retry = saved(await createQuote({ requestId: req.id }, "pricing"));
    expect(retry.handoff).toBeNull();
    expect(startAgentSession).not.toHaveBeenCalled();
  });
});

describe("accepted but not started", () => {
  async function acceptedFree() {
    const req = await planned();
    saved(await createQuote({ requestId: req.id }, "pricing"));
    naiveDownOnce();
    const res = await acceptQuote({ requestId: req.id, actor: "comms-customer", evidence: "Yes please" });
    expect(res.warnings.join(" ")).toMatch(/the handoff failed/);
    expect(await getRequest(req.id)).toMatchObject({ status: "quoted" });
    return req;
  }

  it("is accepted_not_started when the handoff failed, and the coordinator's handoff starts the work", async () => {
    const req = await acceptedFree();
    await age(req.id);
    expect(await stuck(req.id)).toMatchObject({ reason: "accepted_not_started", hint: expect.stringMatching(/handoff once to analytics \(stage analysis\)/) });

    await coordinatorHands(req.id, "analytics", "analysis");
    expect(await getRequest(req.id)).toMatchObject({ status: "analyzing", owner_agent: "analytics" });
    await age(req.id);
    expect(await stuck(req.id)).toMatchObject({ reason: "stale" });
  });

  it("points at the interpreter when the Earth index already answers it", async () => {
    const req = await acceptedFree();
    await sql(`UPDATE requests SET acquisition_plan = acquisition_plan || '{"choice":"existing_index"}'::jsonb WHERE id = $1`, [req.id]);
    await age(req.id);
    expect(await stuck(req.id)).toMatchObject({ reason: "accepted_not_started", hint: expect.stringMatching(/handoff once to interpreter \(stage report\)/) });
    await coordinatorHands(req.id, "interpreter", "report");
    expect(await getRequest(req.id)).toMatchObject({ owner_agent: "interpreter", stage: "report" });
  });

  it("never points an accepted paid option at analytics: its orders go to acquisition, and the gate refuses the analysis", async () => {
    const { req } = await acceptedPaid();
    // The acceptance died after its claim: no order was held and the request never left quoted.
    await sql("DELETE FROM orders WHERE request_id = $1", [req.id]);
    await sql("UPDATE requests SET status = 'quoted', updated_at = now() - interval '3 hours' WHERE id = $1", [req.id]);

    const row = await stuck(req.id);
    expect(row).toMatchObject({ reason: "accepted_not_started", hint: expect.stringMatching(/handoff once to acquisition \(stage acquisition\)/) });
    expect(row?.hint).not.toMatch(/handoff once to analytics/);

    await expect(coordinatorHands(req.id, "analytics", "analysis")).rejects.toThrow(/none has been marked delivered/);
    await expect(handoff({ requestId: req.id, from: "acquisition", to: "analytics", stage: "analysis", instructions: "Run on free data" })).rejects.toThrow(/none has been marked delivered/);
    await coordinatorHands(req.id, "acquisition", "acquisition");
    expect(await getRequest(req.id)).toMatchObject({ owner_agent: "acquisition", status: "acquiring" });
  });

  it("still waits on the customer while no option has been accepted, and a coordinator can't start the work", async () => {
    const req = await planned();
    saved(await createQuote({ requestId: req.id }, "pricing"));
    await sendQuote(req.id, "comms-customer");
    await age(req.id);
    expect(await stuck(req.id)).toMatchObject({ reason: "waiting_on_customer" });
    await expect(coordinatorHands(req.id, "analytics", "analysis")).rejects.toThrow(/waits for the customer/);
  });
});

describe("data delivered but not started", () => {
  async function deliveredButDropped() {
    const ctx = await acceptedPaid();
    naiveDownOnce();
    const res = await markOrderDelivered({ orderId: ctx.orderId, founder: "Laurence" });
    expect(res).toMatchObject({ analysis_started: false, warning: expect.stringMatching(/Handoff to analytics failed/) });
    expect(await getRequest(ctx.req.id)).toMatchObject({ status: "awaiting_approval" });
    return ctx;
  }

  it("is data_delivered_not_started once the delivery has had time to start the analysis by itself", async () => {
    const { req, orderId } = await deliveredButDropped();
    expect(await stuck(req.id)).toMatchObject({ reason: "awaiting_approval" }); // just delivered: the handoff may still be running
    expect(await stuck(req.id)).not.toHaveProperty("hint");

    await ageOrders(req.id);
    expect(await stuck(req.id)).toMatchObject({ reason: "data_delivered_not_started", hint: expect.stringMatching(/handoff once to acquisition \(stage acquisition\)/) });
    expect((await getOrder(orderId))?.status).toBe("delivered");
  });

  it("recovers through acquisition's documented step, never by the coordinator starting the analysis", async () => {
    const { req } = await deliveredButDropped();
    await ageOrders(req.id);

    await expect(coordinatorHands(req.id, "analytics", "analysis")).rejects.toThrow(/hand it to acquisition \(stage acquisition\)/);
    expect(await getRequest(req.id)).toMatchObject({ status: "awaiting_approval" });

    await coordinatorHands(req.id, "acquisition", "acquisition");
    // If acquisition drops it too, the coordinator still can't start the analysis.
    await expect(coordinatorHands(req.id, "analytics", "analysis")).rejects.toThrow(/hand it to acquisition \(stage acquisition\)/);

    await handoff({ requestId: req.id, from: "acquisition", to: "analytics", stage: "analysis", instructions: "The paid data arrived: run the analysis" });
    expect(await getRequest(req.id)).toMatchObject({ status: "analyzing", owner_agent: "analytics" });
    expect((await stuck(req.id))?.reason).not.toBe("data_delivered_not_started");
  });

  it("lets the coordinator re-kick a paid analysis that already started and went stale", async () => {
    const { req } = await deliveredButDropped();
    await handoff({ requestId: req.id, from: "human:Laurence", to: "analytics", stage: "analysis", instructions: "Run the analysis on the delivered data" });
    await age(req.id);
    expect(await stuck(req.id)).toMatchObject({ reason: "stale", status: "analyzing" });
    await coordinatorHands(req.id, "analytics", "analysis");
    expect(await getRequest(req.id)).toMatchObject({ owner_agent: "analytics", status: "analyzing" });
  });

  it("stays awaiting_approval while another paid order still waits for a founder", async () => {
    const { req, orderId } = await acceptedPaid();
    const second = await prepareOrder({
      requestId: req.id, providerId: "sw-pneo-30cm", product: "archive 30 cm", areaKm2: 4, estCostUsd: 112.5,
      justification: "Roof-level damage needs sub-metre imagery; Sentinel-2 at 10 m cannot resolve individual buildings.",
    }, "acquisition");
    expect(await markOrderDelivered({ orderId, founder: "Laurence" })).toMatchObject({ waiting_for: [second.order_id] });
    await ageOrders(req.id);

    expect(await stuck(req.id)).toMatchObject({ reason: "awaiting_approval" });
    await expect(coordinatorHands(req.id, "acquisition", "acquisition")).resolves.toBeDefined();
    await expect(handoff({ requestId: req.id, from: "acquisition", to: "analytics", stage: "analysis", instructions: "Run it" })).rejects.toThrow(/hasn't marked delivered/);
  });

  it("leaves it to a founder when another order of the request was rejected", async () => {
    const { req, orderId } = await acceptedPaid();
    const second = await prepareOrder({
      requestId: req.id, providerId: "sw-pneo-30cm", product: "archive 30 cm", areaKm2: 4, estCostUsd: 112.5,
      justification: "Roof-level damage needs sub-metre imagery; Sentinel-2 at 10 m cannot resolve individual buildings.",
    }, "acquisition");
    await markOrderDelivered({ orderId, founder: "Laurence" });
    await sql("UPDATE orders SET status = 'rejected' WHERE id = $1", [second.order_id]);
    await ageOrders(req.id);
    expect(await stuck(req.id)).toMatchObject({ reason: "awaiting_approval" });
  });

  it("doesn't count an open supplier quote request as an order still waiting", async () => {
    const { req } = await deliveredButDropped();
    await sql(
      `INSERT INTO orders (id, request_id, provider_id, product, est_cost_usd, status, justification, meta)
       VALUES ('ord_supplier_q', $1, 'arlula-archive', 'archive 50 cm', 0, 'quote_requested', 'second price', '{}')`,
      [req.id],
    );
    await ageOrders(req.id);
    expect(await stuck(req.id)).toMatchObject({ reason: "data_delivered_not_started" });
  });

  it("keeps a paid purchase nobody delivered in awaiting_approval", async () => {
    const { req } = await acceptedPaid();
    await ageOrders(req.id);
    await age(req.id);
    expect(await stuck(req.id)).toMatchObject({ reason: "awaiting_approval" });
    expect(await stuck(req.id)).not.toHaveProperty("hint");
  });
});

describe("clarifying question never sent", () => {
  const unclear = { allowed: false, category: "unclear_needs_clarification", reason: "No location" } as const;
  const inbound = (email: string | undefined = "c@example.com") => startInboundRequest({ question: "Can you check my place?", source: "email", email });

  it("record_screening doesn't tell the customer we asked: only the send parks it as clarifying", async () => {
    const req = await inbound();
    const res = await recordScreening(req.id, unclear, "comms-customer");
    expect(res.outcome).toBe("clarify");
    expect(await getRequest(req.id)).toMatchObject({ status: "screening" });

    expect((await sendCustomerMessage({ requestId: req.id, kind: "clarifying_question", text: "Which address?" }, "comms-customer")).status).toBe("sent");
    expect(await getRequest(req.id)).toMatchObject({ status: "clarifying" });
    await age(req.id);
    expect(await stuck(req.id)).toMatchObject({ reason: "waiting_on_customer" });
  });

  it("is clarifying_not_sent when the send was dropped after screening", async () => {
    const req = await inbound();
    await recordScreening(req.id, unclear, "comms-customer");
    await age(req.id);
    expect(await stuck(req.id)).toMatchObject({ reason: "clarifying_not_sent", hint: expect.stringMatching(/handoff once to comms-customer \(stage clarifying\)/) });
    await coordinatorHands(req.id, "comms-customer", "clarifying");
    expect(vi.mocked(startAgentSession).mock.calls.at(-1)?.[0]).toBe("comms-customer");
  });

  it("is clarifying_not_sent for a request already parked as clarifying with no question out (earlier record_screening)", async () => {
    const req = await inbound();
    await recordScreening(req.id, unclear, "comms-customer");
    await setStatus(req.id, "clarifying", "comms-customer", "Waiting on the customer");
    await age(req.id);
    expect(await stuck(req.id)).toMatchObject({ reason: "clarifying_not_sent" });
  });

  it("doesn't count a blocked send as asked", async () => {
    const req = await inbound();
    await recordScreening(req.id, unclear, "comms-customer");
    vi.mocked(sendEmail).mockResolvedValueOnce({ status: "blocked", message_id: "msg_b", blocked_reason: "inbox not armed" });
    await sendCustomerMessage({ requestId: req.id, kind: "clarifying_question", text: "Which address?" }, "comms-customer");
    expect(await getRequest(req.id)).toMatchObject({ status: "screening" });
    await age(req.id);
    expect(await stuck(req.id)).toMatchObject({ reason: "clarifying_not_sent" });

    // Same on a request that was already parked as clarifying before the send was blocked.
    await setStatus(req.id, "clarifying", "comms-customer", "Waiting on the customer");
    vi.mocked(sendEmail).mockResolvedValueOnce({ status: "blocked", message_id: "msg_b", blocked_reason: "inbox not armed" });
    await sendCustomerMessage({ requestId: req.id, kind: "clarifying_question", text: "Which address?" }, "comms-customer");
    await age(req.id);
    expect(await stuck(req.id)).toMatchObject({ reason: "clarifying_not_sent" });
  });

  it("doesn't count a question from an earlier clarifying round", async () => {
    const req = await inbound();
    await sendCustomerMessage({ requestId: req.id, kind: "clarifying_question", text: "Which address?" }, "comms-customer");
    await recordScreening(req.id, { allowed: true, category: "ok", reason: "Address given" }, "comms-customer");
    await handoff({ requestId: req.id, from: "comms-customer", to: "planner", stage: "planning", instructions: "Plan it" });
    await handoff({ requestId: req.id, from: "planner", to: "comms-customer", stage: "clarifying", instructions: "Ask which dates matter" });
    expect(await getRequest(req.id)).toMatchObject({ status: "clarifying" });
    await age(req.id);
    expect(await stuck(req.id)).toMatchObject({ reason: "clarifying_not_sent" });
  });

  it("stops asking for handoffs once the coordinator's one resend hasn't got it out", async () => {
    const req = await inbound();
    await recordScreening(req.id, unclear, "comms-customer");
    await age(req.id);
    await coordinatorHands(req.id, "comms-customer", "clarifying");
    await age(req.id);
    expect(await stuck(req.id)).toMatchObject({ reason: "clarifying_not_sent", hint: expect.stringMatching(/don't hand off again/) });
  });

  it("doesn't promise a send it can't make: with no email or thread the request is just stale", async () => {
    const req = await startInboundRequest({ question: "Can you check my place?", source: "api" });
    await recordScreening(req.id, unclear, "comms-customer");
    await age(req.id);
    const row = await stuck(req.id);
    expect(row).toMatchObject({ reason: "stale" });
    expect(row).not.toHaveProperty("hint");
  });
});

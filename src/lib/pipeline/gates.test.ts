import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../db/client";
import { sendEmail } from "../email/send";
import { logDecision } from "../events";
import { newId } from "../ids";
import { acceptQuote, acceptQuoteByToken, LINK_ACTOR, QuoteAcceptError } from "./acceptance";
import { saveAcquisitionPlan } from "./acquisition";
import { getAnalysisJob, saveAnalysis } from "./analyses";
import { deliverReport, sendCustomerMessage, sendQuote } from "./deliver";
import { priceBlockedReason } from "./gates";
import { approveQuote, createQuote, type CreateQuoteResult, getQuote, rejectQuote } from "./quotes";
import { saveReportDraft } from "./reports";
import { createRequest, getRequest, handoff, mergeMeta, setStatus } from "./requests";
import { saveDataSpec } from "./specs";
import { SAMPLE_FILE_IDS, sampleAnalysis, sampleDraft, samplePlan, sampleSpec, SITE, setupMemoryDb } from "./testing";

vi.mock("../naive/sessions", () => ({ startAgentSession: vi.fn(async () => ({ session_id: `ses_${Math.random().toString(36).slice(2, 10)}` })) }));
vi.mock("../naive/board", () => ({ upsertCard: vi.fn(async () => ({ id: "crd_x" })) }));
vi.mock("../naive/spend", () => ({ sessionCostUsd: vi.fn(async () => 0.2) }));
vi.mock("../email/send", () => ({
  sendEmail: vi.fn(async () => ({ status: "sent", message_id: "msg_1", thread_id: "thd_1" })),
  replyInThread: vi.fn(async () => ({ status: "sent", message_id: "msg_2", thread_id: "thd_1" })),
}));
vi.mock("../email/threads", () => ({ getThread: vi.fn(async () => null) }));
vi.mock("../email/templates", () => {
  const e = (subject: string) => () => ({ subject, text: subject, html: `<p>${subject}</p>` });
  return {
    renderClarifyingQuestion: e("question"), renderRefusal: e("refusal"), renderQuote: e("quote"), renderReportDelivery: e("report"),
    quoteAcceptUrl: (token: string) => `https://terragent.test/quote/${token}`,
  };
});

const PAID_PLAN = {
  choice: "paid" as const, data_cost_usd: 112.5,
  free_option: { provider_id: "pc-sentinel-2-l2a", before_scene: null, after_scene: null, sufficient: false, why: "10 m can't see roofs" },
  paid_options: [{ provider_id: "sw-pneo-30cm", product: "archive 30 cm", resolution_m: 0.3, est_cost_usd: 112.5, min_order_km2: 5, delivery_time: null, license_terms: null, preview_available: true, why: "roofs" }],
  justification: "Roof-level damage needs sub-metre imagery; Sentinel-2 at 10 m cannot resolve individual buildings.",
};

beforeAll(async () => {
  await setupMemoryDb();
});
beforeEach(() => vi.clearAllMocks());

const sql = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await getDb()).query<T>(text, params);

/** A screened customer request with a spec and a plan, up to pricing. */
async function plannedRequest(plan: Parameters<typeof samplePlan>[1] = {}) {
  const req = await createRequest({ question: "Which roofs on our block were damaged?", lat: SITE.lat, lon: SITE.lon, source: "portal", email: "c@example.com" });
  await mergeMeta(req.id, { screening: { allowed: true } });
  await saveDataSpec(sampleSpec(req.id), "planner");
  for (const kind of ["free_vs_paid", "source_selection"] as const) {
    await logDecision({ requestId: req.id, kind, choice: "x", reasoning: "compared options", agent: "acquisition" });
  }
  await saveAcquisitionPlan(samplePlan(req.id, plan), "acquisition");
  return req;
}

function quoteOf(r: CreateQuoteResult) {
  if ("error" in r) throw new Error(r.error);
  return r.quote;
}
async function quotedRequest(plan: Parameters<typeof samplePlan>[1] = {}) {
  const req = await plannedRequest(plan);
  const quote = quoteOf(await createQuote({ requestId: req.id }, "pricing"));
  return { req, quote };
}

const toAnalytics = (requestId: string, from = "pricing", quoteAccepted?: boolean) =>
  handoff({ requestId, from, to: "analytics", stage: "analysis", instructions: "Run the pipeline", quoteAccepted });
const revenue = (quoteId: string) =>
  sql<{ kind: string; amount_usd: string; request_id: string }>("SELECT kind, amount_usd, request_id FROM revenue WHERE quote_id = $1", [quoteId]);

describe("priceBlockedReason", () => {
  const req = { id: "req_x", source: "portal", is_free_sample: false, quote_id: "qte_x" };
  const q = (status: string, auto_approved = false) => ({ id: "qte_x", status, auto_approved });

  it("only an accepted option clears the price; there is no auto-approval under a cap any more", () => {
    expect(priceBlockedReason(req, q("accepted"))).toBeNull();
    expect(priceBlockedReason(req, q("approved", true))).toMatch(/accepts an option/); // the removed v1 path
    for (const status of ["approved", "sent", "needs_approval", "superseded", "expired", "declined"]) {
      expect(priceBlockedReason(req, q(status))).not.toBeNull();
    }
    expect(priceBlockedReason(req, null)).toMatch(/no quote/);
  });

  it("free samples and monitoring follow-ups are never quoted", () => {
    expect(priceBlockedReason({ ...req, is_free_sample: true }, null)).toBeNull();
    expect(priceBlockedReason({ ...req, source: "monitor" }, null)).toBeNull();
  });
});

describe("nothing runs until the customer accepts an option", () => {
  it("a $29 free-data quote still waits: analysis, the job and delivery are held until accept_quote", async () => {
    const { req, quote } = await quotedRequest();
    expect(quote).toMatchObject({ status: "approved", auto_approved: false, price_usd: 29 });

    await expect(toAnalytics(req.id)).rejects.toThrow(/accepts an option/);
    await expect(getAnalysisJob(req.id)).rejects.toThrow(/accepts an option/);
    expect((await sendQuote(req.id, "comms-customer")).status).toBe("sent");
    expect((await getRequest(req.id))?.status).toBe("quoted");
    await expect(toAnalytics(req.id, "comms-customer")).rejects.toThrow(/accept_quote/);
    // The old shortcut no longer accepts anything by itself.
    await expect(toAnalytics(req.id, "comms-customer", true)).rejects.toThrow(/accept_quote/);
    await expect(toAnalytics(req.id, "planner", true)).rejects.toThrow(/Only comms-customer/);

    const res = await acceptQuote({ requestId: req.id, actor: "comms-customer", evidence: "Yes please, go ahead (c@example.com)" });
    expect(res).toMatchObject({ option_id: "A", next: "analysis", status: "analyzing", already_accepted: false, price_usd: 29 });
    expect(await getRequest(req.id)).toMatchObject({ status: "analyzing", owner_agent: "analytics" });
    expect(await getQuote(quote.id)).toMatchObject({ status: "accepted", accepted_option_id: "A" });
    expect((await getAnalysisJob(req.id)).job.request_id).toBe(req.id);
    const [d] = await sql<{ choice: string; reasoning: string }>(
      "SELECT choice, reasoning FROM decisions WHERE request_id = $1 AND kind = 'pricing' AND choice LIKE 'customer accepted%'", [req.id]);
    expect(d.choice).toMatch(/option A/);
    expect(d.reasoning).not.toMatch(/c@example\.com/); // evidence is scrubbed of personal data

    // Committed revenue at the option's price, once; a repeat (double click, retried call) changes nothing.
    expect(await revenue(quote.id)).toEqual([{ kind: "committed", amount_usd: "29.00", request_id: req.id }]);
    expect(await acceptQuote({ requestId: req.id, optionId: "A", actor: "comms-customer", evidence: "yes" })).toMatchObject({ already_accepted: true });
    await handoff({ requestId: req.id, from: "comms-customer", to: "interpreter", stage: "report", instructions: "Retry with the same acceptance", quoteAccepted: true });
    expect(await revenue(quote.id)).toHaveLength(1);
    await expect(acceptQuote({ requestId: req.id, optionId: "B", actor: "comms-customer", evidence: "actually B" })).rejects.toMatchObject({ code: "already_accepted" });
  });

  it("a paid-data option holds the order for a founder and does not start analysis on free data", async () => {
    const { req, quote } = await quotedRequest(PAID_PLAN);
    expect(quote.recommended_option_id).toBe("B");
    const res = await acceptQuote({ requestId: req.id, actor: "comms-customer", evidence: "Option B please" });
    expect(res).toMatchObject({ option_id: "B", next: "awaiting_data_purchase", status: "awaiting_approval" });
    expect(res.order_ids).toHaveLength(1);
    const [order] = await sql<{ provider_id: string; status: string; est_cost_usd: string }>("SELECT provider_id, status, est_cost_usd FROM orders WHERE id = $1", [res.order_ids[0]]);
    expect(order).toMatchObject({ provider_id: "sw-pneo-30cm", status: "awaiting_approval", est_cost_usd: "225.00" });
    const row = await getRequest(req.id);
    expect(row?.owner_agent).not.toBe("analytics");
    const accepted = (await getQuote(quote.id))!;
    expect(Number(accepted.price_usd)).toBe(accepted.options.find((o) => o.option_id === "B")!.price_usd); // mirrors the accepted option
    expect((await revenue(quote.id))[0].amount_usd).toBe(Number(accepted.price_usd).toFixed(2));
  });

  it("the accept link: same service, one acceptance; old links and unknown tokens are refused", async () => {
    const { req, quote } = await quotedRequest();
    const token = (await getQuote(quote.id))!.accept_token!;
    await expect(acceptQuoteByToken({ token: "nope-nope-nope-nope", optionId: "A" })).rejects.toMatchObject({ code: "not_found" });
    await expect(acceptQuoteByToken({ token, optionId: "Z" })).rejects.toMatchObject({ code: "bad_option" });

    // A re-quote replaces the link.
    const newer = quoteOf(await createQuote({ requestId: req.id, options: (await getQuote(quote.id))!.options.slice(0, 1), recommendedOptionId: "A" }, "pricing"));
    await expect(acceptQuoteByToken({ token, optionId: "A" })).rejects.toMatchObject({ code: "superseded" });
    const newToken = (await getQuote(newer.id))!.accept_token!;
    const [a, b] = await Promise.all([acceptQuoteByToken({ token: newToken, optionId: "A" }), acceptQuoteByToken({ token: newToken, optionId: "a" })]);
    expect([a.already_accepted, b.already_accepted].sort()).toEqual([false, true]);
    expect(await revenue(newer.id)).toHaveLength(1);
    const [ev] = await sql<{ actor: string }>("SELECT actor FROM events WHERE request_id = $1 AND type = 'quote.accepted'", [req.id]);
    expect(ev.actor).toBe(LINK_ACTOR);
  });

  it("an expired quote can't be accepted", async () => {
    const { req, quote } = await quotedRequest();
    await sql("UPDATE quotes SET valid_until = now() - interval '1 day' WHERE id = $1", [quote.id]);
    const err = await acceptQuote({ requestId: req.id, actor: "comms-customer", evidence: "yes" }).catch((e) => e);
    expect(err).toBeInstanceOf(QuoteAcceptError);
    expect(err.code).toBe("expired");
    expect((await getQuote(quote.id))?.status).toBe("expired");
    expect(priceBlockedReason(req, { id: quote.id, status: "expired" })).toMatch(/fresh quote/);
  });

  it("an Earth-index answer goes to the interpreter once accepted, never before", async () => {
    const req = await plannedRequest({ choice: "existing_index", free_option: null });
    const toInterpreter = () => handoff({ requestId: req.id, from: "pricing", to: "interpreter", stage: "report", instructions: "Write it from the index" });
    await expect(toInterpreter()).rejects.toThrow(/no quote yet/);
    await createQuote({ requestId: req.id }, "pricing");
    await expect(toInterpreter()).rejects.toThrow(/accepts an option/);
    expect(await acceptQuote({ requestId: req.id, actor: "comms-customer", evidence: "yes" })).toMatchObject({ next: "report" });
    expect((await getRequest(req.id))?.owner_agent).toBe("interpreter");
  });

  it("report work and delivery refuse a request whose quote was never accepted", async () => {
    const { req } = await quotedRequest();
    await saveAnalysis({ requestId: req.id, result: sampleAnalysis(), fileIds: SAMPLE_FILE_IDS }, "analytics");
    await expect(saveReportDraft(sampleDraft(req.id), "interpreter")).rejects.toThrow(/accepts an option/);
    for (const [to, stage] of [["interpreter", "analysis"], ["verifier", "verification"], ["interpreter", "revision"], ["comms-customer", "delivery"]] as const) {
      await expect(handoff({ requestId: req.id, from: "analytics", to, stage, instructions: "Keep going" })).rejects.toThrow(/accepts an option/);
    }
    // A verified report that somehow exists still can't go out.
    await sql(
      `INSERT INTO reports (id, request_id, title, answer, confidence, limitations, verifier_status, public_token)
       VALUES ($1, $2, 'Burn check', 'Yes.', 'medium', 'n/a', 'pass', $3)`,
      [newId("report"), req.id, `Tok${req.id.slice(4)}AAAAAAAAAAAAAAAA`],
    );
    await expect(deliverReport(req.id, "comms-customer")).rejects.toThrow(/accepts an option/);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("free samples still run without a customer quote (our marketing cost)", async () => {
    const sample = await createRequest({ question: "Free sample: did the fire reach the depot?", lat: SITE.lat, lon: SITE.lon, source: "signal", isFreeSample: true, priority: "background" });
    await saveDataSpec(sampleSpec(sample.id), "planner");
    for (const kind of ["free_vs_paid", "source_selection"] as const) await logDecision({ requestId: sample.id, kind, choice: "free", reasoning: "enough", agent: "acquisition" });
    expect((await saveAcquisitionPlan(samplePlan(sample.id), "acquisition")).next).toEqual({ to: "analytics", stage: "analysis" });
    await toAnalytics(sample.id, "acquisition");
    expect((await getRequest(sample.id))?.owner_agent).toBe("analytics");
    expect((await getAnalysisJob(sample.id)).job.request_id).toBe(sample.id);
    await expect(acceptQuote({ requestId: sample.id, actor: "comms-customer", evidence: "yes" })).rejects.toMatchObject({ code: "free_sample" });
  });
});

describe("pre-v2 quotes held for a founder", () => {
  async function legacyHeld() {
    const req = await plannedRequest(PAID_PLAN);
    const id = newId("quote");
    await sql(
      `INSERT INTO quotes (id, request_id, data_cost_usd, analysis_cost_usd, margin_usd, price_usd, auto_approved, status, line_items)
       VALUES ($1, $2, 112.5, 1.7, 343, 458, false, 'needs_approval', '[]')`, [id, req.id]);
    await sql("UPDATE requests SET quote_id = $2, status = 'awaiting_approval' WHERE id = $1", [req.id, id]);
    return { req, id };
  }

  it("a founder's release only lets comms-customer send it; work still waits for the customer", async () => {
    const { req, id } = await legacyHeld();
    await expect(sendQuote(req.id, "comms-customer")).rejects.toThrow(/pre-v2 quote held for founder review/);
    await approveQuote(id, "Laurence");
    const [iv] = await sql<{ action: string; ref_id: string }>("SELECT action, ref_id FROM interventions WHERE request_id = $1", [req.id]);
    expect(iv).toEqual({ action: "approve_quote", ref_id: id });
    await expect(toAnalytics(req.id, "comms-customer")).rejects.toThrow(/accepts an option/);
    expect((await sendQuote(req.id, "comms-customer")).status).toBe("sent");
    // A pre-v2 quote has no options: it is accepted as its single option A.
    expect(await acceptQuote({ requestId: req.id, actor: "comms-customer", evidence: "yes" })).toMatchObject({ option_id: "A", next: "awaiting_data_purchase" });
    expect(await revenue(id)).toEqual([{ kind: "committed", amount_usd: "458.00", request_id: req.id }]);
  });

  it("a founder's rejection declines it and sends it back to pricing", async () => {
    const { req, id } = await legacyHeld();
    await rejectQuote(id, "Laurence", "Too expensive for a 1 km² job");
    expect(await getRequest(req.id)).toMatchObject({ status: "pricing", owner_agent: "pricing" });
    expect((await getQuote(id))?.status).toBe("declined");
    await expect(approveQuote(id, "Laurence")).rejects.toThrow(/not waiting/);
  });
});

describe("finished requests", () => {
  it("send nothing more to the customer (a refusal still goes out on a refused request)", async () => {
    const { req } = await quotedRequest();
    await setStatus(req.id, "cancelled", "coordinator", "Customer withdrew");
    await expect(sendCustomerMessage({ requestId: req.id, kind: "clarifying_question", text: "Which address?" }, "comms-customer")).rejects.toThrow(/cancelled/);
    await expect(sendQuote(req.id, "comms-customer")).rejects.toThrow(/cancelled/);
    await expect(deliverReport(req.id, "comms-customer")).rejects.toThrow(/cancelled/);
    await expect(acceptQuote({ requestId: req.id, actor: "comms-customer", evidence: "yes" })).rejects.toMatchObject({ code: "closed" });
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

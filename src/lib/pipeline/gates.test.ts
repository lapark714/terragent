import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../db/client";
import { sendEmail } from "../email/send";
import { logDecision } from "../events";
import { saveAcquisitionPlan } from "./acquisition";
import { getAnalysisJob, saveAnalysis } from "./analyses";
import { deliverReport, sendCustomerMessage, sendQuote } from "./deliver";
import { priceBlockedReason } from "./gates";
import { approveQuote, createQuote, rejectQuote } from "./quotes";
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
  return { renderClarifyingQuestion: e("question"), renderRefusal: e("refusal"), renderQuote: e("quote"), renderReportDelivery: e("report") };
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

const toAnalytics = (requestId: string, from = "pricing", quoteAccepted?: boolean) =>
  handoff({ requestId, from, to: "analytics", stage: "analysis", instructions: "Run the pipeline", quoteAccepted });

describe("priceBlockedReason", () => {
  const req = { id: "req_x", source: "portal", is_free_sample: false, quote_id: "qte_x" };
  const q = (status: string, auto_approved = false) => ({ id: "qte_x", status, auto_approved });

  it("clears auto-approved and accepted quotes only", () => {
    expect(priceBlockedReason(req, q("approved", true))).toBeNull();
    expect(priceBlockedReason(req, q("accepted"))).toBeNull();
    for (const status of ["needs_approval", "approved", "sent", "declined"]) expect(priceBlockedReason(req, q(status))).not.toBeNull();
    expect(priceBlockedReason(req, null)).toMatch(/no quote/);
  });

  it("free samples and monitoring follow-ups are never quoted", () => {
    expect(priceBlockedReason({ ...req, is_free_sample: true }, null)).toBeNull();
    expect(priceBlockedReason({ ...req, source: "monitor" }, null)).toBeNull();
  });
});

describe("founder approval above the cap", () => {
  it("holds analysis, the job and delivery until a founder approves and the customer accepts", async () => {
    const req = await plannedRequest(PAID_PLAN);
    const { quote, next } = await createQuote({ requestId: req.id }, "pricing");
    expect(quote).toMatchObject({ status: "needs_approval", auto_approved: false });
    expect(next.to).toBeNull();

    await expect(toAnalytics(req.id)).rejects.toThrow(/waits for a founder/);
    await expect(getAnalysisJob(req.id)).rejects.toThrow(/waits for a founder/);
    await expect(sendQuote(req.id, "comms-customer")).rejects.toThrow(/founder must approve/);

    await approveQuote(quote.id, "Laurence");
    const [iv] = await (await getDb()).query<{ action: string; ref_id: string }>("SELECT action, ref_id FROM interventions WHERE request_id = $1", [req.id]);
    expect(iv).toEqual({ action: "approve_quote", ref_id: quote.id });
    await expect(toAnalytics(req.id, "comms-customer")).rejects.toThrow(/send_quote/);

    expect((await sendQuote(req.id, "comms-customer")).status).toBe("sent");
    expect((await getRequest(req.id))?.status).toBe("quoted");
    await expect(toAnalytics(req.id, "comms-customer")).rejects.toThrow(/quote_accepted=true/);
    await expect(toAnalytics(req.id, "planner", true)).rejects.toThrow(/Only comms-customer/);

    await toAnalytics(req.id, "comms-customer", true);
    expect(await getRequest(req.id)).toMatchObject({ status: "analyzing", owner_agent: "analytics" });
    const [q] = await (await getDb()).query<{ status: string }>("SELECT status FROM quotes WHERE id = $1", [quote.id]);
    expect(q.status).toBe("accepted");
    expect((await getAnalysisJob(req.id)).job.request_id).toBe(req.id);

    // The acceptance is committed revenue at the quote's price (the coordinator's value input, the money panel), once.
    const revenue = () => getDb().then((db) => db.query<{ kind: string; amount_usd: string; request_id: string }>(
      "SELECT kind, amount_usd, request_id FROM revenue WHERE quote_id = $1", [quote.id]));
    expect(await revenue()).toEqual([{ kind: "committed", amount_usd: Number(quote.price_usd).toFixed(2), request_id: req.id }]);
    await handoff({ requestId: req.id, from: "comms-customer", to: "interpreter", stage: "report", instructions: "Retry with the same acceptance", quoteAccepted: true });
    expect(await revenue()).toHaveLength(1);
  });

  it("an Earth-index answer can't skip pricing on its way to the interpreter", async () => {
    const req = await plannedRequest({ choice: "existing_index", free_option: null });
    const toInterpreter = () => handoff({ requestId: req.id, from: "pricing", to: "interpreter", stage: "report", instructions: "Write it from the index" });
    await expect(toInterpreter()).rejects.toThrow(/no quote yet/);
    await createQuote({ requestId: req.id }, "pricing");
    await toInterpreter();
    expect((await getRequest(req.id))?.owner_agent).toBe("interpreter");
  });

  it("delivery refuses a report whose quote still waits for a founder", async () => {
    const req = await plannedRequest();
    await createQuote({ requestId: req.id }, "pricing");
    await toAnalytics(req.id);
    await saveAnalysis({ requestId: req.id, result: sampleAnalysis(), fileIds: SAMPLE_FILE_IDS }, "analytics");
    const { report_id } = await saveReportDraft(sampleDraft(req.id), "interpreter");
    await (await getDb()).query("UPDATE reports SET verifier_status = 'pass' WHERE id = $1", [report_id]);
    // Re-priced above the cap after the work (e.g. a real supplier quote came in).
    await createQuote({ requestId: req.id, dataCostUsd: 200 }, "pricing");
    await expect(deliverReport(req.id, "comms-customer")).rejects.toThrow(/waits for a founder/);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("a founder's rejection declines the quote and sends it back to pricing", async () => {
    const req = await plannedRequest(PAID_PLAN);
    const { quote } = await createQuote({ requestId: req.id }, "pricing");
    await rejectQuote(quote.id, "Laurence", "Too expensive for a 1 km² job");
    expect(await getRequest(req.id)).toMatchObject({ status: "pricing", owner_agent: "pricing" });
    const [q] = await (await getDb()).query<{ status: string }>("SELECT status FROM quotes WHERE id = $1", [quote.id]);
    expect(q.status).toBe("declined");
    await expect(approveQuote(quote.id, "Laurence")).rejects.toThrow(/not waiting/);
  });
});

describe("finished requests", () => {
  it("send nothing more to the customer (a refusal still goes out on a refused request)", async () => {
    const req = await plannedRequest();
    await createQuote({ requestId: req.id }, "pricing");
    await setStatus(req.id, "cancelled", "coordinator", "Customer withdrew");
    await expect(sendCustomerMessage({ requestId: req.id, kind: "clarifying_question", text: "Which address?" }, "comms-customer")).rejects.toThrow(/cancelled/);
    await expect(sendQuote(req.id, "comms-customer")).rejects.toThrow(/cancelled/);
    await expect(deliverReport(req.id, "comms-customer")).rejects.toThrow(/cancelled/);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

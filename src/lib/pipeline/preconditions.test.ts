/**
 * Handoff preconditions (preconditions.ts): a stage is handed on only once the step before it saved its output, so a
 * save that Naïve parked and the model never re-issued can't let the next stage run on nothing (req_ybnemrwx4g).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../db/client";
import { type AgentName, VERIFIER_CHECKS, type Verdict } from "../domain";
import { getRequestProgress } from "../dashboard/public";
import { logDecision } from "../events";
import { acceptQuote } from "./acceptance";
import { saveAcquisitionPlan } from "./acquisition";
import { saveAnalysis } from "./analyses";
import { markOrderDelivered } from "./orders";
import { handoffBlockedReason } from "./preconditions";
import { createQuote, type CreateQuoteResult, type CreateQuoteSaved, getQuote } from "./quotes";
import { saveReportDraft } from "./reports";
import { createRequest, getRequest, handoff, mergeMeta, requireRequest, startInboundRequest } from "./requests";
import { saveDataSpec } from "./specs";
import { SAMPLE_FILE_IDS, sampleAnalysis, sampleDraft, samplePlan, sampleSpec, SITE, setupMemoryDb } from "./testing";
import { saveVerdict } from "./verdicts";

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
    requestStatusUrl: (id: string) => `https://terragent.test/request/${id}`,
    quoteAcceptUrl: (token: string) => `https://terragent.test/quote/${token}`,
  };
});

beforeAll(async () => {
  await setupMemoryDb();
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TERRAGENT_LANES", "off");
});
afterAll(() => {
  vi.unstubAllEnvs();
});

const sql = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await getDb()).query<T>(text, params);

/** One handoff, as the handoff tool (or an internal caller) would make it. */
const hand = (requestId: string, from: string, to: AgentName, stage: string) =>
  handoff({ requestId, from, to, stage, instructions: `Do the ${stage} step` });

/** handoffBlockedReason on its own, for a rule's scope: the other handoff() guards (dedupe, screening) don't apply. */
const blocked = async (id: string, from: string, to: AgentName, stage: string) => handoffBlockedReason(await requireRequest(id), { from, to, stage });

/** What every refusal to acquisition spells out: saveAcquisitionPlan refuses without this run's two decisions. */
const LOG_THEN_SAVE =
  "call terragent.log_decision (kinds source_selection and free_vs_paid) unless both are already logged in this run, wait for the results, then call terragent.save_acquisition_plan";

const owner = async (id: string) => (await getRequest(id))?.owner_agent;
const refused = (id: string) =>
  sql<{ actor: string; payload: Record<string, unknown> }>("SELECT actor, payload FROM events WHERE request_id = $1 AND type = 'handoff.refused' ORDER BY id", [id]);

/** A screened customer request with nothing saved yet. */
async function customerRequest() {
  const req = await createRequest({ question: "Did the January fire reach our warehouse?", lat: SITE.lat, lon: SITE.lon, source: "portal", email: "ops@depot.test" });
  await mergeMeta(req.id, { screening: { allowed: true } });
  return req;
}

/** A free sample (signal engine, background lane) with nothing saved yet. */
const freeSample = () =>
  createRequest({ question: "Free sample: did the fire reach the depot?", lat: SITE.lat, lon: SITE.lon, source: "signal", isFreeSample: true, priority: "background" });

/** acquisition's two required decisions, then its plan. */
async function decideAndPlan(id: string, over: Parameters<typeof samplePlan>[1] = {}) {
  for (const kind of ["source_selection", "free_vs_paid"] as const) {
    await logDecision({ requestId: id, kind, choice: "free", reasoning: "Sentinel-2 is enough", agent: "acquisition" });
  }
  return saveAcquisitionPlan(samplePlan(id, over), "acquisition");
}

/** A customer request with a spec and a plan (ready for pricing). */
async function plannedRequest(over: Parameters<typeof samplePlan>[1] = {}) {
  const req = await customerRequest();
  await saveDataSpec(sampleSpec(req.id), "planner");
  await decideAndPlan(req.id, over);
  return req;
}

function saved(r: CreateQuoteResult): CreateQuoteSaved {
  if ("error" in r) throw new Error(r.error);
  return r;
}

/** A customer request priced and accepted on its free option, with the analysis saved (ready for the report). */
async function analysedRequest() {
  const req = await plannedRequest();
  saved(await createQuote({ requestId: req.id }, "pricing"));
  await acceptQuote({ requestId: req.id, actor: "comms-customer", evidence: "Yes, go ahead" });
  await saveAnalysis({ requestId: req.id, result: sampleAnalysis(), fileIds: SAMPLE_FILE_IDS }, "analytics");
  return req;
}

/** A free sample with spec, plan and analysis saved. */
async function analysedSample() {
  const req = await freeSample();
  await saveDataSpec(sampleSpec(req.id), "planner");
  await decideAndPlan(req.id);
  await saveAnalysis({ requestId: req.id, result: sampleAnalysis(), fileIds: SAMPLE_FILE_IDS }, "analytics");
  return req;
}

const verdict = (reportId: string, pass: boolean): Verdict => ({
  report_id: reportId, pass, score: pass ? 92 : 40,
  checks: VERIFIER_CHECKS.map((id) => ({ id, pass, note: pass ? "ok" : "weak" })),
  required_fixes: pass ? [] : ["Explain the dNBR classes in plain words"],
});

const PAID_PLAN = {
  choice: "paid" as const, data_cost_usd: 112.5,
  free_option: { provider_id: "pc-sentinel-2-l2a", before_scene: null, after_scene: null, sufficient: false, why: "10 m can't see roofs" },
  paid_options: [{ provider_id: "sw-pneo-30cm", product: "archive 30 cm", resolution_m: 0.3, est_cost_usd: 112.5, min_order_km2: 5, delivery_time: null, license_terms: null, preview_available: true, why: "roofs" }],
  justification: "Roof-level damage needs sub-metre imagery; Sentinel-2 at 10 m cannot resolve individual buildings.",
};

describe("the live failure (req_ybnemrwx4g, session ses_nb14…): only the parked handoff was re-issued", () => {
  it("acquisition → pricing with no plan is refused with the missing tools and logged; it passes once the plan is saved", async () => {
    const req = await customerRequest();
    await hand(req.id, "comms-customer", "planner", "planning");
    await saveDataSpec(sampleSpec(req.id), "planner");
    await hand(req.id, "planner", "acquisition", "acquisition");

    // log_decision ×2 and save_acquisition_plan never ran; the handoff did.
    const err = await hand(req.id, "acquisition", "pricing", "pricing").catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(
      `No acquisition plan saved for ${req.id}: ${LOG_THEN_SAVE}, wait for its result, then call terragent.handoff to pricing again on its own.`,
    );
    expect(await refused(req.id)).toEqual([
      { actor: "acquisition", payload: { to: "pricing", stage: "pricing", reason: (err as Error).message } },
    ]);
    // The request stays with acquisition: pricing never starts on nothing.
    expect(await getRequest(req.id)).toMatchObject({ owner_agent: "acquisition", stage: "acquisition" });

    await decideAndPlan(req.id);
    await hand(req.id, "acquisition", "pricing", "pricing");
    expect(await getRequest(req.id)).toMatchObject({ owner_agent: "pricing", stage: "pricing", status: "pricing" });
  });

  it("acquisition's save needs its OWN decisions in this run: the planner's source_selection no longer counts", async () => {
    const req = await customerRequest();
    await saveDataSpec(sampleSpec(req.id), "planner");
    await hand(req.id, "planner", "acquisition", "acquisition");
    await logDecision({ requestId: req.id, kind: "source_selection", choice: "Sentinel-2", reasoning: "Planner's note on sources", agent: "planner" });
    await logDecision({ requestId: req.id, kind: "free_vs_paid", choice: "free", reasoning: "10 m is enough", agent: "acquisition" });
    await expect(saveAcquisitionPlan(samplePlan(req.id), "acquisition")).rejects.toThrow(
      "Log your reasoning in this run first: terragent.log_decision kind source_selection (choice, reasoning, alternatives with cost); " +
        "wait for the results, then call terragent.save_acquisition_plan again on its own.",
    );
    await logDecision({ requestId: req.id, kind: "source_selection", choice: "Sentinel-2", reasoning: "Newest clear pair", agent: "acquisition" });
    await expect(saveAcquisitionPlan(samplePlan(req.id), "acquisition")).resolves.toMatchObject({ saved: true });
  });

  it("the screening refusal also says to wait for the result, then hand off again on its own", async () => {
    const req = await startInboundRequest({ question: "Has the river flooded the farm?", lat: 40, lon: -90, source: "portal" });
    await expect(hand(req.id, "comms-customer", "planner", "planning")).rejects.toThrow(
      `Request ${req.id} has not passed screening; comms-customer must record_screening (allowed) first, wait for its result, then call terragent.handoff again on its own.`,
    );
  });
});

describe("consumer rules: what the destination needs", () => {
  it("A. acquisition needs a data spec", async () => {
    const req = await customerRequest();
    await expect(hand(req.id, "planner", "acquisition", "acquisition")).rejects.toThrow(
      `Request ${req.id} has no saved data spec: call terragent.save_data_spec, wait for its result, then call terragent.handoff to acquisition again on its own.`,
    );
    await expect(hand(req.id, "coordinator", "acquisition", "acquisition")).rejects.toThrow(
      `Request ${req.id} has no data spec: hand it to planner (stage planning) to save_data_spec first.`,
    );
    await saveDataSpec(sampleSpec(req.id), "planner");
    await hand(req.id, "planner", "acquisition", "acquisition");
    expect(await owner(req.id)).toBe("acquisition");
  });

  it("B. pricing needs a quotable request with a spec and a plan", async () => {
    const sample = await freeSample();
    await expect(hand(sample.id, "coordinator", "pricing", "pricing")).rejects.toThrow(/is a free sample and is never quoted: hand it to analytics \(stage analysis\)/);

    const req = await customerRequest();
    await expect(hand(req.id, "coordinator", "pricing", "pricing")).rejects.toThrow(
      `Request ${req.id} has no data spec: hand it to planner (stage planning) to start the chain.`,
    );
    await saveDataSpec(sampleSpec(req.id), "planner");
    await expect(hand(req.id, "comms-customer", "pricing", "pricing")).rejects.toThrow(
      `Request ${req.id} has no acquisition plan: hand it to acquisition (stage acquisition) to save_acquisition_plan first.`,
    );
    await decideAndPlan(req.id);
    await hand(req.id, "acquisition", "pricing", "pricing");
    expect(await owner(req.id)).toBe("pricing");
  });

  it("B. a plan older than the data spec is refused until acquisition re-plans for the new spec", async () => {
    const req = await plannedRequest();
    await saveDataSpec(sampleSpec(req.id, { max_cloud_pct: 15 }), "planner"); // the spec changed after the plan
    await expect(hand(req.id, "acquisition", "pricing", "pricing")).rejects.toThrow(
      `The acquisition plan on ${req.id} is older than its data spec: ${LOG_THEN_SAVE} for the current spec, wait for its result, then call terragent.handoff to pricing again on its own.`,
    );
    await expect(hand(req.id, "coordinator", "pricing", "pricing")).rejects.toThrow(/older than its data spec: hand it to acquisition \(stage acquisition\)/);
    await saveAcquisitionPlan(samplePlan(req.id), "acquisition");
    await hand(req.id, "acquisition", "pricing", "pricing");
    expect(await owner(req.id)).toBe("pricing");
  });

  it("C. analysis needs a plan; acquisition is told to save it first", async () => {
    const req = await freeSample();
    await saveDataSpec(sampleSpec(req.id), "planner");
    await hand(req.id, "planner", "acquisition", "acquisition");
    await expect(hand(req.id, "acquisition", "analytics", "analysis")).rejects.toThrow(
      `No acquisition plan saved for ${req.id}: ${LOG_THEN_SAVE} (free data for a free sample), wait for its result, then call terragent.handoff to analytics again on its own.`,
    );
    await expect(hand(req.id, "system", "analytics", "analysis")).rejects.toThrow(
      `Request ${req.id} has no acquisition plan: hand it to acquisition (stage acquisition) first.`,
    );
    await decideAndPlan(req.id);
    await hand(req.id, "acquisition", "analytics", "analysis");
    expect(await owner(req.id)).toBe("analytics");
  });

  it("C. an Earth-index plan goes to the interpreter, not analytics", async () => {
    const req = await freeSample();
    await saveDataSpec(sampleSpec(req.id, { reuse_existing: true }), "planner");
    await hand(req.id, "planner", "acquisition", "acquisition");
    await expect(hand(req.id, "acquisition", "interpreter", "report")).rejects.toThrow(
      `No acquisition plan saved for ${req.id}: ${LOG_THEN_SAVE}, wait for its result, then call terragent.handoff to interpreter again on its own.`,
    );
    await decideAndPlan(req.id, { choice: "existing_index", free_option: null });
    await expect(hand(req.id, "acquisition", "analytics", "analysis")).rejects.toThrow(
      `Request ${req.id}'s plan reuses the Earth index: hand it to interpreter (stage report), not analytics.`,
    );
    await hand(req.id, "acquisition", "interpreter", "report"); // no analysis needed
    expect(await owner(req.id)).toBe("interpreter");
  });

  it("C. analysis waits for paid data a founder hasn't marked delivered; the founder's delivery starts it", async () => {
    const req = await plannedRequest(PAID_PLAN);
    saved(await createQuote({ requestId: req.id }, "pricing"));
    const res = await acceptQuote({ requestId: req.id, actor: "comms-customer", evidence: "Option B please" });
    expect(res).toMatchObject({ next: "awaiting_data_purchase", warnings: [] }); // accept_quote's own handoff to the coordinator passed
    expect(await owner(req.id)).toBe("coordinator");
    const [orderId] = res.order_ids;

    await expect(hand(req.id, "coordinator", "analytics", "analysis")).rejects.toThrow(
      `Request ${req.id} waits on paid data a founder hasn't marked delivered (orders ${orderId}): the analysis starts by itself when a founder marks it delivered. ` +
        "terragent.add_note and leave it waiting.",
    );
    expect(await markOrderDelivered({ orderId, founder: "Laurence" })).toMatchObject({ analysis_started: true });
    expect(await owner(req.id)).toBe("analytics");
  });

  it("D. the report needs an analysis saved in this run", async () => {
    const req = await freeSample();
    await saveDataSpec(sampleSpec(req.id), "planner");
    await decideAndPlan(req.id);
    await hand(req.id, "acquisition", "analytics", "analysis");
    await expect(hand(req.id, "analytics", "interpreter", "report")).rejects.toThrow(
      `No analysis saved for ${req.id} in this run: call terragent.run_analysis({ request_id }) and wait for its result (it saves the analysis), ` +
        "then call terragent.handoff to interpreter again on its own.",
    );
    await expect(hand(req.id, "coordinator", "interpreter", "report")).rejects.toThrow(
      `Request ${req.id} has no analysis yet: hand it to analytics (stage analysis) to run_analysis first.`,
    );
    await saveAnalysis({ requestId: req.id, result: sampleAnalysis(), fileIds: SAMPLE_FILE_IDS }, "analytics");
    await hand(req.id, "analytics", "interpreter", "report");
    expect(await owner(req.id)).toBe("interpreter");
  });

  it("D. an analysis from before the acceptance or before the current plan doesn't count", async () => {
    const req = await plannedRequest();
    saved(await createQuote({ requestId: req.id }, "pricing"));
    await saveAnalysis({ requestId: req.id, result: sampleAnalysis(), fileIds: SAMPLE_FILE_IDS }, "analytics"); // before the acceptance
    const res = await acceptQuote({ requestId: req.id, actor: "comms-customer", evidence: "yes" });
    expect(res).toMatchObject({ next: "analysis", warnings: [] }); // accept_quote's own handoff to analytics passed
    await expect(hand(req.id, "analytics", "interpreter", "report")).rejects.toThrow(/No analysis saved for .* in this run: call terragent\.run_analysis/);
    await saveAnalysis({ requestId: req.id, result: sampleAnalysis(), fileIds: SAMPLE_FILE_IDS }, "analytics");
    await hand(req.id, "analytics", "interpreter", "report");

    const sample = await analysedSample();
    await saveAcquisitionPlan(samplePlan(sample.id, { justification: "Re-planned with a newer clear scene pair." }), "acquisition");
    await expect(hand(sample.id, "analytics", "interpreter", "report")).rejects.toThrow(/No analysis saved for .* in this run/);
  });

  it("E. verification needs a draft nobody graded yet", async () => {
    const req = await analysedRequest();
    await expect(hand(req.id, "interpreter", "verifier", "verification")).rejects.toThrow(
      `No new report draft to verify for ${req.id} (latest: none): call terragent.save_report_draft, then terragent.check_report_rules on the report_id it returns, ` +
        "then call terragent.handoff to verifier again on its own.",
    );
    await expect(hand(req.id, "coordinator", "verifier", "verification")).rejects.toThrow(
      `Request ${req.id} has no report draft waiting for review: hand it to interpreter (stage report, or revision after a failed verdict) first.`,
    );
    const first = await saveReportDraft(sampleDraft(req.id), "interpreter");
    await hand(req.id, "interpreter", "verifier", "verification");

    // A failed verdict sends it back (save_verdict's own handoff to the interpreter, stage revision, passes) ...
    const failed = await saveVerdict(verdict(first.report_id, false), "verifier");
    expect(failed).toMatchObject({ handed_off_to: "interpreter" });
    expect(failed).not.toHaveProperty("handoff_error");
    // ... and the graded draft can't be handed back for review: a new draft must be saved first.
    await expect(hand(req.id, "interpreter", "verifier", "verification")).rejects.toThrow(`(latest: ${first.report_id}, fail)`);
    await saveReportDraft(sampleDraft(req.id, { confidence: "low" }), "interpreter");
    await hand(req.id, "interpreter", "verifier", "verification");
    expect(await owner(req.id)).toBe("verifier");
  });

  it("F. a revision needs a failing verdict", async () => {
    const req = await analysedRequest();
    const draft = await saveReportDraft(sampleDraft(req.id), "interpreter");
    await expect(hand(req.id, "coordinator", "interpreter", "revision")).rejects.toThrow(
      `Report ${draft.report_id} on ${req.id} has no failing verdict: the verifier must call terragent.save_verdict (pass=false with required_fixes); ` +
        "it sends the report back to the interpreter itself.",
    );
    expect(await saveVerdict(verdict(draft.report_id, false), "verifier")).toMatchObject({ handed_off_to: "interpreter" });
    expect(await getRequest(req.id)).toMatchObject({ owner_agent: "interpreter", stage: "revision" });
  });

  it("G. delivery needs a passed report; save_verdict's pass hands it to comms-customer itself", async () => {
    const req = await analysedRequest();
    const draft = await saveReportDraft(sampleDraft(req.id), "interpreter");
    await expect(hand(req.id, "verifier", "comms-customer", "delivery")).rejects.toThrow(
      `Report ${draft.report_id} for ${req.id} is not verified (status pending): the verifier must call terragent.save_verdict first; a pass hands the report on by itself.`,
    );
    const pass = await saveVerdict(verdict(draft.report_id, true), "verifier");
    expect(pass).toMatchObject({ pass: true, handed_off_to: "comms-customer" });
    expect(pass).not.toHaveProperty("handoff_error");
    expect(await getRequest(req.id)).toMatchObject({ owner_agent: "comms-customer", stage: "delivery" });
  });

  it("G, H. a free sample's report goes to outreach once passed, never to delivery", async () => {
    const req = await analysedSample();
    await expect(hand(req.id, "verifier", "comms-outreach", "outreach")).rejects.toThrow(
      `Report (none) for ${req.id} is not verified (status none): the verifier must call terragent.save_verdict first; a pass hands the report on by itself.`,
    );
    const draft = await saveReportDraft(sampleDraft(req.id), "interpreter");
    await expect(hand(req.id, "verifier", "comms-outreach", "outreach")).rejects.toThrow(/is not verified \(status pending\)/);
    const pass = await saveVerdict(verdict(draft.report_id, true), "verifier");
    expect(pass).toMatchObject({ pass: true, handed_off_to: "comms-outreach" });
    expect(pass).not.toHaveProperty("handoff_error");
    await expect(hand(req.id, "coordinator", "comms-customer", "delivery")).rejects.toThrow(
      "Free sample reports go to comms-outreach (stage outreach), not delivery.",
    );
  });

  it("I. the quote stage needs a sendable quote priced on the current plan", async () => {
    const req = await plannedRequest();
    const noQuote = `Request ${req.id} has no quote ready to send: pricing must call terragent.create_quote (it hands the quote to comms-customer itself).`;
    await expect(hand(req.id, "coordinator", "comms-customer", "quote")).rejects.toThrow(noQuote);

    const created = saved(await createQuote({ requestId: req.id }, "pricing"));
    expect(created.handoff).not.toBeNull(); // create_quote's own handoff to comms-customer passed
    expect(created.warnings.join(" ")).not.toMatch(/Handoff to comms-customer failed/);
    expect(await getRequest(req.id)).toMatchObject({ owner_agent: "comms-customer", stage: "quote" });

    await saveAcquisitionPlan(samplePlan(req.id, { justification: "Re-planned after the customer moved the dates." }), "acquisition");
    await expect(hand(req.id, "coordinator", "comms-customer", "quote")).rejects.toThrow(
      `Quote ${created.quote.id} predates ${req.id}'s current acquisition plan: pricing must call terragent.price_options, then terragent.create_quote again.`,
    );

    await sql("UPDATE quotes SET valid_until = now() - interval '1 day' WHERE id = $1", [created.quote.id]);
    await expect(hand(req.id, "coordinator", "comms-customer", "quote")).rejects.toThrow(noQuote);
  });

  it("I. re-pricing an expired quote with unchanged options makes a new one, whose handoff passes; an unexpired repeat stays the same quote", async () => {
    const req = await plannedRequest();
    const first = saved(await createQuote({ requestId: req.id }, "pricing"));
    await sql("UPDATE quotes SET status = 'sent' WHERE id = $1", [first.quote.id]);
    await hand(req.id, "comms-customer", "pricing", "pricing");

    const repeat = saved(await createQuote({ requestId: req.id }, "pricing"));
    expect(repeat.quote.id).toBe(first.quote.id);
    expect(repeat.handoff).toBeNull();

    await sql("UPDATE quotes SET valid_until = now() - interval '1 day' WHERE id = $1", [first.quote.id]);
    const second = saved(await createQuote({ requestId: req.id }, "pricing"));
    expect(second.quote.id).not.toBe(first.quote.id);
    expect(second.handoff).not.toBeNull();
    expect(await getQuote(first.quote.id)).toMatchObject({ status: "superseded" });
    expect(await getRequest(req.id)).toMatchObject({ owner_agent: "comms-customer", stage: "quote", quote_id: second.quote.id });
  });
});

describe("producer freshness: the sender saved its output in THIS run", () => {
  it("P1. after a re-plan (pricing → planner), the planner must save the updated spec before handing to acquisition", async () => {
    const req = await customerRequest();
    await hand(req.id, "comms-customer", "planner", "planning");
    await saveDataSpec(sampleSpec(req.id), "planner");
    await hand(req.id, "planner", "acquisition", "acquisition");
    await hand(req.id, "pricing", "planner", "planning"); // re-plan: nothing new needed to send it back
    await expect(hand(req.id, "planner", "acquisition", "acquisition")).rejects.toThrow(
      `The data spec on ${req.id} was not saved in this planning run: call terragent.save_data_spec (the updated spec), wait for its result, ` +
        "then call terragent.handoff to acquisition again on its own.",
    );
    await saveDataSpec(sampleSpec(req.id, { max_cloud_pct: 10 }), "planner");
    await hand(req.id, "planner", "acquisition", "acquisition");
    expect(await owner(req.id)).toBe("acquisition");
  });

  it("P2. after a re-plan (pricing → acquisition), acquisition must re-save its plan (and re-log its decisions) before pricing", async () => {
    const req = await plannedRequest();
    await hand(req.id, "acquisition", "pricing", "pricing");
    await hand(req.id, "pricing", "acquisition", "acquisition"); // re-plan: only acquisition's own need (a spec) applies
    await expect(hand(req.id, "acquisition", "pricing", "pricing")).rejects.toThrow(
      `No acquisition plan saved in this run (the one on ${req.id} and its decisions are from an earlier run): ${LOG_THEN_SAVE}, even if nothing changed, ` +
        "wait for its result, then call terragent.handoff again on its own.",
    );
    // The earlier run's decisions don't count for the new plan either.
    await expect(saveAcquisitionPlan(samplePlan(req.id), "acquisition")).rejects.toThrow(/Log your reasoning in this run first/);
    await decideAndPlan(req.id);
    await hand(req.id, "acquisition", "pricing", "pricing");
    expect(await owner(req.id)).toBe("pricing");
  });

  it("P2. a free sample's plan must be from this acquisition run before analytics", async () => {
    const req = await freeSample();
    await saveDataSpec(sampleSpec(req.id), "planner");
    await decideAndPlan(req.id);
    await hand(req.id, "coordinator", "acquisition", "acquisition"); // a second acquisition run
    await expect(hand(req.id, "acquisition", "analytics", "analysis")).rejects.toThrow(/No acquisition plan saved in this run/);
    await decideAndPlan(req.id);
    await hand(req.id, "acquisition", "analytics", "analysis");
    expect(await owner(req.id)).toBe("analytics");
  });

  it("P3. after the customer asked for changes, pricing hands on only a NEW quote (create_quote does it)", async () => {
    const req = await plannedRequest();
    const first = saved(await createQuote({ requestId: req.id }, "pricing"));
    // A retried identical handoff after create_quote's own one still dedupes.
    expect(await hand(req.id, "pricing", "comms-customer", "quote")).toMatchObject({ deduped: true });

    await sql("UPDATE quotes SET status = 'sent' WHERE id = $1", [first.quote.id]);
    await hand(req.id, "comms-customer", "pricing", "pricing"); // the customer asked for changes; a plan exists, so it passes
    await expect(hand(req.id, "pricing", "comms-customer", "quote")).rejects.toThrow(
      `No new quote in this pricing run (quote ${first.quote.id} was already sent): call terragent.create_quote with the customer's changes; ` +
        "it hands the new quote to comms-customer itself.",
    );
    const options = (await getQuote(first.quote.id))!.options;
    expect(options.length).toBeGreaterThan(1);
    const second = saved(await createQuote({ requestId: req.id, options: options.slice(0, 1), recommendedOptionId: "A" }, "pricing"));
    expect(second.quote.id).not.toBe(first.quote.id);
    expect(second.handoff).not.toBeNull();
    expect(await getRequest(req.id)).toMatchObject({ owner_agent: "comms-customer", stage: "quote", quote_id: second.quote.id });
  });
});

describe("a refusal to acquisition is enough to recover from", () => {
  const named = (message: string) => [...message.matchAll(/terragent\.([a-z_]+)/g)].map((m) => m[1]);

  /** Acquisition is refused, calls only the tools the refusal names in the order it names them, and hands off again. */
  async function recover(id: string, to: AgentName, stage: string, expected: RegExp, plan: Parameters<typeof samplePlan>[1] = {}) {
    const err = await hand(id, "acquisition", to, stage).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(expected);
    expect(named((err as Error).message)).toEqual(["log_decision", "save_acquisition_plan", "handoff"]);
    await decideAndPlan(id, plan); // log_decision ×2, then save_acquisition_plan
    await hand(id, "acquisition", to, stage);
    expect(await owner(id)).toBe(to);
  }

  /** A request that has a spec and has just reached acquisition, with nothing run there yet. */
  async function atAcquisition(req: { id: string }) {
    await saveDataSpec(sampleSpec(req.id), "planner");
    await hand(req.id, "planner", "acquisition", "acquisition");
    return req;
  }

  it("no plan, to pricing", async () => {
    const req = await atAcquisition(await customerRequest());
    await recover(req.id, "pricing", "pricing", /^No acquisition plan saved for/);
  });

  it("a plan older than a re-planned spec, to pricing", async () => {
    const req = await plannedRequest();
    await hand(req.id, "acquisition", "pricing", "pricing");
    await hand(req.id, "pricing", "planner", "planning");
    await saveDataSpec(sampleSpec(req.id, { max_cloud_pct: 10 }), "planner");
    await hand(req.id, "planner", "acquisition", "acquisition");
    await recover(req.id, "pricing", "pricing", /is older than its data spec/);
  });

  it("no plan on a free sample, to analytics", async () => {
    const req = await atAcquisition(await freeSample());
    await recover(req.id, "analytics", "analysis", /^No acquisition plan saved for/);
  });

  it("no plan on a free sample, to the interpreter", async () => {
    const req = await atAcquisition(await freeSample());
    await recover(req.id, "interpreter", "report", /^No acquisition plan saved for/, { choice: "existing_index", free_option: null });
  });

  it("a plan from an earlier run, to pricing", async () => {
    const req = await plannedRequest();
    await hand(req.id, "acquisition", "pricing", "pricing");
    await hand(req.id, "pricing", "acquisition", "acquisition");
    await recover(req.id, "pricing", "pricing", /from an earlier run/);
  });

  it("decisions that did run are not needed again: the save alone is enough", async () => {
    const req = await atAcquisition(await customerRequest());
    for (const kind of ["source_selection", "free_vs_paid"] as const) {
      await logDecision({ requestId: req.id, kind, choice: "free", reasoning: "Sentinel-2 is enough", agent: "acquisition" });
    }
    await expect(hand(req.id, "acquisition", "pricing", "pricing")).rejects.toThrow(/unless both are already logged in this run/);
    await saveAcquisitionPlan(samplePlan(req.id), "acquisition");
    await hand(req.id, "acquisition", "pricing", "pricing");
    expect(await owner(req.id)).toBe("pricing");
  });
});

describe("each rule's scope", () => {
  const monitorRequest = (isFreeSample = false) =>
    createRequest({ question: "Monitoring update (dnbr) for: did the fire reach us?", lat: SITE.lat, lon: SITE.lon, source: "monitor", isFreeSample, priority: "background" });

  it("C, D, G: a monitoring follow-up needs no plan, analysis or report of its own", async () => {
    const req = await monitorRequest();
    expect(await blocked(req.id, "system", "analytics", "analysis")).toBeNull();
    expect(await blocked(req.id, "system", "interpreter", "report")).toBeNull();
    const sample = await monitorRequest(true);
    expect(await blocked(sample.id, "system", "comms-customer", "delivery")).toBeNull();
  });

  it("C: analytics on the monitoring stage needs no plan", async () => {
    const sample = await freeSample();
    expect(await blocked(sample.id, "system", "analytics", "monitoring")).toBeNull();
  });

  it("A, B, C, E also follow the stage when the destination is another agent", async () => {
    const req = await customerRequest();
    expect(await blocked(req.id, "system", "coordinator", "acquisition")).toMatch(/has no data spec/);
    const sample = await freeSample();
    expect(await blocked(sample.id, "system", "coordinator", "pricing")).toMatch(/never quoted/);
    expect(await blocked(sample.id, "system", "coordinator", "analysis")).toMatch(/has no acquisition plan/);
    const analysed = await analysedSample();
    expect(await blocked(analysed.id, "system", "coordinator", "verification")).toMatch(/no report draft waiting/);
  });

  it("E also follows the destination when the stage is another one", async () => {
    const analysed = await analysedSample();
    expect(await blocked(analysed.id, "system", "verifier", "report")).toMatch(/no report draft waiting/);
  });

  it("P2: a free sample's plan must be from this run before the interpreter too", async () => {
    const sample = await freeSample();
    await saveDataSpec(sampleSpec(sample.id, { reuse_existing: true }), "planner");
    await decideAndPlan(sample.id, { choice: "existing_index", free_option: null });
    await hand(sample.id, "coordinator", "acquisition", "acquisition"); // a second acquisition run
    expect(await blocked(sample.id, "acquisition", "interpreter", "report")).toMatch(/No acquisition plan saved in this run/);
  });

  it("P3: an unsent quote can be handed on again after the request came back to pricing", async () => {
    const req = await plannedRequest();
    saved(await createQuote({ requestId: req.id }, "pricing"));
    await hand(req.id, "comms-customer", "pricing", "pricing");
    expect(await hand(req.id, "pricing", "comms-customer", "quote")).not.toHaveProperty("deduped");
    expect(await owner(req.id)).toBe("comms-customer");
  });

  it("a refusal is logged for the founders but never shows on the customer's status page", async () => {
    const req = await customerRequest();
    await expect(hand(req.id, "acquisition", "pricing", "pricing")).rejects.toThrow(/has no data spec/);
    expect(await refused(req.id)).toHaveLength(1);
    expect((await getRequestProgress(req.id))?.events.map((e) => e.type)).not.toContain("handoff.refused");
  });
});

describe("exemptions", () => {
  it("human:* senders (founder restarts, approvals, deliveries) skip every precondition", async () => {
    const req = await customerRequest();
    const sample = await freeSample();
    const edges: [string, AgentName, string][] = [
      [req.id, "acquisition", "acquisition"], [req.id, "pricing", "pricing"], [req.id, "comms-customer", "quote"],
      [sample.id, "analytics", "analysis"], [sample.id, "interpreter", "report"], [sample.id, "verifier", "verification"],
      [sample.id, "interpreter", "revision"], [sample.id, "comms-outreach", "outreach"], [sample.id, "comms-customer", "delivery"],
    ];
    for (const [id, to, stage] of edges) {
      expect(await handoffBlockedReason(await requireRequest(id), { from: "human:laurence", to, stage }), `${to}/${stage}`).toBeNull();
      await hand(id, "human:laurence", to, stage);
      expect(await owner(id)).toBe(to);
    }
    expect(await refused(req.id)).toEqual([]);
  });

  it("monitoring follow-ups reach delivery and outreach with no report of their own", async () => {
    const customer = await createRequest({ question: "Monitoring update (dnbr) for: did the fire reach us?", lat: SITE.lat, lon: SITE.lon, source: "monitor", email: "ops@depot.test", priority: "background" });
    await hand(customer.id, "analytics", "comms-customer", "delivery");
    expect(await owner(customer.id)).toBe("comms-customer");
    const prospect = await createRequest({ question: "Monitoring update (dnbr) for: free sample", lat: SITE.lat, lon: SITE.lon, source: "monitor", isFreeSample: true, priority: "background" });
    await hand(prospect.id, "system", "comms-outreach", "outreach");
    expect(await owner(prospect.id)).toBe("comms-outreach");
  });

  it("accept_quote's free-option handoff to the interpreter for an Earth-index plan needs no analysis", async () => {
    const req = await plannedRequest({ choice: "existing_index", free_option: null });
    saved(await createQuote({ requestId: req.id }, "pricing"));
    expect(await acceptQuote({ requestId: req.id, actor: "comms-customer", evidence: "yes" })).toMatchObject({ next: "report", warnings: [] });
    expect(await getRequest(req.id)).toMatchObject({ owner_agent: "interpreter", stage: "report" });
  });

  it("a retried identical handoff after a successful one still dedupes", async () => {
    const req = await plannedRequest();
    expect(await hand(req.id, "acquisition", "pricing", "pricing")).not.toHaveProperty("deduped");
    expect(await hand(req.id, "acquisition", "pricing", "pricing")).toMatchObject({ deduped: true });
    expect((await sql("SELECT id FROM events WHERE request_id = $1 AND type = 'handoff'", [req.id])).length).toBe(1);
  });

  it("the coordinator and system get refusals that name the agent and stage to route to", async () => {
    const req = await customerRequest();
    await expect(hand(req.id, "coordinator", "acquisition", "acquisition")).rejects.toThrow(/hand it to planner \(stage planning\)/);
    await saveDataSpec(sampleSpec(req.id), "planner");
    await expect(hand(req.id, "coordinator", "pricing", "pricing")).rejects.toThrow(/hand it to acquisition \(stage acquisition\)/);
    const sample = await analysedSample();
    await expect(hand(sample.id, "system", "verifier", "verification")).rejects.toThrow(/hand it to interpreter \(stage report, or revision after a failed verdict\)/);
    await sql("DELETE FROM analyses WHERE request_id = $1", [sample.id]);
    await sql("DELETE FROM events WHERE request_id = $1 AND type = 'analysis.saved'", [sample.id]);
    await expect(hand(sample.id, "coordinator", "interpreter", "report")).rejects.toThrow(/hand it to analytics \(stage analysis\)/);
    expect((await refused(req.id)).map((r) => r.actor)).toEqual(["coordinator", "coordinator"]);
  });
});

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PRICING } from "../config";
import { getDb } from "../db/client";
import { QuoteOption } from "../domain";
import { logDecision } from "../events";
import { startAgentSession } from "../naive/sessions";
import { saveAcquisitionPlan } from "./acquisition";
import { getQuoteByToken, getRequestProgress } from "../dashboard/public";
import { createQuote, type CreateQuoteResult, type CreateQuoteSaved, estimateCosts, getQuote, priceOptions, pricedEpochs } from "./quotes";
import { createRequest, getRequest, mergeMeta, recordSession } from "./requests";
import { saveDataSpec } from "./specs";
import { samplePlan, sampleSpec, SITE, setupMemoryDb } from "./testing";

vi.mock("../naive/sessions", () => ({ startAgentSession: vi.fn(async () => ({ session_id: `ses_${Math.random().toString(36).slice(2, 10)}` })) }));
vi.mock("../naive/board", () => ({ upsertCard: vi.fn(async () => ({ id: "crd_x" })) }));
vi.mock("../naive/spend", () => ({ sessionCostUsd: vi.fn(async (id: string) => (id === "ses_a" ? 0.4 : 0.2)) }));

beforeAll(async () => {
  await setupMemoryDb();
});
beforeEach(() => vi.clearAllMocks());

const sql = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await getDb()).query<T>(text, params);

/** A roof-level question: free 10 m data can't answer, so a sharper paid archive option is recommended. */
const ROOF_PLAN: Parameters<typeof samplePlan>[1] = {
  choice: "paid", data_cost_usd: 225,
  free_option: { provider_id: "pc-sentinel-2-l2a", before_scene: null, after_scene: null, sufficient: false, why: "10 m can't see individual roofs" },
  paid_options: [{ provider_id: "sw-pneo-30cm", product: "archive 30 cm", resolution_m: 0.3, est_cost_usd: 225, min_order_km2: 5, delivery_time: null, license_terms: null, preview_available: true, why: "roofs" }],
  justification: "Roof-level damage needs sub-metre imagery; Sentinel-2 at 10 m cannot resolve individual buildings.",
};

async function plannedRequest(plan: Parameters<typeof samplePlan>[1] = {}, o: { email?: string | null } = {}) {
  const req = await createRequest({
    question: "Did the fire reach our warehouse?", lat: SITE.lat, lon: SITE.lon, source: "portal", email: o.email === null ? undefined : (o.email ?? "ops@depot.test"),
  });
  await mergeMeta(req.id, { screening: { allowed: true } });
  await saveDataSpec(sampleSpec(req.id), "planner");
  for (const kind of ["free_vs_paid", "source_selection"] as const) {
    await logDecision({ requestId: req.id, kind, choice: "free Sentinel-2", reasoning: "10 m is enough for a burn scar", agent: "acquisition" });
  }
  await saveAcquisitionPlan(samplePlan(req.id, plan), "acquisition");
  return req;
}

function saved(r: CreateQuoteResult): CreateQuoteSaved {
  if ("error" in r) throw new Error(r.error);
  return r;
}

describe("price_options", () => {
  it("returns priced options and a recommendation without writing a quote", async () => {
    const req = await plannedRequest();
    const res = await priceOptions(req.id);
    expect(res.options.length).toBeGreaterThanOrEqual(1);
    expect(res.recommended_option_id).toBe("A");
    expect(res.options[0]).toMatchObject({ kind: "free_data", price_usd: PRICING.minReportUsd });
    for (const o of res.options) expect(() => QuoteOption.parse(o)).not.toThrow();
    expect((await getRequest(req.id))?.quote_id).toBeNull();
    expect(await sql("SELECT id FROM quotes WHERE request_id = $1", [req.id])).toEqual([]);
  });

  it("never prices more dates than the analysis compares, and says so", async () => {
    const req = await plannedRequest();
    const long = await priceOptions(req.id, { epochs: 10 });
    expect(long.epochs).toBe(PRICING.maxAnalysisEpochs);
    expect(long.options[0].data[0].epochs).toBe(PRICING.maxAnalysisEpochs);
    expect(long.notes[0]).toMatch(/Asked for 10 dates.*compares 2 dates/);
    expect(pricedEpochs({ before: null }, undefined)).toEqual({ epochs: 1, note: null });
    expect(pricedEpochs({ before: { start: "2025-01-01", end: "2025-01-10" } }, 1).epochs).toBe(2); // a before/after spec needs both dates
  });

  it("an epochs override (once the pipeline allows it) carries through create_quote", async () => {
    const cap = PRICING.maxAnalysisEpochs;
    PRICING.maxAnalysisEpochs = 40;
    try {
      const req = await plannedRequest();
      const base = await priceOptions(req.id);
      const long = await priceOptions(req.id, { epochs: 10 });
      expect(long.options[0].analysis_cost_usd).toBeGreaterThan(base.options[0].analysis_cost_usd);
      expect(long.options[0].data[0].epochs).toBe(10);

      // The same options without the same epochs are refused (the server would re-price them at 2 dates)...
      const forgot = await createQuote({ requestId: req.id, options: long.options, recommendedOptionId: "A" }, "pricing");
      expect("error" in forgot && forgot.error).toMatch(/pass the same epochs/);
      // ...and with them they are saved as priced.
      const ok = saved(await createQuote({ requestId: req.id, options: long.options, recommendedOptionId: "A", epochs: 10 }, "pricing"));
      expect(ok.quote.options[0].data[0].epochs).toBe(10);
      expect(ok.quote.price_usd).toBe(long.options[0].price_usd);
    } finally {
      PRICING.maxAnalysisEpochs = cap;
    }
  });

  it("refuses free samples and requests without a plan", async () => {
    const sample = await createRequest({ question: "Free sample for a prospect", lat: 1, lon: 1, source: "signal", isFreeSample: true, priority: "background" });
    await expect(priceOptions(sample.id)).rejects.toThrow(/Free samples/);
    const bare = await createRequest({ question: "No plan yet here", source: "portal" });
    await expect(priceOptions(bare.id)).rejects.toThrow(/data spec/);
  });
});

describe("create_quote", () => {
  it("saves server-priced options, never auto-approves, marks the request quoted and hands it to comms-customer", async () => {
    const req = await plannedRequest();
    const res = saved(await createQuote({ requestId: req.id }, "pricing"));
    expect(res.quote).toMatchObject({ auto_approved: false, status: "approved", price_usd: PRICING.minReportUsd, recommended_option_id: "A", accepted_option_id: null });
    expect(res.quote.options.length).toBeGreaterThanOrEqual(1);
    expect("accept_token" in res.quote).toBe(false); // the customer's key never reaches agents
    const validFor = Date.parse(res.valid_until!) - Date.now();
    expect(validFor).toBeGreaterThan((PRICING.quoteValidDays - 0.01) * 86_400_000);

    const row = await getRequest(req.id);
    expect(row).toMatchObject({ quote_id: res.quote.id, status: "quoted", owner_agent: "comms-customer", stage: "quote" });
    expect(vi.mocked(startAgentSession).mock.calls.at(-1)?.[0]).toBe("comms-customer");
    const stored = (await getQuote(res.quote.id))!;
    expect(stored.accept_token).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(stored.line_items.reduce((s, l) => s + l.amount_usd, 0)).toBeCloseTo(PRICING.minReportUsd);
    const [d] = await sql<{ choice: string }>("SELECT choice FROM decisions WHERE request_id = $1 AND kind = 'pricing'", [req.id]);
    expect(d.choice).toMatch(/recommended A at \$29/);

    const again = saved(await createQuote({ requestId: req.id }, "pricing"));
    expect(again.quote.id).toBe(res.quote.id); // a retried call doesn't create (or send) a second quote
  });

  it("re-prices the agent's options: words may change, prices may not", async () => {
    const req = await plannedRequest();
    const { options } = await priceOptions(req.id);
    const tampered = options.map((o) => ({ ...o, price_usd: o.price_usd! - 10 }));
    const refused = await createQuote({ requestId: req.id, options: tampered, recommendedOptionId: "A" }, "pricing");
    expect("error" in refused && refused.error).toMatch(/Prices come from the server/);
    expect("error" in refused && refused.server_options[0].price_usd).toBe(options[0].price_usd);
    expect((await getRequest(req.id))?.quote_id).toBeNull();

    const relabelled = options.map((o) => ({ ...o, label: `${o.label} (relabelled)` }));
    const ok = saved(await createQuote({ requestId: req.id, options: relabelled, recommendedOptionId: "A", notes: "cheapest that answers" }, "pricing"));
    expect(ok.quote.options[0]).toMatchObject({ label: `${options[0].label} (relabelled)`, price_usd: options[0].price_usd });
  });

  it("refuses an option whose quantities were edited: a smaller area, fewer dates, no data, or the wrong kind", async () => {
    const req = await plannedRequest(ROOF_PLAN);
    const { options, recommended_option_id } = await priceOptions(req.id);
    const paid = options.find((o) => o.kind !== "free_data")!;
    expect(paid.price_usd).toBeGreaterThan(PRICING.minReportUsd);
    const shrink = (o: QuoteOption, d: Partial<QuoteOption["data"][number]>) => ({ ...o, data: o.data.map((x) => ({ ...x, ...d })) });

    const refused = async (o: QuoteOption, why: RegExp) => {
      // Priced at whatever the edited quantities would cost, so only the quantity check can catch it.
      const res = await createQuote({ requestId: req.id, options: [{ ...o, price_usd: PRICING.minReportUsd }], recommendedOptionId: o.option_id }, "pricing");
      if (!("error" in res)) throw new Error("expected a refusal");
      expect(res.error).toMatch(/Data items come from the server/);
      expect(res.mismatches[0].reason).toMatch(why);
      expect(res.server_options).toEqual(options);
      expect(res.recommended_option_id).toBe(recommended_option_id);
    };
    await refused(shrink(paid, { area_km2: 0.5, billable_km2: 0.5 }), /covers 0\.5 km² of the/);
    await refused(shrink(paid, { epochs: 1 }), /don't match any option/);
    await refused({ ...paid, kind: "free_data", data: [] }, /no data items/);
    await refused({ ...paid, kind: "free_data" }, /labelled free_data but its data makes it archive/);
    expect((await getRequest(req.id))?.quote_id).toBeNull();
  });

  it("without recommended_option_id, recommends the server's pick (the cheapest that answers), not the cheapest", async () => {
    const req = await plannedRequest(ROOF_PLAN);
    const { options, recommended_option_id } = await priceOptions(req.id);
    expect(options[0]).toMatchObject({ kind: "free_data", price_usd: PRICING.minReportUsd }); // can't see roofs, but cheapest
    expect(recommended_option_id).not.toBe("A");
    const res = saved(await createQuote({ requestId: req.id, options }, "pricing"));
    expect(res.recommended_option_id).toBe(recommended_option_id);
    // Dropping the server's pick without naming one is refused rather than guessed.
    const req2 = await plannedRequest(ROOF_PLAN);
    await expect(createQuote({ requestId: req2.id, options: [options[0]] }, "pricing")).rejects.toThrow(/recommended_option_id is required/);
  });

  it("a changed quote supersedes the earlier one (and its accept link); an accepted one is final", async () => {
    const req = await plannedRequest();
    const first = saved(await createQuote({ requestId: req.id }, "pricing"));
    const { options } = await priceOptions(req.id);
    const second = saved(await createQuote({ requestId: req.id, options: [options[0]], recommendedOptionId: "A" }, "pricing"));
    expect(second.quote.id).not.toBe(first.quote.id);
    expect((await getQuote(first.quote.id))?.status).toBe("superseded");
    const oldLink = await getQuoteByToken((await getQuote(first.quote.id))!.accept_token!);
    expect(oldLink?.quote).toMatchObject({ closed_reason: "superseded", accept_url: null });
    expect((await getRequestProgress(req.id))?.quote?.accept_url).toMatch(/\/quote\/[A-Za-z0-9]{24}$/);

    await sql("UPDATE quotes SET status = 'accepted', accepted_option_id = 'A' WHERE id = $1", [second.quote.id]);
    await expect(createQuote({ requestId: req.id }, "pricing")).rejects.toThrow(/already accepted/);
  });

  it("an API request (no email, no thread) is quoted without a comms handoff", async () => {
    const req = await plannedRequest({}, { email: null });
    const res = saved(await createQuote({ requestId: req.id }, "pricing"));
    expect(res.handoff).toBeNull();
    expect(res.warnings.join(" ")).toMatch(/accept_url/);
    expect((await getRequest(req.id))?.status).toBe("quoted");
  });

  it("refuses free samples, requests without a plan, and an unknown recommendation", async () => {
    const sample = await createRequest({ question: "Free sample for a prospect", lat: 1, lon: 1, source: "signal", isFreeSample: true, priority: "background" });
    await expect(createQuote({ requestId: sample.id }, "pricing")).rejects.toThrow(/Free samples/);
    const bare = await createRequest({ question: "No plan yet here", source: "portal" });
    await expect(createQuote({ requestId: bare.id }, "pricing")).rejects.toThrow(/data spec/);
    const req = await plannedRequest();
    await expect(createQuote({ requestId: req.id, recommendedOptionId: "C" }, "pricing")).rejects.toThrow(/not one of the options/);
  });
});

describe("estimate_costs", () => {
  it("is our real Naïve spend plus the analysis estimate (internal cost view)", async () => {
    const req = await plannedRequest();
    await recordSession({ sessionId: "ses_a", agent: "planner", requestId: req.id, lane: "inbound" });
    await recordSession({ sessionId: "ses_b", agent: "acquisition", requestId: req.id, lane: "inbound" });
    const costs = await estimateCosts(req.id);
    expect(costs.spent_so_far_usd).toBeCloseTo(0.6);
    expect(costs.analysis_cost_usd).toBeCloseTo(0.6 + PRICING.defaultAnalysisCostUsd);
  });
});

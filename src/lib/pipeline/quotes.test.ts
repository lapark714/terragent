import { beforeAll, describe, expect, it, vi } from "vitest";
import { PRICING } from "../config";
import { getDb } from "../db/client";
import { saveAcquisitionPlan } from "./acquisition";
import { createQuote, estimateCosts, priceQuote } from "./quotes";
import { createRequest, getRequest, recordSession } from "./requests";
import { saveDataSpec } from "./specs";
import { samplePlan, sampleSpec, SITE, setupMemoryDb } from "./testing";
import { logDecision } from "../events";

vi.mock("../naive/sessions", () => ({ startAgentSession: vi.fn(async () => ({ session_id: "ses_x" })) }));
vi.mock("../naive/board", () => ({ upsertCard: vi.fn(async () => ({ id: "crd_x" })) }));
vi.mock("../naive/spend", () => ({ sessionCostUsd: vi.fn(async (id: string) => (id === "ses_a" ? 0.4 : 0.2)) }));

beforeAll(async () => {
  await setupMemoryDb();
});

async function plannedRequest(plan: Parameters<typeof samplePlan>[1] = {}) {
  const req = await createRequest({ question: "Did the fire reach our warehouse?", lat: SITE.lat, lon: SITE.lon, source: "portal" });
  await saveDataSpec(sampleSpec(req.id), "planner");
  for (const kind of ["free_vs_paid", "source_selection"] as const) {
    await logDecision({ requestId: req.id, kind, choice: "free Sentinel-2", reasoning: "10 m is enough for a burn scar", agent: "acquisition" });
  }
  await saveAcquisitionPlan(samplePlan(req.id, plan), "acquisition");
  return req;
}

describe("priceQuote", () => {
  it("free data: real cost + margin, floored at the minimum report price, auto-approved", () => {
    const q = priceQuote(0, 2.1);
    expect(q.price_usd).toBe(PRICING.minReportUsd);
    expect(q.data_cost_usd + q.analysis_cost_usd + q.margin_usd).toBeCloseTo(q.price_usd, 2);
    expect(q.auto_approved).toBe(true);
    expect(q.line_items.map((l) => l.label)).toEqual(["Analysis and verified report"]);
  });

  it("margin is the larger of the floor and a multiple of cost; whole dollars", () => {
    const q = priceQuote(10, 2);
    const cost = 12;
    expect(q.price_usd).toBe(Math.ceil(cost + Math.max(PRICING.marginFloorUsd, PRICING.marginMultiple * cost)));
    expect(q.line_items[0]).toEqual({ label: "Satellite data", amount_usd: 10 });
  });

  it("needs a founder above the auto-approve cap", () => {
    const q = priceQuote(112.5, 2);
    expect(q.price_usd).toBeGreaterThan(PRICING.autoApproveCapUsd);
    expect(q.auto_approved).toBe(false);
    expect(q.needs_approval_reason).toMatch(/cap/);
  });
});

describe("create_quote", () => {
  it("prices from real Naïve session spend plus the analysis estimate", async () => {
    const req = await plannedRequest();
    await recordSession({ sessionId: "ses_a", agent: "planner", requestId: req.id, lane: "inbound" });
    await recordSession({ sessionId: "ses_b", agent: "acquisition", requestId: req.id, lane: "inbound" });
    const costs = await estimateCosts(req.id);
    expect(costs.spent_so_far_usd).toBeCloseTo(0.6);
    expect(costs.analysis_cost_usd).toBeCloseTo(0.6 + PRICING.defaultAnalysisCostUsd);

    const { quote, next } = await createQuote({ requestId: req.id }, "pricing");
    expect(quote).toMatchObject({ auto_approved: true, status: "approved", price_usd: PRICING.minReportUsd });
    expect(next.to).toBe("analytics");
    const row = await getRequest(req.id);
    expect(row?.quote_id).toBe(quote.id);
    const [d] = await (await getDb()).query<{ kind: string }>("SELECT kind FROM decisions WHERE request_id = $1 AND kind = 'pricing'", [req.id]);
    expect(d.kind).toBe("pricing");

    const again = await createQuote({ requestId: req.id }, "pricing");
    expect(again.quote.id).toBe(quote.id); // a retried call doesn't create a second quote
  });

  it("holds large quotes for a founder and moves the request to awaiting_approval", async () => {
    const req = await plannedRequest({
      choice: "paid", data_cost_usd: 112.5, free_option: { provider_id: "pc-sentinel-2-l2a", before_scene: null, after_scene: null, sufficient: false, why: "10 m can't see roof damage" },
      paid_options: [{ provider_id: "sw-pneo-30cm", product: "archive 30 cm", resolution_m: 0.3, est_cost_usd: 112.5, min_order_km2: 5, delivery_time: null, license_terms: null, preview_available: true, why: "Sees individual roofs" }],
      justification: "Roof-level damage needs sub-metre imagery; Sentinel-2 at 10 m cannot resolve individual buildings.",
    });
    const { quote } = await createQuote({ requestId: req.id }, "pricing");
    expect(quote).toMatchObject({ auto_approved: false, status: "needs_approval" });
    expect((await getRequest(req.id))?.status).toBe("awaiting_approval");
  });

  it("routes an Earth-index answer straight to the interpreter (no pipeline run)", async () => {
    const req = await plannedRequest({ choice: "existing_index", free_option: null });
    const { next } = await createQuote({ requestId: req.id }, "pricing");
    expect(next).toMatchObject({ to: "interpreter", stage: "report" });
  });

  it("refuses free samples and requests without a plan", async () => {
    const sample = await createRequest({ question: "Free sample for a prospect", lat: 1, lon: 1, source: "signal", isFreeSample: true, priority: "background" });
    await expect(createQuote({ requestId: sample.id }, "pricing")).rejects.toThrow(/Free samples/);
    const bare = await createRequest({ question: "No plan yet here", source: "portal" });
    await expect(createQuote({ requestId: bare.id }, "pricing")).rejects.toThrow(/acquisition plan/);
  });
});

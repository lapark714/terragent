/**
 * send_quote end to end with the REAL templates (the other suites mock renderQuote): the customer's email must carry
 * every option, the recommended mark, the accept link, the validity and the paid-data rule, never the v1 single price.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sendEmail } from "../email/send";
import { logDecision } from "../events";
import { saveAcquisitionPlan } from "./acquisition";
import { sendQuote } from "./deliver";
import { createQuote, getQuote } from "./quotes";
import { createRequest, getRequest, mergeMeta } from "./requests";
import { saveDataSpec } from "./specs";
import { samplePlan, sampleSpec, SITE, setupMemoryDb } from "./testing";

vi.mock("../naive/sessions", () => ({ startAgentSession: vi.fn(async () => ({ session_id: `ses_${Math.random().toString(36).slice(2, 10)}` })) }));
vi.mock("../naive/board", () => ({ upsertCard: vi.fn(async () => ({ id: "crd_q" })) }));
vi.mock("../naive/spend", () => ({ sessionCostUsd: vi.fn(async () => 0.2) }));
vi.mock("../email/send", () => ({
  sendEmail: vi.fn(async () => ({ status: "sent", message_id: "msg_q1", thread_id: "thd_q1" })),
  replyInThread: vi.fn(async () => ({ status: "sent", message_id: "msg_q2", thread_id: "thd_q1" })),
}));
vi.mock("../email/threads", () => ({ getThread: vi.fn(async () => null) }));

const ROOF_PLAN: Parameters<typeof samplePlan>[1] = {
  choice: "paid", data_cost_usd: 225,
  free_option: { provider_id: "pc-sentinel-2-l2a", before_scene: null, after_scene: null, sufficient: false, why: "10 m can't see individual roofs" },
  paid_options: [{ provider_id: "sw-pneo-30cm", product: "archive 30 cm", resolution_m: 0.3, est_cost_usd: 225, min_order_km2: 5, delivery_time: null, license_terms: null, preview_available: true, why: "roofs" }],
  justification: "Roof-level damage needs sub-metre imagery; Sentinel-2 at 10 m cannot resolve individual buildings.",
};

beforeAll(async () => {
  await setupMemoryDb();
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PUBLIC_BASE_URL", "https://terragent.test");
});

async function quoted(plan: Parameters<typeof samplePlan>[1]) {
  const req = await createRequest({
    question: "Was the roof of our house damaged in the storm?", lat: SITE.lat, lon: SITE.lon, source: "portal", email: "pat@example.com", name: "Pat",
  });
  await mergeMeta(req.id, { screening: { allowed: true } });
  await saveDataSpec(sampleSpec(req.id, { min_resolution_m: 0.5 }), "planner");
  for (const kind of ["free_vs_paid", "source_selection"] as const) {
    await logDecision({ requestId: req.id, kind, choice: "compared", reasoning: "free vs sub-metre archive", agent: "acquisition" });
  }
  await saveAcquisitionPlan(samplePlan(req.id, plan), "acquisition");
  const res = await createQuote({ requestId: req.id }, "pricing");
  if ("error" in res) throw new Error(res.error);
  return { req, quote: (await getQuote(res.quote.id))! };
}

describe("send_quote (real templates)", () => {
  it("emails every option, the recommended one, the accept link, the validity and the paid-data rule", async () => {
    const { req, quote } = await quoted(ROOF_PLAN);
    expect(quote.options.length).toBeGreaterThanOrEqual(2);
    expect((await sendQuote(req.id, "comms-customer")).status).toBe("sent");

    const { text, html, to } = vi.mocked(sendEmail).mock.calls[0][0] as { text: string; html: string; to: string };
    expect(to).toBe("pat@example.com");
    expect(text).toContain("Option A");
    expect(text).toContain(`Option ${quote.recommended_option_id} (recommended)`);
    expect(text).toContain(`https://terragent.test/quote/${quote.accept_token}`);
    expect(text).toMatch(/valid until \d{1,2} [A-Z][a-z]{2} \d{4}/);
    expect(text).toContain("We buy paid imagery only after you accept an option that needs it.");
    expect(text).toContain("you receive derived results, not the raw images");
    expect(text).toContain(`reply "yes" for option ${quote.recommended_option_id}`);
    // Never the v1 single-price layout, and nothing internal.
    expect(text).not.toMatch(/Total: \$|We start as soon as you confirm|Satellite data \$/);
    expect(text).not.toMatch(/margin|sw-pneo-30cm|analysis_cost/);
    expect(text).toContain("written and sent by an AI agent"); // compliance footer kept
    expect(html).toContain(`/quote/${quote.accept_token}`);

    expect((await getQuote(quote.id))?.status).toBe("sent");
    expect((await getRequest(req.id))?.status).toBe("quoted");
  });

  it("refuses to send an expired quote", async () => {
    const { req, quote } = await quoted({});
    const { getDb } = await import("../db/client");
    await (await getDb()).query("UPDATE quotes SET valid_until = now() - interval '1 hour' WHERE id = $1", [quote.id]);
    await expect(sendQuote(req.id, "comms-customer")).rejects.toThrow(/expired before it was sent/);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

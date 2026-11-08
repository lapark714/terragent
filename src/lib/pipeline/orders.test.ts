import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../db/client";
import { sendEmail } from "../email/send";
import { logDecision, logIntervention } from "../events";
import { saveAcquisitionPlan } from "./acquisition";
import { approveOrder, getOrder, NAIVE_APPROVER, prepareOrder, requestSupplierQuote } from "./orders";
import { createRequest, getRequest } from "./requests";
import { saveDataSpec } from "./specs";
import { samplePlan, sampleSpec, SITE, setupMemoryDb } from "./testing";

vi.mock("../naive/sessions", () => ({ startAgentSession: vi.fn() }));
vi.mock("../naive/board", () => ({ upsertCard: vi.fn() }));
vi.mock("../email/send", () => ({
  sendEmail: vi.fn(async () => ({ status: "blocked", message_id: "msg_1", blocked_reason: "inbox data not armed" })),
  replyInThread: vi.fn(),
}));
vi.mock("../email/threads", () => ({ getThread: vi.fn(async () => null) }));
vi.mock("../email/templates", () => ({
  renderSupplierQuoteRequest: (a: { orderId: string }) => ({ subject: `Quote request ${a.orderId}`, text: "Please quote", html: "<p>Please quote</p>" }),
}));

const JUSTIFICATION = "Roof-level damage needs sub-metre imagery; Sentinel-2 at 10 m cannot resolve individual buildings.";

beforeAll(async () => {
  await setupMemoryDb();
});
beforeEach(() => vi.clearAllMocks());

async function paidRequest() {
  const req = await createRequest({ question: "Which roofs on our lot were damaged?", lat: SITE.lat, lon: SITE.lon, source: "portal" });
  await saveDataSpec(sampleSpec(req.id), "planner");
  for (const kind of ["free_vs_paid", "source_selection"] as const) {
    await logDecision({ requestId: req.id, kind, choice: "paid 30 cm", reasoning: "roofs need sub-metre", agent: "acquisition" });
  }
  await saveAcquisitionPlan(samplePlan(req.id, {
    choice: "paid", data_cost_usd: 112.5, justification: JUSTIFICATION,
    free_option: { provider_id: "pc-sentinel-2-l2a", before_scene: null, after_scene: null, sufficient: false, why: "too coarse" },
    paid_options: [{ provider_id: "sw-pneo-30cm", product: "archive 30 cm", resolution_m: 0.3, est_cost_usd: 112.5, min_order_km2: 5, delivery_time: null, license_terms: null, preview_available: true, why: "roofs" }],
  }), "acquisition");
  return req;
}

describe("paid orders", () => {
  it("are prepared in full and held at awaiting_approval", async () => {
    const req = await paidRequest();
    const out = await prepareOrder({ requestId: req.id, providerId: "sw-pneo-30cm", product: "archive 30 cm", areaKm2: 4, estCostUsd: 112.5, justification: JUSTIFICATION }, "acquisition");
    expect(out).toMatchObject({ status: "awaiting_approval", purchased: false });
    expect((await getOrder(out.order_id))?.status).toBe("awaiting_approval");
    expect((await getRequest(req.id))?.status).toBe("awaiting_approval");
  });

  it("place_paid_order (after a Naïve approval) records the founder and a decision, and never buys", async () => {
    const req = await paidRequest();
    const { order_id } = await prepareOrder({ requestId: req.id, providerId: "sw-pneo-30cm", product: "archive 30 cm", areaKm2: 4, estCostUsd: 112.5, justification: JUSTIFICATION }, "acquisition");
    const res = await approveOrder({ orderId: order_id, reason: "Customer paid" }, "acquisition");
    expect(res).toMatchObject({ status: "approved", purchased: false });
    expect(res.instruction).toMatch(/founder places this order by hand/);
    expect(await getOrder(order_id)).toMatchObject({ status: "approved", approved_by: NAIVE_APPROVER });

    const db = await getDb();
    const [iv] = await db.query<{ actor: string; action: string; ref_id: string }>("SELECT actor, action, ref_id FROM interventions WHERE request_id = $1", [req.id]);
    expect(iv).toEqual({ actor: NAIVE_APPROVER, action: "approve_order", ref_id: order_id });
    const decisions = await db.query<{ kind: string; choice: string }>("SELECT kind, choice FROM decisions WHERE request_id = $1 AND choice LIKE 'paid order%'", [req.id]);
    expect(decisions).toHaveLength(1);
    expect(sendEmail).not.toHaveBeenCalled();

    // Idempotent: a retried call does not log a second intervention.
    await approveOrder({ orderId: order_id }, "acquisition");
    expect(await db.query("SELECT 1 FROM interventions WHERE ref_id = $1", [order_id])).toHaveLength(1);
  });

  it("an allow from the dashboard is counted once: the order links the dashboard's intervention instead of adding one", async () => {
    const req = await paidRequest();
    const { order_id } = await prepareOrder({ requestId: req.id, providerId: "sw-pneo-30cm", product: "archive 30 cm", areaKm2: 4, estCostUsd: 112.5, justification: JUSTIFICATION }, "acquisition");
    // What src/lib/dashboard/admin.ts logs when a founder allows the paused call.
    await logIntervention({ actor: "Laurence", action: "naive_allow", reason: "Customer paid", refId: "tcl_123" });
    await approveOrder({ orderId: order_id }, "acquisition");
    const rows = await (await getDb()).query<{ action: string; ref_id: string }>("SELECT action, ref_id FROM interventions WHERE request_id = $1", [req.id]);
    expect(rows).toEqual([{ action: "naive_allow", ref_id: "tcl_123" }]);
  });

  it("refuses free samples, free providers and thin justifications", async () => {
    const req = await paidRequest();
    await expect(prepareOrder({ requestId: req.id, providerId: "pc-sentinel-2-l2a", product: "x", areaKm2: 4, estCostUsd: 0, justification: JUSTIFICATION }, "acquisition")).rejects.toThrow(/free data/);
    await expect(prepareOrder({ requestId: req.id, providerId: "sw-pneo-30cm", product: "x", areaKm2: 4, estCostUsd: 1, justification: "need it" }, "acquisition")).rejects.toThrow(/why free data/);
    const sample = await createRequest({ question: "Free sample request here", source: "signal", isFreeSample: true, priority: "background" });
    await expect(prepareOrder({ requestId: sample.id, providerId: "sw-pneo-30cm", product: "x", areaKm2: 4, estCostUsd: 1, justification: JUSTIFICATION }, "acquisition")).rejects.toThrow(/Free samples/);
  });
});

describe("supplier quote requests", () => {
  it("email the provider from data@ in a new order thread (blocked until the inbox is armed)", async () => {
    const req = await paidRequest();
    const res = await requestSupplierQuote({ requestId: req.id, providerId: "arlula-archive", product: "archive 50 cm", reason: "Compare against SkyWatch list prices" }, "acquisition");
    expect(res.status).toBe("blocked");
    const args = vi.mocked(sendEmail).mock.calls[0][0];
    expect(args).toMatchObject({ inbox: "data", to: "hello@arlula.com", kind: "supplier_quote", orderId: res.order_id, idempotencyKey: `supplier_quote:${res.order_id}` });
    expect(await getOrder(res.order_id!)).toMatchObject({ status: "quote_requested", provider_id: "arlula-archive" });
  });

  it("a retried request reuses the open order, so the supplier is emailed once", async () => {
    const req = await paidRequest();
    const args = { requestId: req.id, providerId: "arlula-archive", product: "archive 50 cm", reason: "Compare against SkyWatch list prices" };
    const first = await requestSupplierQuote(args, "acquisition");
    const retry = await requestSupplierQuote(args, "acquisition");
    expect(retry.order_id).toBe(first.order_id);
    const keys = vi.mocked(sendEmail).mock.calls.map((c) => c[0].idempotencyKey);
    expect(new Set(keys)).toEqual(new Set([`supplier_quote:${first.order_id}`]));
    expect(await (await getDb()).query("SELECT 1 FROM orders WHERE request_id = $1", [req.id])).toHaveLength(1);
  });

  it("free samples never ask suppliers for quotes", async () => {
    const sample = await createRequest({ question: "Free sample: burn at the depot", lat: SITE.lat, lon: SITE.lon, source: "signal", isFreeSample: true, priority: "background" });
    await saveDataSpec(sampleSpec(sample.id), "planner");
    await expect(requestSupplierQuote({ requestId: sample.id, providerId: "arlula-archive", product: "archive", reason: "Would sharper data help here?" }, "acquisition")).rejects.toThrow(/Free samples/);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("skips providers that only take web-form quotes", async () => {
    const req = await paidRequest();
    const res = await requestSupplierQuote({ requestId: req.id, providerId: "up42-pleiades-neo", product: "archive 30 cm", reason: "Second price for comparison" }, "acquisition");
    expect(res).toMatchObject({ status: "no_email_contact", contact: "https://up42.com/contact-us/sales" });
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

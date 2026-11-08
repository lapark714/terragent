import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../db/client";
import { sendEmail } from "../email/send";
import { logDecision, logIntervention } from "../events";
import { saveAcquisitionPlan } from "./acquisition";
import { upsertCard } from "../naive/board";
import { newId } from "../ids";
import {
  approveOrder, getOrder, markOrderDelivered, NAIVE_APPROVER, prepareOrder, recordSupplierQuote, requestSupplierQuote, sendSupplierEmail,
} from "./orders";
import { createRequest, getRequest, mergeMeta } from "./requests";
import { saveDataSpec } from "./specs";
import { samplePlan, sampleSpec, SITE, setupMemoryDb } from "./testing";

vi.mock("../naive/sessions", () => ({ startAgentSession: vi.fn() }));
vi.mock("../naive/board", () => ({ upsertCard: vi.fn() }));
vi.mock("../email/send", () => ({
  sendEmail: vi.fn(async () => ({ status: "blocked", message_id: "msg_1", blocked_reason: "inbox data not armed" })),
  replyInThread: vi.fn(async () => ({ status: "sent", message_id: "msg_r", thread_id: "thr-sup" })),
}));
vi.mock("../email/threads", () => ({
  getThread: vi.fn(async (id: string) => (id === "thr-sup" ? { thread_id: id, inbox: "data", messages: [{ direction: "inbound", agentmail_message_id: "<s1@up>" }] } : null)),
}));
vi.mock("../email/templates", () => ({
  renderSupplierQuoteRequest: (a: { orderId: string }) => ({ subject: `Quote request ${a.orderId}`, text: "Please quote", html: "<p>Please quote</p>" }),
}));

const JUSTIFICATION = "Roof-level damage needs sub-metre imagery; Sentinel-2 at 10 m cannot resolve individual buildings.";

beforeAll(async () => {
  await setupMemoryDb();
});
beforeEach(() => vi.clearAllMocks());

const OPTION_B = {
  option_id: "B", label: "Sharper: 30 cm archive imagery", answers: "Roof-level damage at 30 cm resolution.", kind: "archive",
  data: [{ provider_id: "sw-pneo-30cm", product: "archive 30 cm", data_type: "optical", resolution_m: 0.3, epochs: 2, area_km2: 4, billable_km2: 5,
    unit_price_usd: 22.5, data_cost_usd: 225, data_cost_range_usd: null, needs_supplier_quote: false }],
  analysis_cost_usd: 1.5, risk_buffer_usd: 0, margin_usd: 600, price_usd: 830, price_range_usd: null, delivery_time: "2–5 business days",
  confidence: "high", notes: [],
};

/** The request's quote: option B (30 cm) recommended; accepted unless `accepted` is false. */
async function quoteFor(requestId: string, accepted = true) {
  const id = newId("quote");
  await (await getDb()).query(
    `INSERT INTO quotes (id, request_id, price_usd, status, options, recommended_option_id, accepted_option_id, accepted_at, accept_token, valid_until)
     VALUES ($1, $2, 830, $3, $4, 'B', $5, $6, $7, now() + interval '7 days')`,
    [id, requestId, accepted ? "accepted" : "sent", JSON.stringify([OPTION_B]), accepted ? "B" : null, accepted ? new Date().toISOString() : null, `tok${id.slice(4)}AAAAAAAAAAAAAAAA`],
  );
  await (await getDb()).query("UPDATE requests SET quote_id = $2 WHERE id = $1", [requestId, id]);
  return id;
}

async function paidRequest(o: { accepted?: boolean } = {}) {
  const req = await createRequest({ question: "Which roofs on our lot were damaged?", lat: SITE.lat, lon: SITE.lon, source: "portal" });
  await mergeMeta(req.id, { screening: { allowed: true } });
  await saveDataSpec(sampleSpec(req.id), "planner");
  for (const kind of ["free_vs_paid", "source_selection"] as const) {
    await logDecision({ requestId: req.id, kind, choice: "paid 30 cm", reasoning: "roofs need sub-metre", agent: "acquisition" });
  }
  await saveAcquisitionPlan(samplePlan(req.id, {
    choice: "paid", data_cost_usd: 112.5, justification: JUSTIFICATION,
    free_option: { provider_id: "pc-sentinel-2-l2a", before_scene: null, after_scene: null, sufficient: false, why: "too coarse" },
    paid_options: [{ provider_id: "sw-pneo-30cm", product: "archive 30 cm", resolution_m: 0.3, est_cost_usd: 112.5, min_order_km2: 5, delivery_time: null, license_terms: null, preview_available: true, why: "roofs" }],
  }), "acquisition");
  if (o.accepted !== false) await quoteFor(req.id);
  return req;
}

const pneo = (requestId: string) =>
  ({ requestId, providerId: "sw-pneo-30cm", product: "archive 30 cm", areaKm2: 4, estCostUsd: 112.5, justification: JUSTIFICATION });

describe("paid orders wait for the customer's accepted option (pricing v2)", () => {
  it("prepare_paid_order is refused before acceptance, and for a provider the accepted option doesn't buy from", async () => {
    const none = await paidRequest({ accepted: false });
    await expect(prepareOrder(pneo(none.id), "acquisition")).rejects.toThrow(/no accepted quote yet/);
    await quoteFor(none.id, false); // quoted and sent, not accepted
    await expect(prepareOrder(pneo(none.id), "acquisition")).rejects.toThrow(/only after the customer accepts/);
    expect(await (await getDb()).query("SELECT 1 FROM orders WHERE request_id = $1", [none.id])).toEqual([]);
    expect((await getRequest(none.id))?.status).not.toBe("awaiting_approval");

    const accepted = await paidRequest();
    await expect(prepareOrder({ ...pneo(accepted.id), providerId: "arlula-archive" }, "acquisition")).rejects.toThrow(/buys nothing from arlula-archive/);
    expect(await prepareOrder(pneo(accepted.id), "acquisition")).toMatchObject({ status: "awaiting_approval" });
  });

  it("place_paid_order refuses an order whose request has no accepted option (e.g. a re-quote after it was held)", async () => {
    const req = await paidRequest();
    const { order_id } = await prepareOrder(pneo(req.id), "acquisition");
    await quoteFor(req.id, false); // the customer asked for changes: a new, unaccepted quote
    await expect(approveOrder({ orderId: order_id }, "acquisition")).rejects.toThrow(/no accepted quote yet/);
    expect((await getOrder(order_id))?.status).toBe("awaiting_approval");
  });

  it("marking the data delivered starts the analysis once no other paid order waits", async () => {
    vi.stubEnv("TERRAGENT_LANES", "off");
    try {
      const req = await paidRequest();
      const first = await prepareOrder(pneo(req.id), "acquisition");
      const second = await prepareOrder(pneo(req.id), "acquisition");
      const one = await markOrderDelivered({ orderId: first.order_id, founder: "Laurence", fileIds: ["fil_pneo1", "not-a-file"], note: "Pléiades Neo pass from 5 Nov, 2 GeoTIFFs" });
      expect(one).toMatchObject({ analysis_started: false, waiting_for: [second.order_id] });
      expect((await getOrder(first.order_id))?.meta).toMatchObject({ delivered: { by: "Laurence", file_ids: ["fil_pneo1"] } });
      expect((await getRequest(req.id))?.owner_agent).not.toBe("analytics");

      expect(await markOrderDelivered({ orderId: second.order_id, founder: "Laurence" })).toMatchObject({ analysis_started: true });
      expect(await getRequest(req.id)).toMatchObject({ owner_agent: "analytics", status: "analyzing", stage: "analysis" });
      expect(await markOrderDelivered({ orderId: second.order_id, founder: "Laurence" })).toMatchObject({ already: true });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

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

describe("supplier replies (the order's board card)", () => {
  const CARD = { key: "order:%", title: "Supplier reply on order %", body: "New email from sales@arlula.com …" };

  /** An order whose supplier replied: email/inbound.ts opened a card for comms-suppliers and kept its ref on the order. */
  async function repliedOrder(status = "acquiring") {
    const req = await paidRequest();
    const q = await requestSupplierQuote({ requestId: req.id, providerId: "arlula-archive", product: "archive 50 cm", reason: "Compare against SkyWatch list prices" }, "acquisition");
    const card = { key: CARD.key.replace("%", q.order_id!), title: CARD.title.replace("%", q.order_id!), body: CARD.body, id: "crd_sup" };
    await (await getDb()).query("UPDATE orders SET quote_thread_id = 'thr-sup', meta = meta || $2::jsonb WHERE id = $1", [q.order_id, JSON.stringify({ card })]);
    await (await getDb()).query("UPDATE requests SET status = $2 WHERE id = $1", [req.id, status]);
    vi.clearAllMocks();
    return { req, orderId: q.order_id!, card };
  }

  it("record_supplier_quote closes the card (same title and body) and says to hand off while the request is open", async () => {
    const { orderId, card } = await repliedOrder();
    const res = await recordSupplierQuote({ orderId, quotedAmount: 76, currency: "usd", deliveryTime: "24 h" }, "comms-suppliers");
    expect(vi.mocked(upsertCard)).toHaveBeenCalledWith({
      key: card.key, title: card.title, body: card.body, assignee: "comms-suppliers", status: "done", note: "Quote recorded: 76 USD, delivery 24 h.",
    });
    expect(res).toMatchObject({ request_status: "acquiring", next: expect.stringMatching(/handoff to acquisition/) });
  });

  it("on a finished request it says to add a note instead of handing off", async () => {
    const { orderId } = await repliedOrder("delivered");
    const res = await recordSupplierQuote({ orderId, quotedAmount: 90, currency: "EUR" }, "comms-suppliers");
    expect(res).toMatchObject({ request_status: "delivered", next: expect.stringMatching(/can't be handed off: terragent.add_note/) });
    expect(vi.mocked(upsertCard)).toHaveBeenCalledWith(expect.objectContaining({ status: "done" }));
  });

  it("a sent follow-up question closes the card too; a board failure never fails the tool", async () => {
    const { orderId, req } = await repliedOrder();
    vi.mocked(upsertCard).mockRejectedValueOnce(new Error("board down"));
    const res = await sendSupplierEmail({ orderId, text: "Could you confirm the minimum order area?" }, "comms-suppliers");
    expect(res.status).toBe("sent");
    expect(vi.mocked(upsertCard)).toHaveBeenCalledWith(expect.objectContaining({ status: "done", note: expect.stringMatching(/Follow-up sent/) }));
    const [evt] = await (await getDb()).query<{ payload: { order_id: string } }>("SELECT payload FROM events WHERE request_id = $1 AND type = 'board.sync_failed'", [req.id]);
    expect(evt.payload.order_id).toBe(orderId);
  });

  it("an order without a reply card touches no card", async () => {
    const req = await paidRequest();
    const q = await requestSupplierQuote({ requestId: req.id, providerId: "arlula-archive", product: "archive 50 cm", reason: "Compare against SkyWatch list prices" }, "acquisition");
    await recordSupplierQuote({ orderId: q.order_id!, quotedAmount: 50, currency: "USD" }, "comms-suppliers");
    expect(vi.mocked(upsertCard)).not.toHaveBeenCalled();
  });
});

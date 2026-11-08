/** Core tool groups exercised through runTool(), the same path the MCP server uses. */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../../db/client";
import { sendEmail } from "../../email/send";
import { logDecision } from "../../events";
import { saveAcquisitionPlan } from "../../pipeline/acquisition";
import { saveAnalysis } from "../../pipeline/analyses";
import { createRequest, getRequest, mergeMeta } from "../../pipeline/requests";
import { saveDataSpec } from "../../pipeline/specs";
import { SAMPLE_FILE_IDS, sampleAnalysis, samplePlan, sampleSpec, setupMemoryDb, SITE } from "../../pipeline/testing";
import type { AgentName } from "../../domain";
import { runTool } from "../server";

vi.mock("../../naive/sessions", () => ({ startAgentSession: vi.fn(async () => ({ session_id: "ses_t" })) }));
vi.mock("../../naive/board", () => ({ upsertCard: vi.fn(async () => ({ id: "crd_t" })) }));
vi.mock("../../naive/spend", () => ({ sessionCostUsd: vi.fn(async () => 0.1) }));
vi.mock("../../email/send", () => ({
  sendEmail: vi.fn(async () => ({ status: "sent", message_id: "msg_1", thread_id: "thd_1" })),
  replyInThread: vi.fn(async () => ({ status: "sent", message_id: "msg_2", thread_id: "thd_1" })),
}));
vi.mock("../../email/threads", () => ({ getThread: vi.fn(async () => ({ thread_id: "thd_1", inbox: "hello", messages: [] })) }));
vi.mock("../../email/templates", () => {
  const e = (subject: string) => () => ({ subject, text: subject, html: `<p>${subject}</p>` });
  return { renderClarifyingQuestion: e("question"), renderRefusal: e("refusal"), renderQuote: e("quote"), renderReportDelivery: e("report"), renderSupplierQuoteRequest: e("supplier") };
});

const call = (agent: AgentName, tool: string, args: Record<string, unknown>) => runTool(tool, args, { agent }) as Promise<Record<string, unknown>>;

beforeAll(async () => {
  await setupMemoryDb();
});
beforeEach(() => vi.clearAllMocks());

async function quotedRequest() {
  const req = await createRequest({ question: "Is the vineyard greener than last year?", lat: SITE.lat, lon: SITE.lon, source: "portal", email: "c@example.com", name: "Cam" });
  await mergeMeta(req.id, { screening: { allowed: true } });
  await saveDataSpec(sampleSpec(req.id), "planner");
  for (const kind of ["free_vs_paid", "source_selection"] as const) await logDecision({ requestId: req.id, kind, choice: "free", reasoning: "enough", agent: "acquisition" });
  await saveAcquisitionPlan(samplePlan(req.id), "acquisition");
  await call("pricing", "create_quote", { request_id: req.id });
  return req;
}

describe("customer tools", () => {
  it("asks a clarifying question from hello@ and parks the request", async () => {
    const req = await createRequest({ question: "Check my land please", source: "portal", email: "c@example.com" });
    const res = await call("comms-customer", "send_customer_message", { request_id: req.id, kind: "clarifying_question", text: "Which address should we look at?" });
    expect(res.status).toBe("sent");
    expect(vi.mocked(sendEmail).mock.calls[0][0]).toMatchObject({ inbox: "hello", to: "c@example.com", kind: "customer", requestId: req.id });
    expect(await getRequest(req.id)).toMatchObject({ status: "clarifying", thread_id: "thd_1" });
  });

  it("only sends a refusal once screening refused the request", async () => {
    const req = await createRequest({ question: "Watch my neighbour's yard", source: "portal", email: "c@example.com" });
    expect((await call("comms-customer", "send_customer_message", { request_id: req.id, kind: "refusal", text: "We don't watch people." })).error).toMatch(/record_screening/);
    await call("comms-customer", "record_screening", { request_id: req.id, allowed: false, category: "individual_surveillance", reason: "Watching a person" });
    expect((await call("comms-customer", "send_customer_message", { request_id: req.id, kind: "refusal", text: "We don't watch people." })).status).toBe("sent");
  });

  it("sends an approved quote and moves the request to quoted", async () => {
    const req = await quotedRequest();
    await (await getDb()).query("UPDATE requests SET status = 'pricing' WHERE id = $1", [req.id]);
    expect((await call("comms-customer", "send_quote", { request_id: req.id })).status).toBe("sent");
    const row = await getRequest(req.id);
    expect(row?.status).toBe("quoted");
    const [q] = await (await getDb()).query<{ status: string }>("SELECT status FROM quotes WHERE id = $1", [row!.quote_id]);
    expect(q.status).toBe("sent");
  });

  it("creates a 12-hourly monitor with the recipe's change threshold and the current baseline, not yet checked", async () => {
    const req = await quotedRequest();
    await saveAnalysis({ requestId: req.id, result: sampleAnalysis(), fileIds: SAMPLE_FILE_IDS }, "analytics");
    const res = await call("comms-customer", "create_monitor", { request_id: req.id, metric: "dnbr_mean" });
    expect(res).toMatchObject({ recipe: "burn_severity", threshold: 0.27, cadence: "0 */12 * * *" });
    const [m] = await (await getDb()).query<{ last_value: number; last_scene_date: Date; last_checked_at: Date | null }>(
      "SELECT last_value, last_scene_date, last_checked_at FROM monitors WHERE id = $1", [res.monitor_id]);
    expect(m.last_value).toBeCloseTo(0.174);
    expect(m.last_checked_at).toBeNull();
    expect((await getRequest(req.id))?.monitor_id).toBe(res.monitor_id);
  });
});

describe("stated willingness to pay (add_note)", () => {
  it("comms-customer records what a customer said they'd pay, once per request; other agents can't", async () => {
    const req = await createRequest({ question: "Can you watch our quarry every month?", source: "email", email: "q@example.com" });
    const rows = () => getDb().then((db) => db.query<{ kind: string; amount_usd: string; note: string }>(
      "SELECT kind, amount_usd, note FROM revenue WHERE request_id = $1", [req.id]));

    const res = await call("comms-customer", "add_note", { request_id: req.id, note: "Customer: 'we'd pay $150 a month for this'", stated_willingness_usd: 150 });
    expect(res).toMatchObject({ ok: true, stated_willingness_usd: 150, replaced: false });
    await call("comms-customer", "add_note", { request_id: req.id, note: "Customer raised it: '$200 a month is fine'", stated_willingness_usd: 200 });
    expect(await rows()).toEqual([{ kind: "stated_willingness", amount_usd: "200.00", note: "Customer raised it: '$200 a month is fine'" }]);

    expect((await call("planner", "add_note", { request_id: req.id, note: "they'd pay a lot", stated_willingness_usd: 999 })).error).toMatch(/Only comms-customer/);
    expect(await call("planner", "add_note", { request_id: req.id, note: "plain note" })).toEqual({ ok: true });
    expect(await rows()).toHaveLength(1);
  });
});

describe("acquisition and supplier tools", () => {
  it("lists providers with currency, free first", async () => {
    const res = (await call("acquisition", "list_providers", { data_type: "optical" })) as { providers: { id: string; is_free: boolean; currency: string }[] };
    expect(res.providers[0].is_free).toBe(true);
    expect(res.providers.find((p) => p.id === "up42-pleiades-neo")?.currency).toBe("EUR");
    const sharp = (await call("acquisition", "list_providers", { max_resolution_m: 0.5 })) as { providers: { id: string }[] };
    expect(sharp.providers.map((p) => p.id)).not.toContain("pc-sentinel-2-l2a");
  });

  it("records a supplier's quote on the order and shows it in get_order", async () => {
    const req = await quotedRequest();
    const q = await call("acquisition", "request_supplier_quote", { request_id: req.id, provider_id: "arlula-archive", product: "archive 30 cm", reason: "Real price for the roof-level upsell" });
    expect(q.status).toBe("sent");
    await call("comms-suppliers", "record_supplier_quote", { order_id: q.order_id, quoted_amount: 76, currency: "USD", delivery_time: "24 h" });
    const view = (await call("comms-suppliers", "get_order", { order_id: q.order_id })) as { order: { supplier_quote_usd: number; quote_thread_id: string; status: string } };
    expect(view.order).toMatchObject({ supplier_quote_usd: 76, quote_thread_id: "thd_1", status: "quote_requested" });
  });
});

describe("status changes", () => {
  it("finishing statuses only come from their own tools or the coordinator", async () => {
    const req = await quotedRequest();
    expect((await call("planner", "set_status", { request_id: req.id, status: "delivered" })).error).toMatch(/deliver_report/);
    expect((await call("comms-customer", "set_status", { request_id: req.id, status: "refused" })).error).toMatch(/record_screening/);
    expect((await call("analytics", "set_status", { request_id: req.id, status: "failed" })).error).toMatch(/coordinator/);
    const handoff = await call("planner", "handoff", { request_id: req.id, to: "acquisition", stage: "acquisition", instructions: "Close it", status: "refused" });
    expect(handoff.error).toMatch(/can't finish a request/);
    expect((await getRequest(req.id))?.status).not.toBe("refused");

    expect(await call("comms-customer", "set_status", { request_id: req.id, status: "cancelled", note: "Customer withdrew" })).toMatchObject({ status: "cancelled" });
    expect((await getRequest(req.id))?.status).toBe("cancelled");
  });

  it("comms-outreach can close a free sample it decides not to contact", async () => {
    const req = await quotedRequest();
    expect(await call("comms-outreach", "set_status", { request_id: req.id, status: "cancelled", note: "Imagery shows nothing relevant to this business" })).toMatchObject({ status: "cancelled" });
    expect((await call("comms-outreach", "set_status", { request_id: req.id, status: "failed" })).error).toMatch(/coordinator/);
  });
});

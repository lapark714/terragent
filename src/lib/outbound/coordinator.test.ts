import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CAPS, DEFAULT_ALLOCATION } from "../config";
import type { Db } from "../db/client";
import { getSetting, SETTING } from "../settings";
import { getAllocation, setPlaybookAllocation, validateAllocation } from "./allocation";
import { emptyFunnel, getMetrics, suggestAllocation } from "./metrics";
import { getSpendOverview } from "./spend-overview";
import { listStuckRequests } from "./stuck";
import { freshDb, insert, reset, seedProspect, seedReport, seedRequest, seedSignal } from "./testing";

const getSpendSummary = vi.hoisted(() => vi.fn());
vi.mock("../naive/spend", () => ({ getSpendSummary }));

let db: Db;
beforeAll(async () => {
  db = await freshDb();
});
beforeEach(async () => {
  await reset(db);
  getSpendSummary.mockReset();
  getSpendSummary.mockResolvedValue({ total_usd: 12.5, by_agent: { sourcing: 2, planner: 1.5, "agt_unknown": 0.25 }, balance_usd: 238 });
});

/** Disasters: 3 signals (2 matched), 4 prospects, 2 verified samples of 3, 3 first touches, 2 replies (one quoted), $49 paid. */
async function seedFunnel() {
  const sig = await seedSignal(db, { status: "matched" });
  await seedSignal(db, { status: "matched" });
  await seedSignal(db);
  await seedSignal(db, { playbook: "mining" });

  const p = [
    await seedProspect(db, { signal_id: sig, status: "emailed", message_version: "v1" }),
    await seedProspect(db, { signal_id: sig, status: "replied", message_version: "v1" }),
    await seedProspect(db, { signal_id: sig, status: "quoted", message_version: "v2" }),
    await seedProspect(db, { signal_id: sig, status: "matched" }),
  ];
  const samples = [await seedRequest(db, { prospect_id: p[0], cost_usd: 1.2 }), await seedRequest(db, { prospect_id: p[1] }), await seedRequest(db, { prospect_id: p[2] })];
  await seedReport(db, samples[0]);
  await seedReport(db, samples[1]);
  await seedReport(db, samples[2], { verifier_status: "fail" });
  // Spend rows: core mirrors session costs here; requests.cost_usd may already hold the same total (max, not sum).
  await insert(db, "spend", { service: "naive", request_id: samples[0], amount_usd: 1.0 });
  await insert(db, "spend", { service: "naive", request_id: samples[1], amount_usd: 0.75 });
  await insert(db, "spend", { service: "monid", request_id: samples[1], amount_usd: 0.05 });
  await insert(db, "spend", { service: "monid", agent: "sourcing", amount_usd: 0.1 });

  for (const [i, channel] of [[0, "contact_form"], [1, "email_warm"], [2, "email_warm"]] as const) {
    await insert(db, "messages", { id: `msg_f${i}`, direction: "outbound", inbox: "outreach", prospect_id: p[i], kind: "outreach", channel, status: "sent" });
  }
  await insert(db, "messages", { id: "msg_blocked", direction: "outbound", inbox: "outreach", prospect_id: p[3], kind: "outreach", channel: "email_direct", status: "blocked" });
  await insert(db, "messages", { id: "msg_reply", direction: "inbound", inbox: "hello", prospect_id: p[1], counterpart_email: "x@y.com", status: "received" });

  const reply = await seedRequest(db, { source: "email", is_free_sample: false, prospect_id: p[2], priority: "inbound" });
  await insert(db, "quotes", { id: "qte_1", request_id: reply, price_usd: 49 });
  await insert(db, "revenue", { quote_id: "qte_1", amount_usd: 49, kind: "paid" });

  const inbound = await seedRequest(db, { source: "portal", playbook: "inbound", is_free_sample: false, priority: "inbound", status: "delivered" });
  await insert(db, "quotes", { id: "qte_2", request_id: inbound, price_usd: 29 });
  await insert(db, "revenue", { request_id: inbound, amount_usd: 29, kind: "committed" });
  await insert(db, "revenue", { request_id: inbound, amount_usd: 100, kind: "stated_willingness" });
}

describe("getMetrics", () => {
  it("computes the funnel, reply rate, cost per verified report and value per playbook", async () => {
    await seedFunnel();
    const m = await getMetrics();
    expect(m.by_playbook.disasters).toEqual({
      signals: 3, signals_matched: 2, prospects: 4, samples_started: 3, free_reports_verified: 2,
      first_touches: 3, blocked_by_provider: 0, touches_by_channel: { contact_form: 1, email_warm: 2 }, replies: 2, quotes: 1,
      by_signal_feed: { nws: { touches: 3, replies: 2 } },
      by_message_version: { v1: { touches: 2, replies: 1 }, v2: { touches: 1, replies: 1 } },
      revenue_paid_usd: 49, revenue_committed_usd: 0, stated_willingness_usd: 0,
      // max(1.2, 1.0) + (0.75 + 0.05) + 0 = 2.00 over 2 verified reports
      cost_usd: 2, reply_rate: 0.667, cost_per_report_usd: 1, value_usd: 49,
    });
    expect(m.by_playbook.mining.signals).toBe(1);
    expect(m.inbound).toEqual({ requests: 1, delivered: 1, refused: 0, quotes: 1, value_usd: 29 });
    // Naïve ledger 12.5 + non-Naïve spend rows 0.15
    expect(m.overall).toEqual({
      spend_usd: 12.65, revenue_paid_usd: 49, revenue_committed_usd: 29, stated_willingness_usd: 100, value_usd: 78, margin_usd: 65.35,
      blocked_by_provider: 0, blocked_by_provider_reasons: {},
    });
    expect(m.allocation.source).toBe("default");
    expect(Object.values(m.suggested_allocation).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(m.warnings).toEqual([]);
  });

  it("falls back to spend rows when the Naïve ledger is unreachable", async () => {
    await seedFunnel();
    getSpendSummary.mockRejectedValue(new Error("no key"));
    const m = await getMetrics();
    expect(m.overall.spend_usd).toBe(1.9);
    expect(m.warnings).toEqual(["Naïve spend unavailable: no key"]);
  });
});

describe("suggestAllocation", () => {
  it("favours better reply rates and keeps a 10% floor", () => {
    const f = (over: object) => ({ ...emptyFunnel(), ...over });
    const w = suggestAllocation({ disasters: f({ first_touches: 20, replies: 6, cost_per_report_usd: 1 }), deforestation: f({ first_touches: 20, replies: 0, cost_per_report_usd: 1 }), mining: f({}) });
    expect(w.disasters).toBeGreaterThan(w.mining);
    expect(w.mining).toBeGreaterThan(w.deforestation);
    expect(w.deforestation).toBeGreaterThanOrEqual(0.1);
    expect(w.disasters + w.deforestation + w.mining).toBeCloseTo(1, 6);
  });
});

describe("playbook allocation", () => {
  it("validates weights: sum to 1, no inbound, no duplicates", () => {
    const v = (allocations: { playbook: string; weight: number }[]) => () => validateAllocation({ allocations, reason: "r", metrics: {} });
    expect(v([{ playbook: "disasters", weight: 0.6 }, { playbook: "mining", weight: 0.3 }])).toThrow(/sum to 1 \(got 0\.9000\)/);
    expect(v([{ playbook: "disasters", weight: 0.9995 }])()).toMatchObject({ weights: { disasters: 0.9995, deforestation: 0, mining: 0 } });
    expect(v([{ playbook: "inbound", weight: 1 }])).toThrow(/inbound is not allocated/);
    expect(v([{ playbook: "mining", weight: 0.5 }, { playbook: "mining", weight: 0.5 }])).toThrow(/listed twice/);
    expect(v([{ playbook: "disasters", weight: 1.5 }])).toThrow(/invalid allocation/);
  });

  it("records rows, the settings snapshot and a decision with the metrics; get returns the latest", async () => {
    expect(await getAllocation()).toMatchObject({ weights: DEFAULT_ALLOCATION, source: "default" });
    const res = await setPlaybookAllocation({
      input: { allocations: [{ playbook: "disasters", weight: 0.6 }, { playbook: "deforestation", weight: 0.25 }, { playbook: "mining", weight: 0.15 }], reason: "disasters reply rate 30% vs 0%", metrics: { reply_rate: { disasters: 0.3 } } },
      measured: { by_playbook: { disasters: { replies: 6 } } },
      actor: "coordinator",
    });
    expect(res.previous).toEqual(DEFAULT_ALLOCATION);
    expect(await getAllocation()).toMatchObject({ weights: { disasters: 0.6, deforestation: 0.25, mining: 0.15 }, source: "coordinator", reason: "disasters reply rate 30% vs 0%", decided_by: "coordinator" });
    expect(await getSetting(SETTING.allocation, null)).toEqual({ disasters: 0.6, deforestation: 0.25, mining: 0.15 });

    const [d] = await db.query<{ kind: string; choice: string; reasoning: string; agent: string }>("SELECT kind, choice, reasoning, agent FROM decisions");
    expect(d).toMatchObject({ kind: "playbook_allocation", choice: "disasters 0.60, deforestation 0.25, mining 0.15", agent: "coordinator" });
    expect(d.reasoning).toContain('"measured":{"by_playbook":{"disasters":{"replies":6}}}');
    expect(d.reasoning).toContain('"cited":{"reply_rate":{"disasters":0.3}}');
    const [{ n }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM playbook_allocations");
    expect(n).toBe(3);
  });
});

describe("listStuckRequests", () => {
  it("lists stale, failed, approval-held and customer-waiting requests, never finished or fresh ones", async () => {
    const old = new Date(Date.now() - 3 * 3_600_000);
    await seedRequest(db, { id: "req_stale", status: "analyzing", updated_at: old });
    await seedRequest(db, { id: "req_fresh", status: "analyzing" });
    await seedRequest(db, { id: "req_failed", status: "failed" });
    await seedRequest(db, { id: "req_held", status: "awaiting_approval" });
    await seedRequest(db, { id: "req_quoted", status: "quoted", updated_at: old });
    await seedRequest(db, { id: "req_done", status: "delivered", updated_at: old });
    const rows = await listStuckRequests({ staleMinutes: 60 });
    expect(Object.fromEntries(rows.map((r) => [r.id, r.reason]))).toEqual({
      req_stale: "stale", req_quoted: "waiting_on_customer", req_failed: "failed", req_held: "awaiting_approval",
    });
    expect(rows.find((r) => r.id === "req_stale")?.minutes_since_update).toBeGreaterThanOrEqual(179);
  });

  it("drops failures older than a day and lists what the coordinator can act on first", async () => {
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
    await seedRequest(db, { id: "req_failed_old", status: "failed", updated_at: hoursAgo(30) });
    await seedRequest(db, { id: "req_failed_new", status: "failed", updated_at: hoursAgo(2) });
    await seedRequest(db, { id: "req_stale_old", status: "planning", updated_at: hoursAgo(48) });
    await seedRequest(db, { id: "req_stale_new", status: "analyzing", updated_at: hoursAgo(3) });
    expect((await listStuckRequests()).map((r) => r.id)).toEqual(["req_stale_old", "req_stale_new", "req_failed_new"]);
    expect((await listStuckRequests({ failedWithinHours: 48 })).map((r) => r.id)).toContain("req_failed_old");
    // The limit keeps the actionable ones, not the failures.
    expect((await listStuckRequests({ limit: 2 })).map((r) => r.reason)).toEqual(["stale", "stale"]);
  });

  it("points a stale sample whose first touch already went out back at comms-outreach", async () => {
    const old = new Date(Date.now() - 3 * 3_600_000);
    await seedRequest(db, { id: "req_touched", status: "delivering", owner_agent: "comms-outreach", updated_at: old });
    await seedRequest(db, { id: "req_untouched", status: "delivering", owner_agent: "comms-outreach", updated_at: old });
    await insert(db, "messages", { id: "msg_touch", direction: "outbound", inbox: "outreach", request_id: "req_touched", kind: "outreach", channel: "contact_form", status: "sent" });
    const rows = await listStuckRequests();
    expect(rows.find((r) => r.id === "req_touched")).toMatchObject({ reason: "stale", hint: expect.stringMatching(/closes it as delivered/) });
    expect(rows.find((r) => r.id === "req_untouched")).not.toHaveProperty("hint");
  });
});

describe("getSpendOverview", () => {
  it("combines the Naïve ledger, Monid caps, revenue and the costliest requests", async () => {
    await seedFunnel();
    const s = await getSpendOverview();
    expect(s.naive).toMatchObject({ total_usd: 12.5, balance_usd: 238, source: "naive ledger" });
    expect(s.naive.by_agent_today.sourcing).toEqual({ spent_today_usd: 2, cap_per_day_usd: 100, remaining_today_usd: 98 });
    expect(s.naive.by_agent_today.agt_unknown.cap_per_day_usd).toBeNull();
    expect(s.monid).toEqual({ total_usd: 0.15, today_usd: 0.15, cap_per_day_usd: CAPS.monidMaxUsdPerDay, remaining_today_usd: CAPS.monidMaxUsdPerDay - 0.15 });
    expect(s.revenue).toEqual({ paid_usd: 49, committed_usd: 29, stated_willingness_usd: 100 });
    expect(s.total_spend_usd).toBe(12.65);
    expect(s.top_requests_by_cost[0]).toMatchObject({ cost_usd: 1.2, free_sample: true });
  });
});

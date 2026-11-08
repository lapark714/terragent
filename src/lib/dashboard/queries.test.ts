import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { latLngToCell } from "h3-js";
import { createDb, setDb, type Db } from "../db/client";
import { migrate } from "../db/migrate";

vi.mock("../naive/board", () => ({
  listCards: vi.fn(async () => [
    { id: "crd_1", title: "req_inbound01 · planning → planner · ask jane@acme.com", status: "doing", assignee: "planner", note: null, updated_at: "2026-11-07T10:00:00Z" },
  ]),
}));
vi.mock("../naive/spend", () => ({ getSpendSummary: vi.fn(async () => { throw new Error("not implemented yet"); }) }));
vi.mock("../naive/sessions", () => ({
  listPendingApprovals: vi.fn(async () => [
    { session_id: "ses_1", agent: "acquisition", tool_call_id: "tc_1", tool: "terragent.place_paid_order", args: { note: "for bob@x.com" }, parked_at: null },
  ]),
  decideApproval: vi.fn(async () => {}),
}));

const { getFunnel } = await import("./funnel");
const { getBoard } = await import("./board");
const { getDecisions } = await import("./decisions");
const { getMoney } = await import("./money");
const { getInterventions } = await import("./interventions");
const { getAllocationHistory } = await import("./allocation");
const { getActivity, getOverview } = await import("./overview");
const { getGlobeData } = await import("./globe");
const { getApprovals } = await import("./approvals");
const { getLiveSnapshot } = await import("./snapshot");
const { getPublicReport, getRequestProgress, isFileReferenced } = await import("./public");
const { checkAdminToken, runAdminAction, AdminConflict } = await import("./admin");
const { invalidateLive } = await import("./rows");
const sessions = vi.mocked(await import("../naive/sessions"));
const naiveBoard = vi.mocked(await import("../naive/board"));

let db: Db;
const q = (sql: string, params: unknown[] = []) => db.query(sql, params);
const cell = latLngToCell(37.77, -122.42, 8);
const interventionCount = async () => Number((await q("SELECT count(*)::int AS n FROM interventions"))[0].n);
const parkedOrder = (orderId: string, toolCallId: string) => ({
  session_id: "ses_9", agent: "acquisition", tool_call_id: toolCallId, tool: "terragent.place_paid_order", args: { order_id: orderId }, parked_at: null,
});

async function seed() {
  await q(`INSERT INTO requests (id, source, playbook, status, owner_agent, customer_email, customer_name, question, location_text, lat, lon, is_free_sample, cost_usd, price_usd, created_at, updated_at)
           VALUES ('req_inbound01', 'portal', 'inbound', 'delivered', 'comms-customer', 'jane@acme.com', 'Jane Doe', 'Did 42 Elm Street flood?', '42 Elm Street, Houston', 29.7612, -95.3698, false, 1.25, 29, now() - interval '10 minutes', now()),
                  ('req_sample01', 'signal', 'disasters', 'analyzing', 'analytics', null, null, 'Flood check for warehouse', 'Houston TX', 29.7, -95.4, true, 0, null, now(), now()),
                  ('req_forest01', 'signal', 'deforestation', 'planning', 'planner', null, null, 'Forest loss at farm', null, -3.4, -62.2, true, 0, null, now(), now())`);
  await q(`INSERT INTO events (request_id, type, actor, payload, created_at) VALUES
           ('req_inbound01', 'request.created', 'system', '{}', now() - interval '10 minutes'),
           ('req_inbound01', 'status.changed', 'comms-customer', '{"to":"delivered"}', now() - interval '8 minutes')`);
  await q(`INSERT INTO signals (id, playbook, feed, external_id, title, lat, lon) VALUES
           ('sig_1', 'disasters', 'nws', 'a', 'Flood warning for Harris County', 29.7, -95.3),
           ('sig_2', 'disasters', 'usgs_quake', 'b', 'M4.1 quake', 36.1, -120.2),
           ('sig_3', 'deforestation', 'gfw', 'c', 'GLAD alert cluster', -3.4, -62.2)`);
  await q(`INSERT INTO prospects (id, signal_id, playbook, company, status) VALUES
           ('pro_1', 'sig_1', 'disasters', 'Acme Storage', 'replied'),
           ('pro_2', 'sig_1', 'disasters', 'Beta Warehousing', 'emailed'),
           ('pro_3', 'sig_3', 'deforestation', 'Cocoa Co', 'matched')`);
  await q(`INSERT INTO messages (id, direction, inbox, prospect_id, counterpart_email, kind, channel, status) VALUES
           ('msg_1', 'outbound', 'outreach', 'pro_1', 'ops@acme.com', 'outreach', 'email_warm', 'sent'),
           ('msg_2', 'outbound', 'outreach', 'pro_2', null, 'outreach', 'contact_form', 'sent'),
           ('msg_3', 'outbound', 'outreach', 'pro_2', null, 'outreach', 'contact_form', 'blocked'),
           ('msg_4', 'inbound', 'hello', 'pro_1', 'ops@acme.com', 'customer', 'email', 'received')`);
  await q(`INSERT INTO reports (id, request_id, title, answer, confidence, limitations, verifier_status, verifier_score, public_token, images, sources, measurements)
           VALUES ('rpt_1', 'req_inbound01', 'Flooding on Elm Street', 'Yes, standing water covered the block on Jan 3.', 'medium', '10 m pixels.', 'pass', 92, 'TokenAAAAAAAAAAAAAAAAAAAA',
                   '[{"role":"before","url":"fil_before1","caption":"Before","date":"2026-01-01","source":"Sentinel-2"},{"role":"after","url":"https://example.com/a.png","caption":"After","date":"2026-01-04","source":"Sentinel-2"}]',
                   '[{"name":"Sentinel-2 L2A","collection":"sentinel-2-l2a","item_id":"S2B_1","datetime":"2026-01-04","url":null,"license":"CC-BY"}]',
                   '[{"metric":"flooded_area_km2","value":0.4,"unit":"km2","before":0,"after":0.4,"note":null}]'),
                  ('rpt_2', 'req_sample01', 'Draft', 'Draft answer', 'low', 'n/a', 'pending', null, 'TokenBBBBBBBBBBBBBBBBBBBB', '[]', '[]', '[]')`);
  await q(`INSERT INTO analyses (id, request_id, recipe, result, file_ids, created_by) VALUES ('ana_1', 'req_inbound01', 'flood_extent', '{}', '{"out/ndwi.png":"fil_index9"}', 'analytics')`);
  await q(`INSERT INTO quotes (id, request_id, price_usd, status, auto_approved) VALUES ('qte_1', 'req_inbound01', 29, 'accepted', true), ('qte_2', 'req_sample01', 40, 'draft', false)`);
  await q(`INSERT INTO revenue (request_id, quote_id, amount_usd, kind) VALUES ('req_inbound01', 'qte_1', 29, 'paid'), (null, null, 100, 'stated_willingness')`);
  await q(`INSERT INTO spend (service, agent, request_id, amount_usd) VALUES ('naive', 'planner', 'req_sample01', 0.5), ('monid', 'sourcing', null, 0.04), ('naive', 'interpreter', null, 1.0)`);
  await q(`INSERT INTO decisions (id, request_id, kind, choice, reasoning, alternatives, agent) VALUES
           ('dec_1', 'req_inbound01', 'free_vs_paid', 'Free', 'Sentinel-2 at 10 m shows the flood; customer at jane@acme.com does not need 30 cm.', '[{"option":"SkySat 50cm","cost_usd":250,"why_not":"Overkill"}]', 'acquisition'),
           ('dec_2', null, 'playbook_allocation', 'disasters 0.6', 'Reply rate higher', '[]', 'coordinator')`);
  await q(`INSERT INTO interventions (actor, action, reason, request_id) VALUES ('Laurence', 'approve_template', 'First outreach template reviewed', null)`);
  await q(`INSERT INTO playbook_allocations (playbook, weight, reason, created_at) VALUES
           ('disasters', 0.6, 'Disasters reply rate 12% vs 3%', now() - interval '2 hours'),
           ('deforestation', 0.25, 'Disasters reply rate 12% vs 3%', now() - interval '2 hours'),
           ('mining', 0.15, 'Disasters reply rate 12% vs 3%', now() - interval '2 hours'),
           ('disasters', 0.7, 'Two paid replies from disasters', now() - interval '1 hour')`);
  await q(`INSERT INTO earth_index (h3_cell, h3_res, layer, metric, value, observed_at, source, change_flag) VALUES
           ($1, 8, 'inbound', 'mndwi_delta', 0.3, '2026-01-04', 's2', true),
           ($1, 8, 'disasters', 'mndwi_delta', 0.2, '2026-01-04', 's2', false),
           ($1, 8, 'disasters', 'ndvi_mean', 0.5, '2026-01-04', 's2', false)`, [cell]);
  await q(`INSERT INTO orders (id, request_id, provider_id, product, est_cost_usd, justification) VALUES ('ord_1', 'req_sample01', 'skywatch-pneo', 'archive 30cm', 22.5, 'Clouds over the AOI in all free scenes')`);
  await q(`INSERT INTO templates (id, playbook, version, subject, body) VALUES ('tpl_1', 'disasters', 'v1', 'Your site after the flood', 'Hi {{name}}')`);
}

beforeAll(async () => {
  db = await createDb({ memory: true });
  await migrate(db);
  setDb(db);
  await seed();
});
afterAll(async () => {
  setDb(null);
  await db.close();
});
beforeEach(() => {
  invalidateLive();
  vi.stubEnv("NAIVE_API_KEY", "");
  vi.stubEnv("VETTA_API_KEY", "");
});

describe("dashboard queries on an empty database", () => {
  it("return zeros and empty lists instead of failing", async () => {
    const empty = await createDb({ memory: true });
    await migrate(empty);
    setDb(empty);
    try {
      const snap = await getLiveSnapshot();
      for (const p of [snap.overview, snap.funnel, snap.board, snap.decisions, snap.money, snap.interventions, snap.allocation, snap.activity]) {
        expect(p.ok).toBe(true);
      }
      if (snap.funnel.ok) expect(snap.funnel.data.every((s) => s.total === 0)).toBe(true);
      if (snap.allocation.ok) expect(snap.allocation.data).toHaveLength(1);
      if (snap.board.ok) expect(snap.board.data.naive).toEqual({ state: "not_configured" });
      const globe = await getGlobeData();
      expect(globe.cells.world).toEqual([]);
      const approvals = await getApprovals();
      expect(approvals.inboxes.map((i) => i.armed)).toEqual([false, false, false]);
    } finally {
      setDb(db);
      await empty.close();
    }
  });
});

describe("dashboard queries on a seeded database", () => {
  it("builds the funnel by playbook", async () => {
    const funnel = Object.fromEntries((await getFunnel()).map((s) => [s.key, s]));
    expect(funnel.signals.total).toBe(3);
    expect(funnel.signals.byPlaybook.disasters).toBe(2);
    expect(funnel.prospects.total).toBe(3);
    expect(funnel.reports.byPlaybook.inbound).toBe(1); // the pending draft doesn't count
    expect(funnel.reports.total).toBe(1);
    expect(funnel.touches.byPlaybook.disasters).toBe(2); // both prospects, blocked send ignored
    expect(funnel.replies.byPlaybook.disasters).toBe(1);
    expect(funnel.quotes.total).toBe(1); // draft quote excluded
    expect(funnel.paid.byPlaybook.inbound).toBe(1);
  });

  it("masks PII on the board and degrades without Naïve", async () => {
    const board = await getBoard();
    const inbound = board.requests.find((r) => r.id === "req_inbo")!;
    expect(inbound.customer).toBe("J.D. at acme.com");
    expect(inbound.question).toBe("Did # Elm Street flood?");
    expect(inbound.location).toBe("Houston");
    expect(JSON.stringify(board)).not.toContain("jane@acme.com");
    expect(board.requests.find((r) => r.id === "req_samp")!.customer).toBeNull();
    expect(board.naive).toEqual({ state: "not_configured" });

    vi.stubEnv("NAIVE_API_KEY", "sk_test");
    const withNaive = await getBoard();
    expect(withNaive.naive.state).toBe("ok");
    if (withNaive.naive.state === "ok") expect(withNaive.naive.data[0].title).toBe("req_inbo · planning → planner · ask [email]");
  });

  it("lists decisions with scrubbed reasoning and free-vs-paid tallies", async () => {
    const d = await getDecisions();
    expect(d.rows).toHaveLength(2);
    const fvp = d.rows.find((r) => r.kind === "free_vs_paid")!;
    expect(fvp.reasoning).toContain("[email]");
    expect(fvp.alternatives[0]).toEqual({ option: "SkySat 50cm", cost_usd: 250, why_not: "Overkill" });
    expect(fvp.request).toBe("req_inbo");
    expect(fvp.playbook).toBe("inbound");
    expect(d.freeVsPaid).toEqual([{ choice: "free", n: 1 }]);
  });

  it("totals spend and revenue, falling back to the spend table without the Naïve ledger", async () => {
    const m = await getMoney();
    expect(m.spend.naiveSource).toBe("table");
    expect(m.spend.naive).toBeCloseTo(1.5);
    expect(m.spend.monid).toBeCloseTo(0.04);
    expect(m.spend.total).toBeCloseTo(1.54);
    expect(m.revenue.paid).toBe(29);
    expect(m.revenue.stated).toBe(100);
    expect(m.byAgent[0]).toEqual({ agent: "interpreter", usd: 1 });
    const inbound = m.perRequest.find((r) => r.id === "req_inbo")!;
    expect(inbound).toMatchObject({ cost: 1.25, price: 29, paid: 29 });
    expect(m.perRequest.find((r) => r.id === "req_samp")!.cost).toBeCloseTo(0.5);
  });

  it("returns interventions, allocation history and overview", async () => {
    const i = await getInterventions();
    expect(i.total).toBe(1);
    expect(i.rows[0]).toMatchObject({ actor: "Laurence", action: "approve_template" });

    const a = await getAllocationHistory();
    expect(a).toHaveLength(3);
    expect(a[0].by).toBe("default");
    expect(a[1].weights).toEqual({ disasters: 0.6, deforestation: 0.25, mining: 0.15 });
    expect(a[2].weights).toEqual({ disasters: 0.7, deforestation: 0.25, mining: 0.15 });

    const o = await getOverview();
    expect(o).toMatchObject({ inbound: 1, samples: 2, active: 2, delivered: 1, verifiedReports: 1, indexCells: 1, interventions: 1 });
    expect(o.medianAnswerSeconds).toBeGreaterThan(100);
    expect(o.medianAnswerSeconds).toBeLessThan(130);

    const activity = await getActivity();
    expect(activity[0]).toMatchObject({ type: "status.changed", request: "req_inbo" });
  });

  it("aggregates Earth index cells for the globe and coarsens request markers", async () => {
    const g = await getGlobeData();
    expect(g.cells.world).toHaveLength(1);
    expect(g.cells.world[0]).toMatchObject({ layer: "disasters", n: 3, changed: true });
    expect(g.cells.region).toHaveLength(1);
    expect(g.signals.map((s) => s.layer).sort()).toEqual(["disasters", "disasters", "forest"]);
    const inbound = g.requests.find((r) => r.id === "req_inbo")!;
    expect(inbound).toMatchObject({ lat: 29.8, lng: -95.4, layer: "inbound", active: false });
  });

  it("lists approvals with scrubbed Naïve tool args", async () => {
    vi.stubEnv("NAIVE_API_KEY", "sk_test");
    const ap = await getApprovals();
    expect(ap.orders).toHaveLength(1);
    expect(ap.orders[0]).toMatchObject({ id: "ord_1", estCostUsd: 22.5, request: "req_samp" });
    expect(ap.templates[0].id).toBe("tpl_1");
    expect(ap.naive.state).toBe("ok");
    if (ap.naive.state === "ok") expect(ap.naive.data[0].args).toEqual({ note: "for [email]" });
  });
});

describe("public dashboard privacy", () => {
  it("never shows a full request id, report token, address or a refused request's wording", async () => {
    vi.stubEnv("NAIVE_API_KEY", "sk_test");
    await q(`INSERT INTO requests (id, source, playbook, status, question, location_text, customer_email, customer_name, lat, lon) VALUES
             ('req_abcdef2345', 'portal', 'inbound', 'planning', 'Did 42 Elm St flood?', '42 Elm Street, Springfield', 'jo@x.com', 'Jo Bloggs', 39.78, -89.65),
             ('req_refusd2345', 'portal', 'inbound', 'refused', 'Track my ex Jane Doe who lives near the park', 'Leeds', 'ex@y.com', null, null, null)`);
    await q(`INSERT INTO decisions (id, request_id, kind, choice, reasoning, agent) VALUES
             ('dec_9', 'req_abcdef2345', 'source_selection', 'Sentinel-2', 'Sentinel-2 is enough for req_abcdef2345 at 42 Elm Street; report at /r/TokenAAAAAAAAAAAAAAAAAAAA', 'acquisition'),
             ('dec_10', 'req_refusd2345', 'screening', 'refused: stalking', 'Asks to track Jane Doe, a private person', 'comms-customer')`);
    naiveBoard.listCards.mockResolvedValueOnce([
      { id: "crd_9", title: "req_abcdef2345 · planning → planner · Did 42 Elm St flood", status: "doing", assignee: "planner", note: null, updated_at: "2026-11-07T10:00:00Z" },
    ]);
    sessions.listPendingApprovals.mockResolvedValueOnce([
      { session_id: "ses_2", agent: "acquisition", tool_call_id: "tc_2", tool: "terragent.place_paid_order", args: { request_id: "req_abcdef2345", note: "42 Elm Street" }, parked_at: null },
    ]);

    const snapshot = await getLiveSnapshot();
    const approvals = await getApprovals();
    const everything = JSON.stringify([snapshot, approvals, await getGlobeData()]);
    for (const leak of ["req_abcdef2345", "req_refusd2345", "req_inbound01", "TokenAAAA", "42 Elm", "jo@x.com", "Jo Bloggs", "Jane Doe"]) {
      expect(everything).not.toContain(leak);
    }
    expect(everything).toContain("req_abcd");
    if (snapshot.board.ok) {
      expect(snapshot.board.data.requests.find((r) => r.id === "req_refu")?.question).toBe("Refused under the acceptable use policy");
    }
    if (approvals.naive.state === "ok") expect(approvals.naive.data[0].args).toEqual({ request_id: "req_abcd", note: "# Elm Street" });
  });
});

describe("public views", () => {
  it("shows only verified reports and proxies Naïve files", async () => {
    const r = await getPublicReport("TokenAAAAAAAAAAAAAAAAAAAA");
    expect(r?.title).toBe("Flooding on Elm Street");
    expect(r?.images.map((i) => i.src)).toEqual(["/api/files/fil_before1?r=TokenAAAAAAAAAAAAAAAAAAAA", "https://example.com/a.png"]);
    expect(r?.sources[0].itemId).toBe("S2B_1");
    expect(await getPublicReport("TokenBBBBBBBBBBBBBBBBBBBB")).toBeNull();
    expect(await getPublicReport("bad token")).toBeNull();
  });

  it("serves a file only when the report or its analysis references it", async () => {
    expect(await isFileReferenced("TokenAAAAAAAAAAAAAAAAAAAA", "fil_before1")).toBe(true);
    expect(await isFileReferenced("TokenAAAAAAAAAAAAAAAAAAAA", "fil_index9")).toBe(true);
    expect(await isFileReferenced("TokenAAAAAAAAAAAAAAAAAAAA", "fil_other")).toBe(false);
    expect(await isFileReferenced("TokenBBBBBBBBBBBBBBBBBBBB", "fil_before1")).toBe(false);
  });

  it("reports request progress with the report link once delivered", async () => {
    const p = await getRequestProgress("req_inbound01");
    expect(p).toMatchObject({ status: "delivered", terminal: true });
    expect(p?.report?.path).toBe("/r/TokenAAAAAAAAAAAAAAAAAAAA");
    expect(p?.events).toHaveLength(2);
    expect((await getRequestProgress("req_sample01"))?.report).toBeNull();
    expect(await getRequestProgress("nope")).toBeNull();
  });
});

describe("admin actions", () => {
  it("checks the admin token", () => {
    vi.stubEnv("ADMIN_TOKEN", "");
    expect(checkAdminToken("x")).toBe("disabled");
    vi.stubEnv("ADMIN_TOKEN", "s3cret");
    expect(checkAdminToken("s3cret")).toBe("ok");
    expect(checkAdminToken("wrong")).toBe("denied");
    expect(checkAdminToken(null)).toBe("denied");
  });

  it("approves an order once and logs the intervention", async () => {
    await runAdminAction({ action: "order", order_id: "ord_1", decision: "approve", actor: "Aiden", reason: "Paying customer agreed" });
    const [order] = await q("SELECT status, approved_by FROM orders WHERE id = 'ord_1'");
    expect(order).toEqual({ status: "approved", approved_by: "Aiden" });
    await expect(runAdminAction({ action: "order", order_id: "ord_1", decision: "reject", actor: "Aiden", reason: "again" })).rejects.toBeInstanceOf(AdminConflict);
    const rows = await q("SELECT actor, action, request_id, ref_id FROM interventions WHERE action = 'approve_order'");
    expect(rows).toEqual([{ actor: "Aiden", action: "approve_order", request_id: "req_sample01", ref_id: "ord_1" }]);
    expect(await q("SELECT kind FROM decisions WHERE choice LIKE 'paid order ord_1 %'")).toEqual([{ kind: "free_vs_paid" }]);
    expect(await q("SELECT actor FROM events WHERE type = 'order.approved' AND payload->>'order_id' = 'ord_1'")).toEqual([{ actor: "human:Aiden" }]);
  });

  it("records one intervention for one decision on a parked paid order, from either panel", async () => {
    vi.stubEnv("NAIVE_API_KEY", "sk_test");
    await q(`INSERT INTO providers (id, name, vendor, data_type, is_free, access_method) VALUES ('skywatch-pneo', 'Pléiades Neo', 'SkyWatch', 'optical', false, 'api')
             ON CONFLICT (id) DO NOTHING`);
    await q(`INSERT INTO orders (id, request_id, provider_id, product, est_cost_usd, justification) VALUES
             ('ord_2', 'req_sample01', 'skywatch-pneo', 'archive 30cm', 40, 'Clouds in every free scene'),
             ('ord_3', 'req_sample01', 'skywatch-pneo', 'archive 30cm', 40, 'Clouds in every free scene'),
             ('ord_4', 'req_sample01', 'skywatch-pneo', 'archive 30cm', 40, 'Clouds in every free scene')`);
    const before = await interventionCount();

    // Allow in "Paused agent actions": the order is approved first, so core's tool run finds it done and logs nothing.
    sessions.listPendingApprovals.mockResolvedValueOnce([parkedOrder("ord_2", "tc_2")]);
    await runAdminAction({ action: "naive-approval", session_id: "ses_9", tool_call_id: "tc_2", decision: "allow", actor: "Aiden", reason: "Customer paid" });
    expect(sessions.decideApproval).toHaveBeenLastCalledWith("ses_9", "tc_2", "allow", "Customer paid");
    expect(await q("SELECT status, approved_by FROM orders WHERE id = 'ord_2'")).toEqual([{ status: "approved", approved_by: "Aiden" }]);
    const { approveOrder } = await import("../pipeline/orders");
    expect(await approveOrder({ orderId: "ord_2" }, "acquisition")).toMatchObject({ status: "approved", purchased: false });
    expect(await interventionCount()).toBe(before + 1);

    // Deny in "Paused agent actions" rejects the order in the same step.
    sessions.listPendingApprovals.mockResolvedValueOnce([parkedOrder("ord_3", "tc_3")]);
    await runAdminAction({ action: "naive-approval", session_id: "ses_9", tool_call_id: "tc_3", decision: "deny", actor: "Aiden", reason: "Free data is enough" });
    expect(await q("SELECT status FROM orders WHERE id = 'ord_3'")).toEqual([{ status: "rejected" }]);
    expect(await interventionCount()).toBe(before + 2);

    // Deciding in "Paid data orders" answers the parked call too.
    sessions.listPendingApprovals.mockResolvedValueOnce([parkedOrder("ord_4", "tc_4")]);
    await runAdminAction({ action: "order", order_id: "ord_4", decision: "reject", actor: "Aiden", reason: "Too pricey" });
    expect(sessions.decideApproval).toHaveBeenLastCalledWith("ses_9", "tc_4", "deny", "Too pricey");
    expect(await interventionCount()).toBe(before + 3);
    expect(await q("SELECT action FROM interventions WHERE ref_id IN ('ord_2', 'ord_3', 'ord_4') ORDER BY id")).toEqual([
      { action: "approve_order" }, { action: "reject_order" }, { action: "reject_order" },
    ]);
  });

  it("logs other paused tool calls once and refuses calls that aren't waiting", async () => {
    vi.stubEnv("NAIVE_API_KEY", "sk_test");
    const before = await interventionCount();
    sessions.listPendingApprovals.mockResolvedValueOnce([{ ...parkedOrder("ord_x", "tc_5"), tool: "terragent.other_tool" }]);
    await runAdminAction({ action: "naive-approval", session_id: "ses_9", tool_call_id: "tc_5", decision: "allow", actor: "Aiden", reason: "Looks fine" });
    expect(await q("SELECT action, ref_id FROM interventions WHERE ref_id = 'tc_5'")).toEqual([{ action: "naive_allow", ref_id: "tc_5" }]);
    sessions.listPendingApprovals.mockResolvedValueOnce([]);
    await expect(
      runAdminAction({ action: "naive-approval", session_id: "ses_9", tool_call_id: "tc_5", decision: "allow", actor: "Aiden", reason: "again" }),
    ).rejects.toBeInstanceOf(AdminConflict);
    expect(await interventionCount()).toBe(before + 1);
  });

  it("approves a quote held above the cap and hands it to comms-customer", async () => {
    vi.stubEnv("TERRAGENT_LANES", "off");
    await q(`INSERT INTO requests (id, source, playbook, status, question, customer_email, meta) VALUES
             ('req_quoted0001', 'portal', 'inbound', 'awaiting_approval', 'Forest loss near 12 Rue de Rivoli?', 'bo@x.com', '{"screening":{"allowed":true}}')`);
    await q(`INSERT INTO quotes (id, request_id, price_usd, data_cost_usd, analysis_cost_usd, status, line_items) VALUES
             ('qte_held1', 'req_quoted0001', 180, 120, 8, 'needs_approval', '[{"label":"Satellite data","amount_usd":120},{"label":"Analysis and verified report","amount_usd":60}]')`);
    const ap = await getApprovals();
    expect(ap.quotes).toEqual([
      expect.objectContaining({ id: "qte_held1", request: "req_quot", priceUsd: 180, question: "Forest loss near # Rue de Rivoli?", lineItems: [
        { label: "Satellite data", amountUsd: 120 }, { label: "Analysis and verified report", amountUsd: 60 },
      ] }),
    ]);

    const before = await interventionCount();
    const approve = () => runAdminAction({ action: "quote", quote_id: "qte_held1", decision: "approve", actor: "Laurence", reason: "Price checked" });
    expect(await approve()).toEqual({ done: "Quote approved. The customer agent is sending it now." });
    expect(await q("SELECT status FROM quotes WHERE id = 'qte_held1'")).toEqual([{ status: "approved" }]);
    expect(await q("SELECT actor, action FROM interventions WHERE ref_id = 'qte_held1'")).toEqual([{ actor: "Laurence", action: "approve_quote" }]);
    expect(await q("SELECT payload->>'to' AS to FROM events WHERE request_id = 'req_quoted0001' AND type = 'handoff'")).toEqual([{ to: "comms-customer" }]);
    await expect(approve()).rejects.toBeInstanceOf(AdminConflict);
    expect(await interventionCount()).toBe(before + 1);
    expect((await getApprovals()).quotes).toEqual([]);
  });

  it("approves templates once", async () => {
    await runAdminAction({ action: "template", template_id: "tpl_1", decision: "approve", actor: "Aarush", reason: "Copy reviewed" });
    const [tpl] = await q("SELECT status, approved_by FROM templates WHERE id = 'tpl_1'");
    expect(tpl).toEqual({ status: "approved", approved_by: "Aarush" });
    await expect(runAdminAction({ action: "template", template_id: "tpl_1", decision: "retire", actor: "Aarush", reason: "again" })).rejects.toBeInstanceOf(AdminConflict);
  });

  it("arms inboxes one flag at a time and refuses a repeat", async () => {
    const before = await interventionCount();
    const arm = (inbox: "hello" | "data" | "outreach", armed = true) => runAdminAction({ action: "inbox", inbox, armed, actor: "Laurence", reason: "First send approved" });
    await arm("outreach");
    await arm("hello");
    await expect(arm("hello")).rejects.toBeInstanceOf(AdminConflict);
    await expect(arm("data", false)).rejects.toBeInstanceOf(AdminConflict);
    const ap = await getApprovals();
    expect(Object.fromEntries(ap.inboxes.map((i) => [i.role, i.armed]))).toEqual({ hello: true, data: false, outreach: true });
    expect(await q("SELECT value, updated_by FROM settings WHERE key = 'email.inbox_armed'")).toEqual([{ value: { outreach: true, hello: true }, updated_by: "human:Laurence" }]);
    await arm("hello", false);
    expect((await getApprovals()).inboxes.find((i) => i.role === "hello")?.armed).toBe(false);
    expect(await interventionCount()).toBe(before + 3);
  });
});

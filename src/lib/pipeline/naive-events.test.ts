import { beforeAll, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/webhooks/naive/route";
import { getDb } from "../db/client";
import { signNaivePayload } from "../naive/webhooks";
import { setSetting, SETTING } from "../settings";
import { logEvent } from "../events";
import { createRequest, getRequest, recordSession } from "./requests";
import { setupMemoryDb } from "./testing";

const pending: Promise<unknown>[] = [];
vi.mock("next/server", () => ({ after: (fn: () => Promise<unknown>) => pending.push(fn()) }));
vi.mock("../naive/spend", () => ({ sessionCostUsd: vi.fn(async () => 0.42) }));
// Sessions the board woke (or a cron started) are looked up in Naïve once; no network in tests.
const sessions = vi.hoisted(() => new Map<string, { agent_id: string; metadata: Record<string, unknown> }>());
vi.mock("../naive/client", () => ({
  getNaive: vi.fn(async () => ({
    sessions: {
      get: vi.fn(async (id: string) => {
        const s = sessions.get(id);
        if (!s) throw new Error(`404 session ${id}`);
        return { id, ...s };
      }),
    },
  })),
}));

const SECRET = "whsec_test";

beforeAll(async () => {
  await setupMemoryDb();
  await setSetting(SETTING.naiveWebhookSecrets, [{ id: "whk_1", secret: SECRET, purpose: "events" }]);
  await setSetting(SETTING.naiveAgents, { analytics: { id: "agt_an", version: 1 }, "comms-suppliers": { id: "agt_cs", version: 1 }, sourcing: { id: "agt_so", version: 1 } });
});

async function deliver(envelope: Record<string, unknown>, secret = SECRET) {
  const body = JSON.stringify(envelope);
  const ts = Math.floor(Date.now() / 1000);
  const res = await POST(new Request("https://terragent.test/api/webhooks/naive", {
    method: "POST", body,
    headers: { "content-type": "application/json", "vetta-timestamp": String(ts), "vetta-signature": `v1=${signNaivePayload(body, secret, ts)}` },
  }));
  await Promise.all(pending.splice(0));
  return { status: res.status, body: await res.json() };
}

const eventsOf = async (type: string) =>
  (await getDb()).query<{ request_id: string | null; payload: Record<string, unknown> }>("SELECT request_id, payload FROM events WHERE type = $1", [type]);

describe("POST /api/webhooks/naive", () => {
  it("rejects a bad signature with 400", async () => {
    const res = await deliver({ id: "evt_bad", type: "session.idle", created_at: "", data: {} }, "whsec_wrong");
    expect(res).toEqual({ status: 400, body: { error: "bad_signature" } });
  });

  it("records session spend on idle and dedupes redeliveries", async () => {
    const req = await createRequest({ question: "Did the flood reach the depot?", source: "portal" });
    await recordSession({ sessionId: "ses_idle1", agent: "planner", requestId: req.id, lane: "inbound" });
    const evt = { id: "evt_1", type: "session.idle", created_at: new Date().toISOString(), data: { session_id: "ses_idle1", stop_reason: "end_turn" } };

    expect(await deliver(evt)).toEqual({ status: 200, body: { ok: true } });
    expect(Number((await getRequest(req.id))?.cost_usd)).toBeCloseTo(0.42);
    const [spend] = await (await getDb()).query<{ agent: string; amount_usd: string }>("SELECT agent, amount_usd FROM spend WHERE session_id = 'ses_idle1'", []);
    expect(spend.agent).toBe("planner");

    expect(await deliver(evt)).toEqual({ status: 200, body: { ok: true, duplicate: true } });
    expect(await (await getDb()).query("SELECT 1 FROM spend WHERE session_id = 'ses_idle1'")).toHaveLength(1);
    const [row] = await (await getDb()).query<{ processed_at: Date | null }>("SELECT processed_at FROM webhook_events WHERE id = 'naive:evt_1'");
    expect(row.processed_at).not.toBeNull();
  });

  it("surfaces approvals and errors for the dashboard and coordinator", async () => {
    const req = await createRequest({ question: "Buy the 30 cm scene?", source: "portal" });
    await recordSession({ sessionId: "ses_ask", agent: "acquisition", requestId: req.id, lane: "inbound" });
    await recordSession({ sessionId: "ses_err", agent: "analytics", requestId: req.id, lane: "inbound" });

    await deliver({ id: "evt_ask", type: "session.idle", created_at: "", data: { session_id: "ses_ask", stop_reason: "awaiting_approval", pending_actions: [{ kind: "tool", name: "terragent.place_paid_order" }] } });
    const [approval] = await eventsOf("approval.pending");
    expect(approval).toMatchObject({ request_id: req.id, payload: { agent: "acquisition", tools: ["terragent.place_paid_order"] } });

    await deliver({ id: "evt_err", type: "session.idle", created_at: "", data: { session_id: "ses_err", stop_reason: "error", code: "computer_failed" } });
    expect((await eventsOf("session.attention"))[0]).toMatchObject({ request_id: req.id, payload: { stop_reason: "error", code: "computer_failed" } });
    const notes = await eventsOf("note");
    expect(notes.find((n) => n.request_id === req.id)?.payload.note).toMatch(/analytics session ses_err stopped \(error, computer_failed\)/);

    await deliver({ id: "evt_budget", type: "budget.exceeded", created_at: "", data: { code: "budget_exceeded", message: "cap reached" } });
    expect(await eventsOf("budget.exceeded")).toHaveLength(1);
  });

  it("links a board-woken session to its request through the card, with the agent's name", async () => {
    const req = await createRequest({ question: "Free sample: flood at the depot", source: "signal", priority: "background" });
    // A background handoff created card crd_bg for analytics; the board woke ses_woken for it.
    await logEvent("handoff", "acquisition", { to: "analytics", stage: "analysis", lane: "background", card_id: "crd_bg" }, req.id);
    sessions.set("ses_woken", { agent_id: "agt_an", metadata: { board: { card_id: "crd_bg", board_id: "brd_1" } } });

    await deliver({ id: "evt_woken", type: "session.idle", created_at: "", data: { session_id: "ses_woken", stop_reason: "end_turn", structured_output: null } });
    const db = await getDb();
    const [spend] = await db.query<{ agent: string; request_id: string }>("SELECT agent, request_id FROM spend WHERE session_id = 'ses_woken'");
    expect(spend).toEqual({ agent: "analytics", request_id: req.id });
    const [row] = await db.query<{ agent: string; request_id: string; stage: string }>("SELECT agent, request_id, stage FROM agent_sessions WHERE session_id = 'ses_woken'");
    expect(row).toEqual({ agent: "analytics", request_id: req.id, stage: "analysis" });
    const after = await getRequest(req.id);
    expect(Number(after?.cost_usd)).toBeCloseTo(0.42);
    expect(after?.naive_session_ids).toContain("ses_woken");
  });

  it("maps a supplier-reply card through its order, and falls back to the run summary when Naïve has no answer", async () => {
    const req = await createRequest({ question: "Roofs on our lot?", source: "portal" });
    const db = await getDb();
    await db.query("INSERT INTO orders (id, request_id, provider_id, product, est_cost_usd, justification, meta) VALUES ('ord_w', $1, 'arlula-archive', 'archive', 10, 'roofs', $2)",
      [req.id, JSON.stringify({ card: { key: "order:ord_w", title: "t", body: "b", id: "crd_ord" } })]);
    sessions.set("ses_sup", { agent_id: "agt_cs", metadata: { board: { card_id: "crd_ord", board_id: "brd_1" } } });
    await deliver({ id: "evt_sup", type: "session.idle", created_at: "", data: { session_id: "ses_sup", stop_reason: "end_turn" } });
    expect((await db.query("SELECT agent, request_id FROM spend WHERE session_id = 'ses_sup'"))[0]).toEqual({ agent: "comms-suppliers", request_id: req.id });

    // ses_gone is unknown to Naïve's mock: the RunSummary's request_id is used, if that request exists.
    await deliver({ id: "evt_gone", type: "session.idle", created_at: "", data: { session_id: "ses_gone", stop_reason: "end_turn", structured_output: { request_id: req.id } } });
    expect((await db.query("SELECT agent, request_id FROM spend WHERE session_id = 'ses_gone'"))[0]).toEqual({ agent: null, request_id: req.id });
    await deliver({ id: "evt_bogus", type: "session.idle", created_at: "", data: { session_id: "ses_bogus", stop_reason: "end_turn", structured_output: { request_id: "req_invented" } } });
    expect((await db.query("SELECT request_id FROM spend WHERE session_id = 'ses_bogus'"))[0]).toEqual({ request_id: null });
  });

  it("names the agent of a cron session (no request) and resolves it only once", async () => {
    sessions.set("ses_cron", { agent_id: "agt_so", metadata: {} });
    await deliver({ id: "evt_cron1", type: "session.idle", created_at: "", data: { session_id: "ses_cron", stop_reason: "end_turn", deployment_id: "dep_1" } });
    sessions.delete("ses_cron"); // a second idle must not need Naïve again
    await deliver({ id: "evt_cron2", type: "session.idle", created_at: "", data: { session_id: "ses_cron", stop_reason: "end_turn", deployment_id: "dep_1" } });
    const db = await getDb();
    expect((await db.query("SELECT agent, request_id FROM agent_sessions WHERE session_id = 'ses_cron'"))[0]).toEqual({ agent: "sourcing", request_id: null });
    expect((await db.query("SELECT agent FROM spend WHERE session_id = 'ses_cron'"))).toEqual([{ agent: "sourcing" }]);
  });
});

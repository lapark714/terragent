import { beforeAll, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/webhooks/naive/route";
import { getDb } from "../db/client";
import { signNaivePayload } from "../naive/webhooks";
import { setSetting, SETTING } from "../settings";
import { createRequest, getRequest, recordSession } from "./requests";
import { setupMemoryDb } from "./testing";

const pending: Promise<unknown>[] = [];
vi.mock("next/server", () => ({ after: (fn: () => Promise<unknown>) => pending.push(fn()) }));
vi.mock("../naive/spend", () => ({ sessionCostUsd: vi.fn(async () => 0.42) }));

const SECRET = "whsec_test";

beforeAll(async () => {
  await setupMemoryDb();
  await setSetting(SETTING.naiveWebhookSecrets, [{ id: "whk_1", secret: SECRET, purpose: "events" }]);
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
});

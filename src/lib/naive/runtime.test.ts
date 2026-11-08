/** Runtime helpers (sessions, board, spend, files) against a mocked Naïve client and an in-memory DB. */
import type { VettaClient } from "@usenaive-sdk/managed-agents";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, setDb, type Db } from "../db/client";
import { migrate } from "../db/migrate";
import { setSetting, SETTING } from "../settings";
import { cardKey, diffCard, listCards, upsertCard, WAKE_LIMIT } from "./board";
import { setNaive } from "./client";
import { fileUrl } from "./files";
import { decideApproval, listPendingApprovals, startAgentSession } from "./sessions";
import { getSpendSummary } from "./spend";

let db: Db;
beforeAll(async () => {
  db = await createDb({ memory: true });
  await migrate(db);
  setDb(db);
  await setSetting(SETTING.naiveAgents, {
    planner: { id: "agt_planner", version: 3 },
    acquisition: { id: "agt_acq", version: 2 },
    "comms-outreach": { id: "agt_out", version: 1 },
  });
  await setSetting(SETTING.naiveBoard, { coordinator: "agt_coord" });
});
afterAll(async () => {
  setNaive(null);
  setDb(null);
  await db.close();
});
beforeEach(() => vi.stubEnv("VERCEL_ENV", ""));

const card = (over: Record<string, unknown> = {}) => ({
  id: "crd_1",
  title: "req_1: planner",
  body: "brief",
  status: "todo",
  assignee: "planner",
  note: null,
  woken_session_id: null as string | null,
  wake_count: 0,
  updated_at: "2026-11-07T00:00:00Z",
  ...over,
});
type CreateCard = (board: string, body: Record<string, unknown>) => Promise<ReturnType<typeof card>>;

function mockClient(parts: Record<string, unknown>) {
  setNaive(parts as unknown as VettaClient);
}

describe("sessions", () => {
  it("starts a session with the provisioned agent id, request metadata and a budget clamped to the agent cap", async () => {
    const create = vi.fn(async () => ({ id: "ses_1" }));
    mockClient({ sessions: { create } });
    const out = await startAgentSession("planner", "Plan req_1", { requestId: "req_1", budgetUsd: 999, idempotencyKey: "k1" });
    expect(out).toEqual({ session_id: "ses_1" });
    expect(create).toHaveBeenCalledWith(
      { agent_id: "agt_planner", message: "Plan req_1", metadata: { agent: "planner", request_id: "req_1" }, budget_micro_usd: 30_000_000 },
      { idempotencyKey: "k1" },
    );
  });

  it("refuses an agent that was never provisioned", async () => {
    mockClient({ sessions: { create: vi.fn() } });
    await expect(startAgentSession("verifier", "x")).rejects.toThrow(/not provisioned/);
  });

  it("lists only our agents' tool approvals, across pages, with whether a founder may allow them", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            id: "ses_a",
            agent_id: "agt_acq",
            ended_at: "2026-11-07T01:00:00Z",
            pending_actions: [
              { kind: "tool", tool_call_id: "tc_1", name: "terragent.place_paid_order", args: { order_id: "ord_1" } },
              { kind: "question", tool_call_id: "tc_2", name: "ask_operator", args: {} },
            ],
          },
        ],
        has_more: true,
        next_cursor: "cur_2",
      })
      .mockResolvedValueOnce({
        data: [
          // another team's agent in the same org: never listed
          { id: "ses_shop", agent_id: "agt_shop_ceo", ended_at: null, pending_actions: [{ kind: "tool", tool_call_id: "tc_3", name: "social.post", args: {} }] },
          {
            id: "ses_o",
            agent_id: "agt_out",
            ended_at: null,
            pending_actions: [
              { kind: "tool", tool_call_id: "tc_4", name: "browser", args: { action: "click" } },
              { kind: "tool", tool_call_id: "tc_5", name: "browser", args: { action: "signup" } },
            ],
          },
        ],
        has_more: false,
        next_cursor: null,
      });
    mockClient({ sessions: { list } });
    const pending = await listPendingApprovals();
    expect(list).toHaveBeenNthCalledWith(1, { stop_reason: "awaiting_approval", limit: 100 });
    expect(list).toHaveBeenNthCalledWith(2, { stop_reason: "awaiting_approval", limit: 100, after: "cur_2" });
    expect(pending).toEqual([
      { session_id: "ses_a", agent: "acquisition", tool_call_id: "tc_1", tool: "terragent.place_paid_order", args: { order_id: "ord_1" }, parked_at: "2026-11-07T01:00:00Z", approvable: true },
      { session_id: "ses_o", agent: "comms-outreach", tool_call_id: "tc_4", tool: "browser", args: { action: "click" }, parked_at: null, approvable: true },
      { session_id: "ses_o", agent: "comms-outreach", tool_call_id: "tc_5", tool: "browser", args: { action: "signup" }, parked_at: null, approvable: false },
    ]);
  });

  const parked = (agent_id: string, name: string, args: Record<string, unknown> = {}) => ({ id: "ses_a", agent_id, pending_actions: [{ kind: "tool", tool_call_id: "tc_1", name, args }] });

  it("decides one parked call of ours at a time", async () => {
    const confirmTool = vi.fn(async () => ({}));
    mockClient({ sessions: { get: vi.fn(async () => parked("agt_acq", "terragent.place_paid_order")), confirmTool } });
    await decideApproval("ses_a", "tc_1", "deny", "no paying customer");
    expect(confirmTool).toHaveBeenCalledWith("ses_a", { tool_call_id: "tc_1", decision: "deny", reason: "no paying customer", scope: "call" });
    await decideApproval("ses_a", "tc_1", "allow", "customer paid");
    expect(confirmTool).toHaveBeenLastCalledWith("ses_a", { tool_call_id: "tc_1", decision: "allow", reason: "customer paid", scope: "call" });
  });

  it("refuses another team's sessions, unknown calls, and allowing anything outside the allowlist", async () => {
    const confirmTool = vi.fn(async () => ({}));
    const get = vi.fn();
    mockClient({ sessions: { get, confirmTool } });
    get.mockResolvedValueOnce(parked("agt_shop_ceo", "terragent.place_paid_order"));
    await expect(decideApproval("ses_a", "tc_1", "allow", "x")).rejects.toThrow(/not belong to a Terragent agent/);
    get.mockResolvedValueOnce(parked("agt_acq", "terragent.place_paid_order"));
    await expect(decideApproval("ses_a", "tc_9", "deny", "x")).rejects.toThrow(/no pending tool call tc_9/);
    get.mockResolvedValueOnce(parked("agt_planner", "terragent.place_paid_order"));
    await expect(decideApproval("ses_a", "tc_1", "allow", "x")).rejects.toThrow(/only denied/);
    get.mockResolvedValueOnce(parked("agt_out", "browser", { action: "signup" }));
    await expect(decideApproval("ses_a", "tc_1", "allow", "x")).rejects.toThrow(/only denied/);
    expect(confirmTool).not.toHaveBeenCalled();
    get.mockResolvedValueOnce(parked("agt_out", "browser", { action: "signup" }));
    await decideApproval("ses_a", "tc_1", "deny", "agents never sign up");
    expect(confirmTool).toHaveBeenCalledTimes(1);
  });
});

type UpdateCard = (board: string, cardId: string, patch: Record<string, unknown>) => Promise<ReturnType<typeof card>>;
const echoUpdate = () => vi.fn<UpdateCard>(async (_b, cardId, patch) => card({ id: cardId, ...patch }));

describe("board", () => {
  it("creates a background card as todo + assignee on the coordinator's board, and patches nothing when it matches", async () => {
    const create = vi.fn(async () => card());
    const update = vi.fn();
    mockClient({ board: { cards: { create, update } } });
    const view = await upsertCard({ key: "req_1", title: "req_1: planner", body: "brief", assignee: "planner" });
    expect(create).toHaveBeenCalledWith("agt_coord", { key: "req_1", title: "req_1: planner", body: "brief", status: "todo", assignee: "planner" });
    expect(update).not.toHaveBeenCalled();
    expect(view.status).toBe("todo");
  });

  it("mirrors the inbound lane as an unassigned `doing` card naming the agent, so it never makes the agent busy", async () => {
    const create = vi.fn<CreateCard>(async () => card({ status: "doing", assignee: "planner" })); // an older, assigned mirror
    const update = echoUpdate();
    mockClient({ board: { cards: { create, update } } });
    await upsertCard({ key: "req_1", title: "req_1: planner", body: "brief", assignee: "acquisition", mirror: true, status: "todo" });
    expect(create.mock.calls[0][1]).toMatchObject({ status: "doing", assignee: null, title: "acquisition ▸ req_1: planner" });
    expect(update).toHaveBeenCalledWith("agt_coord", "crd_1", { title: "acquisition ▸ req_1: planner", assignee: null });
  });

  it("re-writes the assignee to wake the same agent again once its earlier run has ended", async () => {
    const create = vi.fn(async () => card({ status: "blocked", woken_session_id: "ses_prev", wake_count: 1 }));
    const update = echoUpdate();
    const get = vi.fn(async () => ({ id: "ses_prev", status: "idle", stop_reason: "end_turn" }));
    mockClient({ board: { cards: { create, update } }, sessions: { get } });
    await upsertCard({ key: "req_1", title: "req_1: planner", body: "revise", assignee: "planner", status: "todo" });
    expect(get).toHaveBeenCalledWith("ses_prev");
    expect(update).toHaveBeenCalledWith("agt_coord", "crd_1", { body: "revise", status: "todo", assignee: "planner" });
  });

  it.each([
    ["running", null],
    ["idle", "awaiting_approval"],
  ])("does not start the agent twice when a retried handoff targets the agent already holding the card (%s %s)", async (status, stop_reason) => {
    const create = vi.fn(async () => card({ status: "doing", woken_session_id: "ses_run", wake_count: 1 }));
    const update = echoUpdate();
    mockClient({ board: { cards: { create, update } }, sessions: { get: vi.fn(async () => ({ id: "ses_run", status, stop_reason })) } });
    await upsertCard({ key: "req_1", title: "req_1: planner", body: "brief", assignee: "planner", status: "todo" });
    expect(update).not.toHaveBeenCalled();
    await upsertCard({ key: "req_1", title: "req_1: planner", body: "brief, retried", assignee: "planner", status: "todo" });
    expect(update).toHaveBeenCalledWith("agt_coord", "crd_1", { body: "brief, retried" }); // no assignee, no status: no second wake
  });

  it("continues on a fresh card once the board has started this one WAKE_LIMIT times, and keeps using it", async () => {
    expect(WAKE_LIMIT).toBe(3);
    const cards: Record<string, ReturnType<typeof card>> = {
      "req:req_9": card({ id: "crd_old", title: "req_9", assignee: "analytics", status: "doing", woken_session_id: "ses_an", wake_count: 3 }),
      "req:req_9#1": card({ id: "crd_new", title: "req_9", body: "interpret", assignee: "interpreter", status: "todo", wake_count: 0 }),
    };
    const create = vi.fn<CreateCard>(async (_b, body) => cards[body.key as string]);
    const update = echoUpdate();
    mockClient({ board: { cards: { create, update } }, sessions: { get: vi.fn() } });

    const view = await upsertCard({ key: "req:req_9", title: "req_9", body: "interpret", assignee: "interpreter", status: "todo" });
    expect(create.mock.calls.map((c) => c[1].key)).toEqual(["req:req_9", "req:req_9#1"]);
    expect(create.mock.calls[1][1]).toMatchObject({ status: "todo", assignee: "interpreter", body: "interpret" });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][1]).toBe("crd_old");
    expect(update.mock.calls[0][2]).toMatchObject({ status: "done", note: expect.stringMatching(/^Continued on a fresh card \(req:req_9#1, crd_new\)/) });
    expect(view.id).toBe("crd_new");
    expect(await db.query("SELECT generation FROM naive_card_generations WHERE key = $1", ["req:req_9"])).toEqual([{ generation: 1 }]);

    // Later calls (the next handoff, core closing the request) address the fresh card.
    create.mockClear();
    update.mockClear();
    await upsertCard({ key: "req:req_9", title: "req_9", body: "done", assignee: "interpreter", status: "done", note: "delivered: ok" });
    expect(create.mock.calls.map((c) => c[1].key)).toEqual(["req:req_9#1"]);
    expect(update).toHaveBeenCalledWith("agt_coord", "crd_new", { body: "done", status: "done", note: "delivered: ok" });
  });

  it("never creates a card as done (Naïve needs a note) and closes it with a note", async () => {
    const create = vi.fn<CreateCard>(async () => card({ status: "doing" }));
    const update = echoUpdate();
    mockClient({ board: { cards: { create, update } } });
    await upsertCard({ key: "req_1", title: "req_1: planner", body: "brief", assignee: "planner", status: "done" });
    expect(create.mock.calls[0][1]).toMatchObject({ status: "doing" });
    expect(update).toHaveBeenCalledWith("agt_coord", "crd_1", { status: "done", note: "Completed." });
  });

  it("diffCard only lists changed fields", () => {
    const c = card() as Parameters<typeof diffCard>[0];
    expect(diffCard(c, { title: c.title, body: c.body, status: "todo", assignee: "planner" })).toBeNull();
    expect(diffCard(c, { title: c.title, body: "new", status: "blocked", assignee: "planner", note: "why" })).toEqual({ body: "new", status: "blocked", note: "why" });
  });

  it("hashes keys longer than 128 chars", () => {
    expect(cardKey("am:abc")).toBe("am:abc");
    const long = cardKey(`<${"x".repeat(200)}@mail>`);
    expect(long).toMatch(/^h:[0-9a-f]{40}$/);
  });

  it("pages through every card", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({ data: [card({ id: "crd_1" })], has_more: true, next_cursor: "c2" })
      .mockResolvedValueOnce({ data: [card({ id: "crd_2", status: "done" })], has_more: false, next_cursor: null });
    mockClient({ board: { cards: { list } } });
    expect((await listCards()).map((c) => c.id)).toEqual(["crd_1", "crd_2"]);
    expect(list).toHaveBeenLastCalledWith("agt_coord", { limit: 100, after: "c2" });
  });
});

describe("spend and files", () => {
  it("converts micro-USD and names agents", async () => {
    const spend = vi.fn(async () => ({
      spent_micro_usd: 2_500_000,
      by_tier: {},
      by_agent: [{ agent_id: "agt_planner", spent_micro_usd: 2_000_000 }, { agent_id: "agt_other", spent_micro_usd: 500_000 }],
      by_session: [{ session_id: "ses_1", spent_micro_usd: 1_000_000 }],
    }));
    mockClient({ credits: { spend, show: vi.fn(async () => ({ balance_micro_usd: 247_500_000 })) } });
    const from = new Date("2026-11-07T00:00:00Z");
    expect(await getSpendSummary({ from })).toEqual({
      total_usd: 2.5,
      by_agent: { planner: 2, agt_other: 0.5 },
      by_session: { ses_1: 1 },
      balance_usd: 247.5,
    });
    expect(spend).toHaveBeenCalledWith({ from: "2026-11-07T00:00:00.000Z" });
  });

  it("re-uses a minted file URL until it nears expiry", async () => {
    const url = vi.fn(async () => ({ object: "file_url", url: "https://x/f.png", expires_at: new Date(Date.now() + 7 * 864e5).toISOString() }));
    mockClient({ files: { url } });
    expect(await fileUrl("fil_1")).toBe("https://x/f.png");
    expect(await fileUrl("fil_1")).toBe("https://x/f.png");
    expect(url).toHaveBeenCalledTimes(1);
  });
});

/** Offline mode (npm run dev:local): session helpers never reach Naïve. */
import type { VettaClient } from "@usenaive-sdk/managed-agents";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, setDb, type Db } from "../db/client";
import { migrate } from "../db/migrate";
import { setNaive } from "./client";
import { decideApproval, listPendingApprovals, OFFLINE_SESSION_PREFIX, startAgentSession } from "./sessions";

let db: Db;
const create = vi.fn(async () => ({ id: "ses_real" }));
const list = vi.fn(async () => ({ data: [], has_more: false, next_cursor: null }));

beforeAll(async () => {
  db = await createDb({ memory: true });
  await migrate(db);
  setDb(db);
  setNaive({ sessions: { create, list, get: vi.fn(), confirmTool: vi.fn() } } as unknown as VettaClient);
});
afterAll(async () => {
  setNaive(null);
  setDb(null);
  await db.close();
});
afterEach(() => {
  vi.unstubAllEnvs();
  create.mockClear();
  list.mockClear();
});

describe("offline mode", () => {
  it("startAgentSession returns a stand-in id, logs offline.skipped and never calls Naïve", async () => {
    vi.stubEnv("TERRAGENT_OFFLINE", "1");
    const a = await startAgentSession("comms-customer", "Screen req_1", { requestId: "req_offline1", idempotencyKey: "handoff:req_offline1:0:comms-customer", metadata: { stage: "screening" } });
    const again = await startAgentSession("comms-customer", "Screen req_1", { requestId: "req_offline1", idempotencyKey: "handoff:req_offline1:0:comms-customer" });
    expect(a.session_id.startsWith(OFFLINE_SESSION_PREFIX)).toBe(true);
    expect(again.session_id).toBe(a.session_id); // same idempotency key → same id, like the real API
    expect(create).not.toHaveBeenCalled();
    const events = await db.query<{ type: string; actor: string; payload: Record<string, unknown> }>(
      "SELECT type, actor, payload FROM events WHERE request_id = 'req_offline1' ORDER BY id",
    );
    expect(events[0]).toMatchObject({ type: "offline.skipped", actor: "system", payload: { service: "naive", call: "sessions.create", agent: "comms-customer", stage: "screening" } });
    expect(events).toHaveLength(2);
  });

  it("is on whenever the local demo database is in use, even without TERRAGENT_OFFLINE", async () => {
    vi.stubEnv("TERRAGENT_DB", "local");
    expect((await startAgentSession("planner", "Plan")).session_id.startsWith(OFFLINE_SESSION_PREFIX)).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it("lists no parked calls and refuses to decide one", async () => {
    vi.stubEnv("TERRAGENT_OFFLINE", "1");
    expect(await listPendingApprovals()).toEqual([]);
    await expect(decideApproval("ses_1", "tc_1", "deny", "no")).rejects.toThrow(/Offline mode/);
    expect(list).not.toHaveBeenCalled();
  });
});

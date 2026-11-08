/** Offline mode (npm run dev:local): the Monid wrapper never reaches the network and never books spend. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, setDb, type Db } from "../db/client";
import { migrate } from "../db/migrate";
import { monidDiscover, monidRun } from "./client";

let db: Db;
const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));

beforeAll(async () => {
  db = await createDb({ memory: true });
  await migrate(db);
  setDb(db);
});
afterAll(async () => {
  setDb(null);
  await db.close();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchSpy.mockClear();
});

describe("Monid offline guard", () => {
  it("monidRun is REFUSED with reason offline, logs offline.skipped, books nothing and fetches nothing", async () => {
    vi.stubEnv("TERRAGENT_OFFLINE", "1");
    vi.stubEnv("MONID_API_KEY", "monid_live_TESTSECRET");
    vi.stubGlobal("fetch", fetchSpy);
    const r = await monidRun({ provider: "akta", endpoint: "/v1/news", input: { query: "copper" }, purpose: "test", agent: "sourcing", requestId: "req_mon1" });
    expect(r).toEqual({ status: "REFUSED", output: null, cost_usd: 0, run_id: null, reason: "offline" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await db.query("SELECT 1 FROM spend")).toEqual([]);
    expect(await db.query("SELECT type, actor, payload->>'service' AS service FROM events WHERE request_id = 'req_mon1'")).toEqual([
      { type: "offline.skipped", actor: "sourcing", service: "monid" },
    ]);
  });

  it("free calls fail fast instead of reaching Monid", async () => {
    vi.stubEnv("TERRAGENT_DB", "local");
    vi.stubEnv("MONID_API_KEY", "monid_live_TESTSECRET");
    vi.stubGlobal("fetch", fetchSpy);
    await expect(monidDiscover("geocode")).rejects.toThrow(/offline mode/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

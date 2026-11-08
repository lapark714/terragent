/** Neon $250 rule (NOTES H4c): one database read per window however many viewers poll, and no retry loop on a quota stop. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, setDb, type Db } from "../db/client";
import { migrate } from "../db/migrate";

vi.mock("../naive/board", () => ({ listCards: vi.fn(async () => []) }));
vi.mock("../naive/spend", () => ({ getSpendSummary: vi.fn(async () => ({ total_usd: 0, by_agent: {}, balance_usd: 0 })) }));
vi.mock("../naive/sessions", () => ({ listPendingApprovals: vi.fn(async () => []), decideApproval: vi.fn(async () => {}) }));

const { cached, cachedLiveSnapshot, cachedOverview, DASHBOARD_TTL_MS, invalidateDashboard } = await import("./cache");
const { DB_PAUSE_MS, isDbPaused, isDbSuspendedError, resetDbPause } = await import("./rows");
const { GET: overviewRoute } = await import("@/app/api/dashboard/overview/route");
const { GET: globeRoute } = await import("@/app/api/dashboard/globe/route");

let db: Db;

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
  vi.useRealTimers();
  invalidateDashboard();
  resetDbPause();
  setDb(db);
});

/** A Neon-shaped database that answers every query with `error`, counting calls. */
function failingDb(error: string) {
  const query = vi.fn(async () => {
    throw new Error(error);
  });
  return { db: { kind: "neon" as const, query, close: async () => {} }, query };
}

describe("dashboard cache", () => {
  it("shares one read between concurrent viewers and reuses it until the window ends", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fn = vi.fn(async () => ({ n: fn.mock.calls.length }));
    const [a, b] = await Promise.all([cached("k", fn), cached("k", fn)]);
    expect(a).toBe(b);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(DASHBOARD_TTL_MS - 100);
    await cached("k", fn);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(200);
    expect(await cached("k", fn)).toEqual({ n: 2 });
    invalidateDashboard();
    await cached("k", fn);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("caches a failure for the window too, so a broken database isn't hit by every viewer", async () => {
    const fn = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(cached("bad", fn)).rejects.toThrow("boom");
    await expect(cached("bad", fn)).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("makes one snapshot read per window for many viewers", async () => {
    const spy = vi.spyOn(db, "query");
    await Promise.all(Array.from({ length: 20 }, () => cachedLiveSnapshot()));
    const perSnapshot = spy.mock.calls.length;
    await Promise.all(Array.from({ length: 20 }, () => cachedLiveSnapshot()));
    expect(spy.mock.calls.length).toBe(perSnapshot); // the second wave read nothing
    spy.mockRestore();
  });
});

describe("database paused (Neon quota)", () => {
  it("recognises Neon's quota and suspension wording, and nothing else", () => {
    for (const msg of [
      "Your account or project has exceeded the compute time quota. Upgrade your plan to increase limits.",
      "The compute is suspended until the next billing period",
      "data transfer quota exceeded",
      "endpoint is disabled",
    ]) expect(isDbSuspendedError(new Error(msg))).toBe(true);
    for (const msg of ["relation \"requests\" does not exist", "fetch failed", "timeout exceeded"]) expect(isDbSuspendedError(new Error(msg))).toBe(false);
  });

  it("flags dbSuspended on the overview and stops reading until the pause ends (no retry loop)", async () => {
    const { db: paused, query } = failingDb("Your project has exceeded the compute time quota.");
    setDb(paused);
    const res = await overviewRoute();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, suspended: true, dbSuspended: true });
    expect(isDbPaused()).toBe(true);
    const calls = query.mock.calls.length;

    // Another viewer, the live snapshot and the globe: none of them touches the database while it is paused.
    invalidateDashboard();
    expect(await cachedOverview()).toMatchObject({ dbSuspended: true });
    const snap = await cachedLiveSnapshot();
    expect(snap.dbSuspended).toBe(true);
    expect(snap.overview).toMatchObject({ ok: false, suspended: true });
    const globe = await globeRoute();
    expect(globe.status).toBe(503);
    expect(await globe.json()).toMatchObject({ error: "db_suspended", dbSuspended: true });
    expect(query.mock.calls.length).toBe(calls);
    expect(DB_PAUSE_MS).toBeGreaterThanOrEqual(30_000);
  });

  it("keeps other database errors as ordinary panel failures", async () => {
    const { db: broken } = failingDb("relation \"requests\" does not exist");
    setDb(broken);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const o = await cachedOverview();
    errors.mockRestore();
    expect(o).toMatchObject({ ok: false, dbSuspended: false });
    expect(isDbPaused()).toBe(false);
  });
});

/** GET /api/requests/{id}/status: public and polled per open tab, so it must not reach Neon on every hit (NOTES H4c). */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resetMemoryLimits } from "@/lib/api-keys";
import { createDb, setDb, type Db } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";
import { invalidateDashboard, MAX_CACHE_ENTRIES, STATUS_TTL_MS } from "@/lib/dashboard/cache";
import { resetDbPause } from "@/lib/dashboard/rows";

const { GET } = await import("./[id]/status/route");

let db: Db;
let ip = 0;

const get = (id: string, from = `10.9.0.${++ip}`) =>
  GET(new Request(`http://localhost/api/requests/${id}/status`, { headers: { "x-forwarded-for": from } }), { params: Promise.resolve({ id }) });

beforeAll(async () => {
  db = await createDb({ memory: true });
  await migrate(db);
  setDb(db);
  await db.query("INSERT INTO requests (id, source, question, status) VALUES ('req_status0001', 'portal', 'Did the river flood?', 'planning')");
  await db.query("INSERT INTO events (request_id, type, actor) VALUES ('req_status0001', 'request.created', 'system')");
});
afterAll(async () => {
  setDb(null);
  await db.close();
});
afterEach(() => {
  vi.useRealTimers();
  invalidateDashboard();
  resetMemoryLimits();
  resetDbPause();
  setDb(db);
});

describe("GET /api/requests/[id]/status", () => {
  it("answers many polls from one read per window, unknown ids included", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const spy = vi.spyOn(db, "query");
    const first = await get("req_status0001");
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ id: "req_status0001", status: "planning", terminal: false, events: [{ type: "request.created" }] });
    const perRead = spy.mock.calls.length;
    expect(perRead).toBeGreaterThan(0);
    for (let i = 0; i < 10; i++) expect((await get("req_status0001")).status).toBe(200);
    expect(spy.mock.calls.length).toBe(perRead);

    // A miss is cached too: one lookup, however often a made-up id is asked for.
    expect((await get("req_nosuch0001")).status).toBe(404);
    const afterMiss = spy.mock.calls.length;
    expect(afterMiss).toBe(perRead + 1);
    expect((await get("req_nosuch0001")).status).toBe(404);
    expect(spy.mock.calls.length).toBe(afterMiss);

    // Malformed ids never reach the database.
    expect((await get("not-an-id")).status).toBe(404);
    expect(spy.mock.calls.length).toBe(afterMiss);

    vi.advanceTimersByTime(STATUS_TTL_MS + 1);
    await get("req_status0001");
    expect(spy.mock.calls.length).toBe(afterMiss + perRead);
    spy.mockRestore();
  });

  it("caps cache misses per IP in memory, without a database write per hit", async () => {
    const from = "10.9.9.9";
    const spy = vi.spyOn(db, "query");
    let limited: Response | undefined;
    for (let i = 0; i < 400 && !limited; i++) {
      const res = await get(`req_flood${String(i).padStart(5, "0")}`, from);
      if (res.status === 429) limited = res;
    }
    expect(limited?.status).toBe(429);
    expect(Number(limited?.headers.get("Retry-After"))).toBeGreaterThan(0);
    const reads = spy.mock.calls.length;
    expect(reads).toBeLessThanOrEqual(240); // one lookup per allowed miss, nothing for the refused ones
    expect(spy.mock.calls.every(([sql]) => !/rate_limits/.test(String(sql)))).toBe(true);
    // Cached ids still answer for that IP, and other IPs are unaffected.
    expect((await get("req_flood00000", from)).status).toBe(404);
    expect((await get("req_status0001")).status).toBe(200);
    expect(spy.mock.calls.length).toBeGreaterThan(reads); // the other IP's read
    spy.mockRestore();
  });

  it("keeps memory bounded however many ids are asked for", async () => {
    for (let i = 0; i < MAX_CACHE_ENTRIES + 50; i++) await get(`req_bound${String(i).padStart(5, "0")}`);
    // The oldest entries were dropped: asking for the first id again reads the database again.
    const spy = vi.spyOn(db, "query");
    await get("req_bound00000");
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("answers 503 without echoing the error when the database fails", async () => {
    const broken = { kind: "neon" as const, query: vi.fn(async () => { throw new Error("postgresql://owner:FAKEPASSWORD@ep-x/neondb is not a valid URL"); }), close: async () => {} };
    setDb(broken);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await get("req_status0002");
    errors.mockRestore();
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("FAKEPASSWORD");
  });
});

import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CAPS } from "../config";
import { createDb, type Db } from "../db/client";
import { migrate } from "../db/migrate";
import { fixtureJson, json, mockFetch, type Call } from "../signals/__fixtures__/fetch-mock";

const KEY = "monid_live_TESTSECRET";
const FIX = path.join(import.meta.dirname, "__fixtures__");
const inspectFixtures: Record<string, string> = {
  "akta /v1/news": "inspect-akta-news.json",
  "api.kadec0.xyz /v1/geocode": "inspect-kadec0-geocode.json",
  "hunterio /email-finder": "inspect-hunterio-email-finder.json",
};

let db: Db;

/** Fresh client module (empty inspect cache) wired to the test database. */
async function load() {
  vi.resetModules();
  (await import("../db/client")).setDb(db);
  return import("./client");
}

const body = (c: Call) => JSON.parse(String(c.init.body ?? "null"));
const inspectRoute = (overrides: Record<string, unknown> = {}): [string, (c: Call) => Response] => [
  "/v1/inspect",
  (c) => {
    const { provider, endpoint } = body(c);
    const key = `${provider} ${endpoint}`;
    if (overrides[key]) return json(overrides[key]);
    return inspectFixtures[key] ? json(fixtureJson(inspectFixtures[key], FIX)) : json({ message: "not found" }, 404);
  },
];
const completed = (extra: object = {}) => ({
  runId: "01RUN",
  provider: "akta",
  endpoint: "/v1/news",
  status: "COMPLETED",
  output: { count: 1, data: [{ id: "a1", title: "t" }] },
  providerResponse: { httpStatus: 200 },
  billing: { reportedCost: { currency: "USD", value: 7500, unit: "MICRO_DOLLAR" } },
  ...extra,
});
const newsArgs = { provider: "akta", endpoint: "/v1/news", input: { query: "copper drilling", limit: 50 }, purpose: "test", agent: "sourcing", requestId: "req_1" };

/** Resolve a promise that sleeps on fake setTimeout while real I/O (PGlite) keeps running. */
async function settle<T>(p: Promise<T>): Promise<T> {
  let done = false;
  void p.then(
    () => (done = true),
    () => (done = true),
  );
  while (!done) {
    await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(1000);
  }
  return p;
}

async function spendRows() {
  return db.query<{ amount_usd: string; is_estimate: boolean; agent: string; request_id: string; meta: Record<string, unknown> }>(
    "SELECT amount_usd, is_estimate, agent, request_id, meta FROM spend WHERE service = 'monid' ORDER BY id",
  );
}

beforeAll(async () => {
  db = await createDb({ memory: true });
  await migrate(db);
});
afterAll(() => db.close());
beforeEach(async () => {
  vi.stubEnv("MONID_API_KEY", KEY);
  await db.query("DELETE FROM spend");
  await db.query("DELETE FROM events");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("free calls", () => {
  it("discover maps price cards and marks allowlisted endpoints", async () => {
    const calls = mockFetch([["/v1/discover/endpoints", json(fixtureJson("discover-endpoints.json", FIX))]]);
    const { monidDiscover } = await load();
    const items = await monidDiscover("company news", 3);
    expect(body(calls[0])).toEqual({ q: "company news", limit: 3 });
    expect(items[0]).toMatchObject({ provider: "akta", endpoint: "/v1/news", price_usd: 0.0055, allowlisted: true, health: "healthy" });
    expect(items[1]).toMatchObject({ provider: "apollo", endpoint: "/news_articles/search", price_usd: 0.026, allowlisted: false });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
  });

  it("inspect is cached; balance reads the wallet", async () => {
    const calls = mockFetch([inspectRoute(), ["/v1/wallet/balance", json(fixtureJson("balance.json", FIX))]]);
    const { monidInspect, monidBalance } = await load();
    const a = await monidInspect("akta", "/v1/news");
    await monidInspect("akta", "/v1/news");
    expect(a).toMatchObject({ method: "GET", price_usd: 0.0055, allowlisted: true });
    expect(calls.filter((c) => c.url.endsWith("/v1/inspect"))).toHaveLength(1);
    expect(await monidBalance()).toEqual({ balance_usd: 20, held_usd: 0 });
  });

  it("errors name the status, never the key", async () => {
    mockFetch([["/v1/wallet/balance", json({ code: 401, message: "Invalid API key" }, 401)]]);
    const { monidBalance } = await load();
    await expect(monidBalance()).rejects.toThrow("Monid balance failed: 401 Invalid API key");
  });
});

describe("monidRun guards", () => {
  it("refuses endpoints that are not allowlisted, before any network call", async () => {
    const calls = mockFetch([]);
    const { monidRun } = await load();
    const r = await monidRun({ provider: "apollo", endpoint: "/people/match", input: {}, purpose: "x", agent: "sourcing" });
    expect(r).toMatchObject({ status: "REFUSED", cost_usd: 0, run_id: null });
    expect(r.reason).toMatch(/not on the Monid allowlist/);
    expect(calls).toHaveLength(0);
    const [ev] = await db.query<{ type: string; actor: string; payload: { status: string } }>("SELECT type, actor, payload FROM events");
    expect(ev).toMatchObject({ type: "monid.run", actor: "sourcing", payload: { status: "REFUSED" } });
  });

  it("refuses when the live price is over the per-call cap", async () => {
    const pricey = { price: { type: "PER_CALL", amount: { value: CAPS.monidMaxUsdPerCall + 0.05, currency: "USD" } } };
    const calls = mockFetch([inspectRoute({ "zillow /get_zestimate": pricey })]);
    const { monidRun } = await load();
    const r = await monidRun({ provider: "zillow", endpoint: "/get_zestimate", input: { zpid: "1" }, purpose: "x" });
    expect(r.status).toBe("REFUSED");
    expect(r.reason).toMatch(/over the per-call cap/);
    expect(calls.some((c) => c.url.endsWith("/v1/run"))).toBe(false);
  });

  it("refuses when an unpriceable card would have to be assumed free", async () => {
    mockFetch([inspectRoute({ "zillow /get_zestimate": { price: { type: "PER_UNIT", amount: { value: 0.001, currency: "USD" }, per: 1000, unit: "token" } } })]);
    const { monidRun } = await load();
    expect((await monidRun({ provider: "zillow", endpoint: "/get_zestimate", input: { zpid: "1" }, purpose: "x" })).status).toBe("REFUSED");
  });

  it("refuses when today's ledger plus the estimate would pass the daily cap (yesterday doesn't count)", async () => {
    await db.query("INSERT INTO spend (service, amount_usd) VALUES ('monid', $1)", [CAPS.monidMaxUsdPerDay - 0.005]);
    await db.query("INSERT INTO spend (service, amount_usd, recorded_at) VALUES ('monid', 5, now() - interval '2 days')");
    const calls = mockFetch([inspectRoute()]);
    const { monidRun } = await load();
    const r = await monidRun(newsArgs);
    expect(r).toMatchObject({ status: "REFUSED", estimated_usd: 0.01 });
    expect(r.reason).toMatch(/daily Monid cap/);
    expect(calls.some((c) => c.url.endsWith("/v1/run"))).toBe(false);
  });
});

describe("monidRun execution + ledger", () => {
  it("runs a sync endpoint, clamps the result count, and books the reported cost", async () => {
    const calls = mockFetch([inspectRoute(), [/\/v1\/run$/, json(completed())]]);
    const { monidRun } = await load();
    const r = await monidRun(newsArgs);
    expect(r).toMatchObject({ status: "COMPLETED", cost_usd: 0.0075, run_id: "01RUN", estimated_usd: 0.01 });
    expect(r.output).toEqual({ count: 1, data: [{ id: "a1", title: "t" }] });

    const run = calls.find((c) => c.url.endsWith("/v1/run"))!;
    expect(body(run)).toEqual({ provider: "akta", endpoint: "/v1/news", input: { queryParams: { query: "copper drilling", limit: 10 } } });
    expect((run.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);

    const [row] = await spendRows();
    expect(Number(row.amount_usd)).toBe(0.0075);
    expect(row).toMatchObject({ is_estimate: false, agent: "sourcing", request_id: "req_1" });
    expect(row.meta).toMatchObject({ provider: "akta", endpoint: "/v1/news", purpose: "test", run_id: "01RUN", status: "COMPLETED" });
  });

  it("polls async runs (202) until they finish", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    let polls = 0;
    mockFetch([
      inspectRoute(),
      [/\/v1\/run$/, json({ runId: "01ASYNC", provider: "akta", endpoint: "/v1/news", status: "RUNNING" }, 202)],
      ["/v1/runs/01ASYNC", () => json(++polls < 2 ? { runId: "01ASYNC", status: "RUNNING" } : { ...completed({ runId: "01ASYNC", billing: undefined }), cost: { value: 0.006, currency: "USD" } })],
    ]);
    const { monidRun } = await load();
    expect(await settle(monidRun(newsArgs))).toMatchObject({ status: "COMPLETED", cost_usd: 0.006, run_id: "01ASYNC" });
    expect(polls).toBe(2);
    expect(Number((await spendRows())[0].amount_usd)).toBe(0.006);
  });

  it("maps BLOCKED, provider errors and 408 to unbilled results with a zero spend row", async () => {
    const replies = [
      json({ runId: "01B", status: "BLOCKED", reason: "budget reached", controls: [{ controlType: "WORKSPACE_BUDGET" }] }),
      json(completed({ runId: "01P", providerResponse: { httpStatus: 404 }, billing: undefined, cost: { value: 0, currency: "USD" } }), 404),
      json({ runId: "01T", status: "TIMED_OUT" }, 408),
    ];
    mockFetch([inspectRoute(), [/\/v1\/run$/, () => replies.shift()!]]);
    const { monidRun } = await load();
    const blocked = await monidRun(newsArgs);
    const provider = await monidRun(newsArgs);
    const timedOut = await monidRun(newsArgs);
    expect(blocked).toMatchObject({ status: "BLOCKED", cost_usd: 0, run_id: "01B" });
    expect(blocked.reason).toMatch(/WORKSPACE_BUDGET.*budget reached/);
    expect(provider).toMatchObject({ status: "FAILED", cost_usd: 0, run_id: "01P" });
    expect(provider.reason).toMatch(/provider returned HTTP 404/);
    expect(timedOut).toMatchObject({ status: "TIMED_OUT", cost_usd: 0 });
    const rows = await spendRows();
    expect(rows.map((r) => [Number(r.amount_usd), r.is_estimate, r.meta.status])).toEqual([[0, false, "BLOCKED"], [0, false, "FAILED"], [0, false, "TIMED_OUT"]]);
  });

  it("402 (wallet empty) is BLOCKED with no run and no spend row", async () => {
    mockFetch([inspectRoute(), [/\/v1\/run$/, json({ code: 402, message: "Insufficient funds", errorCode: "WALLET_INSUFFICIENT_FUNDS" }, 402)]]);
    const { monidRun } = await load();
    const r = await monidRun(newsArgs);
    expect(r).toMatchObject({ status: "BLOCKED", run_id: null });
    expect(r.reason).toMatch(/wallet balance too low/);
    expect(await spendRows()).toHaveLength(0);
  });

  it("a lost response books the estimate (the run may exist) and never echoes the key", async () => {
    mockFetch([
      inspectRoute(),
      [/\/v1\/run$/, () => { throw new TypeError(`fetch failed for Bearer ${KEY}`); }],
    ]);
    const { monidRun } = await load();
    const r = await monidRun(newsArgs);
    expect(r.status).toBe("FAILED");
    expect(r.reason).toMatch(/the run may exist/);
    expect(r.reason).not.toContain(KEY);
    const [row] = await spendRows();
    expect([Number(row.amount_usd), row.is_estimate]).toEqual([0.01, true]);
    const events = await db.query<{ payload: object }>("SELECT payload FROM events");
    expect(JSON.stringify(events)).not.toContain(KEY);
  });

  it("a 5xx without a run id books the estimate; a 4xx rejection books nothing", async () => {
    const replies = [json({ message: "Gateway Timeout" }, 504), json({ message: "invalid input" }, 400)];
    mockFetch([inspectRoute(), [/\/v1\/run$/, () => replies.shift()!]]);
    const { monidRun } = await load();
    const gateway = await monidRun(newsArgs);
    expect(gateway).toMatchObject({ status: "FAILED", cost_usd: 0, run_id: null });
    expect(gateway.reason).toMatch(/504 Gateway Timeout; the run may exist/);
    const rejected = await monidRun(newsArgs);
    expect(rejected.reason).toMatch(/run rejected: 400 invalid input/);
    const rows = await spendRows();
    expect(rows.map((r) => [Number(r.amount_usd), r.is_estimate])).toEqual([[0.01, true]]);
  });

  it("stringifies params for kadec0 and passes composite input through", async () => {
    const calls = mockFetch([inspectRoute(), [/\/v1\/run$/, json(completed({ provider: "api.kadec0.xyz", endpoint: "/v1/geocode" }))]]);
    const { monidRun } = await load();
    await monidRun({ provider: "api.kadec0.xyz", endpoint: "/v1/geocode", input: { queryParams: { q: "Arcadia", maxItems: 1 } }, purpose: "geocode" });
    expect(body(calls.find((c) => c.url.endsWith("/v1/run"))!).input).toEqual({ queryParams: { q: "Arcadia", maxItems: "1" } });
  });
});

/** Local UI mode: the demo seed fills every dashboard panel, marks its rows, and can never target Neon. */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, setDb, type Db } from "../src/lib/db/client";
import { migrate } from "../src/lib/db/migrate";
import { QuoteOption, REQUEST_STATUSES } from "../src/lib/domain";

vi.mock("../src/lib/naive/board", () => ({ listCards: vi.fn(async () => []) }));
vi.mock("../src/lib/naive/spend", () => ({ getSpendSummary: vi.fn(async () => ({ total_usd: 0, by_agent: {}, balance_usd: 0 })) }));
vi.mock("../src/lib/naive/sessions", () => ({ listPendingApprovals: vi.fn(async () => []), decideApproval: vi.fn(async () => {}) }));

const { assertDemoTarget, COCOA_OPTIONS, demoDataDir, HUALIEN_OPTIONS, NotLocalError, pcImageUrl, seedDemo, siteBox, SITES } = await import("./seed-demo");
const { getLiveSnapshot } = await import("../src/lib/dashboard/snapshot");
const { getGlobeData } = await import("../src/lib/dashboard/globe");
const { getApprovals } = await import("../src/lib/dashboard/approvals");
const { getPublicReport, getQuoteByToken, getRequestProgress } = await import("../src/lib/dashboard/public");
const { acceptToken } = await import("../src/components/request/quote");
const { invalidateLive } = await import("../src/lib/dashboard/rows");
const { seedProviders } = await import("../db/seeds/providers");

let db: Db;
let counts: Awaited<ReturnType<typeof seedDemo>>;

beforeAll(async () => {
  db = await createDb({ memory: true });
  await migrate(db);
  setDb(db);
  await seedProviders(db);
  counts = await seedDemo(db, { now: new Date() });
});
afterAll(async () => {
  setDb(null);
  await db.close();
});
beforeEach(() => {
  invalidateLive();
  vi.stubEnv("TERRAGENT_OFFLINE", "1");
});

describe("guards", () => {
  it("refuses to run unless TERRAGENT_DB=local, and refuses anything but PGlite", () => {
    expect(() => assertDemoTarget({ TERRAGENT_DB: "memory" })).toThrow(NotLocalError);
    expect(() => assertDemoTarget({ DATABASE_URL: "postgres://prod" })).toThrow(NotLocalError);
    expect(() => assertDemoTarget({ TERRAGENT_DB: "local" }, { kind: "neon" })).toThrow(/only writes to local PGlite/);
    expect(() => assertDemoTarget({ TERRAGENT_DB: "local" }, { kind: "pglite" })).not.toThrow();
  });

  it("only ever wipes a .pglite-demo folder inside the repo", () => {
    const cwd = "/repo";
    expect(demoDataDir({}, cwd)).toBe(path.resolve("/repo/.pglite-demo"));
    expect(demoDataDir({ PGLITE_DATA_DIR: ".pglite-demo-aarush" }, cwd)).toBe(path.resolve("/repo/.pglite-demo-aarush"));
    for (const bad of [".pglite", ".", "..", "../.pglite-demo", "/tmp/.pglite-demo", "src"]) {
      expect(() => demoDataDir({ PGLITE_DATA_DIR: bad }, cwd)).toThrow(NotLocalError);
    }
  });

  it("the CLI exits before opening any database without TERRAGENT_DB=local", async () => {
    const run = promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/seed-demo.ts"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: { ...process.env, TERRAGENT_DB: "", DATABASE_URL: "postgres://user:pw@neon.invalid/db" },
      timeout: 60_000,
    });
    await expect(run).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("only runs with TERRAGENT_DB=local") });
  });
});

describe("demo data", () => {
  it("fills every live panel", async () => {
    const s = await getLiveSnapshot();
    expect(s.offline).toBe(true);
    expect(s.dbSuspended).toBe(false);
    for (const p of [s.overview, s.funnel, s.board, s.decisions, s.money, s.interventions, s.allocation, s.activity]) expect(p.ok).toBe(true);
    if (!s.overview.ok || !s.funnel.ok || !s.board.ok || !s.decisions.ok || !s.money.ok || !s.interventions.ok || !s.allocation.ok || !s.activity.ok) return;

    const o = s.overview.data;
    expect(o.inbound).toBeGreaterThan(10);
    expect(o.samples).toBeGreaterThan(5);
    expect(o.reportsDelivered).toBeGreaterThanOrEqual(8);
    expect(o.firstTouches).toBeGreaterThanOrEqual(5);
    expect(o.touchesHeld).toBeGreaterThanOrEqual(3);
    expect(o.replies).toBeGreaterThanOrEqual(3);
    expect(o.indexCells).toBeGreaterThan(250);
    expect(o.medianAnswerSeconds).toBeGreaterThan(60);

    for (const stage of s.funnel.data) expect(stage.total, stage.key).toBeGreaterThan(0);
    const touches = s.funnel.data.find((f) => f.key === "touches")!;
    expect(touches.byPlaybook.disasters && touches.byPlaybook.deforestation && touches.byPlaybook.mining).toBeTruthy();

    // Every board status has a card, each with an owner agent.
    const statuses = new Set(s.board.data.requests.map((r) => r.status));
    for (const status of REQUEST_STATUSES) expect(statuses.has(status), status).toBe(true);
    expect(s.board.data.requests.every((r) => r.owner)).toBe(true);
    expect(s.board.data.naive).toEqual({ state: "offline" });

    const kinds = new Set(s.decisions.data.rows.map((d) => d.kind));
    for (const k of ["source_selection", "free_vs_paid", "pricing", "screening", "playbook_allocation", "verification"] as const) expect(kinds.has(k), k).toBe(true);
    expect(s.decisions.data.freeVsPaid.map((c) => c.choice).sort()).toEqual(["free", "paid"]);

    expect(s.money.data.spend.total).toBeGreaterThan(5);
    expect(s.money.data.spend.monid).toBeGreaterThan(0);
    expect(s.money.data.revenue).toMatchObject({ paid: 171, committed: 78, stated: 150 });
    expect(s.money.data.perRequest.length).toBeGreaterThan(10);

    expect(s.interventions.data.total).toBeGreaterThanOrEqual(3);
    expect(s.interventions.data.total).toBeLessThanOrEqual(5);
    expect(counts.interventions).toBe(s.interventions.data.total);

    // The coordinator shifted effort: the starting split, then three decisions ending on disasters.
    const alloc = s.allocation.data;
    expect(alloc.length).toBeGreaterThanOrEqual(4);
    expect(alloc.at(-1)!.weights.disasters).toBeGreaterThan(alloc[1].weights.disasters);

    expect(s.activity.data.length).toBeGreaterThan(5);
    expect(Date.now() - Date.parse(s.activity.data[0].at)).toBeLessThan(10 * 60_000); // something happened minutes ago
  });

  it("puts a paid-option comparison and its order on hold for a founder", async () => {
    const s = await getLiveSnapshot();
    if (!s.decisions.ok) throw new Error("decisions failed");
    const paid = s.decisions.data.rows.find((d) => d.kind === "free_vs_paid" && d.choice === "paid")!;
    expect(paid.alternatives.length).toBeGreaterThanOrEqual(3);
    expect(paid.alternatives.filter((a) => (a.cost_usd ?? 0) > 0).length).toBeGreaterThanOrEqual(2);

    const ap = await getApprovals();
    expect(ap.orders).toHaveLength(1);
    expect(ap.orders[0]).toMatchObject({ provider: "sw-pneo-30cm", estCostUsd: 210, request: paid.request });
    expect(ap.quotes).toHaveLength(1);
    expect(ap.quotes[0].priceUsd).toBeGreaterThan(50);
    expect(ap.templates.length).toBeGreaterThanOrEqual(3);
    expect(ap.naive).toEqual({ state: "offline" });
    expect(ap.inboxes.find((i) => i.role === "outreach")?.armed).toBe(true);
  });

  it("covers all four globe layers on several continents", async () => {
    const g = await getGlobeData();
    expect(new Set(g.cells.region.map((c) => c.layer))).toEqual(new Set(["disasters", "forest", "mining", "inbound"]));
    expect(g.signals.length).toBe(counts.signals);
    expect(counts.signals).toBeGreaterThanOrEqual(35);
    const lats = g.cells.world.map((c) => c.lat);
    const lngs = g.cells.world.map((c) => c.lng);
    expect(Math.min(...lats)).toBeLessThan(-15); // South America / Australia
    expect(Math.max(...lats)).toBeGreaterThan(35); // North America / Europe
    expect(Math.max(...lngs)).toBeGreaterThan(100); // Asia / Australia
    const [{ n }] = await db.query<{ n: number }>("SELECT count(DISTINCT h3_cell)::int AS n FROM earth_index");
    expect(Number(n)).toBeGreaterThanOrEqual(280);
  });

  it("serves delivered reports with real Sentinel-2 image URLs, measurements and sources", async () => {
    const rows = await db.query<{ public_token: string }>(
      "SELECT rp.public_token FROM reports rp JOIN requests r ON r.id = rp.request_id WHERE r.status = 'delivered' AND r.is_free_sample ORDER BY rp.created_at LIMIT 1",
    );
    const report = await getPublicReport(rows[0].public_token);
    expect(report).not.toBeNull();
    expect(report!.images.map((i) => i.role)).toEqual(expect.arrayContaining(["before", "after"]));
    for (const img of report!.images) expect(img.src).toMatch(/^https:\/\/planetarycomputer\.microsoft\.com\/api\/data\/v1\/item\/bbox\//);
    expect(report!.measurements.length).toBeGreaterThan(0);
    expect(report!.sources[0]).toMatchObject({ collection: "sentinel-2-l2a", itemId: expect.stringMatching(/^S2[ABC]_MSIL2A_/) });
    const [{ n }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM reports");
    expect(Number(n)).toBeGreaterThanOrEqual(10);
  });

  it("marks demo rows and keeps outreach to fictional .example addresses", async () => {
    const unmarked = await db.query<{ t: string; n: number }>(
      `SELECT 'requests' AS t, count(*)::int AS n FROM requests WHERE meta->>'demo' IS DISTINCT FROM 'true'
       UNION ALL SELECT 'reports', count(*)::int FROM reports WHERE meta->>'demo' IS DISTINCT FROM 'true'
       UNION ALL SELECT 'prospects', count(*)::int FROM prospects WHERE meta->>'demo' IS DISTINCT FROM 'true'
       UNION ALL SELECT 'signals', count(*)::int FROM signals WHERE raw->>'demo' IS DISTINCT FROM 'true'
       UNION ALL SELECT 'earth_index', count(*)::int FROM earth_index WHERE meta->>'demo' IS DISTINCT FROM 'true'
       UNION ALL SELECT 'events', count(*)::int FROM events WHERE payload->>'demo' IS DISTINCT FROM 'true'
       UNION ALL SELECT 'messages', count(*)::int FROM messages WHERE meta->>'demo' IS DISTINCT FROM 'true'
       UNION ALL SELECT 'spend', count(*)::int FROM spend WHERE meta->>'demo' IS DISTINCT FROM 'true'
       UNION ALL SELECT 'orders', count(*)::int FROM orders WHERE meta->>'demo' IS DISTINCT FROM 'true'`,
    );
    expect(unmarked.filter((r) => Number(r.n) > 0)).toEqual([]);
    const emails = await db.query<{ e: string }>(
      "SELECT counterpart_email AS e FROM messages WHERE counterpart_email IS NOT NULL UNION SELECT customer_email FROM requests WHERE customer_email IS NOT NULL",
    );
    for (const { e } of emails) expect(e).toMatch(/@([a-z0-9-]+\.)*(example|example\.com)$/);
  });

  it("has a pricing v2 quote waiting for the customer: three options, an accept link, valid for a week", async () => {
    for (const o of [...COCOA_OPTIONS, ...HUALIEN_OPTIONS]) expect(() => QuoteOption.parse(o), o.option_id).not.toThrow();
    const [row] = await db.query<{ id: string; accept_token: string; meta: { demo?: boolean } }>(
      `SELECT r.id, q.accept_token, r.meta FROM requests r JOIN quotes q ON q.id = r.quote_id WHERE r.status = 'quoted' AND jsonb_array_length(q.options) = 3`,
    );
    expect(row.meta.demo).toBe(true);
    const p = (await getRequestProgress(row.id))!;
    const quote = p.quote!;
    expect(quote.options.map((o) => [o.option_id, o.kind, o.resolution_m, o.price_usd, o.price_range_usd, o.needs_supplier_quote])).toEqual([
      ["A", "free_data", 10, 29, null, false],
      ["B", "archive", 0.5, 85, null, false],
      ["C", "tasking", 0.3, null, [450, 700], true],
    ]);
    expect(quote).toMatchObject({ recommended_option_id: "B", accepted_option_id: null, closed_reason: null });
    expect(acceptToken(quote.accept_url)).toBe(row.accept_token);
    expect(Date.parse(quote.valid_until!) - Date.now()).toBeGreaterThan(6 * 86_400_000);
    // The accept link finds the same quote (what POST /api/quotes/accept and the quote page read).
    expect((await getQuoteByToken(row.accept_token))?.requestId).toBe(row.id);
    // No costs, margins or suppliers reach the customer.
    expect(JSON.stringify(quote)).not.toMatch(/margin|risk_buffer|unit_price|provider_id|sw-skysat/);
  });

  it("has a paid option the customer accepted, waiting while a founder buys the imagery", async () => {
    const [row] = await db.query<{ id: string }>(
      "SELECT r.id FROM requests r JOIN quotes q ON q.id = r.quote_id WHERE r.status = 'awaiting_approval' AND q.accepted_option_id IS NOT NULL",
    );
    const p = (await getRequestProgress(row.id))!;
    expect(p.quote).toMatchObject({ accepted_option_id: "B", closed_reason: "accepted", accept_url: null });
    expect(p.quote!.options.find((o) => o.option_id === "B")).toMatchObject({ kind: "archive", label: "Sharp archive image", price_usd: 295 });
    expect(Date.parse(p.quote!.accepted_at!)).toBeLessThan(Date.parse(p.updatedAt));
    // Its paid order is the one held for a founder, and the timeline shows the acceptance before it.
    const held = await db.query<{ request_id: string }>("SELECT request_id FROM orders WHERE status = 'awaiting_approval'");
    expect(held.map((o) => o.request_id)).toEqual([row.id]);
    const types = p.events.map((e) => e.type);
    expect(types.indexOf("quote.accepted")).toBeGreaterThan(types.indexOf("quote.sent"));
    expect(types.indexOf("order.prepared")).toBeGreaterThan(types.indexOf("quote.accepted"));
  });

  it("builds image URLs for a box inside each scene", () => {
    const url = new URL(pcImageUrl(SITES.houston.after.item, siteBox(SITES.houston)));
    expect(url.searchParams.get("item")).toBe(SITES.houston.after.item);
    expect(url.searchParams.get("asset_bidx")).toBe("visual|1,2,3");
    expect(new URL(pcImageUrl(SITES.chaco.after.item, siteBox(SITES.chaco), "ndvi")).searchParams.get("expression")).toBe("(B08-B04)/(B08+B04-2000)");
    for (const s of Object.values(SITES)) expect(s.after.date > s.before.date).toBe(true);
  });
});

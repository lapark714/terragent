/**
 * Pricing v2 acceptance by link: POST /api/quotes/accept, the /quote/<token> page and the quote block of
 * GET /api/requests/{id}/status. The real acceptance service (src/lib/pipeline/acceptance.ts) runs against an
 * in-memory database with TERRAGENT_LANES=off (handoffs are recorded, no Naïve session starts); the spy only counts
 * calls and injects failures. Covers the route's own rules: the token as the only credential, idempotency, no state
 * change on GET, the rate limit, and what the customer may see.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMemoryLimits } from "@/lib/api-keys";
import { invalidateDashboard } from "@/lib/dashboard/cache";
import { resetDbPause } from "@/lib/dashboard/rows";
import { createDb, setDb, type Db } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";
import type * as Acceptance from "@/lib/pipeline/acceptance";

const mocks = vi.hoisted(() => ({ acceptQuoteByToken: vi.fn(), notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }) }));
vi.mock("@/lib/pipeline/acceptance", async (importOriginal) => {
  const actual = await importOriginal<typeof Acceptance>();
  mocks.acceptQuoteByToken.mockImplementation(actual.acceptQuoteByToken);
  return { ...actual, acceptQuoteByToken: mocks.acceptQuoteByToken };
});
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
const { acceptQuote } = await import("@/lib/pipeline/acceptance");

const route = await import("./accept/route");
const { GET: statusGET } = await import("../requests/[id]/status/route");
const { default: QuotePage } = await import("@/app/quote/[token]/page");

const TOKEN = "QuoteTokenAAAAAAAAAAAAAA";
const REQ = "req_quoteflow01";

const OPTIONS = [
  {
    option_id: "A", label: "Free-data check", answers: "Whether water reached the building.", kind: "free_data",
    data: [{ provider_id: "sentinel-2", product: "Sentinel-2 L2A scenes", data_type: "optical", resolution_m: 10, epochs: 2, area_km2: 4, billable_km2: 4,
      unit_price_usd: 0, data_cost_usd: 0, data_cost_range_usd: null, needs_supplier_quote: false }],
    analysis_cost_usd: 1.5, risk_buffer_usd: 0, margin_usd: 27.5, price_usd: 29, price_range_usd: null, delivery_time: "within 2 hours",
    confidence: "medium", notes: ["internal: margin floor applied"],
  },
  {
    option_id: "B", label: "Sharp archive image", answers: "Whether individual roof sections are damaged.", kind: "archive",
    data: [{ provider_id: "up42", product: "archive 0.5 m", data_type: "optical", resolution_m: 0.5, epochs: 1, area_km2: 4, billable_km2: 25,
      unit_price_usd: null, data_cost_usd: null, data_cost_range_usd: [60, 120], needs_supplier_quote: true }],
    analysis_cost_usd: 1.5, risk_buffer_usd: 18, margin_usd: 100, price_usd: null, price_range_usd: [180, 260], delivery_time: "1–2 days",
    confidence: "high", notes: ["supplier quote pending"],
  },
];

let db: Db;
let ip = 0;

const post = (body: unknown, o: { form?: boolean; from?: string } = {}) => {
  const headers: Record<string, string> = { "x-forwarded-for": o.from ?? `10.7.0.${++ip}` };
  let payload: BodyInit;
  if (o.form) {
    payload = new URLSearchParams(body as Record<string, string>);
    headers["content-type"] = "application/x-www-form-urlencoded";
  } else {
    payload = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  return route.POST(new Request("http://localhost/api/quotes/accept", { method: "POST", headers, body: payload }));
};
const status = async (id = REQ) =>
  (await statusGET(new Request(`http://localhost/api/requests/${id}/status`, { headers: { "x-forwarded-for": `10.8.0.${++ip}` } }), {
    params: Promise.resolve({ id }),
  })).json();
const page = async (token = TOKEN, search: Record<string, string> = {}) =>
  renderToStaticMarkup(await QuotePage({ params: Promise.resolve({ token }), searchParams: Promise.resolve(search) }));
const quoteRow = async () =>
  (await db.query<{ accepted_option_id: string | null; status: string }>("SELECT accepted_option_id, status FROM quotes WHERE id = 'qte_flow1'"))[0];

beforeAll(async () => {
  db = await createDb({ memory: true });
  await migrate(db);
  setDb(db);
});
beforeEach(async () => {
  vi.stubEnv("PUBLIC_BASE_URL", "https://terragent.test");
  vi.stubEnv("TERRAGENT_LANES", "off");
  await db.query("TRUNCATE requests, quotes, events, decisions, revenue, orders");
  await db.query(
    `INSERT INTO requests (id, source, question, status, quote_id, meta, acquisition_plan) VALUES ($1, 'portal', $2, 'quoted', 'qte_flow1', '{"screening":{"allowed":true}}', '{"choice":"free"}')`,
    [REQ, "Did the storm damage our roof?\n\n(sent from the portal)"],
  );
  await db.query(
    `INSERT INTO quotes (id, request_id, price_usd, status, options, recommended_option_id, accept_token, valid_until)
     VALUES ('qte_flow1', $1, 180, 'sent', $2, 'B', $3, now() + interval '7 days')`,
    [REQ, JSON.stringify(OPTIONS), TOKEN],
  );
  mocks.acceptQuoteByToken.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  invalidateDashboard();
  resetMemoryLimits();
  resetDbPause();
});
afterAll(async () => {
  setDb(null);
  await db.close();
});

describe("GET /api/requests/[id]/status quote block", () => {
  it("shows the options' public fields, the recommendation and the accept link, never costs, suppliers or notes", async () => {
    const body = await status();
    expect(body.quote).toEqual({
      id: "qte_flow1", status: "sent", recommended_option_id: "B", accepted_option_id: null, accepted_at: null,
      valid_until: expect.any(String), closed_reason: null, accept_url: `https://terragent.test/quote/${TOKEN}`,
      options: [
        { option_id: "A", label: "Free-data check", answers: "Whether water reached the building.", kind: "free_data", resolution_m: 10, data_types: ["optical"],
          epochs: 2, price_usd: 29, price_range_usd: null, needs_supplier_quote: false, delivery_time: "within 2 hours", confidence: "medium", recommended: false },
        { option_id: "B", label: "Sharp archive image", answers: "Whether individual roof sections are damaged.", kind: "archive", resolution_m: 0.5,
          data_types: ["optical"], epochs: 1, price_usd: null, price_range_usd: [180, 260], needs_supplier_quote: true, delivery_time: "1–2 days",
          confidence: "high", recommended: true },
      ],
    });
    expect(JSON.stringify(body)).not.toMatch(/margin|analysis_cost|risk_buffer|unit_price|up42|internal|supplier quote pending/);
  });

  it("has no quote block for a request without one, or with a quote from before options", async () => {
    await db.query("UPDATE quotes SET options = '[]' WHERE id = 'qte_flow1'");
    expect((await status()).quote).toBeNull();
    await db.query("UPDATE requests SET quote_id = NULL");
    invalidateDashboard();
    expect((await status()).quote).toBeNull();
  });
});

describe("POST /api/quotes/accept", () => {
  it("accepts an option through acceptQuote as the customer (link), and the status page shows it", async () => {
    const res = await post({ token: TOKEN, option_id: "b" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ request_id: REQ, status: "awaiting_approval", accepted_option_id: "B", already_accepted: false });
    expect(mocks.acceptQuoteByToken).toHaveBeenCalledOnce();
    const arg = mocks.acceptQuoteByToken.mock.calls[0][0];
    expect(arg).toMatchObject({ token: TOKEN, optionId: "B", actor: "customer (link)" });
    expect(arg.evidence.length).toBeLessThanOrEqual(300);
    expect(await quoteRow()).toEqual({ accepted_option_id: "B", status: "accepted" });

    const body = await status();
    expect(body.status).toBe("awaiting_approval");
    expect(body.quote).toMatchObject({ accepted_option_id: "B", closed_reason: "accepted", accept_url: null });
    expect(body.quote.accepted_at).toEqual(expect.any(String));
  });

  const accepted = async () => ({
    events: (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM events WHERE type = 'quote.accepted'"))[0].n,
    revenue: (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM revenue WHERE kind = 'committed'"))[0].n,
  });

  it("is idempotent: the same option again changes nothing; another option after acceptance is refused", async () => {
    const first = await post({ token: TOKEN, option_id: "A" });
    expect(await first.json()).toMatchObject({ accepted_option_id: "A", already_accepted: false, status: "analyzing" });
    const again = await post({ token: TOKEN, option_id: "A" });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ request_id: REQ, accepted_option_id: "A", already_accepted: true });
    const other = await post({ token: TOKEN, option_id: "B" });
    expect(other.status).toBe(409);
    const body = await other.json();
    expect(body).toMatchObject({ error: "already_accepted", accepted_option_id: "A", message: expect.stringMatching(/reply to the quote email/) });
    expect(body.message).not.toMatch(/add_note|pricing/); // the service's agent-facing wording never reaches the customer
    expect((await quoteRow()).accepted_option_id).toBe("A");
    expect(await accepted()).toEqual({ events: 1, revenue: 1 });
  });

  it("a double click accepts once", async () => {
    const [a, b] = await Promise.all([post({ token: TOKEN, option_id: "B" }), post({ token: TOKEN, option_id: "B" })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([(await a.json()).already_accepted, (await b.json()).already_accepted].sort()).toEqual([false, true]);
    expect(await accepted()).toEqual({ events: 1, revenue: 1 });
  });

  it("after an acceptance by email reply, the link answers as a repeat (or refuses another option)", async () => {
    await acceptQuote({ requestId: REQ, optionId: "A", actor: "comms-customer", evidence: "Yes, go with the free check." });
    expect(await (await post({ token: TOKEN, option_id: "A" })).json()).toMatchObject({ accepted_option_id: "A", already_accepted: true });
    expect((await post({ token: TOKEN, option_id: "B" })).status).toBe(409);
    expect(await accepted()).toEqual({ events: 1, revenue: 1 });
  });

  it("a form post (the quote page) redirects back to the page, with the error code when it fails", async () => {
    const ok = await post({ token: TOKEN, option_id: "A" }, { form: true });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe(`/quote/${TOKEN}`);
    const refused = await post({ token: TOKEN, option_id: "B" }, { form: true });
    expect(refused.status).toBe(303);
    expect(refused.headers.get("location")).toBe(`/quote/${TOKEN}?error=already_accepted`);
  });

  it("refuses malformed input before any read, and unknown tokens, missing options and closed quotes after one", async () => {
    const spy = vi.spyOn(db, "query");
    expect((await post({ token: "short", option_id: "A" })).status).toBe(400);
    expect((await post({ token: TOKEN, option_id: "D" })).status).toBe(400);
    expect((await post({ token: TOKEN })).status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();

    expect((await post({ token: "NoSuchTokenAAAAAAAAAAAAA", option_id: "A" })).status).toBe(404);
    const missing = await post({ token: TOKEN, option_id: "C" });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: "unknown_option" });

    await db.query("UPDATE quotes SET valid_until = now() - interval '1 minute'");
    const expired = await post({ token: TOKEN, option_id: "A" });
    expect(expired.status).toBe(410);
    expect(await expired.json()).toMatchObject({ error: "expired", message: expect.stringMatching(/price it again/) });

    // A newer quote for the same request: the old link no longer accepts anything.
    await db.query("UPDATE quotes SET valid_until = now() + interval '1 day', status = 'sent'");
    await db.query(
      `INSERT INTO quotes (id, request_id, price_usd, status, options, recommended_option_id, accept_token, valid_until)
       VALUES ('qte_newer', $1, 29, 'sent', $2, 'A', 'QuoteTokenBBBBBBBBBBBBBB', now() + interval '7 days')`,
      [REQ, JSON.stringify(OPTIONS)],
    );
    await db.query("UPDATE requests SET quote_id = 'qte_newer'");
    const superseded = await post({ token: TOKEN, option_id: "A" });
    expect(superseded.status).toBe(409);
    expect(await superseded.json()).toMatchObject({ error: "superseded" });

    await db.query("UPDATE requests SET quote_id = 'qte_flow1', status = 'cancelled'");
    const closed = await post({ token: TOKEN, option_id: "A" });
    expect(closed.status).toBe(409);
    expect(await closed.json()).toMatchObject({ error: "closed" });
    expect(await accepted()).toEqual({ events: 0, revenue: 0 });
  });

  it("rate-limits per IP in memory", async () => {
    let limited: Response | undefined;
    for (let i = 0; i < 30 && !limited; i++) {
      const res = await post({ token: "NoSuchTokenAAAAAAAAAAAAA", option_id: "A" }, { from: "10.6.6.6" });
      if (res.status === 429) limited = res;
    }
    expect(limited?.status).toBe(429);
    expect(Number(limited?.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await post({ token: TOKEN, option_id: "A" })).status).toBe(200); // another IP
  });

  it("answers 503 without echoing the error when acceptance fails", async () => {
    mocks.acceptQuoteByToken.mockRejectedValueOnce(new Error("postgresql://owner:FAKEPASSWORD@ep-x/neondb exploded"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post({ token: TOKEN, option_id: "A" });
    errors.mockRestore();
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("FAKEPASSWORD");
  });

  it("has no GET handler, so link prefetchers can't accept", () => {
    expect(Object.keys(route)).toEqual(["POST"]);
  });
});

describe("/quote/[token] page", () => {
  it("lists the options with one POST form each, and reading it changes nothing", async () => {
    const html = await page();
    expect(html).toContain("Your quote");
    expect(html).toContain("Did the storm damage our roof?");
    expect(html).not.toContain("sent from the portal");
    expect(html).toContain("Option B · Recommended");
    expect(html).toContain("Sharp archive image");
    expect(html).toContain("$180–$260");
    expect(html).toContain("0.5 m detail");
    const forms = html.match(/<form[^>]*>/g) ?? [];
    expect(forms).toHaveLength(2);
    for (const f of forms) expect(f).toMatch(/action="\/api\/quotes\/accept"[^>]*method="post"|method="post"[^>]*action="\/api\/quotes\/accept"/);
    expect(html).toContain(`name="token" value="${TOKEN}"`);
    expect(html).toContain('name="option_id" value="A"');
    expect(html).toContain("Accept option A · $29");
    expect(html).toContain("We buy paid imagery only after you accept");
    expect(html).not.toMatch(/margin|up42|supplier quote pending/);
    expect(await quoteRow()).toEqual({ accepted_option_id: null, status: "sent" });
    expect(mocks.acceptQuoteByToken).not.toHaveBeenCalled();
  });

  it("shows the accepted option without buttons, and errors from the redirect", async () => {
    await post({ token: TOKEN, option_id: "B" });
    const html = await page();
    expect(html).toContain("You accepted option B");
    expect(html).toContain("Option B · Recommended · Accepted");
    expect(html).not.toContain("<form");
    expect(await page(TOKEN, { error: "already_accepted" })).toContain("already accepted with another option");

    await db.query("UPDATE quotes SET accepted_option_id = NULL, accepted_at = NULL, valid_until = now() - interval '1 hour'");
    const expired = await page(TOKEN, { error: "expired" });
    expect(expired.match(/This quote has expired/g)).toHaveLength(1);
    expect(expired).not.toContain("<form");
    expect(await page(TOKEN, { error: "<script>" })).not.toContain("<script>");
  });

  it("is not found for an unknown or malformed token", async () => {
    await expect(page("NoSuchTokenAAAAAAAAAAAAA")).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(page("../etc")).rejects.toThrow("NEXT_NOT_FOUND");
  });
});

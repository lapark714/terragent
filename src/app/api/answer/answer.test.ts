import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApiKey, tagApiRequest } from "@/lib/api-keys";
import { createDb, setDb, type Db } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";

const started: unknown[] = [];
vi.mock("@/lib/pipeline/requests", () => ({
  startInboundRequest: vi.fn(async (input: { question: string; source: string }) => {
    started.push(input);
    const { getDb } = await import("@/lib/db/client");
    const id = `req_test${started.length}aa`;
    await (await getDb()).query("INSERT INTO requests (id, source, question) VALUES ($1, $2, $3)", [id, input.source, input.question]);
    return { id, status: "received" };
  }),
}));

vi.mock("@/lib/api-keys", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api-keys")>();
  return { ...real, tagApiRequest: vi.fn(real.tagApiRequest) };
});

const { POST } = await import("./route");
const { GET } = await import("./[id]/route");

let db: Db;
let key: string;
let otherKey: string;

const post = (body: unknown, auth = key) =>
  POST(new Request("http://localhost/api/answer", {
    method: "POST",
    headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
const get = (id: string, auth = key) =>
  GET(new Request(`http://localhost/api/answer/${id}`, { headers: { authorization: `Bearer ${auth}` } }), { params: Promise.resolve({ id }) });

beforeAll(async () => {
  db = await createDb({ memory: true });
  await migrate(db);
  setDb(db);
  key = (await createApiKey("test-agent", 4)).key;
  otherKey = (await createApiKey("someone-else", 4)).key;
});
afterAll(async () => {
  setDb(null);
  await db.close();
});

describe("POST /api/answer", () => {
  it("rejects missing or unknown keys", async () => {
    const res = await POST(new Request("http://localhost/api/answer", { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
    expect((await post({ question: "x" }, "tg_live_nope")).status).toBe(401);
  });

  it("validates the body and names the bad fields", async () => {
    const res = await post({ question: "How much burned?", lat: 20 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_request");
    expect(body.issues.map((i: { field: string }) => i.field)).toContain("lon");
    expect((await post("not json")).status).toBe(400);
    expect(res.headers.get("RateLimit-Limit")).toBe("4");
  });

  it("accepts a valid request, returns 202 and ties it to the key", async () => {
    const res = await post({ question: "How much of the town burned?", location: "Lahaina, HI", callback_url: "https://agent.example/cb" });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.request_id).toMatch(/^req_/);
    expect(body.status_url).toMatch(new RegExp(`/api/answer/${body.request_id}$`));
    expect(started.at(-1)).toMatchObject({ source: "api", location_text: "Lahaina, HI", question: "How much of the town burned?" });
    const [row] = await db.query<{ meta: Record<string, string> }>("SELECT meta FROM requests WHERE id = $1", [body.request_id]);
    expect(row.meta).toMatchObject({ api_owner: "test-agent", callback_url: "https://agent.example/cb" });

    const status = await get(body.request_id);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ request_id: body.request_id, status: "received", done: false, quote: null, report: null });
    expect((await get(body.request_id, otherKey)).status).toBe(404);
  });

  it("shows the caller its quote once priced, so a price held for a founder isn't a silent stall", async () => {
    const own = (await createApiKey("quote-reader", 4)).key; // its own key, so the rate-limit test below keeps its count
    const res = await post({ question: "Did the dam overflow?", location: "Oroville, CA" }, own);
    const { request_id } = await res.json();
    await db.query(
      `INSERT INTO quotes (id, request_id, price_usd, status, auto_approved, line_items, payment_link) VALUES
       ('qte_api1', $1, 120, 'needs_approval', false, '[{"label":"Satellite data","amount_usd":80},{"label":"Analysis and verified report","amount_usd":40}]', null)`,
      [request_id],
    );
    await db.query("UPDATE requests SET quote_id = 'qte_api1', status = 'awaiting_approval' WHERE id = $1", [request_id]);
    const body = await (await get(request_id, own)).json();
    expect(body).toMatchObject({ status: "awaiting_approval", done: false });
    expect(body.quote).toEqual({
      id: "qte_api1", price_usd: 120, status: "needs_approval", auto_approved: false, payment_link: null,
      line_items: [{ label: "Satellite data", amount_usd: 80 }, { label: "Analysis and verified report", amount_usd: 40 }],
    });
    expect((await get("req_nosuch0001", own)).status).toBe(404);
    expect((await get(request_id)).status).toBe(404); // another key never sees it
  });

  it("still answers 202 when the request started but tagging it failed, so the client doesn't retry into a duplicate", async () => {
    vi.mocked(tagApiRequest).mockRejectedValueOnce(new Error("connection reset"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await post({ question: "How much burned?", location: "Lahaina" }, otherKey);
    expect(res.status).toBe(202);
    expect((await res.json()).request_id).toMatch(/^req_/);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("rate-limits per key", async () => {
    // Three hits so far (two invalid bodies count too); the limit is 4 per hour.
    expect((await post({ question: "How much burned?", location: "Lahaina" })).status).toBe(202);
    const res = await post({ question: "How much burned?", location: "Lahaina" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect((await post({ question: "How much burned?", location: "Lahaina" }, otherKey)).status).toBe(202);
  });
});

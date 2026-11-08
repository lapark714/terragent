import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, setDb, type Db } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";

const started: { source: string; question: string; location_text?: string; email?: string }[] = [];
vi.mock("@/lib/pipeline/requests", () => ({
  startInboundRequest: vi.fn(async (input: (typeof started)[number]) => {
    started.push(input);
    return { id: `req_portal${started.length}aa`, status: "received" };
  }),
}));

const { POST } = await import("./route");

let db: Db;
let ip = 0;
const valid = { location: "Lahaina, HI", question: "How much of the town burned?", email: "kai@example.com" };

function post(body: Record<string, string>, opts: { form?: boolean; ip?: string } = {}) {
  const headers: Record<string, string> = { "x-forwarded-for": opts.ip ?? `10.0.0.${ip}` };
  if (!opts.form) headers["content-type"] = "application/json";
  return POST(new Request("http://localhost/api/requests", {
    method: "POST",
    headers,
    body: opts.form ? new URLSearchParams(body) : JSON.stringify(body),
  }));
}

beforeAll(async () => {
  db = await createDb({ memory: true });
  await migrate(db);
  setDb(db);
});
afterAll(async () => {
  setDb(null);
  await db.close();
});
beforeEach(() => {
  ip += 1; // a fresh address per test, so per-IP limits don't leak between tests
  vi.unstubAllEnvs();
});

describe("POST /api/requests", () => {
  it("starts a portal request and answers JSON with 201", async () => {
    const res = await post(valid);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ request_id: "req_portal1aa", status_page: "/request/req_portal1aa" });
    expect(started.at(-1)).toMatchObject({ source: "portal", question: valid.question, location_text: "Lahaina, HI", email: "kai@example.com" });
  });

  it("redirects a plain form post to the status page with 303", async () => {
    const res = await post(valid, { form: true });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/request/req_portal${started.length}aa`);
  });

  it("rejects bad input and filled honeypots without starting anything", async () => {
    const before = started.length;
    const bad = await post({ ...valid, email: "not-an-email" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).issues.map((i: { field: string }) => i.field)).toContain("email");
    expect((await post({ ...valid, website: "http://spam.example" })).status).toBe(400);
    expect(started.length).toBe(before);
  });

  it("rate-limits per IP address", async () => {
    vi.stubEnv("PORTAL_RATE_PER_HOUR", "2");
    expect((await post(valid)).status).toBe(201);
    expect((await post(valid)).status).toBe(201);
    const res = await post(valid);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect((await res.json()).error).toBe("rate_limited");
    expect((await post(valid, { ip: "10.9.9.9" })).status).toBe(201);
  });

  it("caps the whole portal per hour so rotating addresses can't drain the agent budget", async () => {
    const [used] = await db.query<{ count: number }>("SELECT count FROM rate_limits WHERE bucket = 'portal:all'");
    vi.stubEnv("PORTAL_GLOBAL_PER_HOUR", String(Number(used?.count ?? 0) + 1));
    const before = started.length;
    expect((await post(valid, { ip: "10.1.1.1" })).status).toBe(201);
    expect((await post(valid, { ip: "10.1.1.2" })).status).toBe(429);
    expect(started.length).toBe(before + 1);
  });
});

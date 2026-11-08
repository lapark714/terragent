import { describe, expect, it } from "vitest";
import { retryingFetch } from "./client";

const res = (status: number, headers: Record<string, string> = {}) => new Response(status === 200 ? "{}" : "busy", { status, headers });

describe("retryingFetch", () => {
  it("retries 429/503 with the same request (same idempotency key) until it succeeds", async () => {
    const seen: (string | null)[] = [];
    const answers = [res(429), res(503), res(200)];
    const base = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("idempotency-key"));
      return answers.shift()!;
    }) as typeof fetch;
    const f = retryingFetch(base, { tries: 5, sleep: async () => {} });
    const out = await f("https://api.vetta.sh/v1/agents", { method: "POST", headers: { "idempotency-key": "k-1" }, body: "{}" });
    expect(out.status).toBe(200);
    expect(seen).toEqual(["k-1", "k-1", "k-1"]);
  });

  it("gives up after the configured tries and returns the last 429; never retries other errors", async () => {
    let calls = 0;
    const f429 = retryingFetch((async () => { calls++; return res(429, { "retry-after": "1" }); }) as typeof fetch, { tries: 3, sleep: async () => {} });
    expect((await f429("x")).status).toBe(429);
    expect(calls).toBe(3);
    calls = 0;
    const f400 = retryingFetch((async () => { calls++; return res(400); }) as typeof fetch, { tries: 3, sleep: async () => {} });
    expect((await f400("x")).status).toBe(400);
    expect(calls).toBe(1);
  });
});

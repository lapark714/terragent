import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, setDb, type Db } from "../db/client";
import { migrate } from "../db/migrate";
import { apiKeyFromRequest, clientIp, createApiKey, generateKey, hashKey, hitMemoryLimit, hitRateLimit, rateLimitHeaders, verifyApiKey } from ".";

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

describe("api keys", () => {
  it("hashes with sha256 hex and generates distinct prefixed keys", () => {
    expect(hashKey("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const a = generateKey();
    expect(a).toMatch(/^tg_live_[A-Za-z0-9_-]{32}$/);
    expect(generateKey()).not.toBe(a);
  });

  it("stores only the hash and verifies the raw key", async () => {
    const created = await createApiKey("acme-agent", 5);
    const [row] = await db.query<{ key_hash: string }>("SELECT key_hash FROM api_keys WHERE id = $1", [created.id]);
    expect(row.key_hash).toBe(hashKey(created.key));
    expect(row.key_hash).not.toContain(created.key);

    expect(await verifyApiKey(created.key)).toEqual({ id: created.id, owner: "acme-agent", rate_per_hour: 5 });
    expect(await verifyApiKey("tg_live_wrong")).toBeNull();
    expect(await verifyApiKey(null)).toBeNull();
  });

  it("rejects revoked keys", async () => {
    const created = await createApiKey("old-client");
    await db.query("UPDATE api_keys SET revoked = true WHERE id = $1", [created.id]);
    expect(await verifyApiKey(created.key)).toBeNull();
  });

  it("reads the key from Authorization or x-api-key", () => {
    const bearer = new Request("http://x", { headers: { authorization: "Bearer tg_live_abc" } });
    const header = new Request("http://x", { headers: { "x-api-key": "tg_live_def" } });
    expect(apiKeyFromRequest(bearer)).toBe("tg_live_abc");
    expect(apiKeyFromRequest(header)).toBe("tg_live_def");
    expect(apiKeyFromRequest(new Request("http://x"))).toBeNull();
  });
});

describe("rate limiter", () => {
  it("counts hits in a fixed window and blocks past the limit", async () => {
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await hitRateLimit("key:test", 3));
    expect(results.map((r) => r.count)).toEqual([1, 2, 3, 4]);
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results[3].remaining).toBe(0);
    expect(results[0].resetSeconds).toBeGreaterThan(0);
    expect(results[0].resetSeconds).toBeLessThanOrEqual(3600);
    expect(rateLimitHeaders(results[3])["Retry-After"]).toBe(String(results[3].resetSeconds));
    expect(rateLimitHeaders(results[0])["Retry-After"]).toBeUndefined();
  });

  it("is atomic under concurrent hits", async () => {
    const all = await Promise.all(Array.from({ length: 20 }, () => hitRateLimit("ip:1.2.3.4", 100)));
    expect(Math.max(...all.map((r) => r.count))).toBe(20);
  });

  it("keeps buckets separate and prunes old windows", async () => {
    await db.query("INSERT INTO rate_limits (bucket, window_start, count) VALUES ('ip:9.9.9.9', now() - interval '3 hours', 50)");
    const r = await hitRateLimit("ip:9.9.9.9", 10);
    expect(r.count).toBe(1);
    const rows = await db.query("SELECT 1 FROM rate_limits WHERE bucket = 'ip:9.9.9.9'");
    expect(rows).toHaveLength(1);
  });

  it("has an in-memory variant for public reads: fixed window, per bucket, no database write", async () => {
    const t0 = 1_000_000;
    const spy = vi.spyOn(db, "query");
    const hits = Array.from({ length: 4 }, () => hitMemoryLimit("status:1.1.1.1", 3, 60_000, t0));
    expect(hits.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(hits[3]).toMatchObject({ count: 4, remaining: 0, resetSeconds: 60 });
    expect(hitMemoryLimit("status:2.2.2.2", 3, 60_000, t0).allowed).toBe(true);
    expect(hitMemoryLimit("status:1.1.1.1", 3, 60_000, t0 + 59_000)).toMatchObject({ allowed: false, resetSeconds: 1 });
    expect(hitMemoryLimit("status:1.1.1.1", 3, 60_000, t0 + 60_000)).toMatchObject({ allowed: true, count: 1 });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("takes the first forwarded hop as the client IP", () => {
    expect(clientIp(new Request("http://x", { headers: { "x-forwarded-for": "5.6.7.8, 10.0.0.1" } }))).toBe("5.6.7.8");
    expect(clientIp(new Request("http://x"))).toBe("unknown");
  });
});

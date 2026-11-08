import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureSafeRuntimeKey, forbiddenScopes, setNaive, UnsafeNaiveKeyError } from "./client";

const me = (scopes: string[]) =>
  vi.fn(async () => new Response(JSON.stringify({ object: "identity", scopes }), { status: 200, headers: { "content-type": "application/json" } }));

describe("runtime key scope guard", () => {
  beforeEach(() => {
    vi.stubEnv("NAIVE_API_KEY", "sk_test_not_real");
    setNaive(null); // also resets the cached check
  });
  afterEach(() => vi.unstubAllEnvs());

  it("does nothing off Vercel", async () => {
    vi.stubEnv("VERCEL_ENV", "");
    const f = me(["admin"]);
    await expect(ensureSafeRuntimeKey(f)).resolves.toBeUndefined();
    expect(f).not.toHaveBeenCalled();
  });

  it("refuses a key with admin or billing:write on Vercel, and keeps refusing without re-asking", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const f = me(["agents:read", "admin", "billing:write"]);
    await expect(ensureSafeRuntimeKey(f)).rejects.toBeInstanceOf(UnsafeNaiveKeyError);
    await expect(ensureSafeRuntimeKey(f)).rejects.toThrow(/admin, billing:write/);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("accepts a narrow key once and caches it", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const f = me(["agents:read", "agents:write", "sessions:write", "billing:read", "files:read"]);
    await ensureSafeRuntimeKey(f);
    await ensureSafeRuntimeKey(f);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/v1\/me$/);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk_test_not_real");
  });

  it("does not cache a network failure", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const f = vi.fn(async () => new Response("nope", { status: 503 }));
    await expect(ensureSafeRuntimeKey(f)).rejects.toThrow(/503/);
    const ok = me(["agents:read"]);
    await expect(ensureSafeRuntimeKey(ok)).resolves.toBeUndefined();
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("names only the forbidden scopes", () => {
    expect(forbiddenScopes(["admin", "agents:read", "billing:write", "billing:read"])).toEqual(["admin", "billing:write"]);
    expect(forbiddenScopes(["webhooks:*", "proxy:write"])).toEqual([]);
  });
});

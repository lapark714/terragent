/**
 * Naïve client for runtime code (Next.js routes, MCP tools) and scripts.
 *
 * Runtime helpers call `getNaive()`, which on a deployed app (VERCEL_ENV set) first checks the key's
 * scopes with GET /v1/me and refuses a key that holds `admin` or `billing:write` (NOTES H1d): a leaked
 * server key must not be able to mint keys or top up the card. Scripts may use `naive()` directly.
 */
import { createClient, type VettaClient } from "@usenaive-sdk/managed-agents";
import { env, isOffline, requireEnv } from "../env";

export type Naive = VettaClient;

/** Scopes the deployed app refuses to run with. */
export const FORBIDDEN_RUNTIME_SCOPES = ["admin", "billing:write"] as const;

const API_VERSION = "2026-09-30"; // the version the SDK pins (naive-core §3.2)

let client: VettaClient | null = null;
let guard: Promise<void> | null = null;

export function naiveBaseUrl(): string {
  return (env("NAIVE_BASE_URL") ?? "https://api.vetta.sh").replace(/\/+$/, "");
}

/** Raw client, no scope check. Use in scripts; runtime code should use getNaive(). */
export function naive(): VettaClient {
  client ??= createClient({ apiKey: requireEnv("NAIVE_API_KEY"), baseUrl: naiveBaseUrl() });
  return client;
}

/** Client for runtime code: on Vercel, the key's scopes are checked once per process first. */
/** Thrown instead of reaching Naïve in offline mode (npm run dev:local / TERRAGENT_OFFLINE=1). */
export class NaiveOfflineError extends Error {
  constructor() {
    super("Offline mode: Naïve isn't called locally (TERRAGENT_OFFLINE / TERRAGENT_DB=local).");
    this.name = "NaiveOfflineError";
  }
}

/**
 * The only way code reaches Naïve. Offline mode is enforced HERE as a backstop, so no path (board cards,
 * files, sessions, spend, approvals — present or future) can touch the production org from a local run
 * that happens to have real keys in .env. Callers that should degrade gracefully check isOffline() first.
 */
export async function getNaive(): Promise<VettaClient> {
  if (isOffline()) throw new NaiveOfflineError();
  await ensureSafeRuntimeKey();
  return naive();
}

/** Test hook: swap the client (and reset the scope check). */
export function setNaive(c: VettaClient | null) {
  client = c;
  guard = null;
}

export class UnsafeNaiveKeyError extends Error {
  constructor(readonly scopes: string[]) {
    super(
      `Refusing to run: the Naïve key has ${scopes.join(", ")}. Deploy a key without admin/billing:write ` +
        "(NOTES H1d) and keep the broad key for local provisioning only.",
    );
    this.name = "UnsafeNaiveKeyError";
  }
}

export function forbiddenScopes(scopes: readonly string[]): string[] {
  return scopes.filter((s) => (FORBIDDEN_RUNTIME_SCOPES as readonly string[]).includes(s));
}

/**
 * GET /v1/me with plain fetch. The SDK parses scopes against a closed enum, so a scope added by
 * Naïve later would make `auth.me()` throw and take the app down with it; here we only need names.
 */
export async function fetchKeyScopes(fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const res = await fetchImpl(`${naiveBaseUrl()}/v1/me`, {
    headers: { authorization: `Bearer ${requireEnv("NAIVE_API_KEY")}`, "vetta-version": API_VERSION, accept: "application/json" },
  });
  if (!res.ok) throw new Error(`GET /v1/me failed: HTTP ${res.status}`);
  const body = (await res.json()) as { scopes?: unknown };
  if (!Array.isArray(body.scopes)) throw new Error("GET /v1/me: response has no scopes");
  return body.scopes.map(String);
}

/**
 * On Vercel: resolve once the key is known to be safe, reject (forever, for this process) if it is
 * not. A network failure is not cached, so the next call retries.
 */
export function ensureSafeRuntimeKey(fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!env("VERCEL_ENV")) return Promise.resolve();
  guard ??= fetchKeyScopes(fetchImpl)
    .then((scopes) => {
      const bad = forbiddenScopes(scopes);
      if (bad.length) throw new UnsafeNaiveKeyError(bad);
    })
    .catch((e: unknown) => {
      if (!(e instanceof UnsafeNaiveKeyError)) guard = null;
      throw e;
    });
  return guard;
}

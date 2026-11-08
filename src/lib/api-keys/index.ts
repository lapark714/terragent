/**
 * Public API keys: the raw key is shown once (scripts/create-api-key.ts); only its sha256 is stored.
 * Keys are looked up by hash and must not be revoked.
 */
import { createHash, randomBytes } from "node:crypto";
import { CAPS } from "../config";
import { getDb } from "../db/client";
import { newId } from "../ids";

const KEY_PREFIX = "tg_live_";

export interface ApiKey {
  id: string;
  owner: string;
  rate_per_hour: number;
}

export function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function generateKey(): string {
  return KEY_PREFIX + randomBytes(24).toString("base64url");
}

export async function createApiKey(owner: string, ratePerHour: number = CAPS.apiRequestsPerHourDefault): Promise<ApiKey & { key: string }> {
  const db = await getDb();
  const key = generateKey();
  const id = newId("apiKey");
  await db.query("INSERT INTO api_keys (id, key_hash, owner, rate_per_hour) VALUES ($1, $2, $3, $4)", [
    id,
    hashKey(key),
    owner,
    ratePerHour,
  ]);
  return { id, owner, rate_per_hour: ratePerHour, key };
}

export async function verifyApiKey(raw: string | null | undefined): Promise<ApiKey | null> {
  if (!raw) return null;
  const db = await getDb();
  const rows = await db.query<ApiKey>(
    "SELECT id, owner, rate_per_hour FROM api_keys WHERE key_hash = $1 AND NOT revoked",
    [hashKey(raw.trim())],
  );
  return rows[0] ?? null;
}

/** `Authorization: Bearer <key>`, or `x-api-key: <key>` for clients that can't set Authorization. */
export function apiKeyFromRequest(req: Request): string | null {
  const auth = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)\s*$/i)?.[1];
  return auth ?? req.headers.get("x-api-key")?.trim() ?? null;
}

/** Ties a request created through the API to its key (and optional callback) so only that key can read it. */
export async function tagApiRequest(requestId: string, key: ApiKey, callbackUrl?: string) {
  const db = await getDb();
  const meta = { api_key_id: key.id, api_owner: key.owner, ...(callbackUrl ? { callback_url: callbackUrl } : {}) };
  await db.query("UPDATE requests SET meta = meta || $2::jsonb WHERE id = $1", [requestId, JSON.stringify(meta)]);
}

export { clientIp, hitMemoryLimit, hitRateLimit, rateLimitHeaders, resetMemoryLimits, type RateLimitResult } from "./rate-limit";

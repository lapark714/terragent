/**
 * Naïve webhook verification (naive-orchestration §3.5), for the route core owns
 * (src/app/api/webhooks/naive). HMAC-SHA256 with the endpoint secret over `${timestamp}.${rawBody}`,
 * hex, in `Vetta-Signature: v1=<hex>[,v1=<hex>]`; reject timestamps more than 300 s away.
 * Every endpoint (the main one and each deployment's on_idle) has its own secret, so pass them all
 * (settings SETTING.naiveWebhookSecrets). Dedupe on the envelope `id` after verifying.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_TOLERANCE_S = 300;

export interface NaiveWebhookEnvelope {
  id: string; // evt_…, stable across retries → dedupe key
  type: string; // session.idle | message.completed | budget.exceeded | webhook.test
  created_at: string;
  data: Record<string, unknown>;
}

/** What provisioning stores in SETTING.naiveWebhookSecrets. */
export interface WebhookSecret {
  id: string; // whk_…
  secret: string;
  purpose: "events" | "on_idle";
}

export type VerifyResult = { ok: true } | { ok: false; reason: "missing_headers" | "stale_timestamp" | "bad_signature" | "no_secrets" };

type HeaderSource = Headers | Record<string, string | string[] | undefined>;

function header(h: HeaderSource, name: string): string | undefined {
  if (h instanceof Headers) return h.get(name) ?? undefined;
  const key = Object.keys(h).find((k) => k.toLowerCase() === name);
  const v = key ? h[key] : undefined;
  return Array.isArray(v) ? v[0] : v;
}

export function signNaivePayload(rawBody: string | Uint8Array, secret: string, timestamp: number): string {
  return createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex");
}

/** Verify on the RAW request bytes (never re-serialized JSON). */
export function verifyNaiveSignature(
  rawBody: string | Uint8Array,
  headers: HeaderSource,
  secrets: readonly string[],
  nowSeconds = Math.floor(Date.now() / 1000),
): VerifyResult {
  if (!secrets.length) return { ok: false, reason: "no_secrets" };
  const tsHeader = header(headers, "vetta-timestamp");
  const sigHeader = header(headers, "vetta-signature");
  if (!tsHeader || !sigHeader) return { ok: false, reason: "missing_headers" };
  const ts = Number(tsHeader);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > SIGNATURE_TOLERANCE_S) return { ok: false, reason: "stale_timestamp" };
  const given = sigHeader
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("v1="))
    .map((s) => Buffer.from(s.slice(3), "hex"));
  for (const secret of secrets) {
    const want = Buffer.from(signNaivePayload(rawBody, secret, ts), "hex");
    if (given.some((g) => g.length === want.length && timingSafeEqual(g, want))) return { ok: true };
  }
  return { ok: false, reason: "bad_signature" };
}

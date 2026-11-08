import { describe, expect, it } from "vitest";
import { signNaivePayload, verifyNaiveSignature } from "./webhooks";

const NOW = 1_794_000_000;
const body = JSON.stringify({ id: "evt_1", type: "session.idle", created_at: "2026-11-07T00:00:00Z", data: { stop_reason: "end_turn" } });
const headersFor = (sig: string, ts = NOW) => ({ "Vetta-Signature": sig, "Vetta-Timestamp": String(ts) });

describe("verifyNaiveSignature", () => {
  it("accepts a valid v1 signature over `${ts}.${rawBody}`", () => {
    const sig = signNaivePayload(body, "whsec_a", NOW);
    expect(verifyNaiveSignature(body, headersFor(`v1=${sig}`), ["whsec_a"], NOW)).toEqual({ ok: true });
  });

  it("accepts when any of several signatures matches any stored secret (rotation, per-endpoint secrets)", () => {
    const sig = signNaivePayload(body, "whsec_new", NOW);
    const header = `v1=${"0".repeat(64)}, v1=${sig}`;
    expect(verifyNaiveSignature(body, headersFor(header), ["whsec_old", "whsec_new"], NOW).ok).toBe(true);
  });

  it("works on raw bytes and with a Headers object", () => {
    const bytes = new TextEncoder().encode(body);
    const sig = signNaivePayload(bytes, "whsec_a", NOW);
    const h = new Headers({ "vetta-signature": `v1=${sig}`, "vetta-timestamp": String(NOW) });
    expect(verifyNaiveSignature(bytes, h, ["whsec_a"], NOW).ok).toBe(true);
  });

  it("rejects a tampered body, a wrong secret and a garbage signature", () => {
    const sig = signNaivePayload(body, "whsec_a", NOW);
    expect(verifyNaiveSignature(body + " ", headersFor(`v1=${sig}`), ["whsec_a"], NOW)).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyNaiveSignature(body, headersFor(`v1=${sig}`), ["whsec_b"], NOW).ok).toBe(false);
    expect(verifyNaiveSignature(body, headersFor("v1=zz"), ["whsec_a"], NOW).ok).toBe(false);
    expect(verifyNaiveSignature(body, headersFor(sig), ["whsec_a"], NOW).ok).toBe(false); // missing v1= prefix
  });

  it("rejects timestamps more than 300 s away", () => {
    const old = NOW - 301;
    const sig = signNaivePayload(body, "whsec_a", old);
    expect(verifyNaiveSignature(body, headersFor(`v1=${sig}`, old), ["whsec_a"], NOW)).toEqual({ ok: false, reason: "stale_timestamp" });
    const edge = NOW - 300;
    expect(verifyNaiveSignature(body, headersFor(`v1=${signNaivePayload(body, "whsec_a", edge)}`, edge), ["whsec_a"], NOW).ok).toBe(true);
  });

  it("rejects missing headers and an empty secret list", () => {
    expect(verifyNaiveSignature(body, {}, ["whsec_a"], NOW)).toEqual({ ok: false, reason: "missing_headers" });
    expect(verifyNaiveSignature(body, headersFor("v1=00"), [], NOW)).toEqual({ ok: false, reason: "no_secrets" });
  });
});

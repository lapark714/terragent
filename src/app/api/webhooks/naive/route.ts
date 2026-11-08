/**
 * Naïve → Terragent webhooks (session.idle, message.completed, budget.exceeded). Verify the HMAC on the raw body,
 * dedupe on the envelope id, ack fast (Naïve wants a 2xx within 10 s), and do the work in after().
 */
import { after } from "next/server";
import { env } from "@/lib/env";
import { claimWebhookEvent, processNaiveEvent } from "@/lib/pipeline/naive-events";
import { getSetting, SETTING } from "@/lib/settings";
import { type NaiveWebhookEnvelope, verifyNaiveSignature, type WebhookSecret } from "@/lib/naive/webhooks";

export const runtime = "nodejs";
export const maxDuration = 60;

async function secrets(): Promise<string[]> {
  const stored = await getSetting<WebhookSecret[]>(SETTING.naiveWebhookSecrets, []);
  const fromEnv = env("NAIVE_WEBHOOK_SECRET");
  return [...stored.map((s) => s.secret), ...(fromEnv ? [fromEnv] : [])];
}

export async function POST(req: Request) {
  const raw = new Uint8Array(await req.arrayBuffer());
  const verified = verifyNaiveSignature(raw, req.headers, await secrets());
  if (!verified.ok) return Response.json({ error: verified.reason }, { status: 400 });

  let evt: NaiveWebhookEnvelope;
  try {
    evt = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  if (typeof evt?.id !== "string" || typeof evt.type !== "string") return Response.json({ error: "invalid_envelope" }, { status: 400 });

  if (!(await claimWebhookEvent(evt))) return Response.json({ ok: true, duplicate: true });
  after(() => processNaiveEvent(evt).catch((e) => console.error("[webhooks/naive] processing failed:", evt.id, e)));
  return Response.json({ ok: true });
}

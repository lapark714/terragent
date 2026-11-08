/**
 * AgentMail → Terragent. Verify + dedupe synchronously, ack, then route the email in after()
 * (AgentMail needs a 2xx within 15 s and retries at-least-once). Logic lives in src/lib/email/webhook.ts.
 */
import { after } from "next/server";
import { receiveWebhook } from "@/lib/email/webhook";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  const receipt = await receiveWebhook(await req.text(), req.headers);
  if (receipt.process) after(receipt.process);
  return new Response(receipt.body, { status: receipt.status });
}

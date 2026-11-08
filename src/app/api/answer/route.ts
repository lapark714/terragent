/**
 * Public API for software and agents: POST /api/answer with a place and a question.
 * Bearer key, fixed-window rate limit per key, answers asynchronously (202 + status URL).
 */
import { AnswerBody, answerToRequest, issues } from "@/app/_lib/intake";
import { json } from "@/app/_lib/http";
import { apiKeyFromRequest, hitRateLimit, rateLimitHeaders, tagApiRequest, verifyApiKey } from "@/lib/api-keys";
import { publicBaseUrl } from "@/lib/env";
import { startInboundRequest } from "@/lib/pipeline/requests";

export async function POST(req: Request) {
  const key = await verifyApiKey(apiKeyFromRequest(req));
  if (!key) return json({ error: "invalid_api_key", message: "Send Authorization: Bearer <your key>. Email us for a key." }, 401);

  const limit = await hitRateLimit(`key:${key.id}`, key.rate_per_hour);
  const headers = rateLimitHeaders(limit);
  if (!limit.allowed) return json({ error: "rate_limited", retry_after_s: limit.resetSeconds }, 429, headers);

  const body: unknown = await req.json().catch(() => undefined);
  const parsed = AnswerBody.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_request", issues: issues(parsed.error) }, 400, headers);

  let request;
  try {
    request = await startInboundRequest({ ...answerToRequest(parsed.data), source: "api" });
  } catch (e) {
    console.error("[api] startInboundRequest failed:", e);
    return json({ error: "unavailable", message: "Could not start the request. Retry shortly." }, 503, headers);
  }
  // The request (and its agent session) exists now, so a tagging failure must not invite a duplicate retry.
  try {
    await tagApiRequest(request.id, key, parsed.data.callback_url);
  } catch (e) {
    console.error(`[api] could not tie ${request.id} to key ${key.id}:`, e);
  }
  return json(
    { request_id: request.id, status: request.status, status_url: `${publicBaseUrl()}/api/answer/${request.id}` },
    202,
    headers,
  );
}

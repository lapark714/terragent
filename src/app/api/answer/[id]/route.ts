/** Status of an API request; once delivered, the answer summary and the report link. Only the creating key may read it. */
import { json } from "@/app/_lib/http";
import { apiKeyFromRequest, hitRateLimit, rateLimitHeaders, verifyApiKey } from "@/lib/api-keys";
import { getRequestProgress, requestApiKeyId } from "@/lib/dashboard/public";

/** Polling is cheap but not free: allow far more reads than writes per key. */
const POLLS_PER_REQUEST = 20;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const key = await verifyApiKey(apiKeyFromRequest(req));
  if (!key) return json({ error: "invalid_api_key" }, 401);
  const limit = await hitRateLimit(`poll:${key.id}`, key.rate_per_hour * POLLS_PER_REQUEST);
  const headers = rateLimitHeaders(limit);
  if (!limit.allowed) return json({ error: "rate_limited", retry_after_s: limit.resetSeconds }, 429, headers);

  const { id } = await params;
  const progress = (await requestApiKeyId(id)) === key.id ? await getRequestProgress(id) : null;
  if (!progress) return json({ error: "not_found" }, 404, headers);
  return json(
    {
      request_id: progress.id,
      status: progress.status,
      done: progress.terminal,
      created_at: progress.createdAt,
      updated_at: progress.updatedAt,
      refusal_reason: progress.refusalReason,
      report: progress.report && {
        url: progress.report.url,
        title: progress.report.title,
        answer: progress.report.answer,
        confidence: progress.report.confidence,
        limitations: progress.report.limitations,
        human_review_recommended: progress.report.humanReview,
      },
    },
    200,
    headers,
  );
}

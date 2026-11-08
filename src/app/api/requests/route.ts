/** Portal form → new inbound request. Rate-limited per IP; works as a JSON API and as a plain HTML form post. */
import { issues, PortalForm, portalToRequest } from "@/app/_lib/intake";
import { isFormPost, json, readBody } from "@/app/_lib/http";
import { helloAddress } from "@/components/site/contact";
import { clientIp, hitRateLimit, rateLimitHeaders, type RateLimitResult } from "@/lib/api-keys";
import { envNumber } from "@/lib/env";
import { startInboundRequest } from "@/lib/pipeline/requests";

const tooMany = (who: string, limit: RateLimitResult) =>
  json(
    { error: "rate_limited", message: `Too many requests ${who}. Try again in ${Math.ceil(limit.resetSeconds / 60)} min, or email ${helloAddress()}.` },
    429,
    rateLimitHeaders(limit),
  );

export async function POST(req: Request) {
  // Generous on purpose: a whole hackathon room shares one office IP.
  const perIp = await hitRateLimit(`ip:${clientIp(req)}`, envNumber("PORTAL_RATE_PER_HOUR", 30));
  if (!perIp.allowed) return tooMany("from your network", perIp);

  const parsed = PortalForm.safeParse(await readBody(req));
  if (!parsed.success) return json({ error: "invalid_request", issues: issues(parsed.error) }, 400);
  if (parsed.data.website) return json({ error: "invalid_request", issues: [] }, 400);

  // Every accepted post starts a paid agent session, so rotating IPs must not drain the customer agent's daily budget.
  const global = await hitRateLimit("portal:all", envNumber("PORTAL_GLOBAL_PER_HOUR", 120));
  if (!global.allowed) return tooMany("right now", global);

  let id: string;
  try {
    id = (await startInboundRequest({ ...portalToRequest(parsed.data), source: "portal" })).id;
  } catch (e) {
    console.error("[portal] startInboundRequest failed:", e);
    return json({ error: "unavailable", message: "We couldn't start your request just now. Try again in a minute, or email us." }, 503);
  }
  if (isFormPost(req)) return new Response(null, { status: 303, headers: { location: `/request/${id}` } });
  return json({ request_id: id, status_page: `/request/${id}` }, 201);
}

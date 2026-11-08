/**
 * Founder actions: naive-approval | order | quote | template | inbox | payment. Header x-admin-token must equal
 * ADMIN_TOKEN. Body carries the target, the decision, `actor` (who) and `reason` — every action is logged as an
 * intervention.
 */
import { issues } from "@/app/_lib/intake";
import { json, readBody } from "@/app/_lib/http";
import { clientIp, hitRateLimit } from "@/lib/api-keys";
import { AdminAction, AdminConflict, checkAdminToken, runAdminAction } from "@/lib/dashboard/admin";
import { redactSecrets } from "@/lib/dashboard/rows";

export async function POST(req: Request, { params }: { params: Promise<{ action: string }> }) {
  const limit = await hitRateLimit(`admin:${clientIp(req)}`, 120);
  if (!limit.allowed) return json({ error: "rate_limited" }, 429);

  const auth = checkAdminToken(req.headers.get("x-admin-token"));
  if (auth === "disabled") return json({ error: "admin_disabled", message: "Set ADMIN_TOKEN on the server to enable founder actions." }, 503);
  if (auth === "denied") return json({ error: "unauthorized", message: "That admin token is not right." }, 401);

  const parsed = AdminAction.safeParse({ ...(await readBody(req)), action: (await params).action });
  if (!parsed.success) return json({ error: "invalid_request", issues: issues(parsed.error) }, 400);
  try {
    return json(await runAdminAction(parsed.data));
  } catch (e) {
    if (e instanceof AdminConflict) return json({ error: "conflict", message: e.message }, 409);
    console.error("[admin] action failed:", e);
    // Founders only, but shown on a screen people film: no connection strings or keys, whatever the driver said.
    return json({ error: "failed", message: e instanceof Error ? redactSecrets(e.message).slice(0, 300) : "Action failed" }, 502);
  }
}

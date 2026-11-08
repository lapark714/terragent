/**
 * What is waiting on a founder. Readable by anyone; acting on it needs the admin token (POST /api/admin/*).
 * Cached server-side (NOTES H4c); an admin action drops the cache so the decision shows on the next poll.
 */
import { json } from "@/app/_lib/http";
import { cachedApprovals } from "@/lib/dashboard/cache";
import { DbPausedError } from "@/lib/dashboard/rows";

export async function GET() {
  try {
    return json(await cachedApprovals());
  } catch (e) {
    if (e instanceof DbPausedError) return json({ error: "db_suspended", dbSuspended: true, message: e.message }, 503);
    console.error("[dashboard] approvals query failed:", e);
    return json({ error: "unavailable" }, 503);
  }
}

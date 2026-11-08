/** Globe layers: Earth index cells, recent signals, coarsened request markers. Cached server-side (NOTES H4c). */
import { json } from "@/app/_lib/http";
import { cachedGlobe } from "@/lib/dashboard/cache";
import { DbPausedError } from "@/lib/dashboard/rows";

export async function GET() {
  try {
    return json(await cachedGlobe());
  } catch (e) {
    if (e instanceof DbPausedError) return json({ error: "db_suspended", dbSuspended: true, message: e.message }, 503);
    console.error("[dashboard] globe query failed:", e);
    return json({ error: "unavailable" }, 503);
  }
}

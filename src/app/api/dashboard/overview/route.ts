/**
 * Headline counters only (the landing page's live line), cached server-side like the other dashboard reads.
 * `dbSuspended` is true when Neon refused the read with quota / suspension wording (NOTES H4c).
 */
import { json } from "@/app/_lib/http";
import { cachedOverview } from "@/lib/dashboard/cache";

export async function GET() {
  return json(await cachedOverview());
}

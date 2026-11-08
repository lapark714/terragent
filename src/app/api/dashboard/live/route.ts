/**
 * Everything mission control polls every few seconds (PII masked). Served from a short server-side cache: one
 * database read per window however many viewers are polling (Neon $250 rule, NOTES H4c).
 */
import { json } from "@/app/_lib/http";
import { cachedLiveSnapshot } from "@/lib/dashboard/cache";

export async function GET() {
  return json(await cachedLiveSnapshot());
}

/** Headline counters only (the landing page's live line). */
import { json } from "@/app/_lib/http";
import { getOverview } from "@/lib/dashboard/overview";
import { panel } from "@/lib/dashboard/rows";

export async function GET() {
  return json(await panel(getOverview));
}

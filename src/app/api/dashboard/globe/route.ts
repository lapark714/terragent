/** Globe layers: Earth index cells, recent signals, coarsened request markers. */
import { json } from "@/app/_lib/http";
import { getGlobeData } from "@/lib/dashboard/globe";

export async function GET() {
  try {
    return json(await getGlobeData());
  } catch (e) {
    console.error("[dashboard] globe query failed:", e);
    return json({ error: "unavailable" }, 503);
  }
}

/** What is waiting on a founder. Readable by anyone; acting on it needs the admin token (POST /api/admin/*). */
import { json } from "@/app/_lib/http";
import { getApprovals } from "@/lib/dashboard/approvals";

export async function GET() {
  try {
    return json(await getApprovals());
  } catch (e) {
    console.error("[dashboard] approvals query failed:", e);
    return json({ error: "unavailable" }, 503);
  }
}

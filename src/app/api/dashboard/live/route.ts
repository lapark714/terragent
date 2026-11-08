/** Everything mission control polls every few seconds (PII masked). */
import { json } from "@/app/_lib/http";
import { getLiveSnapshot } from "@/lib/dashboard/snapshot";

export async function GET() {
  return json(await getLiveSnapshot());
}

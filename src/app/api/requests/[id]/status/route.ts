/** Progress of one request for its status page. The request id is the capability. */
import { json } from "@/app/_lib/http";
import { getRequestProgress } from "@/lib/dashboard/public";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const progress = await getRequestProgress((await params).id);
  return progress ? json(progress) : json({ error: "not_found" }, 404);
}

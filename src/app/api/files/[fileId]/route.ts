/** Report images: a fresh Naïve file link, served only if the report (by its public token) uses that file. */
import { json } from "@/app/_lib/http";
import { isFileReferenced } from "@/lib/dashboard/public";
import { fileBytes, fileUrl } from "@/lib/naive/files";

export async function GET(req: Request, { params }: { params: Promise<{ fileId: string }> }) {
  const { fileId } = await params;
  const token = new URL(req.url).searchParams.get("r") ?? "";
  if (!(await isFileReferenced(token, fileId))) return json({ error: "not_found" }, 404);
  try {
    return new Response(null, { status: 302, headers: { location: await fileUrl(fileId), "cache-control": "private, max-age=300" } });
  } catch (e) {
    console.error("[files] fileUrl failed, streaming instead:", e);
  }
  try {
    const { bytes, contentType } = await fileBytes(fileId);
    return new Response(new Blob([bytes as BlobPart], { type: contentType }), { headers: { "cache-control": "private, max-age=3600" } });
  } catch (e) {
    console.error("[files] fileBytes failed:", e);
    return json({ error: "file_unavailable" }, 502);
  }
}

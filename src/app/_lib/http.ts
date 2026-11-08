/** Response helpers for the route handlers. */
export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers: { "cache-control": "no-store", ...headers } });
}

/** Reads a JSON body or a classic form post into a plain object; undefined if unreadable. */
export async function readBody(req: Request): Promise<Record<string, unknown> | undefined> {
  const type = req.headers.get("content-type") ?? "";
  try {
    if (type.includes("application/json")) {
      const body: unknown = await req.json();
      return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
    }
    return Object.fromEntries((await req.formData()).entries());
  } catch {
    return undefined;
  }
}

export const isFormPost = (req: Request) => !(req.headers.get("content-type") ?? "").includes("application/json");

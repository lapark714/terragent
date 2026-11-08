/** Person names tied to a tool call's request/prospect, so the MCP boundary can scrub them from free text. */
import { getDb } from "../db/client";

export async function peopleNamesFor(args: unknown): Promise<string[]> {
  const a = (args ?? {}) as { request_id?: unknown; prospect_id?: unknown };
  const requestId = typeof a.request_id === "string" ? a.request_id : null;
  const prospectId = typeof a.prospect_id === "string" ? a.prospect_id : null;
  if (!requestId && !prospectId) return [];
  try {
    const db = await getDb();
    const rows = await db.query<{ n: string | null }>(
      `SELECT customer_name AS n FROM requests WHERE id = $1
       UNION ALL SELECT p.contact_name FROM prospects p WHERE p.id = $2 OR p.id = (SELECT prospect_id FROM requests WHERE id = $1)`,
      [requestId, prospectId],
    );
    return rows.map((r) => r.n).filter((n): n is string => !!n && n.trim().length >= 3);
  } catch {
    return []; // never fail a tool call over scrubbing context; field + email scrubbing still apply
  }
}

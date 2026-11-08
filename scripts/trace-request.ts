/** Usage: npx tsx scripts/trace-request.ts [request_id]  — latest request's status, timeline and agent sessions. Read-only. */
import "dotenv/config";
import { createDb } from "../src/lib/db/client";

const db = await createDb();
const id = process.argv[2] ?? (await db.query<{ id: string }>("SELECT id FROM requests ORDER BY created_at DESC LIMIT 1"))[0]?.id;
if (!id) { console.log("no requests yet"); process.exit(0); }
const [r] = await db.query<Record<string, unknown>>(
  "SELECT id, source, status, stage, owner_agent, priority, location_text, lat, lon, quote_id, report_id, naive_session_ids, created_at, updated_at FROM requests WHERE id = $1", [id]);
console.log("REQUEST", JSON.stringify(r));
const ev = await db.query<{ created_at: Date; type: string; actor: string; payload: unknown }>(
  "SELECT created_at, type, actor, payload FROM events WHERE request_id = $1 OR (type = 'tool.called' AND created_at > $2) ORDER BY created_at", [id, r.created_at]);
const t0 = new Date(r.created_at as string).getTime();
for (const e of ev) {
  const p = JSON.stringify(e.payload); 
  console.log(`+${((new Date(e.created_at).getTime() - t0) / 1000).toFixed(1).padStart(6)}s  ${e.actor.padEnd(16)} ${e.type.padEnd(22)} ${p.length > 160 ? p.slice(0, 160) + "…" : p}`);
}
await db.close();

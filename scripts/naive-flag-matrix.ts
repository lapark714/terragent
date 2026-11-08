/**
 * Probe which get_request content trips Naïve's "read people's data" flag.
 * Creates two probe requests (meta.probe), runs one planner session per request (get_request, then list_providers)
 * and reports whether the second call parked. Removes the probe rows afterwards.
 *   npx tsx scripts/naive-flag-matrix.ts
 */
import "dotenv/config";
import { getDb } from "../src/lib/db/client";
import { naive } from "../src/lib/naive/client";
import { getSetting, SETTING } from "../src/lib/settings";

const db = await getDb();
const agents = await getSetting<Record<string, { id: string }>>(SETTING.naiveAgents, {});
const client = naive();
const cases = [
  { id: "req_probe_nopii1", name: null as string | null, email: null as string | null },
  { id: "req_probe_email1", name: null as string | null, email: "someone@example.com" },
];

for (const c of cases) {
  await db.query("DELETE FROM requests WHERE id = $1", [c.id]);
  await db.query(
    "INSERT INTO requests (id, source, status, question, location_text, customer_name, customer_email, meta) VALUES ($1, 'portal', 'planning', 'Probe: is this area vegetated?', 'Altadena, CA', $2, $3, $4)",
    [c.id, c.name, c.email, JSON.stringify({ probe: true })],
  );
}

async function run(c: (typeof cases)[number]): Promise<string> {
  const s = await client.sessions.create({
    agent_id: agents.planner.id,
    budget_micro_usd: 600_000,
    metadata: { probe: "flag_matrix" },
    message:
      "Diagnostic run, not a customer request. Call terragent.get_request with request_id \"" + c.id +
      "\". Then call terragent.list_providers with data_type \"optical\". Then reply \"done\". Call no other tools and save nothing.",
  });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const cur = await client.sessions.get(s.id);
    if (cur.status !== "idle") continue;
    const pending = (cur.pending_actions ?? []) as { name: string; read_people?: boolean }[];
    if (pending.length) await client.sessions.interrupt(s.id, { message: "probe done" }).catch(() => undefined);
    const parked = pending.map((a) => a.name + "(read_people=" + String(!!a.read_people) + ")").join(",") || "none";
    return c.id + ": stop=" + cur.stop_reason + " parked=" + parked + " cost=" + (cur.consumed_micro_usd ?? 0) / 1e6;
  }
  return c.id + ": still running after 180 s";
}

console.log((await Promise.all(cases.map(run))).join("\n"));
for (const c of cases) {
  await db.query("DELETE FROM events WHERE request_id = $1", [c.id]);
  await db.query("DELETE FROM requests WHERE id = $1", [c.id]);
}
console.log("probe rows cleaned up");

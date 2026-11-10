/**
 * Probe: does calling get_request on a SPECIFIC request flag a fresh session that has no board card or handoff link?
 *   npx tsx scripts/research/naive-flag-probe-request.ts <request_id> [agent=planner]
 */
import "dotenv/config";
import { naive } from "../../src/lib/naive/client";
import { getSetting, SETTING } from "../../src/lib/settings";

const [requestId, agent = "planner"] = process.argv.slice(2);
if (!requestId) throw new Error("usage: naive-flag-probe-request.ts <request_id> [agent]");
const agents = await getSetting<Record<string, { id: string }>>(SETTING.naiveAgents, {});
const client = naive();
const s = await client.sessions.create({
  agent_id: agents[agent].id,
  budget_micro_usd: 600_000,
  metadata: { probe: "flag_by_request" },
  message:
    "Diagnostic run, not a customer request. Call terragent.get_request with request_id \"" + requestId +
    "\". Then call terragent.list_providers with data_type \"optical\". Then reply \"done\". Call no other tools and save nothing.",
});
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const cur = await client.sessions.get(s.id);
  if (cur.status !== "idle") continue;
  const pending = (cur.pending_actions ?? []) as { name: string; read_people?: boolean }[];
  if (pending.length) await client.sessions.interrupt(s.id, { message: "probe done" }).catch(() => undefined);
  console.log(s.id + ": stop=" + cur.stop_reason + " parked=" + (pending.map((a) => a.name + "(read_people=" + String(!!a.read_people) + ")").join(",") || "none"));
  process.exit(0);
}
console.log("still running after 180 s");

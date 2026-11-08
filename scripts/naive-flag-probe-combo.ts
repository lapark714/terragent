/**
 * Two probes run in parallel on a real request:
 *  A) plain session: get_request, then geocode(location), then list_providers   (does the combination flag?)
 *  B) startAgentSession() with the handoff's brief + metadata, no board card    (does how the session starts flag it?)
 *   npx tsx scripts/naive-flag-probe-combo.ts <request_id> "<location text>"
 */
import "dotenv/config";
import { naive } from "../src/lib/naive/client";
import { startAgentSession } from "../src/lib/naive/sessions";
import { getSetting, SETTING } from "../src/lib/settings";

const [requestId, place] = process.argv.slice(2);
if (!requestId || !place) throw new Error("usage: naive-flag-probe-combo.ts <request_id> \"<location>\"");
const agents = await getSetting<Record<string, { id: string }>>(SETTING.naiveAgents, {});
const client = naive();

async function watch(label: string, sessionId: string): Promise<string> {
  for (let i = 0; i < 70; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const cur = await client.sessions.get(sessionId);
    if (cur.status !== "idle") continue;
    const pending = (cur.pending_actions ?? []) as { name: string; read_people?: boolean }[];
    if (pending.length) await client.sessions.interrupt(sessionId, { message: "probe done" }).catch(() => undefined);
    return label + " " + sessionId + ": stop=" + cur.stop_reason + " parked=" + (pending.map((a) => a.name + "(read_people=" + String(!!a.read_people) + ")").join(",") || "none");
  }
  return label + ": still running";
}

const a = await client.sessions.create({
  agent_id: agents.planner.id, budget_micro_usd: 600_000, metadata: { probe: "flag_combo" },
  message: "Diagnostic run, not a customer request. Call terragent.get_request with request_id \"" + requestId + "\". Then call terragent.geocode with text \"" + place +
    "\". Then call terragent.list_providers with data_type \"optical\". Then reply \"done\". Call no other tools and save nothing.",
});
const b = await startAgentSession(
  "planner",
  "Request " + requestId + " — stage planning. Diagnostic run after a platform fix: call terragent.get_request, then terragent.list_providers with data_type \"optical\", then reply \"done\". Save nothing and hand off to no one. Start with terragent.get_request.",
  { requestId, metadata: { stage: "planning", probe: "flag_handoff_path" } },
);
console.log((await Promise.all([watch("A(combo)", a.id), watch("B(handoff-path)", b.session_id)])).join("\n"));

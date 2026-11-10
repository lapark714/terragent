/**
 * Probe Naïve's "read people's data" flag: does an MCP read WITHOUT personal data flag the chat?
 * Starts one short pricing-agent session that calls two PII-free tools, then reports pending actions.
 *   npx tsx scripts/research/naive-flag-probe.ts
 */
import "dotenv/config";
import { naive } from "../../src/lib/naive/client";
import { getSetting, SETTING } from "../../src/lib/settings";

const agents = await getSetting<Record<string, { id: string }>>(SETTING.naiveAgents, {});
const pricing = agents.pricing?.id;
if (!pricing) throw new Error("pricing agent not provisioned");
const n = naive();
const s = await n.sessions.create({
  agent_id: pricing,
  budget_micro_usd: 200_000,
  metadata: { probe: "read_people_flag" },
  message:
    "Diagnostic run, not a customer request. Call terragent.list_providers with data_type \"optical\". Then call " +
    "terragent.get_spend_summary. Then reply with one line: the number of providers listed. Do not call any other tool.",
});
console.log("session", s.id);
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const cur = await n.sessions.get(s.id);
  if (cur.status === "idle") {
    console.log("stop_reason:", cur.stop_reason, "| $", (cur.consumed_micro_usd ?? 0) / 1e6);
    for (const a of cur.pending_actions ?? []) console.log("PENDING", a.name, "read_people:", (a as { read_people?: boolean }).read_people ?? false);
    process.exit(0);
  }
}
console.log("still running after 120 s");

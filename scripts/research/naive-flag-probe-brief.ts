/**
 * Decisive probe: re-run a real stage with the EXACT brief of an earlier (flagged) session, via startAgentSession,
 * WITHOUT writing the board card. Interrupts the flagged session first. If this one isn't flagged, the board card is
 * the trigger; if it is, the brief/content is.
 *   npx tsx scripts/research/naive-flag-probe-brief.ts <flagged ses_id> <agent> <request_id>
 */
import "dotenv/config";
import { AgentName } from "../../src/lib/domain";
import { naive } from "../../src/lib/naive/client";
import { startAgentSession } from "../../src/lib/naive/sessions";

const [flagged, agentArg, requestId] = process.argv.slice(2);
if (!flagged || !agentArg || !requestId) throw new Error("usage: naive-flag-probe-brief.ts <ses_id> <agent> <request_id>");
const agent = AgentName.parse(agentArg);
const client = naive();
const events = await client.sessions.events(flagged, { limit: 10 });
const first = (events.data as { type: string; data?: { role?: string; content?: unknown } }[])
  .find((e) => e.type === "message.completed" && e.data?.role === "user");
const brief = typeof first?.data?.content === "string" ? first.data.content : null;
if (!brief) throw new Error("could not read the flagged session's brief");
await client.sessions.interrupt(flagged, { message: "Superseded by a probe re-run of this stage." }).catch(() => undefined);
const { session_id } = await startAgentSession(agent, brief, { requestId, metadata: { stage: "probe-rerun" } });
console.log("re-run session", session_id, "| brief chars", brief.length);
for (let i = 0; i < 70; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const cur = await client.sessions.get(session_id);
  if (cur.status !== "idle") continue;
  const pending = (cur.pending_actions ?? []) as { name: string; read_people?: boolean }[];
  console.log("stop=" + cur.stop_reason + " parked=" + (pending.map((a) => a.name + "(read_people=" + String(!!a.read_people) + ")").join(",") || "none"));
  process.exit(0);
}
console.log("still running after 210 s");

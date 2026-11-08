/**
 * Founder override: allow specific parked tool calls in one session (the dashboard can only allow paid orders).
 * Logs one intervention per call. Usage: npx tsx scripts/approve-parked.ts <ses_id> "<actor>" "<reason>" [tool_call_id ...]
 * With no tool_call_ids, allows every pending call in the session.
 */
import "dotenv/config";
import { naive } from "../src/lib/naive/client";
import { logIntervention } from "../src/lib/events";

const [sessionId, actor, reason, ...ids] = process.argv.slice(2);
if (!sessionId || !actor || !reason) throw new Error('usage: approve-parked.ts <ses_id> "<actor>" "<reason>" [tool_call_id ...]');
const n = naive();
const s = await n.sessions.get(sessionId);
const pending = (s.pending_actions ?? []).filter((a) => a.kind !== "question" && (!ids.length || ids.includes(a.tool_call_id)));
const requestId = (s.metadata as Record<string, string> | undefined)?.request_id ?? null;
for (const a of pending) {
  await logIntervention({ actor, action: "approve_tool_call", reason: `${reason} [${a.name}]`, requestId, refId: a.tool_call_id });
  await n.sessions.confirmTool(sessionId, { tool_call_id: a.tool_call_id, decision: "allow", reason });
  console.log("allowed", a.name, a.tool_call_id);
}
if (!pending.length) console.log("nothing pending in", sessionId);

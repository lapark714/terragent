/**
 * Founder ops: stop a stuck agent session and re-issue a request's stage through the normal handoff
 * (so the brief is scrubbed, logged and mirrored like any other). Logs an intervention.
 *   npx tsx scripts/restart-stage.ts <request_id> <agent> <stage> "<instructions>" [--interrupt ses_…] --actor "<who>" --reason "<why>"
 */
import "dotenv/config";
import { AgentName } from "../src/lib/domain";
import { logIntervention } from "../src/lib/events";
import { naive } from "../src/lib/naive/client";
import { handoff } from "../src/lib/pipeline/requests";

const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv.splice(i, 2)[1] : undefined; };
const interrupt = flag("--interrupt");
const actor = flag("--actor") ?? "founder";
const reason = flag("--reason") ?? "restart stage";
const [requestId, agent, stage, instructions] = argv;
if (!requestId || !agent || !stage || !instructions) throw new Error("usage: restart-stage.ts <request_id> <agent> <stage> \"<instructions>\" [--interrupt ses_…] --actor … --reason …");
const to = AgentName.parse(agent);
if (interrupt) {
  await naive().sessions.interrupt(interrupt, { message: "Superseded: this stage was restarted with a clean brief." });
  console.log("interrupted", interrupt);
}
await logIntervention({ actor, action: "restart_stage", reason: `${reason} (${to}, ${stage})`, requestId, refId: interrupt ?? null });
// A founder restart is a human action: attribute it to them (agents retrying the same handoff are deduped, humans are not).
const res = await handoff({ requestId, from: `human:${actor}`, to, stage, instructions });
console.log("handoff", JSON.stringify(res));

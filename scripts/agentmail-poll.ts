/**
 * Local inbound without a public URL: read recent inbound mail from AgentMail and feed it through the same
 * handler the webhook uses (src/lib/email/inbound.ts). Never sends mail.
 *   npx tsx scripts/agentmail-poll.ts                     # dry run (default): print where each message would route
 *   npx tsx scripts/agentmail-poll.ts --apply             # store + route (may start agent sessions / board cards)
 * Options: --inbox hello|data|outreach (default all) · --limit N (default 20 per inbox) · --since-hours H (default 24)
 * Re-runs are safe: each message is stored once (key in:<inbox>:<message id>), later runs report "duplicate".
 * With TERRAGENT_DB=memory the schema is created first, so a dry run touches no real database.
 */
import "dotenv/config";
import { mailApi } from "../src/lib/agentmail/client";
import { inboxes } from "../src/lib/agentmail/config";
import { createDb, setDb } from "../src/lib/db/client";
import { migrate } from "../src/lib/db/migrate";
import { Inbox } from "../src/lib/domain";
import { handleInboundEmail, planRoute, type Route } from "../src/lib/email/inbound";
import { fromSdkMessage } from "../src/lib/email/inbound-parse";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const apply = process.argv.includes("--apply");
const only = arg("inbox") ? Inbox.parse(arg("inbox")) : null;
const limit = Number(arg("limit") ?? 20);
const after = new Date(Date.now() - Number(arg("since-hours") ?? 24) * 3_600_000);

const db = await createDb();
if (process.env.TERRAGENT_DB === "memory") await migrate(db);
setDb(db);

const describe = (r: Route) => [r.kind, "reason" in r ? r.reason : "", "requestId" in r ? (r.requestId ?? "") : ""].filter(Boolean).join(" ");

console.log(`[agentmail-poll] ${apply ? "APPLY" : "dry run"} · db ${db.kind} · since ${after.toISOString()}`);
for (const cfg of Object.values(inboxes())) {
  if (only && cfg.role !== only) continue;
  const page = await mailApi().listMessages(cfg.address, { limit, after, ascending: true });
  const received = page.messages.filter((m) => m.labels.includes("received"));
  console.log(`${cfg.role} (${cfg.address}): ${received.length} received`);
  for (const item of received) {
    const msg = fromSdkMessage(await mailApi().getMessage(cfg.address, item.messageId));
    const route = apply ? (await handleInboundEmail(msg)).route : await planRoute(msg);
    console.log(`  ${item.timestamp.toISOString()}  ${msg.from.slice(0, 40).padEnd(40)}  ${(msg.subject ?? "").slice(0, 50).padEnd(50)}  → ${describe(route)} [armor ${msg.security.verdict}]`);
  }
}
await db.close();

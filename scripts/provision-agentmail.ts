/**
 * Ensure the three Terragent inboxes exist with the right display names. Idempotent.
 *   npm run provision:agentmail -- --dry-run   # show what would change
 *   npm run provision:agentmail                # apply
 * Creates inboxes only; never sends mail. Free plan = 3 inboxes total.
 */
import "dotenv/config";
import { AgentMailClient, AgentMailError } from "agentmail";
import { inboxes } from "../src/lib/agentmail/config";

const dryRun = process.argv.includes("--dry-run");
if (!process.env.AGENTMAIL_API_KEY) throw new Error("AGENTMAIL_API_KEY is not set (see .env.example)");
const am = new AgentMailClient({ apiKey: process.env.AGENTMAIL_API_KEY });

const existing = new Map<string, { inboxId: string; displayName?: string }>();
let pageToken: string | undefined;
do {
  const page = await am.inboxes.list({ limit: 100, pageToken });
  for (const i of page.inboxes) existing.set(i.inboxId.toLowerCase(), { inboxId: i.inboxId, displayName: i.displayName });
  pageToken = page.nextPageToken;
} while (pageToken);
console.log(`[agentmail] org has ${existing.size} inbox(es): ${[...existing.keys()].join(", ") || "none"}`);

for (const cfg of Object.values(inboxes())) {
  const found = existing.get(cfg.address);
  if (found) {
    if (found.displayName === cfg.displayName) {
      console.log(`  ok      ${cfg.role.padEnd(8)} ${cfg.address} ("${cfg.displayName}")`);
    } else if (dryRun) {
      console.log(`  would rename ${cfg.role} ${cfg.address}: "${found.displayName}" -> "${cfg.displayName}"`);
    } else {
      await am.inboxes.update(found.inboxId, { displayName: cfg.displayName });
      console.log(`  renamed ${cfg.role.padEnd(8)} ${cfg.address}: "${found.displayName}" -> "${cfg.displayName}"`);
    }
    continue;
  }
  if (dryRun) {
    console.log(`  would create ${cfg.role} ${cfg.address} ("${cfg.displayName}")`);
    continue;
  }
  try {
    const created = await am.inboxes.create({ username: cfg.username, displayName: cfg.displayName, clientId: cfg.clientId });
    console.log(`  created ${cfg.role.padEnd(8)} ${created.inboxId} ("${cfg.displayName}")`);
  } catch (e) {
    const body = e instanceof AgentMailError ? (e.body as { code?: string; message?: string; suggestions?: string[] }) : undefined;
    const code = body?.code;
    if (code === "resource_taken") {
      console.error(`  TAKEN   ${cfg.address} belongs to another AgentMail customer.` +
        (body?.suggestions?.length ? ` Suggestions: ${body.suggestions.join(", ")}.` : "") +
        ` Set AGENTMAIL_INBOX_${cfg.role.toUpperCase()} to another address and re-run.`);
    } else if (code === "limit_exceeded") {
      console.error(`  LIMIT   plan inbox limit reached; ${cfg.address} not created.`);
    } else {
      console.error(`  FAILED  ${cfg.address}: ${code ?? ""} ${body?.message ?? (e as Error).message}`);
    }
    process.exitCode = 1;
  }
}

/**
 * Create or update the one AgentMail webhook for our three inboxes and store its signing secret in settings
 * (SETTING.agentmailWebhook, read by /api/webhooks/agentmail). Never sends mail; never prints the secret.
 *   npx tsx scripts/provision-agentmail-webhook.ts --dry-run   # show what would change
 *   npx tsx scripts/provision-agentmail-webhook.ts             # apply (writes settings in DATABASE_URL's DB)
 * Needs an https PUBLIC_BASE_URL: AgentMail can't reach localhost (use scripts/agentmail-poll.ts locally).
 * Idempotent: the clientId is derived from the URL, so re-runs find the same webhook.
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { agentmailSdk } from "../src/lib/agentmail/client";
import { inboxes } from "../src/lib/agentmail/config";
import { WEBHOOK_EVENT_TYPES } from "../src/lib/email/webhook";
import { getDb } from "../src/lib/db/client";
import { publicBaseUrl } from "../src/lib/env";
import { setSetting, SETTING } from "../src/lib/settings";

const dryRun = process.argv.includes("--dry-run");
const base = publicBaseUrl();
if (!base.startsWith("https://")) {
  throw new Error(`PUBLIC_BASE_URL must be an https URL AgentMail can reach (got ${base}). For local runs use scripts/agentmail-poll.ts.`);
}
const url = `${base}/api/webhooks/agentmail`;
const clientId = `terragent-webhook-${createHash("sha256").update(url).digest("hex").slice(0, 12)}`;
const inboxIds = Object.values(inboxes()).map((i) => i.address);
const am = agentmailSdk();

const all = (await am.webhooks.list({ limit: 100 })).webhooks;
const existing = all.find((w) => w.clientId === clientId) ?? all.find((w) => w.url === url);
for (const w of all) {
  if (w !== existing && w.clientId?.startsWith("terragent-webhook-")) {
    console.warn(`  note    older Terragent webhook ${w.webhookId} -> ${w.url} (enabled=${w.enabled}); delete it in the AgentMail console if unused`);
  }
}

let webhook = existing;
if (existing) {
  const addInboxIds = inboxIds.filter((i) => !(existing.inboxIds ?? []).includes(i));
  const missingTypes = WEBHOOK_EVENT_TYPES.filter((t) => !(existing.eventTypes ?? []).includes(t));
  if (!addInboxIds.length && !missingTypes.length && existing.enabled) {
    console.log(`  ok      ${existing.webhookId} -> ${url}`);
  } else if (dryRun) {
    console.log(`  would update ${existing.webhookId}: enable, add inboxes [${addInboxIds.join(", ")}], add events [${missingTypes.join(", ")}]`);
  } else {
    // eventTypes replaces the list, so always send the full set.
    webhook = await am.webhooks.update(existing.webhookId, { eventTypes: WEBHOOK_EVENT_TYPES, enabled: true, addInboxIds });
    console.log(`  updated ${webhook.webhookId} -> ${url}`);
  }
} else if (dryRun) {
  console.log(`  would create webhook -> ${url} for [${inboxIds.join(", ")}], events [${WEBHOOK_EVENT_TYPES.join(", ")}]`);
} else {
  webhook = await am.webhooks.create({ url, eventTypes: WEBHOOK_EVENT_TYPES, inboxIds, clientId });
  console.log(`  created ${webhook.webhookId} -> ${url}`);
}

if (webhook && !dryRun) {
  const { secret } = await am.webhooks.get(webhook.webhookId); // list results may not carry the secret
  const db = await getDb();
  await setSetting(SETTING.agentmailWebhook, { id: webhook.webhookId, secret, url }, "provision-agentmail-webhook");
  console.log(`  stored signing secret in settings "${SETTING.agentmailWebhook}" (${db.kind})`);
  await db.close();
}

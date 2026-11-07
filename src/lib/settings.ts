/**
 * Key/value settings in Postgres (table `settings`). Holds runtime state that isn't a secret
 * credential to a third party: Naïve agent ids, inbox armed flags, feature flags, allocation.
 */
import { getDb } from "./db/client";

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const db = await getDb();
  const rows = await db.query<{ value: T }>("SELECT value FROM settings WHERE key = $1", [key]);
  return rows.length ? rows[0].value : fallback;
}

export async function setSetting(key: string, value: unknown, updatedBy = "system") {
  const db = await getDb();
  await db.query(
    `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, JSON.stringify(value), updatedBy],
  );
}

/** Well-known keys. Add new ones here so they're discoverable. */
export const SETTING = {
  /** { [agentName]: { id: "agt_…", version: number } } written by scripts/provision-naive.ts */
  naiveAgents: "naive.agents",
  /** { coordinator: "agt_…" } board owner */
  naiveBoard: "naive.board",
  /** { [deploymentName]: "dep_…" } */
  naiveDeployments: "naive.deployments",
  /** Webhook signing secrets [{ id: "whk_…", secret: "whsec_…", purpose }] — written once by provisioning */
  naiveWebhookSecrets: "naive.webhook_secrets",
  /** { file_id: "fil_…", sha256, uploaded_at } — the pipeline tarball the Analytics agent bootstraps from */
  pipelineBundle: "pipeline.bundle",
  /** AgentMail webhook { id, secret } */
  agentmailWebhook: "agentmail.webhook",
  /** { hello: boolean, data: boolean, outreach: boolean } — founder-armed after approving first send */
  inboxArmed: "email.inbox_armed",
  /** Latest playbook allocation { disasters, deforestation, mining } */
  allocation: "coordinator.allocation",
} as const;

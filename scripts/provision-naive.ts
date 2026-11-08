/**
 * Provision Terragent on Naïve: playbook skills, the 12 agents, per-agent MCP tokens in the vault,
 * the coordinator's team + board, the pipeline bundle, cron deployments and webhooks. Idempotent.
 *
 *   npx tsx scripts/provision-naive.ts --dry-run                 # read-only plan (no DB access)
 *   npx tsx scripts/provision-naive.ts                           # apply everything
 *   npx tsx scripts/provision-naive.ts --only agents,team        # some parts
 *
 * Safety flags: --force-budgets applies budgets below the measured pre-flight floor (refused otherwise),
 * --adopt takes over same-name agents not created by Terragent, --reenable-webhooks turns disabled
 * endpoints back on. Deployments a founder paused stay paused. OUTREACH_CONTACT_FORM_APPROVED=true
 * (a founder's decision) lets comms-outreach submit contact forms without a per-action approval.
 *
 * Parts that Naïve calls back (MCP server, vault tokens, deployments, webhooks) need PUBLIC_BASE_URL
 * to be the deployed https origin; without it they are skipped. Applying writes ids, token hashes and
 * webhook secrets to getDb() (production Neon when DATABASE_URL is set). Never prints secrets.
 */
import "dotenv/config";
import { parseArgs } from "node:util";
import { env, envFlag } from "../src/lib/env";
import { naive } from "../src/lib/naive/client";
import { PARTS, provision, type Action, type Part } from "../naive/provision";

const { values } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    only: { type: "string" },
    "local-db": { type: "boolean", default: false },
    "force-budgets": { type: "boolean", default: false },
    adopt: { type: "boolean", default: false },
    "reenable-webhooks": { type: "boolean", default: false },
  },
});

const parts = values.only ? (values.only.split(",").map((p) => p.trim()) as Part[]) : [...PARTS];
const unknown = parts.filter((p) => !PARTS.includes(p));
if (unknown.length) throw new Error(`--only: unknown part(s) ${unknown.join(", ")}; expected ${PARTS.join("|")}`);

const dryRun = values["dry-run"];
const publicBaseUrl = env("PUBLIC_BASE_URL") ?? null;
const contactFormsApproved = envFlag("OUTREACH_CONTACT_FORM_APPROVED");
console.log(
  `[provision-naive] ${dryRun ? "DRY RUN" : "APPLY"}; parts: ${parts.join(", ")}; PUBLIC_BASE_URL: ${publicBaseUrl ?? "(unset)"}; ` +
    `contact forms: ${contactFormsApproved ? "approved" : "each write action asks a founder"}`,
);

const actions: Action[] = await provision({
  client: naive(),
  dryRun,
  publicBaseUrl,
  notifyEmail: env("NAIVE_NOTIFY_EMAIL") ?? null,
  parts,
  allowLocalDb: values["local-db"],
  contactFormsApproved,
  forceBudgets: values["force-budgets"],
  adopt: values.adopt,
  reenableWebhooks: values["reenable-webhooks"],
  log: (line) => console.log(line),
});

const counts = actions.reduce<Record<string, number>>((acc, a) => ({ ...acc, [a.action]: (acc[a.action] ?? 0) + 1 }), {});
console.log(`[provision-naive] done: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ") || "nothing to do"}`);

/**
 * Idempotent provisioning of the Naïve side of Terragent. Every step finds what exists (by name, slug,
 * key or marker), changes only what differs, and records one action per target. Dry runs read Naïve
 * only: no Naïve writes, no database access, no bundle build.
 *
 * Order matters: skills (agents reference them) → agents → vault (credentials bind to the agents'
 * current versions) → team (pins members' current versions, so it runs after every agent change) →
 * bundle → deployments → webhooks (collects the on_idle endpoints deployments create).
 */
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AgentPatch, DeploymentPatch, VettaClient } from "@usenaive-sdk/managed-agents";
import { usd } from "../src/lib/config";
import { getDb } from "../src/lib/db/client";
import { AGENT_NAMES, type AgentName } from "../src/lib/domain";
import type { AgentRegistry } from "../src/lib/naive/registry";
import type { WebhookSecret } from "../src/lib/naive/webhooks";
import { getSetting, setSetting, SETTING } from "../src/lib/settings";
import { DEPLOYMENT_TIMEZONE, DEPLOYMENTS, deploymentMarker, runBudgetUsd } from "./deployments";
import { budgetWarnings, buildAllAgentConfigs, isPublicBaseUrl, naiveWebhookUrl, terragentMcpUrl } from "./index";
import { loadAllSkills } from "./skills";

export const PARTS = ["skills", "agents", "vault", "team", "bundle", "deployments", "webhooks"] as const;
export type Part = (typeof PARTS)[number];

export type ProvisionClient = Pick<VettaClient, "agents" | "skills" | "vaults" | "board" | "deployments" | "webhooks" | "files">;
type Agent = Awaited<ReturnType<VettaClient["agents"]["get"]>>;

export const VAULT_NAME = "terragent";
export const WEBHOOK_EVENTS = ["session.idle", "message.completed", "budget.exceeded"];
export const BUNDLE_PATH = path.join("dist", "pipeline-bundle.tgz");
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const credentialKey = (agent: AgentName) => `terragent-mcp:${agent}`;

export interface ProvisionOptions {
  client: ProvisionClient;
  dryRun: boolean;
  /** https origin of the deployed app; anything else skips the parts Naïve must call back. */
  publicBaseUrl: string | null;
  notifyEmail?: string | null;
  parts?: readonly Part[];
  log?: (line: string) => void;
  /** Allow token hashes to go to a non-Neon database (tests; a local DB would orphan the vault tokens). */
  allowLocalDb?: boolean;
  repoRoot?: string;
  /** Builds dist/pipeline-bundle.tgz; defaults to `npx tsx scripts/bundle-pipeline.ts` when that script exists. */
  buildBundle?: (root: string) => void;
  mintToken?: () => string;
  /** A founder approved contact-form outreach (OUTREACH_CONTACT_FORM_APPROVED); see BuildOptions. */
  contactFormsApproved?: boolean;
  /** Apply budgets that budgetWarnings() flags as below the measured pre-flight floor (otherwise refused). */
  forceBudgets?: boolean;
  /** Take over a same-name agent that was not created by Terragent (metadata.app !== "terragent"). */
  adopt?: boolean;
  /** Re-enable webhook endpoints at our URL that someone disabled. */
  reenableWebhooks?: boolean;
}

export interface Action {
  part: Part;
  target: string;
  action: "create" | "update" | "ok" | "skip" | "delete" | "rotate";
  detail?: string;
}

type Page<T> = { data: T[]; has_more: boolean; next_cursor: string | null };

async function listAll<T>(fetchPage: (q: { limit: number; after?: string }) => Promise<Page<T>>): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  do {
    const page = await fetchPage({ limit: 100, ...(after ? { after } : {}) });
    out.push(...page.data);
    after = page.has_more && page.next_cursor ? page.next_cursor : undefined;
  } while (after);
  return out;
}

const isNotFound = (e: unknown) => (e as { status?: number } | null)?.status === 404;
const isOurs = (a: Agent) => (a.metadata as Record<string, unknown> | null)?.app === "terragent";
const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

/** JSON with sorted keys, so semantically equal configs compare equal. */
export function canon(v: unknown): string {
  const sort = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(sort)
      : x && typeof x === "object"
        ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort((x as Record<string, unknown>)[k])]))
        : x;
  return JSON.stringify(sort(v ?? null));
}

/** Apply the server's read-side defaults so a stored config compares equal to the one we wrote. */
function normalize(field: string, v: unknown): unknown {
  if (field === "tools" && v && typeof v === "object") {
    const t = v as { default_config: unknown; configs: Record<string, { enabled?: boolean; permission: string; config?: unknown }> };
    return {
      default_config: t.default_config,
      configs: Object.fromEntries(
        Object.entries(t.configs).map(([k, c]) => [k, { enabled: c.enabled ?? true, permission: c.permission, ...(c.config ? { config: c.config } : {}) }]),
      ),
    };
  }
  if (field === "handoffs") return v ?? true;
  return v ?? null;
}

/** Config fields whose stored value differs from what we want (name and harness are create-only). */
export function changedFields(current: Agent, want: Record<string, unknown>): string[] {
  return Object.keys(want).filter(
    (k) => k !== "name" && k !== "harness" && canon(normalize(k, (current as Record<string, unknown>)[k])) !== canon(normalize(k, want[k])),
  );
}

class Run {
  readonly actions: Action[] = [];
  readonly changedAgents = new Set<AgentName>();
  private agentCache: Map<string, Agent> | null = null;

  constructor(readonly o: ProvisionOptions & { log: (line: string) => void; root: string }) {}

  get client() {
    return this.o.client;
  }
  get dry() {
    return this.o.dryRun;
  }
  get root() {
    return this.o.root;
  }
  get base(): string | null {
    return isPublicBaseUrl(this.o.publicBaseUrl) ? this.o.publicBaseUrl : null;
  }

  record(part: Part, target: string, action: Action["action"], detail?: string) {
    this.actions.push({ part, target, action, ...(detail ? { detail } : {}) });
    const verb = this.dry && action !== "ok" && action !== "skip" ? `would ${action}` : action;
    this.o.log(`  ${verb.padEnd(14)} ${part}/${target}${detail ? ` (${detail})` : ""}`);
  }

  async agents(): Promise<Map<string, Agent>> {
    this.agentCache ??= new Map((await listAll((q) => this.client.agents.list(q))).map((a) => [a.name, a]));
    return this.agentCache;
  }

  async saveRegistry() {
    if (this.dry) return;
    const agents = await this.agents();
    const reg: AgentRegistry = {};
    for (const name of AGENT_NAMES) {
      const a = agents.get(name);
      if (a) reg[name] = { id: a.id, version: a.current_version };
    }
    await setSetting(SETTING.naiveAgents, reg, "provision-naive");
  }
}

async function stepSkills(r: Run) {
  for (const s of loadAllSkills()) {
    let latest: { version: number; sha256: string } | undefined;
    try {
      const versions = await listAll((q) => r.client.skills.listVersions(s.slug, q));
      latest = versions.reduce<typeof latest>((best, v) => (!best || v.version > best.version ? v : best), undefined);
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
    if (latest?.sha256 === s.sha256) {
      r.record("skills", s.slug, "ok", `v${latest.version}`);
      continue;
    }
    const action = latest ? "update" : "create";
    if (r.dry) {
      r.record("skills", s.slug, action);
      continue;
    }
    const pushed = await r.client.skills.push({ slug: s.slug, content: s.content, description: s.description });
    r.record("skills", s.slug, action, `v${pushed.version}`);
  }
}

async function stepAgents(r: Run) {
  if (!r.base) {
    r.o.log("  ! PUBLIC_BASE_URL is not a public https URL: agents are saved WITHOUT the terragent MCP server and tools. Re-run after the first deploy.");
  }
  const agents = await r.agents();
  const configs = buildAllAgentConfigs({ publicBaseUrl: r.base, notifyEmail: r.o.notifyEmail ?? null, contactFormsApproved: r.o.contactFormsApproved });
  const foreign = AGENT_NAMES.filter((n) => agents.has(n) && !isOurs(agents.get(n)!));
  if (foreign.length && !r.o.adopt) {
    throw new Error(`agents: ${foreign.join(", ")} already exist in the org but were not created by Terragent (metadata.app). Rename them, or re-run with --adopt to take them over.`);
  }
  for (const name of AGENT_NAMES) {
    const want = configs[name];
    const current = agents.get(name);
    if (!current) {
      r.changedAgents.add(name);
      if (r.dry) {
        r.record("agents", name, "create", `${want.model}, ${want.window}`);
        continue;
      }
      const created = await r.client.agents.create(want);
      agents.set(name, created);
      r.record("agents", name, "create", created.id);
      continue;
    }
    const changed = changedFields(current, want);
    if (!changed.length) {
      r.record("agents", name, "ok", `v${current.current_version}`);
      continue;
    }
    r.changedAgents.add(name);
    if (r.dry) {
      r.record("agents", name, "update", changed.join(", "));
      continue;
    }
    const patch = Object.fromEntries(changed.map((k) => [k, (want as Record<string, unknown>)[k]])) as AgentPatch;
    const updated = await r.client.agents.update(current.id, { ...patch, expected_version: current.current_version });
    agents.set(name, updated);
    r.record("agents", name, "update", `${changed.join(", ")} → v${updated.current_version}`);
  }
  await r.saveRegistry();
}

async function hasActiveToken(agent: AgentName): Promise<boolean> {
  const db = await getDb();
  return (await db.query("SELECT 1 FROM mcp_tokens WHERE agent = $1 AND NOT revoked LIMIT 1", [agent])).length > 0;
}

/** Store the new hash first, then vault the token, then revoke older hashes: no window without auth. */
async function storeToken(agent: AgentName, token: string) {
  const db = await getDb();
  const hash = sha256(token);
  await db.query("INSERT INTO mcp_tokens (token_hash, agent) VALUES ($1, $2)", [hash, agent]);
  return async () => {
    await db.query("UPDATE mcp_tokens SET revoked = true WHERE agent = $1 AND token_hash <> $2 AND NOT revoked", [agent, hash]);
  };
}

async function stepVault(r: Run) {
  if (!r.base) {
    r.record("vault", VAULT_NAME, "skip", "needs PUBLIC_BASE_URL (https): credentials bind to the exact MCP URL");
    return;
  }
  if (!r.dry && !r.o.allowLocalDb && (await getDb()).kind !== "neon") {
    throw new Error("vault: token hashes must go to the production database (DATABASE_URL) or the deployed MCP server cannot verify them");
  }
  const url = terragentMcpUrl(r.base);
  const agents = await r.agents();
  let vault = (await listAll((q) => r.client.vaults.list(q))).find((v) => v.display_name === VAULT_NAME);
  if (!vault) {
    if (r.dry) r.record("vault", VAULT_NAME, "create");
    else {
      vault = await r.client.vaults.create({ display_name: VAULT_NAME, identity_id: null });
      r.record("vault", VAULT_NAME, "create", vault.id);
    }
  }
  const vaultId = vault?.id;
  const creds = vaultId ? await listAll((q) => r.client.vaults.credentials.list(vaultId, q)) : [];
  const mint = r.o.mintToken ?? (() => `tgm_${randomBytes(32).toString("base64url")}`);

  for (const name of AGENT_NAMES) {
    const agent = agents.get(name);
    if (!agent) {
      r.record("vault", name, r.dry ? "create" : "skip", "after the agent exists");
      continue;
    }
    const mine = creds.filter((c) => c.key === credentialKey(name));
    const current = mine.filter((c) => c.mcp_server_url === url && c.agent_id === agent.id);
    if (current.length && (r.dry || (await hasActiveToken(name)))) {
      r.record("vault", name, "ok", r.dry ? "credential exists (token hash checked on apply)" : current[0].id);
      continue;
    }
    if (r.dry || !vaultId) {
      r.record("vault", name, mine.length ? "rotate" : "create", "mint token, store sha256 in mcp_tokens, static_bearer bound to agent");
      continue;
    }
    const token = mint();
    const revokeOld = await storeToken(name, token);
    const cred = await r.client.vaults.credentials.create(vaultId, {
      kind: "static_bearer",
      key: credentialKey(name),
      value: token,
      mcp_server_url: url,
      agent_id: agent.id,
    });
    for (const old of mine) await r.client.vaults.credentials.delete(vaultId, old.id);
    await revokeOld();
    r.record("vault", name, mine.length ? "rotate" : "create", cred.id);
  }
}

async function stepTeam(r: Run) {
  const agents = await r.agents();
  const coordinator = agents.get("coordinator");
  const members = AGENT_NAMES.filter((n) => n !== "coordinator");
  const missing = members.filter((n) => !agents.has(n));
  if (!coordinator || missing.length) {
    r.record("team", "coordinator", r.dry ? "update" : "skip", `after agents exist (missing: ${[...(coordinator ? [] : ["coordinator"]), ...missing].join(", ")})`);
    return;
  }
  const roster = members.map((n) => ({ type: "agent" as const, id: agents.get(n)!.id, version: agents.get(n)!.current_version }));
  const want = { type: "coordinator" as const, agents: roster, board: true };
  const memberChanged = members.some((n) => r.changedAgents.has(n));
  if (!memberChanged && canon(coordinator.multiagent) === canon(want) && coordinator.handoffs === "team") {
    r.record("team", "coordinator", "ok", `${roster.length} members, board`);
  } else if (r.dry) {
    r.record("team", "coordinator", "update", memberChanged ? "re-pin members after their updates" : "roster/board");
  } else {
    const updated = await r.client.agents.update(coordinator.id, { expected_version: coordinator.current_version, multiagent: want, handoffs: "team" });
    agents.set("coordinator", updated);
    r.record("team", "coordinator", "update", `${roster.length} members pinned → v${updated.current_version}`);
  }
  if (r.dry) {
    r.record("team", "board", "ok", "ensured on apply");
    return;
  }
  const board = await r.client.board.create(coordinator.id);
  await setSetting(SETTING.naiveBoard, { coordinator: coordinator.id }, "provision-naive");
  r.record("team", "board", "ok", board.id);
  await r.saveRegistry();
}

function defaultBuildBundle(root: string) {
  const script = path.join(root, "scripts", "bundle-pipeline.ts");
  if (existsSync(script)) execFileSync("npx", ["tsx", script], { cwd: root, stdio: "inherit" });
}

async function stepBundle(r: Run) {
  const file = path.join(r.root, BUNDLE_PATH);
  if (!r.dry) (r.o.buildBundle ?? defaultBuildBundle)(r.root);
  if (!existsSync(file)) {
    r.record("bundle", BUNDLE_PATH, "skip", "missing: build it with `npx tsx scripts/bundle-pipeline.ts` (imagery builder)");
    return;
  }
  const bytes = readFileSync(file);
  const digest = sha256(bytes);
  if (bytes.length > MAX_UPLOAD_BYTES) throw new Error(`bundle is ${bytes.length} bytes; Naïve multipart upload takes ≤ 25 MiB`);
  if (r.dry) {
    r.record("bundle", BUNDLE_PATH, "update", `upload unless settings already hold sha256 ${digest.slice(0, 12)}`);
    return;
  }
  const prev = await getSetting<{ file_id: string; sha256: string } | null>(SETTING.pipelineBundle, null);
  if (prev?.sha256 === digest) {
    r.record("bundle", BUNDLE_PATH, "ok", prev.file_id);
    return;
  }
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "application/gzip" }), `pipeline-${digest.slice(0, 12)}.tgz`);
  form.append("folder", "infra");
  form.append("tags", "pipeline");
  const uploaded = await r.client.files.upload(form);
  await setSetting(SETTING.pipelineBundle, { file_id: uploaded.id, sha256: digest, uploaded_at: new Date().toISOString() }, "provision-naive");
  r.record("bundle", BUNDLE_PATH, prev ? "update" : "create", uploaded.id);
}

async function stepDeployments(r: Run) {
  if (!r.base) {
    // A cron run without the terragent MCP can do nothing useful and still costs credits.
    r.record("deployments", "*", "skip", "needs PUBLIC_BASE_URL (https): runs need the terragent MCP and on_idle");
    return;
  }
  const agents = await r.agents();
  const existing = await listAll((q) => r.client.deployments.list(q));
  const ids: Record<string, string> = {};
  for (const spec of DEPLOYMENTS) {
    const agent = agents.get(spec.agent);
    if (!agent) {
      r.record("deployments", spec.key, r.dry ? "create" : "skip", `after agent ${spec.agent} exists; ${spec.cron}, $${runBudgetUsd(spec)}/run`);
      continue;
    }
    const want = {
      cron: spec.cron,
      timezone: DEPLOYMENT_TIMEZONE,
      input_template: spec.prompt,
      budget_micro_usd: usd(runBudgetUsd(spec)),
      window: spec.window,
      on_idle: naiveWebhookUrl(r.base),
      agent_version: null,
    };
    const current = existing.find((d) => d.agent_id === agent.id && d.input_template.includes(deploymentMarker(spec.key)));
    if (!current) {
      if (r.dry) {
        r.record("deployments", spec.key, "create", `${spec.cron} ${want.window} $${runBudgetUsd(spec)}/run`);
        continue;
      }
      const created = await r.client.deployments.create({ agent_id: agent.id, ...want, enabled: true });
      ids[spec.key] = created.id;
      r.record("deployments", spec.key, "create", `${created.id} ${created.schedule_status}${created.schedule_status === "scheduled" ? "" : " (will NOT fire on its own)"}`);
      continue;
    }
    ids[spec.key] = current.id;
    // `enabled` is the founders' pause switch: set on create, never flipped back here.
    const paused = current.enabled ? "" : ", paused (left paused)";
    const changed = (Object.keys(want) as (keyof typeof want)[]).filter((k) => canon(current[k]) !== canon(want[k]));
    if (!changed.length) {
      r.record("deployments", spec.key, "ok", `${current.id} ${current.schedule_status}${paused}`);
      continue;
    }
    if (r.dry) {
      r.record("deployments", spec.key, "update", `${changed.join(", ")}${paused}`);
      continue;
    }
    const patch = Object.fromEntries(changed.map((k) => [k, want[k]])) as DeploymentPatch;
    await r.client.deployments.update(current.id, patch);
    r.record("deployments", spec.key, "update", `${changed.join(", ")}${paused}`);
  }
  if (!r.dry) await setSetting(SETTING.naiveDeployments, ids, "provision-naive");
}

async function stepWebhooks(r: Run) {
  if (!r.base) {
    r.record("webhooks", "*", "skip", "needs PUBLIC_BASE_URL (https): Naïve refuses private webhook URLs");
    return;
  }
  const url = naiveWebhookUrl(r.base);
  const endpoints = (await listAll((q) => r.client.webhooks.list(q))).filter((w) => w.url === url);
  const stored = r.dry ? [] : await getSetting<WebhookSecret[]>(SETTING.naiveWebhookSecrets, []);
  const next: WebhookSecret[] = [];
  const main = endpoints.find((w) => WEBHOOK_EVENTS.every((e) => w.events.includes(e)));
  if (!main) {
    if (r.dry) r.record("webhooks", "events", "create", WEBHOOK_EVENTS.join(","));
    else {
      const hook = await r.client.webhooks.create({ url, events: WEBHOOK_EVENTS });
      next.push({ id: hook.id, secret: hook.secret, purpose: "events" });
      r.record("webhooks", "events", "create", hook.id);
    }
  }
  // Every endpoint at our URL (the main one and one per deployment on_idle) has its own secret.
  for (const w of endpoints) {
    const purpose: WebhookSecret["purpose"] = w === main ? "events" : "on_idle";
    const reenable = !w.enabled && Boolean(r.o.reenableWebhooks);
    if (reenable && !r.dry) await r.client.webhooks.update(w.id, { enabled: true });
    const state = w.enabled ? "" : reenable ? ", re-enabled" : ", disabled (left so; --reenable-webhooks turns it back on)";
    const known = stored.find((s) => s.id === w.id);
    if (known) {
      next.push(known);
      r.record("webhooks", w.id, "ok", `${purpose}${state}`);
      continue;
    }
    if (r.dry) {
      r.record("webhooks", w.id, "rotate", `${purpose}: secret unknown here, rotate to learn it`);
      continue;
    }
    const rotated = await r.client.webhooks.rotate(w.id, 0);
    next.push({ id: w.id, secret: rotated.secret, purpose });
    r.record("webhooks", w.id, "rotate", purpose);
  }
  if (!r.dry) await setSetting(SETTING.naiveWebhookSecrets, next, "provision-naive");
}

/**
 * Budgets below the measured pre-flight floor get sessions refused (402) or paused after a call or two,
 * so applying them is refused unless forced. A dry run only reports what apply would do.
 */
function checkBudgets(r: Run, parts: readonly Part[]) {
  if (!parts.includes("agents") && !parts.includes("deployments")) return;
  const warnings = budgetWarnings();
  for (const w of warnings) r.o.log(`  ! budget: ${w}`);
  if (!warnings.length || r.o.forceBudgets) return;
  const fix = "raise them in src/lib/config.ts (AGENT_BUDGETS), or pass --force-budgets to apply them anyway";
  if (r.dry) r.o.log(`  ! apply would refuse: ${warnings.length} budget(s) below the measured floor; ${fix}`);
  else throw new Error(`budgets: ${warnings.length} below the measured pre-flight floor (see the "! budget:" lines); ${fix}`);
}

const STEPS: Record<Part, (r: Run) => Promise<void>> = {
  skills: stepSkills,
  agents: stepAgents,
  vault: stepVault,
  team: stepTeam,
  bundle: stepBundle,
  deployments: stepDeployments,
  webhooks: stepWebhooks,
};

export async function provision(opts: ProvisionOptions): Promise<Action[]> {
  const run = new Run({ ...opts, log: opts.log ?? (() => {}), root: opts.repoRoot ?? process.cwd() });
  const parts = PARTS.filter((p) => !opts.parts || opts.parts.includes(p));
  checkBudgets(run, parts);
  for (const part of parts) {
    run.o.log(`[${part}]`);
    await STEPS[part](run);
  }
  if (run.changedAgents.size && !parts.includes("team")) {
    run.o.log("! agents changed: run with --only team so the coordinator's roster pins their new versions");
  }
  return run.actions;
}

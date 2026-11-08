/**
 * Full Naïve agent configs for the 12-agent team, built from the agent definitions (naive/agents),
 * the MCP tool catalog (src/lib/mcp/catalog.ts) and the budgets (src/lib/config.ts).
 *
 * Shape rules (docs/platform, ARCHITECTURE §8): harness "pi"; integer micro-USD budgets with
 * period "day"; mcp_servers are { name, url } only (no `type`, no secret headers: auth is a vault
 * static_bearer bound to each agent); every MCP tool an agent may call is listed in tools.configs as
 * "<server>.<tool>" because MCP tools default to ask; default_config deny so nothing unlisted runs.
 */
import type { AgentCreate } from "@usenaive-sdk/managed-agents";
import { AGENT_BUDGETS, usd, type AgentBudget } from "../src/lib/config";
import { AGENT_NAMES, outputSchema, type AgentName } from "../src/lib/domain";
import { envFlag } from "../src/lib/env";
import { TERRAGENT_MCP_SERVER, toolsForAgent } from "../src/lib/mcp/catalog";
import { AGENTS } from "./agents";
import { browserTools, neverTools } from "./agents/tools";
import type { ToolConfigs } from "./agents/types";
import { DEPLOYMENTS, runBudgetUsd, type DeploymentSpec } from "./deployments";
import { RunSummary } from "./schemas";
import { skillSlug } from "./skills";

export { AGENTS } from "./agents";

export const MCP_PATH = "/api/mcp";
export const WEBHOOK_PATH = "/api/webhooks/naive";

/** SkyWatch's public MCP: live $/km² and archive search, no account (verified live, docs/platform/naive-live.md). */
export const SKYWATCH_MCP = { name: "skywatch", url: "https://mcp.skywatch.com/mcp" } as const;
export const SKYWATCH_TOOLS: Record<string, "allow" | "deny"> = {
  search_archive_imagery: "allow",
  calculate_pricing: "allow",
  get_offerings: "allow",
  get_satellites: "allow",
  get_started: "deny", // account sign-up guidance; agents never create accounts
};

/** Parts that Naïve calls back (MCP, webhooks, on_idle) need a public https origin. */
export function isPublicBaseUrl(url: string | null | undefined): url is string {
  if (!url || !/^https:\/\/[^/]+/.test(url)) return false;
  const host = new URL(url).hostname;
  return !(host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || /^(127\.|10\.|192\.168\.)/.test(host));
}

const trimSlash = (u: string) => u.replace(/\/+$/, "");
export const terragentMcpUrl = (publicBaseUrl: string) => `${trimSlash(publicBaseUrl)}${MCP_PATH}`;
export const naiveWebhookUrl = (publicBaseUrl: string) => `${trimSlash(publicBaseUrl)}${WEBHOOK_PATH}`;

export interface BuildOptions {
  /** https origin of the deployed app; null → configs are built without the Terragent MCP. */
  publicBaseUrl: string | null;
  /** Founder address for approval/question emails (coordinator + acquisition), optional. */
  notifyEmail?: string | null;
  /**
   * A founder approved website contact-form outreach (env OUTREACH_CONTACT_FORM_APPROVED, read when
   * omitted). Until then every browser action that can write to a page pauses for a founder.
   */
  contactFormsApproved?: boolean;
}

/** "terragent.<tool>" → permission, for exactly the catalog tools this agent is granted. */
export function terragentToolConfigs(agent: AgentName): ToolConfigs {
  return Object.fromEntries(
    toolsForAgent(agent).map((t) => [`${TERRAGENT_MCP_SERVER}.${t.name}`, { enabled: true, permission: t.permission }]),
  );
}

export function skywatchToolConfigs(): ToolConfigs {
  return Object.fromEntries(
    Object.entries(SKYWATCH_TOOLS).map(([tool, p]) => [
      `${SKYWATCH_MCP.name}.${tool}`,
      p === "allow" ? { enabled: true, permission: "allow" } : { enabled: false, permission: "deny" },
    ]),
  );
}

export function agentBudget(agent: AgentName): AgentCreate["budget"] {
  const b = AGENT_BUDGETS[agent];
  return { cap_micro_usd: usd(b.capUsdPerDay), max_task_micro_usd: usd(b.maxTaskUsd), period: "day" };
}

/**
 * The config provisioning writes for one agent. The coordinator's `multiagent` roster and
 * `handoffs: "team"` are added by the team step (they need the members' ids); members never hand
 * off natively (handoffs: false): they pass work with terragent.handoff, which keeps our DB in sync.
 */
export function buildAgentConfig(agent: AgentName, opts: BuildOptions): AgentCreate {
  const def = AGENTS[agent];
  const budget = AGENT_BUDGETS[agent];
  const mcp_servers: NonNullable<AgentCreate["mcp_servers"]> = [];
  const configs: ToolConfigs = { ...neverTools(), ...def.builtins };

  if (isPublicBaseUrl(opts.publicBaseUrl)) {
    mcp_servers.push({ name: TERRAGENT_MCP_SERVER, url: terragentMcpUrl(opts.publicBaseUrl) });
    Object.assign(configs, terragentToolConfigs(agent));
  }
  if (def.skywatch) {
    mcp_servers.push({ ...SKYWATCH_MCP });
    Object.assign(configs, skywatchToolConfigs());
  }
  if (def.browser) {
    Object.assign(configs, browserTools({ contactFormsApproved: opts.contactFormsApproved ?? envFlag("OUTREACH_CONTACT_FORM_APPROVED") }));
  }

  const notify = opts.notifyEmail && (agent === "coordinator" || agent === "acquisition");
  return {
    name: agent,
    description: def.description,
    model: budget.model,
    window: budget.window,
    harness: "pi",
    system: def.system,
    budget: agentBudget(agent),
    tools: { default_config: { permission: "deny" }, configs },
    mcp_servers,
    skills: def.skills.map(skillSlug),
    ...(agent === "coordinator" ? {} : { handoffs: false }),
    output_schema: outputSchema(RunSummary),
    structured_output_required: false,
    metadata: { app: "terragent", agent },
    ...(notify ? { notifications: { email: opts.notifyEmail!, approvals: true, questions: true, updates: false } } : {}),
  };
}

export function buildAllAgentConfigs(opts: BuildOptions): Record<AgentName, AgentCreate> {
  return Object.fromEntries(AGENT_NAMES.map((a) => [a, buildAgentConfig(a, opts)])) as Record<AgentName, AgentCreate>;
}

/**
 * Smallest session budget Naïve accepted per model in the live smoke test (2026-11-07, 6–8k-token
 * context; docs/platform/naive-live.md). Below it sessions.create is refused (402 budget_exceeded,
 * "below the pre-flight quote"), and a running session pauses once its remaining budget drops under
 * the next call's quote, so real runs need headroom above it.
 */
export const MEASURED_PREFLIGHT_USD: Record<string, number> = {
  "anthropic/claude-sonnet-5.5": 0.4,
  "zai-org/GLM-5.2-FP8": 0.3,
  "anthropic/claude-haiku-5.5": 0.05,
};
export const PREFLIGHT_HEADROOM = 2;

/** Per-task ceilings and per-run budgets that leave less than 2× a model's measured pre-flight minimum. */
export function budgetWarnings(budgets: Record<AgentName, AgentBudget> = AGENT_BUDGETS, deployments: readonly DeploymentSpec[] = DEPLOYMENTS): string[] {
  const floor = (model: string) => (MEASURED_PREFLIGHT_USD[model] ?? 0) * PREFLIGHT_HEADROOM;
  const out: string[] = [];
  for (const a of AGENT_NAMES) {
    const b = budgets[a];
    if (b.maxTaskUsd < floor(b.model)) out.push(`${a}: maxTaskUsd $${b.maxTaskUsd} < $${floor(b.model)} (2× ${b.model} pre-flight); sessions will pause early`);
  }
  for (const d of deployments) {
    const run = runBudgetUsd(d, deployments, budgets);
    const model = budgets[d.agent].model;
    if (run < floor(model)) out.push(`deployment ${d.key}: $${run}/run < $${floor(model)} (2× ${model} pre-flight)`);
  }
  return out;
}

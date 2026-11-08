import type { AgentCreate } from "@usenaive-sdk/managed-agents";
import type { AgentName, Playbook } from "../../src/lib/domain";

export type ToolSetting = NonNullable<AgentCreate["tools"]>["configs"][string];
export type ToolConfigs = Record<string, ToolSetting>;

/** One agent's role. Model, window and budget come from AGENT_BUDGETS; Terragent MCP tools from the catalog. */
export interface AgentDefinition {
  name: AgentName;
  description: string;
  system: string;
  /** Playbook skills attached (slugs are derived in naive/skills.ts). */
  skills: readonly Playbook[];
  /** Built-in Naïve tools this agent may use. Everything unlisted is denied (default_config deny). */
  builtins: ToolConfigs;
  /** Acquisition only: SkyWatch's public, no-login pricing MCP. */
  skywatch?: boolean;
  /** Comms-outreach only: the Naïve browser for contact forms (write actions gated, naive/agents/tools.ts). */
  browser?: boolean;
}

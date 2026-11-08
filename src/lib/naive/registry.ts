/** Provisioned Naïve ids, read from settings (written by scripts/provision-naive.ts). */
import type { AgentName } from "../domain";
import { getSetting, SETTING } from "../settings";

export interface ProvisionedAgent {
  id: string;
  version: number;
}
export type AgentRegistry = Partial<Record<AgentName, ProvisionedAgent>>;

export function getAgentRegistry(): Promise<AgentRegistry> {
  return getSetting<AgentRegistry>(SETTING.naiveAgents, {});
}

export async function agentId(name: AgentName): Promise<string> {
  const id = (await getAgentRegistry())[name]?.id;
  if (!id) throw new Error(`Naïve agent "${name}" is not provisioned (run: npx tsx scripts/provision-naive.ts)`);
  return id;
}

/** agt_… → agent name, for labelling sessions and spend rows. */
export async function agentNamesById(): Promise<Map<string, AgentName>> {
  const reg = await getAgentRegistry();
  return new Map(Object.entries(reg).map(([name, a]) => [a.id, name as AgentName]));
}

/** The board is addressed by the coordinator's agt_ id. */
export async function boardOwnerId(): Promise<string> {
  const board = await getSetting<{ coordinator?: string }>(SETTING.naiveBoard, {});
  if (!board.coordinator) throw new Error("Naïve board is not provisioned (run: npx tsx scripts/provision-naive.ts --only team)");
  return board.coordinator;
}

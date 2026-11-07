/** OWNER: signals builder. Free signal feeds normalised to SignalInput. */
import type { Playbook, SignalFeed, SignalInput } from "../domain";

export const FEEDS_BY_PLAYBOOK: Record<Exclude<Playbook, "inbound">, SignalFeed[]> = {
  disasters: ["nws", "usgs_quake", "nwps_flood", "firms", "openfema"],
  deforestation: ["gfw", "firms"],
  mining: ["mrds", "news"],
};

/** Fetch recent events from one feed. Feeds missing a key return [] and a warning, never throw. */
export async function pollFeed(feed: SignalFeed, opts: { since?: Date; limit?: number } = {}): Promise<{ signals: SignalInput[]; warnings: string[] }> { throw new Error("not implemented yet"); }

/** OWNER: naive builder. Board cards on the coordinator's board (assignee = agent NAME). */
import type { AgentName } from "../domain";

export interface CardView { id: string; title: string; status: "todo" | "doing" | "blocked" | "done"; assignee: string | null; note: string | null; updated_at: string }

/**
 * Background lane: create a todo card WITH assignee → the board wakes that agent (one card at a time per agent).
 * Inbound lane: mirror=true creates/updates a card with status "doing" so it is visible but does not wake anyone.
 */
export async function upsertCard(args: { key: string; title: string; body: string; assignee: AgentName | null; status?: CardView["status"]; note?: string; mirror?: boolean }): Promise<CardView> { throw new Error("not implemented yet"); }
export async function listCards(): Promise<CardView[]> { throw new Error("not implemented yet"); }

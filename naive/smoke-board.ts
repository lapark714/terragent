/**
 * Live board-limit probes for scripts/naive-smoke.ts (--only board-limits). They answer two questions
 * the background lane depends on, using an owner and two cheap members whose woken sessions are
 * cancelled as soon as they appear (≈ $0):
 *   1. busy: does a member holding a `doing` mirror card stop the board waking it for a `todo` card?
 *   2. wakes: does re-assigning a card reset `wake_count`, and what happens after the third wake?
 */
import type { AgentCreate, VettaClient } from "@usenaive-sdk/managed-agents";
import { usd } from "../src/lib/config";
import { neverTools } from "./agents/tools";

type Agent = Awaited<ReturnType<VettaClient["agents"]["get"]>>;
type Card = Awaited<ReturnType<VettaClient["board"]["cards"]["get"]>>;

export const PROBE_MEMBERS = ["tg-smoke-a", "tg-smoke-b"] as const;
const CHEAPEST_SESSION_MODEL = "anthropic/claude-haiku-5.5"; // lowest pre-flight floor measured ($0.05)
const TICK_WAIT_MS = 75_000; // the board sweeps once a minute

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function memberConfig(name: string): AgentCreate {
  return {
    name,
    description: "Throwaway board-probe member (scripts/naive-smoke.ts). Safe to delete.",
    model: CHEAPEST_SESSION_MODEL,
    window: "immediate",
    harness: "pi",
    system: "You are a test agent. Reply with the single word ok and stop. Do not call any tool.",
    budget: { cap_micro_usd: usd(0.3), max_task_micro_usd: usd(0.1), period: "day" },
    tools: { default_config: { permission: "deny" }, configs: neverTools() },
    mcp_servers: [],
    skills: [],
    handoffs: false,
    metadata: { app: "terragent", purpose: "smoke" },
  };
}

const view = (c: Card) => ({ status: c.status, assignee: c.assignee, woken_session_id: c.woken_session_id, wake_count: c.wake_count });

export class BoardProbe {
  readonly cancelled: string[] = [];

  constructor(
    private readonly client: VettaClient,
    private readonly owner: Agent,
    private readonly log: (line: string) => void,
  ) {}

  /** Cancel a woken session right away, so it never reaches a model call. */
  private async cancel(sessionId: string | null) {
    if (!sessionId || this.cancelled.includes(sessionId)) return;
    this.cancelled.push(sessionId);
    await this.client.sessions.cancel(sessionId).catch(() => undefined);
  }

  private get cards() {
    return this.client.board.cards;
  }

  /** Read the card until it was woken (or the wait ends), cancelling whatever woke. */
  private async waitForWake(cardId: string, ms: number): Promise<Card> {
    const deadline = Date.now() + ms;
    for (;;) {
      const c = await this.cards.get(this.owner.id, cardId);
      if (c.woken_session_id || Date.now() > deadline) {
        await this.cancel(c.woken_session_id);
        return c;
      }
      await sleep(10_000);
    }
  }

  /** 1. A `doing` mirror card (assigned to the member, or unassigned): is a new `todo` card for the member woken? */
  async busy(member: string, mirrorAssigned: boolean) {
    const stamp = Date.now();
    const mirror = await this.cards.create(this.owner.id, { key: `probe:mirror:${stamp}`, title: `Probe mirror (${mirrorAssigned ? member : "unassigned"})`, body: "doing, wakes nobody", status: "doing", assignee: mirrorAssigned ? member : null });
    const todo = await this.cards.create(this.owner.id, { title: "Probe todo while mirror is doing", body: "should wake unless the mirror makes the member busy", status: "todo", assignee: member });
    await this.cancel(todo.woken_session_id);
    this.log(`[board-limits] busy: todo card woken in-request=${Boolean(todo.woken_session_id)}`);
    const later = todo.woken_session_id ? todo : await this.waitForWake(todo.id, TICK_WAIT_MS);
    await this.cards.update(this.owner.id, mirror.id, { status: "done", note: "probe finished" });
    // Still not woken: does closing the mirror free the member?
    const afterMirrorDone = later.woken_session_id ? null : view(await this.waitForWake(todo.id, TICK_WAIT_MS));
    await this.cards.update(this.owner.id, todo.id, { status: "done", note: "probe finished" });
    return {
      mirror: view(mirror),
      todo_on_create: view(todo),
      todo_after_wait: view(later),
      todo_after_mirror_done: afterMirrorDone,
      verdict: todo.woken_session_id || later.woken_session_id ? "mirror does NOT make the member busy" : afterMirrorDone?.woken_session_id ? "mirror DOES make the member busy" : "todo never woke (inconclusive)",
    };
  }

  /** 2. Re-assign one card between two members until the board refuses to wake it. */
  async wakes(members: readonly [string, string], rounds = 5) {
    const steps: (ReturnType<typeof view> & { step: string })[] = [];
    let card = await this.cards.create(this.owner.id, { title: "Probe wake count", body: "re-assigned between two members", status: "todo", assignee: members[0] });
    await this.cancel(card.woken_session_id);
    steps.push({ step: `create → ${members[0]}`, ...view(card) });
    for (let i = 1; i < rounds; i++) {
      await sleep(3000); // let the cancel land, so the member is not busy
      const assignee = members[i % 2];
      card = await this.cards.update(this.owner.id, card.id, { status: "todo", assignee });
      await this.cancel(card.woken_session_id);
      steps.push({ step: `PATCH todo → ${assignee}`, ...view(card) });
      this.log(`[board-limits] wakes: round ${i + 1} → ${assignee}: wake_count=${card.wake_count} woken=${Boolean(card.woken_session_id)} status=${card.status}`);
    }
    // Same assignee again, then let a tick pass to see whether the board parks the card.
    card = await this.cards.update(this.owner.id, card.id, { status: "todo", assignee: card.assignee });
    await this.cancel(card.woken_session_id);
    steps.push({ step: `PATCH todo → same assignee ${card.assignee}`, ...view(card) });
    const settled = await this.waitForWake(card.id, TICK_WAIT_MS);
    steps.push({ step: "after one board tick", ...view(settled) });
    const comments = await this.cards.comments(this.owner.id, card.id, { limit: 20 }).then((p) => p.data.map((c) => c.body.slice(0, 300)), () => []);
    // What upsertCard does at the limit: a fresh keyed card (a seed, woken on the next tick), then close the old one.
    const fresh = await this.cards.create(this.owner.id, { key: `probe:wake:${Date.now()}#1`, title: "Probe wake count (continued)", body: "fresh card", status: "todo", assignee: members[1] });
    await this.cancel(fresh.woken_session_id);
    const freshWoken = fresh.woken_session_id ? fresh : await this.waitForWake(fresh.id, TICK_WAIT_MS);
    steps.push({ step: `fresh keyed card → ${members[1]} (after one tick)`, ...view(freshWoken) });
    const closed = await this.cards.update(this.owner.id, card.id, { status: "done", note: "Continued on a fresh card (probe)" });
    steps.push({ step: "old card closed done", ...view(closed) });
    await this.cards.update(this.owner.id, fresh.id, { status: "done", note: "probe finished" });
    return { steps, comments };
  }
}

/** Owner roster for the probe: both members pinned at their current versions, board on. */
export function probeRoster(members: readonly Agent[]) {
  return { type: "coordinator" as const, agents: members.map((m) => ({ type: "agent" as const, id: m.id, version: m.current_version })), board: true };
}

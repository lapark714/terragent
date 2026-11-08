/** Board cards on the coordinator's board (assignee = agent NAME). */
import { createHash } from "node:crypto";
import type { CardPatch, VettaClient } from "@usenaive-sdk/managed-agents";
import { getDb } from "../db/client";
import type { AgentName } from "../domain";
import { getNaive } from "./client";
import { boardOwnerId } from "./registry";

export interface CardView { id: string; title: string; status: "todo" | "doing" | "blocked" | "done"; assignee: string | null; note: string | null; updated_at: string }

type BoardCard = Awaited<ReturnType<VettaClient["board"]["cards"]["get"]>>;
type Want = { title: string; body: string; status: CardView["status"]; assignee: string | null; note?: string };

const MAX_TITLE = 200;
const MAX_BODY = 20_000;
const MAX_KEY = 128;
/** Naïve starts a card at most this many times, then parks it blocked; re-assigning does not reset it (verified live). */
export const WAKE_LIMIT = 3;
/** A woken session in one of these states still holds the card: waking its agent again would start a duplicate. */
const HOLDING_STOPS = new Set(["awaiting_approval", "awaiting_input", "awaiting_answer", "awaiting_delegation"]);

/** Card keys are 1–128 chars; long ones (e.g. RFC Message-IDs) are hashed. */
export function cardKey(key: string): string {
  return key.length <= MAX_KEY ? key : `h:${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
}

/** The Naïve key of a card generation: the caller's key first, then "<key>#<n>". */
export const generationKey = (key: string, generation: number) => cardKey(generation ? `${key}#${generation}` : key);

/**
 * Background lane: a todo card WITH assignee → the board wakes that agent (one card at a time per agent).
 * Inbound lane: mirror=true keeps a `doing` card visible but UNASSIGNED (the agent is named in the title):
 * a doing card held by an agent makes it busy, which would stop the board waking it for background cards.
 *
 * Idempotent on `key`: a keyed create returns the existing card (ignoring the body), then we PATCH only
 * the fields that differ. Writing `assignee` is what wakes, so it is written only when a wake is wanted,
 * and a card the board has already started WAKE_LIMIT times continues on a fresh card instead.
 */
export async function upsertCard(args: { key: string; title: string; body: string; assignee: AgentName | null; status?: CardView["status"]; note?: string; mirror?: boolean }): Promise<CardView> {
  const naive = await getNaive();
  const board = await boardOwnerId();
  const want: Want = args.mirror
    ? { title: mirrorTitle(args.title, args.assignee), body: args.body.slice(0, MAX_BODY), status: "doing", assignee: null, note: args.note }
    : {
        title: args.title.slice(0, MAX_TITLE),
        body: args.body.slice(0, MAX_BODY),
        status: args.status ?? "todo",
        assignee: args.assignee,
        note: args.note ?? (args.status === "done" ? "Completed." : undefined), // Naïve refuses `done` without a note
      };
  const generation = await cardGeneration(args.key);
  const card = await createKeyed(naive, board, generationKey(args.key, generation), want);
  const update = async (patch: CardPatch | null) => toView(patch ? await naive.board.cards.update(board, card.id, patch) : card);

  if (!(want.status === "todo" && want.assignee && !args.mirror)) return update(diffCard(card, want));

  // A retried handoff to the agent already working the card: leave its run alone.
  if (card.assignee === want.assignee && card.woken_session_id && (await holdsCard(naive, card.woken_session_id))) {
    return update(diffCard(card, { ...want, status: card.status, assignee: card.assignee }));
  }
  if (card.wake_count >= WAKE_LIMIT) return toView(await continueOnFreshCard(naive, board, args.key, generation, card, want));
  const patch: CardPatch = diffCard(card, want) ?? {};
  // The same agent again after its run ended: writing assignee clears woken_session_id, which wakes it.
  if (card.woken_session_id) patch.assignee = want.assignee;
  return update(Object.keys(patch).length ? patch : null);
}

/** A card cannot be created as done (no note on create), so it is created as `doing`, which wakes nobody. */
function createKeyed(naive: VettaClient, board: string, key: string, want: Want): Promise<BoardCard> {
  return naive.board.cards.create(board, { key, title: want.title, body: want.body, status: want.status === "done" ? "doing" : want.status, assignee: want.assignee });
}

function mirrorTitle(title: string, agent: AgentName | null): string {
  return (agent ? `${agent} ▸ ${title}` : title).slice(0, MAX_TITLE);
}

async function holdsCard(naive: VettaClient, sessionId: string): Promise<boolean> {
  const s = await naive.sessions.get(sessionId).catch(() => null);
  if (!s) return false;
  return s.status === "queued" || s.status === "running" || (s.status === "idle" && HOLDING_STOPS.has(s.stop_reason ?? ""));
}

async function cardGeneration(key: string): Promise<number> {
  const db = await getDb();
  const [row] = await db.query<{ generation: number }>("SELECT generation FROM naive_card_generations WHERE key = $1", [key]);
  return row?.generation ?? 0;
}

/** Record the new generation, create its card (a keyed seed: the board wakes it within a minute), then close the old one. */
async function continueOnFreshCard(naive: VettaClient, board: string, key: string, generation: number, old: BoardCard, want: Want): Promise<BoardCard> {
  const next = generation + 1;
  const db = await getDb();
  await db.query(
    `INSERT INTO naive_card_generations (key, generation) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET generation = GREATEST(naive_card_generations.generation, EXCLUDED.generation), updated_at = now()`,
    [key, next],
  );
  const fresh = await createKeyed(naive, board, generationKey(key, next), want);
  await naive.board.cards.update(board, old.id, {
    status: "done",
    note: `Continued on a fresh card (${generationKey(key, next)}, ${fresh.id}): the board starts a card at most ${WAKE_LIMIT} times.`,
  });
  return fresh;
}

export function diffCard(
  card: Pick<BoardCard, "title" | "body" | "status" | "assignee" | "note">,
  want: { title: string; body: string; status: CardView["status"]; assignee: string | null; note?: string },
): CardPatch | null {
  const patch: CardPatch = {};
  if (card.title !== want.title) patch.title = want.title;
  if (card.body !== want.body) patch.body = want.body;
  if (card.status !== want.status) patch.status = want.status;
  if (card.assignee !== want.assignee) patch.assignee = want.assignee;
  if (want.note !== undefined && card.note !== want.note) patch.note = want.note;
  return Object.keys(patch).length ? patch : null;
}

/** Every card on the board. Cards are column-sorted before pagination, so always page to the end. */
export async function listCards(): Promise<CardView[]> {
  const naive = await getNaive();
  const board = await boardOwnerId();
  const out: CardView[] = [];
  let after: string | undefined;
  do {
    const page = await naive.board.cards.list(board, { limit: 100, ...(after ? { after } : {}) });
    out.push(...page.data.map(toView));
    after = page.has_more && page.next_cursor ? page.next_cursor : undefined;
  } while (after);
  return out;
}

function toView(c: BoardCard): CardView {
  return { id: c.id, title: c.title, status: c.status, assignee: c.assignee, note: c.note, updated_at: c.updated_at };
}

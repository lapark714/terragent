/** Live board: requests by status with their owner agent, plus the coordinator's Naïve board cards. */
import { getDb } from "../db/client";
import { PLAYBOOKS, type Playbook, type RequestStatus } from "../domain";
import { listCards } from "../naive/board";
import { coarsePlace, maskPerson, scrubText, shortId } from "./mask";
import { iso, live } from "./rows";
import type { Board, BoardRequest } from "./types";

interface BoardRow {
  id: string; source: string; playbook: string; status: RequestStatus; owner_agent: string | null; is_free_sample: boolean;
  question: string; location_text: string | null; customer_name: string | null; customer_email: string | null; updated_at: unknown;
}

export const asPlaybook = (p: string): Playbook => ((PLAYBOOKS as readonly string[]).includes(p) ? (p as Playbook) : "inbound");

export function toBoardRequest(r: BoardRow): BoardRequest {
  return {
    id: shortId(r.id),
    playbook: asPlaybook(r.playbook),
    status: r.status,
    owner: r.owner_agent,
    source: r.source,
    sample: r.is_free_sample,
    // A refused request is the one most likely to name a person, so its wording never reaches the public board.
    question: r.status === "refused" ? "Refused under the acceptable use policy" : scrubText(r.question).slice(0, 180),
    location: coarsePlace(r.location_text),
    customer: r.is_free_sample ? null : maskPerson({ name: r.customer_name, email: r.customer_email }),
    updatedAt: iso(r.updated_at),
  };
}

export async function getBoard(): Promise<Board> {
  const db = await getDb();
  // Everything in flight, plus what finished in the last day so the Done column isn't empty.
  const rows = await db.query<BoardRow>(
    `SELECT id, source, playbook, status, owner_agent, is_free_sample, question, location_text,
            customer_name, customer_email, updated_at
     FROM requests
     WHERE status NOT IN ('delivered', 'refused', 'failed', 'cancelled') OR updated_at > now() - interval '24 hours'
     ORDER BY updated_at DESC LIMIT 80`,
  );
  const naive = await live("naive.cards", 15_000, async () =>
    (await listCards()).map((c) => ({
      id: c.id,
      title: scrubText(c.title).slice(0, 120),
      status: c.status,
      assignee: c.assignee,
      updatedAt: iso(c.updated_at),
    })),
  );
  return { requests: rows.map(toBoardRequest), naive };
}

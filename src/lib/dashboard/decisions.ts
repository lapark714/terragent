/** Decision log: what the agents chose and why (source, free vs paid, pricing, screening, allocation…). */
import { getDb } from "../db/client";
import type { DecisionKind } from "../domain";
import { asPlaybook } from "./board";
import { scrubText, shortId } from "./mask";
import { iso, num, numOrNull } from "./rows";
import type { DecisionRow, Decisions } from "./types";

interface Row {
  id: string; request_id: string | null; playbook: string | null; kind: DecisionKind; choice: string; reasoning: string;
  alternatives: unknown; agent: string; created_at: unknown;
}

function alternatives(v: unknown): DecisionRow["alternatives"] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 6).map((a: Record<string, unknown>) => ({
    option: scrubText(String(a?.option ?? "")),
    cost_usd: numOrNull(a?.cost_usd),
    why_not: scrubText(String(a?.why_not ?? "")),
  }));
}

export async function getDecisions(limit = 40): Promise<Decisions> {
  const db = await getDb();
  const [rows, freeVsPaid] = await Promise.all([
    db.query<Row>(
      `SELECT d.id, d.request_id, r.playbook, d.kind, d.choice, d.reasoning, d.alternatives, d.agent, d.created_at
       FROM decisions d LEFT JOIN requests r ON r.id = d.request_id
       ORDER BY d.created_at DESC LIMIT $1`,
      [limit],
    ),
    db.query<{ choice: string; n: number }>(
      `SELECT lower(trim(choice)) AS choice, count(*)::int AS n FROM decisions
       WHERE kind = 'free_vs_paid' GROUP BY 1 ORDER BY 2 DESC LIMIT 4`,
    ),
  ]);
  return {
    rows: rows.map((d) => ({
      id: d.id,
      request: d.request_id ? shortId(d.request_id) : null,
      playbook: d.playbook ? asPlaybook(d.playbook) : null,
      kind: d.kind,
      choice: scrubText(d.choice).slice(0, 200),
      // Screening reasons quote the request (and refusals may name people); the choice already carries the category.
      reasoning: d.kind === "screening" ? "Screened against the acceptable use policy." : scrubText(d.reasoning).slice(0, 600),
      alternatives: alternatives(d.alternatives),
      agent: d.agent,
      at: iso(d.created_at),
    })),
    freeVsPaid: freeVsPaid.map((r) => ({ choice: scrubText(r.choice).slice(0, 40), n: num(r.n) })),
  };
}

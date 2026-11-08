/** Playbook allocation over time: the coordinator's shifts in outreach effort. */
import { DEFAULT_ALLOCATION } from "../config";
import { getDb } from "../db/client";
import { scrubText } from "./mask";
import { iso, num } from "./rows";
import type { AllocationPoint, OutboundPlaybook } from "./types";

interface Row { playbook: string; weight: number; reason: string; decided_by: string; created_at: unknown }

const OUTBOUND = Object.keys(DEFAULT_ALLOCATION) as OutboundPlaybook[];
/** Rows written by one set_playbook_allocation call land within a few seconds of each other. */
const SAME_DECISION_MS = 10_000;

export function groupAllocations(rows: Row[]): AllocationPoint[] {
  const points: AllocationPoint[] = [];
  let lastAt = -Infinity;
  for (const r of rows) {
    const at = new Date(iso(r.created_at)).getTime();
    const current = points.at(-1);
    if (!current || at - lastAt > SAME_DECISION_MS || current.reason !== scrubText(r.reason)) {
      // Carry forward weights the coordinator didn't restate this time.
      points.push({ at: iso(r.created_at), weights: { ...(current?.weights ?? DEFAULT_ALLOCATION) }, reason: scrubText(r.reason), by: r.decided_by });
    }
    if ((OUTBOUND as string[]).includes(r.playbook)) points.at(-1)!.weights[r.playbook as OutboundPlaybook] = num(r.weight);
    lastAt = at;
  }
  return points;
}

export async function getAllocationHistory(): Promise<AllocationPoint[]> {
  const db = await getDb();
  const rows = await db.query<Row>(
    `SELECT playbook, weight::float8 AS weight, reason, decided_by, created_at
     FROM playbook_allocations ORDER BY created_at ASC, id ASC LIMIT 900`,
  );
  const start: AllocationPoint = { at: null, weights: { ...DEFAULT_ALLOCATION }, reason: "Starting split, before any results were measured", by: "default" };
  return [start, ...groupAllocations(rows)];
}

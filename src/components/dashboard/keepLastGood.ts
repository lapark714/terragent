import type { LiveSnapshot } from "@/lib/dashboard/types";

/** While the database is paused (NOTES H4c) the panels keep the last numbers they had instead of going blank. */
const PANELS = ["overview", "funnel", "board", "decisions", "money", "interventions", "allocation", "activity"] as const;
export function keepLastGood(previous: LiveSnapshot | null, next: LiveSnapshot): LiveSnapshot {
  if (!previous || !next.dbSuspended) return next;
  const merged = { ...next };
  for (const key of PANELS) {
    const p = next[key];
    if (!p.ok && p.suspended && previous[key].ok) (merged as Record<string, unknown>)[key] = previous[key];
  }
  return merged;
}

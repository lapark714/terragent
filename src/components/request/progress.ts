/** Pure helpers for the request progress view. No "use client": callable from server and client. */
import type { RequestStatus } from "@/lib/domain";
import type { RequestProgress } from "@/lib/dashboard/public";
import type { TrackOutcome } from "./StepTrack";

/** Status → index into STEPS (StepTrack). Delivered is past the last step. */
const STEP_OF: Record<RequestStatus, number> = {
  received: 0, screening: 1, clarifying: 1, planning: 2, acquiring: 3, fetching: 3, pricing: 3, quoted: 3,
  awaiting_approval: 3, analyzing: 4, verifying: 5, revising: 5, delivering: 6, delivered: 7,
  refused: 1, failed: -1, cancelled: -1,
};

/** Where the track should stop and how it ended. Failed/cancelled don't record a step, so they report -1. */
export function trackOf(p: Pick<RequestProgress, "status">): { step: number; outcome: TrackOutcome } {
  if (p.status === "delivered") return { step: STEP_OF.delivered, outcome: "delivered" };
  if (p.status === "refused") return { step: STEP_OF.refused, outcome: "refused" };
  if (p.status === "failed" || p.status === "cancelled") return { step: -1, outcome: "stopped" };
  return { step: STEP_OF[p.status], outcome: "active" };
}

/** Statuses where the ball is with the customer or a founder; the Outcome block explains, so no "agent is on it". */
const WAITING_ON_PERSON: ReadonlySet<RequestStatus> = new Set(["clarifying", "quoted", "awaiting_approval"]);

/** Whether to show the "agent is on it" card. */
export const agentIsWorking = (p: Pick<RequestProgress, "status" | "terminal">) => !p.terminal && !WAITING_ON_PERSON.has(p.status);

/** When the current owner took over: the latest hand-off or status move, else the request's last update. */
export function ownerSince(p: Pick<RequestProgress, "events" | "updatedAt" | "createdAt">): string {
  for (let i = p.events.length - 1; i >= 0; i--) {
    const e = p.events[i];
    if (e.type === "handoff" || e.type === "status.changed") return e.at;
  }
  return p.updatedAt || p.createdAt;
}

/**
 * The globe form sends "Place name · lat, lon". Split it back for display: the name as the headline,
 * the coordinates as small print. Plain text or bare coordinates come back as name only.
 */
export function splitLocation(location: string | null): { name: string | null; coords: string | null } {
  if (!location) return { name: null, coords: null };
  const m = location.match(/^(.*?)\s·\s(-?\d{1,2}\.\d+,\s*-?\d{1,3}\.\d+)$/);
  return m ? { name: m[1], coords: m[2] } : { name: location, coords: null };
}

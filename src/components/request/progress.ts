/** Pure helpers for the request progress view. No "use client": callable from server and client. */
import { actorLabel, STATUS_LABEL } from "@/components/format";
import type { RequestStatus } from "@/lib/domain";
import type { QuoteClosedReason, RequestProgress } from "@/lib/dashboard/public";

/** The step track's labels (StepTrack). Kept here, with the status mapping, so both are tested without a DOM. */
export const STEPS = ["Received", "Checked", "Priced", "Your choice", "Imagery", "Analysis", "Verified", "Delivered"] as const;

export type TrackOutcome = "active" | "delivered" | "refused" | "stopped";

/**
 * Status → index into STEPS (StepTrack). Delivered is past the last step.
 * Pricing v2: the free investigation (planning, acquiring, pricing) ends in a quote; "Your choice" waits for the customer
 * to accept an option; "Imagery" is fetching it, or a founder buying paid data by hand (awaiting_approval).
 */
export const STEP_OF: Readonly<Record<RequestStatus, number>> = {
  received: 0, screening: 1, clarifying: 1, planning: 2, acquiring: 2, pricing: 2, quoted: 3,
  awaiting_approval: 4, fetching: 4, analyzing: 5, verifying: 6, revising: 6, delivering: 7, delivered: STEPS.length,
  refused: 1, failed: -1, cancelled: -1,
};

/** Where the track should stop and how it ended. Failed/cancelled don't record a step, so they report -1. */
export function trackOf(p: Pick<RequestProgress, "status">): { step: number; outcome: TrackOutcome } {
  if (p.status === "delivered") return { step: STEP_OF.delivered, outcome: "delivered" };
  if (p.status === "refused") return { step: STEP_OF.refused, outcome: "refused" };
  if (p.status === "failed" || p.status === "cancelled") return { step: -1, outcome: "stopped" };
  return { step: STEP_OF[p.status], outcome: "active" };
}

/**
 * Statuses where the ball is with the customer or a founder; the Outcome block explains, so no "agent is on it".
 * Since pricing v2, awaiting_approval means a founder is buying the paid data the customer chose, by hand.
 */
const WAITING_ON_PERSON: ReadonlySet<RequestStatus> = new Set(["clarifying", "quoted", "awaiting_approval"]);

/**
 * Whether Outcome shows the quote ("Your choice"): status quoted with a pricing v2 quote, or any open accept link
 * with no option chosen yet. Older single-price quotes have no `quote` and keep the plain "reply to accept" text.
 */
export const showsQuoteChoice = (p: Pick<RequestProgress, "status" | "terminal" | "quote">): boolean =>
  !p.terminal && !!p.quote && (p.status === "quoted" || (!!p.quote.accept_url && !p.quote.accepted_option_id));

/** The compact "You chose option B …" line: once an option is accepted, until the answer is delivered (then the answer speaks). */
export const showsChosenOption = (p: Pick<RequestProgress, "status" | "terminal" | "quote">): boolean =>
  !!p.quote?.accepted_option_id && p.status !== "delivered" && !showsQuoteChoice(p);

/** Whether to show the "agent is on it" card. */
export const agentIsWorking = (p: Pick<RequestProgress, "status" | "terminal" | "quote">) =>
  !p.terminal && !WAITING_ON_PERSON.has(p.status) && !showsQuoteChoice(p);

const CLOSED_HEADING: Record<Exclude<QuoteClosedReason, "accepted">, string> = {
  expired: "Your quote has expired",
  superseded: "Replaced by a newer quote",
  closed: "This quote is closed",
};

/**
 * The status line above the outcome. STATUS_LABEL, except while the quote block shows a quote that can no longer be
 * accepted (expired, replaced, request closed): then the heading says so too, instead of "Your quote is ready".
 */
export function headingOf(p: Pick<RequestProgress, "status" | "terminal" | "quote">): string {
  const q = p.quote;
  if (q && showsQuoteChoice(p) && !q.accepted_option_id && q.closed_reason && q.closed_reason !== "accepted") return CLOSED_HEADING[q.closed_reason];
  return STATUS_LABEL[p.status];
}

type ProgressEvent = RequestProgress["events"][number];

/** Internal bookkeeping that never belongs on the customer's timeline (revenue.committed, revenue.stated_willingness …). */
const isInternalEvent = (type: string) => type.startsWith("revenue.");

/** The events the customer's timeline shows, in the order given. */
export const customerEvents = <E extends Pick<ProgressEvent, "type">>(events: readonly E[]): E[] => events.filter((e) => !isInternalEvent(e.type));

/** Actors that are the customer themselves: "customer (link)" (the Accept button), and any other "customer…" actor. */
const isCustomerActor = (actor: string | null) => !!actor && /^customer\b/i.test(actor);

/** Who did it, as the customer reads it: "You" for their own actions, else the shared actorLabel. */
export const timelineActor = (actor: string | null) => (isCustomerActor(actor) ? "You" : actorLabel(actor));

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

/**
 * Turns the demo script (yc.ts) into what the real tracking components expect: a RequestProgress at a given
 * moment, plus the agent log lines so far. Pure, so it is tested without a DOM (playback.test.ts).
 */
import type { RequestProgress } from "@/lib/dashboard/public";
import type { QuoteOptionId, RequestStatus } from "@/lib/domain";
import { demoQuote, POST_QUOTE, PRE_QUOTE, REPORT_ANSWER, REPORT_LIMITATIONS, REPORT_TITLE, type DemoStep } from "./yc";

export interface DemoClock {
  id: string;
  question: string;
  location: string;
  /** ms epoch the request was "created". */
  startedAt: number;
  /** ms epoch the customer accepted an option, or null while choosing. */
  acceptedAt: number | null;
  optionId: QuoteOptionId | null;
  /** Script time multiplier (2 = twice as fast). */
  speed: number;
  /** Extra script seconds added by the presenter's "skip ahead" key. */
  skipPre: number;
  skipPost: number;
}

export interface DemoLogEntry {
  at: string;
  actor: string;
  text: string;
}

export interface DemoFrame {
  progress: RequestProgress;
  log: DemoLogEntry[];
  /** Script seconds until the next step lands, or null when waiting on the customer / finished. */
  nextIn: number | null;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** The report link the delivered state points at (the demo report page, never a real token). */
export const demoReportPath = (id: string) => `/demo/report/${id}`;

/** Script seconds elapsed in a phase. */
const elapsed = (from: number, now: number, speed: number, skip: number) => Math.max(0, ((now - from) / 1000) * speed + skip);

/** When a script step landed, in wall-clock ms (skips pull steps into the past). */
const landedAt = (from: number, at: number, speed: number, skip: number, now: number) => Math.min(now, from + ((at - skip) / speed) * 1000);

function apply(steps: DemoStep[], secs: number, from: number, speed: number, skip: number, now: number, s: Acc) {
  for (const step of steps) {
    if (step.at > secs) return step.at - secs;
    const at = iso(landedAt(from, step.at, speed, skip, now));
    if (step.status) s.status = step.status;
    if (step.owner !== undefined) s.owner = step.owner;
    for (const e of step.events ?? []) s.events.push({ ...e, at });
    for (const l of step.log ?? []) s.log.push({ ...l, at });
    s.updatedAt = at;
  }
  return null;
}

interface Acc {
  status: RequestStatus;
  owner: string | null;
  events: RequestProgress["events"];
  log: DemoLogEntry[];
  updatedAt: string;
}

export function demoFrame(c: DemoClock, now: number): DemoFrame {
  const s: Acc = { status: "received", owner: null, events: [], log: [], updatedAt: iso(c.startedAt) };
  const preSecs = elapsed(c.startedAt, now, c.speed, c.skipPre);
  let nextIn = apply(PRE_QUOTE, preSecs, c.startedAt, c.speed, c.skipPre, now, s);

  if (c.acceptedAt !== null && s.status === "quoted") {
    const postSecs = elapsed(c.acceptedAt, now, c.speed, c.skipPost);
    nextIn = apply(POST_QUOTE, postSecs, c.acceptedAt, c.speed, c.skipPost, now, s);
  } else if (s.status === "quoted") {
    nextIn = null;
  }

  const delivered = s.status === "delivered";
  const progress: RequestProgress = {
    id: c.id,
    status: s.status,
    terminal: delivered,
    owner: s.owner,
    question: c.question,
    location: c.location,
    refusalReason: null,
    createdAt: iso(c.startedAt),
    updatedAt: s.updatedAt,
    events: s.events,
    report: delivered
      ? {
          url: demoReportPath(c.id),
          path: demoReportPath(c.id),
          title: REPORT_TITLE,
          answer: REPORT_ANSWER,
          confidence: "high",
          limitations: REPORT_LIMITATIONS,
          humanReview: false,
        }
      : null,
    quote: preSecs >= quoteAt() ? demoQuote(c.id, c.acceptedAt !== null ? c.optionId : null, c.acceptedAt !== null ? iso(c.acceptedAt) : null, iso(c.startedAt)) : null,
  };
  return { progress, log: s.log, nextIn };
}

/** Script second the quote appears. */
const quoteAt = () => PRE_QUOTE.find((s) => s.status === "quoted")?.at ?? Infinity;

/** Script seconds to add so the next step lands now (the presenter's skip key). Null when nothing is pending. */
export function skipToNext(c: DemoClock, now: number): Pick<DemoClock, "skipPre" | "skipPost"> | null {
  const { nextIn } = demoFrame(c, now);
  if (nextIn === null) return null;
  const add = nextIn + 0.01;
  return c.acceptedAt !== null ? { skipPre: c.skipPre, skipPost: c.skipPost + add } : { skipPre: c.skipPre + add, skipPost: c.skipPost };
}

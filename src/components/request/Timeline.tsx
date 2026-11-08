"use client";
/**
 * What the agents have done, newest first. Milestones show by default; routine plumbing
 * (hand-offs, status moves, skipped calls) folds behind a toggle so the story stays readable.
 */
import { useState } from "react";
import { actorLabel, ago, clockUtc, eventLabel, isHuman } from "@/components/format";
import { useNow } from "@/components/useNow";
import type { RequestProgress } from "@/lib/dashboard/public";

type Event = RequestProgress["events"][number];

const ROUTINE = new Set(["status.changed", "handoff", "offline.skipped", "decision.logged"]);

export function Timeline({ events }: { events: Event[] }) {
  const [all, setAll] = useState(false);
  const now = useNow();
  const newestFirst = [...events].reverse();
  // The newest event always shows, even if routine: it's the answer to "what just happened?".
  const shown = all ? newestFirst : newestFirst.filter((e, i) => i === 0 || !ROUTINE.has(e.type));
  const hidden = newestFirst.length - shown.length;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-sm font-medium text-fg-2">What the agents have done</h2>
        {(hidden > 0 || all) && (
          <button type="button" onClick={() => setAll((a) => !a)} aria-pressed={all}
            className="text-sm text-fg-3 underline decoration-line-strong underline-offset-4 hover:text-fg">
            {all ? "Milestones only" : `Show all ${newestFirst.length} steps`}
          </button>
        )}
      </div>
      <ol className="flex flex-col border-l border-line-strong">
        {shown.map((e, i) => (
          <li key={`${e.at}-${e.type}-${i}`} className="relative grid grid-cols-[3.25rem_1fr] gap-x-3 py-2 pl-5">
            <span className={`absolute top-[0.95rem] -left-[4.5px] size-2 rounded-full ${i === 0 ? "bg-inbound-hi" : isHuman(e.actor) ? "bg-human" : "bg-line-strong"}`} aria-hidden />
            <time dateTime={e.at} className="pt-0.5 font-mono text-xs text-fg-3 tabular-nums">
              {now ? ago(e.at, now) : clockUtc(e.at)}
            </time>
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2.5">
              <span className={ROUTINE.has(e.type) ? "text-fg-2" : "text-fg"}>{eventLabel(e.type)}</span>
              <span className="text-sm text-fg-3">{actorLabel(e.actor)}</span>
            </span>
          </li>
        ))}
        {!shown.length && <li className="py-2 pl-5 text-fg-3">Waiting for the first agent to pick this up.</li>}
      </ol>
    </section>
  );
}

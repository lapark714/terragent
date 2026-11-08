"use client";
/** Every human action, with time and reason. Hollow rings mark people; agents are filled dots elsewhere. */
import type { Interventions } from "@/lib/dashboard/types";
import { actionLabel, ago, clockUtc } from "../format";
import { useNow } from "../useNow";

export function InterventionsPanel({ data }: { data: Interventions }) {
  const now = useNow();
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <p className="flex items-baseline gap-3">
        <span className="stretch-wide text-5xl font-semibold">{data.total}</span>
        <span className="text-sm leading-snug text-fg-2">
          {data.total === 1 ? "time a person stepped in" : "times a person stepped in"}
          <br />
          <span className="text-fg-3">everything else ran on agents</span>
        </span>
      </p>
      <ol className="scroll-quiet -mr-2 flex min-h-0 flex-1 flex-col overflow-y-auto pr-2">
        {data.rows.map((i) => (
          <li key={i.id} className="grid grid-cols-[0.75rem_1fr_auto] gap-x-2.5 border-b border-line py-2 last:border-0">
            <span className="mt-[5px] size-2.5 rounded-full border-2 border-human" aria-hidden />
            <div className="min-w-0">
              <p className="text-sm">
                <span className="font-medium">{i.actor}</span> <span className="text-fg-2">{actionLabel(i.action).toLowerCase()}</span>
                {i.request && <span className="ml-1.5 font-mono text-xs text-fg-3">{i.request}</span>}
              </p>
              <p className="line-clamp-2 text-[13px] leading-snug text-fg-3">{i.reason}</p>
            </div>
            <span className="text-xs text-fg-3 tabular-nums">{now ? ago(i.at, now) : clockUtc(i.at)}</span>
          </li>
        ))}
        {!data.rows.length && <li className="text-sm text-fg-3">No one has stepped in yet.</li>}
      </ol>
    </div>
  );
}

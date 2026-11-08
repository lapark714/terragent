"use client";
/** What the agents chose and why: source, free vs paid, price, screening, effort shifts. */
import type { Decisions } from "@/lib/dashboard/types";
import { actorLabel, ago, clockUtc, DECISION_LABEL, usd } from "../format";
import { PLAYBOOK_BG, PLAYBOOK_LABEL } from "../palette";
import { useNow } from "../useNow";
import { Quiet } from "./Panel";

export function freeVsPaidSummary(d: Decisions): string | null {
  if (!d.freeVsPaid.length) return null;
  return d.freeVsPaid.map((c) => `${c.choice} ${c.n}`).join(", ");
}

export function DecisionLog({ decisions }: { decisions: Decisions }) {
  const now = useNow();
  if (!decisions.rows.length) return <Quiet>No decisions yet. Every source choice, free-or-paid call and price lands here with its reasoning.</Quiet>;
  return (
    <ol className="scroll-quiet -mr-2 flex h-full flex-col overflow-y-auto pr-2">
      {decisions.rows.map((d) => (
        <li key={d.id} className="border-b border-line py-2.5 first:pt-0 last:border-0">
          <div className="flex items-baseline justify-between gap-3 text-xs text-fg-3">
            <span className="flex min-w-0 items-center gap-1.5 truncate">
              {d.playbook && <span className={`size-2 shrink-0 rounded-full ${PLAYBOOK_BG[d.playbook]}`} aria-label={PLAYBOOK_LABEL[d.playbook]} />}
              <span className="text-fg-2">{DECISION_LABEL[d.kind] ?? d.kind}</span>
              <span>by {actorLabel(d.agent)}</span>
              {d.request && <span className="font-mono">{d.request}</span>}
            </span>
            <span className="shrink-0 tabular-nums">{now ? ago(d.at, now) : clockUtc(d.at)}</span>
          </div>
          <p className="mt-1 text-sm font-medium">{d.choice}</p>
          <p className="mt-0.5 line-clamp-3 text-[13px] leading-snug text-fg-2">{d.reasoning}</p>
          {d.alternatives.length > 0 && (
            <p className="mt-1 text-xs leading-snug text-fg-3">
              Also weighed:{" "}
              {d.alternatives.map((a) => `${a.option}${a.cost_usd !== null && a.cost_usd !== undefined ? ` (${usd(a.cost_usd)})` : ""}`).join("; ")}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}

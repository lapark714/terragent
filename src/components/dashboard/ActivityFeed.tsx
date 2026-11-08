"use client";
/**
 * The company's pulse: the latest events, newest first. Agents are filled dots, people are hollow rings
 * (same marks as the intervention log); the playbook dot says which line of business the work belongs to.
 */
import type { ActivityRow } from "@/lib/dashboard/types";
import { actionLabel, actorLabel, ago, clockUtc, DECISION_LABEL, eventLabel, isHuman, SERVICE_LABEL, STATUS_LABEL } from "../format";
import { PLAYBOOK_BG, PLAYBOOK_LABEL } from "../palette";
import { useNow } from "../useNow";
import { Quiet } from "./Panel";

/** One short phrase from the event's safe details: "→ Planner, planning", "Free vs paid", "Naïve, for Planner". */
export function activityNote(e: ActivityRow): string | null {
  const d = e.detail;
  if (!d) return null;
  switch (e.type) {
    case "handoff":
      return d.agent ? `to ${actorLabel(d.agent)}${d.stage ? `, ${d.stage.replace(/_/g, " ")}` : ""}` : null;
    case "status.changed":
      return d.to ? `now ${STATUS_LABEL[d.to].toLowerCase()}` : null;
    case "decision.logged":
      return d.kind ? DECISION_LABEL[d.kind] : null;
    case "human.intervention":
    case "human.intervention_undone":
      return d.action ? actionLabel(d.action) : null;
    case "offline.skipped":
      return d.service ? `${SERVICE_LABEL[d.service] ?? d.service}${d.agent ? `, for ${actorLabel(d.agent)}` : ""}` : null;
    default:
      return d.stage ? d.stage.replace(/_/g, " ") : null;
  }
}

export function ActivityFeed({ rows }: { rows: ActivityRow[] }) {
  const now = useNow();
  if (!rows.length) return <Quiet>Nothing has happened yet. Every hand-off, decision and email lands here as it happens.</Quiet>;
  return (
    <ol className="scroll-quiet -mr-2 flex h-full flex-col overflow-y-auto pr-2" aria-live="polite" aria-relevant="additions">
      {rows.map((e) => {
        const human = isHuman(e.actor);
        const note = activityNote(e);
        return (
          <li key={e.id} className="grid grid-cols-[0.625rem_minmax(0,1fr)_auto] items-baseline gap-x-2.5 border-b border-line py-[7px] last:border-0">
            <span
              className={`size-2 translate-y-[1px] rounded-full ${human ? "border-2 border-human" : e.actor === "system" ? "bg-fg-3" : "bg-fg-2"}`}
              aria-hidden
            />
            <p className="min-w-0 text-[13px] leading-snug">
              <span className={human ? "font-medium text-human" : "font-medium"}>{actorLabel(e.actor)}</span>{" "}
              <span className="text-fg-2">{eventLabel(e.type).toLowerCase()}</span>
              {note && <span className="text-fg-3"> · {note}</span>}
              {e.request && (
                <span className="ml-1.5 inline-flex items-center gap-1 align-baseline font-mono text-[11px] text-fg-3">
                  {e.playbook && <span className={`size-1.5 rounded-full ${PLAYBOOK_BG[e.playbook]}`} aria-label={PLAYBOOK_LABEL[e.playbook]} />}
                  {e.request}
                </span>
              )}
            </p>
            <time dateTime={e.at} className="text-xs text-fg-3 tabular-nums">{now ? ago(e.at, now) : clockUtc(e.at)}</time>
          </li>
        );
      })}
    </ol>
  );
}

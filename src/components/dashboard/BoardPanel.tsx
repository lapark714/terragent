"use client";
/** Requests by status column with their owner agent, plus the coordinator's Naïve board. */
import type { RequestStatus } from "@/lib/domain";
import type { Board, BoardRequest, NaiveCard } from "@/lib/dashboard/types";
import { actorLabel, ago, clockUtc, STATUS_LABEL } from "../format";
import { PLAYBOOK_BG, PLAYBOOK_LABEL } from "../palette";
import { useNow } from "../useNow";
import { Quiet } from "./Panel";

const COLUMNS: { label: string; statuses: RequestStatus[] }[] = [
  { label: "Intake", statuses: ["received", "screening", "clarifying"] },
  { label: "Planning and data", statuses: ["planning", "acquiring", "fetching"] },
  { label: "Pricing", statuses: ["pricing", "quoted", "awaiting_approval"] },
  { label: "Analysis", statuses: ["analyzing"] },
  { label: "Review", statuses: ["verifying", "revising", "delivering"] },
  { label: "Done", statuses: ["delivered", "refused", "failed", "cancelled"] },
];

const columnOf = (s: RequestStatus) => COLUMNS.find((c) => c.statuses.includes(s))!;

function Card({ r, now }: { r: BoardRequest; now: number | null }) {
  const needsHuman = r.status === "awaiting_approval";
  // Name the exact status when the column groups several and it isn't obvious.
  const showStatus = !needsHuman && r.status !== "delivered" && columnOf(r.status).statuses.length > 1;
  return (
    <li className="rounded-md border border-line bg-raised px-2.5 py-2">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="flex min-w-0 items-center gap-1.5 font-mono text-fg-2">
          <span className={`size-2 shrink-0 rounded-full ${PLAYBOOK_BG[r.playbook]}`} title={PLAYBOOK_LABEL[r.playbook]} aria-label={PLAYBOOK_LABEL[r.playbook]} />
          {r.id}
        </span>
        <span className="shrink-0 text-fg-3 tabular-nums">{now ? ago(r.updatedAt, now) : clockUtc(r.updatedAt)}</span>
      </div>
      <p className="mt-1.5 line-clamp-2 text-[13px] leading-snug">{r.question}</p>
      <p className="mt-1.5 truncate text-xs text-fg-2">
        {needsHuman ? <span className="text-human">Waiting on a founder</span> : actorLabel(r.owner)}
        <span className="text-fg-3">, {r.sample ? "free sample" : (r.customer ?? r.source)}</span>
      </p>
      {showStatus && <p className="mt-0.5 text-xs text-fg-3">{STATUS_LABEL[r.status]}</p>}
    </li>
  );
}

function NaiveStrip({ naive }: { naive: Board["naive"] }) {
  if (naive.state === "not_configured") return <Quiet>Naïve board not connected on this deployment.</Quiet>;
  if (naive.state === "error") return <Quiet>Naïve board unavailable right now ({naive.message}).</Quiet>;
  const cards: NaiveCard[] = naive.data;
  const by = (s: NaiveCard["status"]) => cards.filter((c) => c.status === s).length;
  return (
    <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-xs text-fg-2">
      <span className="text-fg">Naïve board</span>
      <span className="tabular-nums">{by("doing")} doing</span>
      <span className="tabular-nums">{by("todo")} to do</span>
      <span className="tabular-nums">{by("blocked")} blocked</span>
      <span className="tabular-nums">{by("done")} done</span>
      {cards
        .filter((c) => c.status === "doing")
        .slice(0, 3)
        .map((c) => (
          <span key={c.id} className="max-w-[16rem] truncate text-fg-3">
            {actorLabel(c.assignee)}: {c.title}
          </span>
        ))}
    </div>
  );
}

export function BoardPanel({ board }: { board: Board }) {
  const now = useNow();
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="scroll-quiet grid min-h-0 flex-1 auto-cols-[minmax(8.5rem,1fr)] grid-flow-col gap-2 overflow-x-auto">
        {COLUMNS.map((col) => {
          const items = board.requests.filter((r) => col.statuses.includes(r.status));
          return (
            <div key={col.label} className="flex min-h-0 flex-col rounded-md bg-space/60">
              <h3 className="flex items-baseline justify-between px-2.5 pt-2 pb-1.5 text-xs text-fg-2">
                {col.label}
                <span className="text-fg-3 tabular-nums">{items.length}</span>
              </h3>
              <ul className="scroll-quiet flex min-h-24 flex-col gap-1.5 overflow-y-auto px-1.5 pb-1.5">
                {items.map((r) => (
                  <Card key={r.id} r={r} now={now} />
                ))}
              </ul>
            </div>
          );
        })}
      </div>
      <NaiveStrip naive={board.naive} />
    </div>
  );
}

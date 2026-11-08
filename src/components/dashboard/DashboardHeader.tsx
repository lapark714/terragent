"use client";
/** Wordmark, the headline counters, and whether the feed is live. */
import type { Overview, Panel } from "@/lib/dashboard/types";
import { count, duration } from "../format";
import { Wordmark } from "../site/Wordmark";
import { useNow } from "../useNow";

function Stat({ label, value, human }: { label: string; value: string; human?: boolean }) {
  return (
    <div className="flex flex-col">
      <span className="flex items-center gap-1.5 text-xs text-fg-3">
        {human && <span className="size-2 rounded-full border-[1.5px] border-human" aria-hidden />}
        {label}
      </span>
      <span className="stretch-semi text-lg font-semibold">{value}</span>
    </div>
  );
}

export function DashboardHeader({ overview, updatedAt, error }: { overview: Panel<Overview> | undefined; updatedAt: number | null; error: string | null }) {
  const now = useNow();
  const o = overview?.ok ? overview.data : null;
  const fresh = !error;
  return (
    <header className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3 px-4 py-3">
      <Wordmark suffix="Mission control" />
      {o && (
        <div className="flex flex-wrap gap-x-7 gap-y-2">
          <Stat label="In progress" value={count(o.active)} />
          <Stat label="Answered" value={count(o.delivered)} />
          <Stat label="Free samples" value={count(o.samples)} />
          <Stat label="Verified reports" value={count(o.verifiedReports)} />
          <Stat label="Index cells" value={count(o.indexCells)} />
          <Stat label="Median answer" value={duration(o.medianAnswerSeconds)} />
          <Stat label="Human interventions" value={count(o.interventions)} human />
        </div>
      )}
      <p className="flex items-center gap-2 text-xs text-fg-2" role="status">
        <span className={`size-2 rounded-full ${fresh ? "beacon bg-forest text-forest" : "bg-alert"}`} aria-hidden />
        {fresh ? "Live" : "Reconnecting"}
        {now && updatedAt && <span className="text-fg-3 tabular-nums">updated {Math.max(0, Math.round((now - updatedAt) / 1000))}s ago</span>}
      </p>
    </header>
  );
}

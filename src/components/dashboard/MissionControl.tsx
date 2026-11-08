"use client";
/**
 * Mission control: the demo screen. Polls three JSON endpoints (live panels every 6 s, globe every 8 s,
 * approvals every 10 s) starting from server-rendered data; the server answers them from a short cache, so
 * viewers never multiply database reads. The first screen (overview strip + instrument grid) fills one 16:9
 * display at xl; what is waiting on a founder sits below it.
 */
import type { Approvals, GlobeData, LiveSnapshot } from "@/lib/dashboard/types";
import { usePoll } from "../usePoll";
import { ActivityFeed } from "./ActivityFeed";
import { AllocationChart } from "./AllocationChart";
import { ApprovalsPanel } from "./ApprovalsPanel";
import { BoardPanel } from "./BoardPanel";
import { DashboardHeader } from "./DashboardHeader";
import { DecisionLog, freeVsPaidSummary } from "./DecisionLog";
import { FunnelPanel } from "./FunnelPanel";
import { GlobePanel } from "./GlobePanel";
import { InterventionsPanel } from "./InterventionsPanel";
import { PlaybookLegend } from "./Legend";
import { MoneyPanel } from "./MoneyPanel";
import { Panel, PanelData, Quiet } from "./Panel";

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

/** Slow down while the database is paused: no point asking every few seconds, and no retry loop. */
const PAUSED_POLL_MS = 60_000;

function Banner({ tone, title, children }: { tone: "alert" | "quiet"; title: string; children?: React.ReactNode }) {
  return (
    <div
      role={tone === "alert" ? "alert" : "status"}
      className={`mx-2 flex items-start gap-3 rounded-lg border px-4 py-2.5 text-sm ${tone === "alert" ? "border-alert/60 bg-alert/10" : "border-line-strong bg-panel"}`}
    >
      <span className={`mt-1.5 size-2 shrink-0 rounded-full ${tone === "alert" ? "bg-alert" : "bg-fg-3"}`} aria-hidden />
      <p className="leading-relaxed">
        <span className="font-semibold text-fg">{title}</span>
        {children && <span className="text-fg-2"> {children}</span>}
      </p>
    </div>
  );
}

export function MissionControl({ initialLive, initialGlobe, initialApprovals }: {
  initialLive: LiveSnapshot | null;
  initialGlobe: GlobeData | null;
  initialApprovals: Approvals | null;
}) {
  const paused = initialLive?.dbSuspended === true;
  const live = usePoll<LiveSnapshot>("/api/dashboard/live", 6_000, initialLive, keepLastGood);
  const suspended = (live.data?.dbSuspended ?? paused) === true;
  const globe = usePoll<GlobeData>("/api/dashboard/globe", suspended ? PAUSED_POLL_MS : 8_000, initialGlobe);
  const approvals = usePoll<Approvals>("/api/dashboard/approvals", suspended ? PAUSED_POLL_MS : 10_000, initialApprovals);
  const s = live.data;
  const decisionsMeta = s?.decisions.ok ? freeVsPaidSummary(s.decisions.data) : null;
  const offline = s?.offline === true;

  return (
    <div className="flex flex-col pb-2">
      <div className="flex flex-col gap-2 xl:h-dvh xl:min-h-[44rem]">
        <DashboardHeader overview={s?.overview} money={s?.money} offline={offline} updatedAt={live.updatedAt} error={live.error} />
        {suspended && (
          <Banner tone="alert" title="Database paused — quota hit; a founder must check Neon (NOTES H4c).">
            Neon suspends compute when a billing quota is reached. Panels keep their last numbers and check again once a minute; nothing retries in a loop.
          </Banner>
        )}
        <main className="instrument mx-2 grid-cols-1 overflow-hidden rounded-lg xl:min-h-0 xl:flex-1 xl:grid-cols-24 xl:grid-rows-[minmax(0,1.45fr)_minmax(0,1fr)]">
          <GlobePanel data={globe.data} className="h-[62vh] xl:col-span-11 xl:h-auto" />
          <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-px bg-line xl:col-span-13">
            <Panel title="Signal funnel" meta={<PlaybookLegend />}>
              <PanelData result={s?.funnel}>{(f) => <FunnelPanel stages={f} />}</PanelData>
            </Panel>
            <Panel title="Live board" meta="Requests by step, with the agent on each" className="min-h-[24rem] xl:min-h-0">
              <PanelData result={s?.board}>{(b) => <BoardPanel board={b} />}</PanelData>
            </Panel>
          </div>
          <Panel title="Decision log" meta={decisionsMeta && `Free vs paid: ${decisionsMeta}`} className="h-[26rem] xl:col-span-5 xl:h-auto">
            <PanelData result={s?.decisions}>{(d) => <DecisionLog decisions={d} />}</PanelData>
          </Panel>
          <Panel title="Activity" meta="Newest first" className="h-[26rem] xl:col-span-5 xl:h-auto">
            <PanelData result={s?.activity}>{(a) => <ActivityFeed rows={a} />}</PanelData>
          </Panel>
          <Panel title="Spend vs revenue" className="h-[26rem] xl:col-span-5 xl:h-auto">
            <PanelData result={s?.money}>{(m) => <MoneyPanel money={m} offline={offline} />}</PanelData>
          </Panel>
          <Panel title="Playbook effort" meta="Set by the coordinator" className="xl:col-span-5">
            <PanelData result={s?.allocation}>{(a) => <AllocationChart points={a} />}</PanelData>
          </Panel>
          <Panel title="Intervention log" className="h-[26rem] xl:col-span-4 xl:h-auto">
            <PanelData result={s?.interventions}>{(i) => <InterventionsPanel data={i} />}</PanelData>
          </Panel>
        </main>
      </div>
      <div className="instrument mx-2 mt-2 overflow-hidden rounded-lg">
        {approvals.data ? (
          <ApprovalsPanel approvals={approvals.data} offline={offline} onChanged={() => { approvals.refresh(); live.refresh(); }} />
        ) : (
          <div className="bg-panel p-4">
            <Quiet>{suspended ? "Waiting for the database before showing what is waiting on a founder." : "Loading what is waiting on a founder."}</Quiet>
          </div>
        )}
      </div>
    </div>
  );
}

"use client";
/**
 * Signal Engine (the /dashboard tab): where business could come from. The globe of signals, the funnel, which
 * playbooks convert, the latest signals and their feeds, and where the coordinator puts effort. Polls three JSON
 * endpoints (live every 6 s, globe every 8 s, approvals every 10 s) from server-rendered data; the server answers
 * them from a short cache. The first screen fills one 16:9 display at xl; what is waiting on a founder sits below.
 */
import type { Approvals, GlobeData, LiveSnapshot } from "@/lib/dashboard/types";
import { usePoll } from "../usePoll";
import { keepLastGood } from "./keepLastGood";
import { AllocationChart } from "./AllocationChart";
import { ApprovalsPanel } from "./ApprovalsPanel";
import { DashboardHeader } from "./DashboardHeader";
import { FunnelPanel } from "./FunnelPanel";
import { GlobePanel } from "./GlobePanel";
import { PlaybookLegend } from "./Legend";
import { Panel, PanelData, Quiet } from "./Panel";
import { ConversionPanel } from "./signals/ConversionPanel";
import { SignalFeedPanel } from "./signals/SignalFeedPanel";
import { SignalSourcesPanel } from "./signals/SourcesPanel";

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
  const offline = s?.offline === true;

  return (
    <div className="flex flex-col pb-2">
      <div className="flex flex-col gap-2 xl:h-dvh xl:min-h-[44rem]">
        <DashboardHeader current="signals" />
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
            <Panel title="What's converting" meta="Each playbook's signals, followed to payment" className="min-h-[18rem] xl:min-h-0">
              <PanelData result={s?.funnel}>{(f) => <ConversionPanel stages={f} />}</PanelData>
            </Panel>
          </div>
          <Panel title="Latest signals" meta="What the sourcing agent picked up" className="h-[26rem] xl:col-span-10 xl:h-auto">
            {globe.data ? <SignalFeedPanel signals={globe.data.signals} /> : <Quiet>Waiting for the first update.</Quiet>}
          </Panel>
          <Panel title="Signal sources" meta="Signals per feed" className="h-[22rem] xl:col-span-6 xl:h-auto">
            {globe.data ? <SignalSourcesPanel signals={globe.data.signals} /> : <Quiet>Waiting for the first update.</Quiet>}
          </Panel>
          <Panel title="Playbook effort" meta="Set by the coordinator" className="xl:col-span-8">
            <PanelData result={s?.allocation}>{(a) => <AllocationChart points={a} />}</PanelData>
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

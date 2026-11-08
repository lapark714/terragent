"use client";
/**
 * Mission control: the demo screen. Polls three JSON endpoints (live panels every 6 s, globe every 8 s,
 * approvals every 10 s) starting from server-rendered data. Laid out to fill one 16:9 screen at xl.
 */
import type { Approvals, GlobeData, LiveSnapshot } from "@/lib/dashboard/types";
import { usePoll } from "../usePoll";
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

export function MissionControl({ initialLive, initialGlobe, initialApprovals }: {
  initialLive: LiveSnapshot | null;
  initialGlobe: GlobeData | null;
  initialApprovals: Approvals | null;
}) {
  const live = usePoll<LiveSnapshot>("/api/dashboard/live", 6_000, initialLive);
  const globe = usePoll<GlobeData>("/api/dashboard/globe", 8_000, initialGlobe);
  const approvals = usePoll<Approvals>("/api/dashboard/approvals", 10_000, initialApprovals);
  const s = live.data;
  const activity = s?.activity.ok ? s.activity.data : null;
  const decisionsMeta = s?.decisions.ok ? freeVsPaidSummary(s.decisions.data) : null;

  return (
    <div className="flex min-h-dvh flex-col pb-2">
      <DashboardHeader overview={s?.overview} updatedAt={live.updatedAt} error={live.error} />
      <main className="flex flex-col gap-2 px-2">
        <div className="instrument grid grid-cols-1 overflow-hidden rounded-lg xl:h-[calc(100dvh-5.25rem)] xl:grid-cols-12 xl:grid-rows-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <GlobePanel data={globe.data} activity={activity} className="h-[62vh] xl:col-span-6 xl:h-auto" />
          <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-px bg-line xl:col-span-6">
            <Panel title="Signal funnel" meta={<PlaybookLegend />}>
              <PanelData result={s?.funnel}>{(f) => <FunnelPanel stages={f} />}</PanelData>
            </Panel>
            <Panel title="Live board" meta="Requests by step, with the agent on each" className="min-h-[24rem] xl:min-h-0">
              <PanelData result={s?.board}>{(b) => <BoardPanel board={b} />}</PanelData>
            </Panel>
          </div>
          <Panel title="Decision log" meta={decisionsMeta && `Free vs paid: ${decisionsMeta}`} className="h-[26rem] xl:col-span-3 xl:h-auto">
            <PanelData result={s?.decisions}>{(d) => <DecisionLog decisions={d} />}</PanelData>
          </Panel>
          <Panel title="Spend vs revenue" className="h-[26rem] xl:col-span-3 xl:h-auto">
            <PanelData result={s?.money}>{(m) => <MoneyPanel money={m} />}</PanelData>
          </Panel>
          <Panel title="Playbook effort" meta="Set by the coordinator" className="xl:col-span-3">
            <PanelData result={s?.allocation}>{(a) => <AllocationChart points={a} />}</PanelData>
          </Panel>
          <Panel title="Intervention log" className="h-[26rem] xl:col-span-3 xl:h-auto">
            <PanelData result={s?.interventions}>{(i) => <InterventionsPanel data={i} />}</PanelData>
          </Panel>
        </div>
        <div className="instrument overflow-hidden rounded-lg">
          {approvals.data ? (
            <ApprovalsPanel approvals={approvals.data} onChanged={() => { approvals.refresh(); live.refresh(); }} />
          ) : (
            <div className="bg-panel p-4"><Quiet>Loading what is waiting on a founder.</Quiet></div>
          )}
        </div>
      </main>
    </div>
  );
}

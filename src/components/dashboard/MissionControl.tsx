"use client";
/**
 * Signal Engine (the /dashboard tab): where business could come from. The globe of signals; the latest signals,
 * each opening to the businesses matched to it and where outreach stands; conversion by event type; and where the
 * coordinator puts effort. Polls the live, globe and prospects endpoints, which the server answers from a short
 * cache. Fills one 16:9 display at xl.
 */
import type { GlobeData, LiveSnapshot } from "@/lib/dashboard/types";
import { usePoll } from "../usePoll";
import { AllocationChart } from "./AllocationChart";
import { DashboardHeader } from "./DashboardHeader";
import { GlobePanel } from "./GlobePanel";
import { keepLastGood } from "./keepLastGood";
import { Panel, PanelData, Quiet } from "./Panel";
import { EventConversionPanel } from "./signals/EventConversionPanel";
import type { SignalProspectsResponse } from "./signals/outreach";
import { SignalOutreachPanel } from "./signals/SignalOutreachPanel";

/** Slow down while the database is paused: no point asking every few seconds, and no retry loop. */
const PAUSED_POLL_MS = 60_000;

export function MissionControl({ initialLive, initialGlobe }: { initialLive: LiveSnapshot | null; initialGlobe: GlobeData | null }) {
  const paused = initialLive?.dbSuspended === true;
  const live = usePoll<LiveSnapshot>("/api/dashboard/live", 6_000, initialLive, keepLastGood);
  const suspended = (live.data?.dbSuspended ?? paused) === true;
  const globe = usePoll<GlobeData>("/api/dashboard/globe", suspended ? PAUSED_POLL_MS : 8_000, initialGlobe);
  const prospects = usePoll<SignalProspectsResponse>("/api/dashboard/prospects", suspended ? PAUSED_POLL_MS : 10_000);
  const p = prospects.data;
  const s = live.data;

  return (
    <div className="flex flex-col gap-2 pb-2 xl:h-dvh xl:min-h-[44rem]">
      <DashboardHeader current="signals" />
      {suspended && (
        <div role="alert" className="mx-2 rounded-lg border border-alert/60 bg-alert/10 px-4 py-2.5 text-sm">
          <span className="font-semibold">Database paused — quota hit; a founder must check Neon (NOTES H4c).</span>{" "}
          <span className="text-fg-2">Panels keep their last numbers and check again once a minute.</span>
        </div>
      )}
      <main className="instrument mx-2 grid-cols-1 overflow-hidden rounded-lg xl:min-h-0 xl:flex-1 xl:grid-cols-24 xl:grid-rows-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <GlobePanel data={globe.data} className="h-[62vh] xl:col-span-10 xl:h-auto" />
        <Panel title="Latest signals" meta="Open one to see the businesses matched to it and where outreach stands" className="h-[36rem] xl:col-span-14 xl:h-auto">
          <SignalOutreachPanel signals={p?.ok ? p.data.signals : null} fallback={globe.data?.signals ?? null} />
        </Panel>
        <Panel title="Conversion by event type" meta="From signal to paid, per feed" className="h-[26rem] xl:col-span-16 xl:h-auto">
          {p ? <PanelData result={p}>{(d) => <EventConversionPanel rows={d.byFeed} />}</PanelData> : <Quiet>{prospects.error ? "Conversion by event type needs the prospects feed, which isn't connected yet." : "Waiting for the first update."}</Quiet>}
        </Panel>
        <Panel title="Playbook effort" meta="Set by the coordinator" className="xl:col-span-8">
          <PanelData result={s?.allocation}>{(a) => <AllocationChart points={a} />}</PanelData>
        </Panel>
      </main>
    </div>
  );
}

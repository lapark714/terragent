"use client";
/**
 * Operations (the /dashboard tab), for founders: deals and money first, then what we've delivered, what it costs, and
 * where the data comes from. Reads the same cached endpoints as the Signal Engine.
 */
import type { LiveSnapshot } from "@/lib/dashboard/types";
import { count, usd } from "../../format";
import { usePoll } from "../../usePoll";
import { DashboardHeader } from "../DashboardHeader";
import { keepLastGood } from "../keepLastGood";
import { Panel, PanelData, Quiet } from "../Panel";
import type { SignalProspectsResponse } from "../signals/outreach";
import { CostsPanel } from "./CostsPanel";
import { DataSourcesPanel } from "./DataSourcesPanel";
import { DealsPanel } from "./DealsPanel";
import { dataSources, deals as toDeals, openValue, products as toProducts } from "./model";
import { ProductsPanel } from "./ProductsPanel";

const PAUSED_POLL_MS = 60_000;

function Kpi({ label, value, note, tone }: { label: string; value: React.ReactNode; note?: React.ReactNode; tone?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 bg-panel px-3.5 py-2.5">
      <dt className="flex items-center gap-1.5 truncate text-xs text-fg-3">
        {tone && <span className={`size-2 shrink-0 rounded-full ${tone}`} aria-hidden />}
        {label}
      </dt>
      <dd className="stretch-semi truncate text-[1.35rem] leading-tight font-semibold tabular-nums">{value}</dd>
      {note && <dd className="truncate text-xs text-fg-3">{note}</dd>}
    </div>
  );
}

export function SalesConsole({ initialLive }: { initialLive: LiveSnapshot | null }) {
  const live = usePoll<LiveSnapshot>("/api/dashboard/live", 6_000, initialLive, keepLastGood);
  const suspended = live.data?.dbSuspended === true;
  const prospects = usePoll<SignalProspectsResponse>("/api/dashboard/prospects", suspended ? PAUSED_POLL_MS : 10_000);
  const outreach = prospects.data?.ok ? prospects.data.data.signals : null;

  const s = live.data;
  const money = s?.money.ok ? s.money.data : null;
  const board = s?.board.ok ? s.board.data : null;
  const overview = s?.overview.ok ? s.overview.data : null;
  const decisions = s?.decisions.ok ? s.decisions.data : null;
  const dealList = money ? toDeals(money, board, decisions) : [];
  const value = openValue(dealList);
  const paidDeals = dealList.filter((d) => d.stage === "completed" && d.paid > 0);
  const paidProfit = paidDeals.reduce((t, d) => t + d.paid - d.cost, 0);
  const dash = "–";

  return (
    <div className="flex flex-col gap-2 pb-2">
      <DashboardHeader current="operations" />
      <header className="flex flex-col gap-2.5 px-2">

        <dl className="instrument grid-cols-2 overflow-hidden rounded-lg sm:grid-cols-3 xl:grid-cols-5" aria-label="Operations overview">
          <Kpi label="Open deals" value={money ? usd(value.open) : dash} note="quoted, in progress or owed" tone="bg-inbound" />
          <Kpi label="Delivered, not paid" value={money ? usd(value.owed) : dash} note={money && `${count(value.owedCount)} to follow up`} tone="bg-alert" />
          <Kpi label="Revenue paid" value={money ? usd(money.revenue.paid) : dash} note={money && `${count(money.revenue.paidCount)} payments; ${usd(money.revenue.committed)} committed`} tone="bg-forest" />
          <Kpi label="Profit on paid deals" value={money && paidDeals.length ? usd(paidProfit) : dash} note={money && `${count(paidDeals.length)} paid in the recent requests`} />
          <Kpi label="Spend" value={money ? usd(money.spend.total) : dash} note={overview ? `${count(overview.reportsDelivered)} reports delivered` : undefined} />
        </dl>
      </header>

      {suspended && (
        <div role="alert" className="mx-2 rounded-lg border border-alert/60 bg-alert/10 px-4 py-2.5 text-sm">
          <span className="font-semibold">Database paused — Neon quota reached (NOTES H4c).</span>{" "}
          <span className="text-fg-2">Panels keep their last numbers and check again once a minute.</span>
        </div>
      )}

      <main className="instrument mx-2 grid-cols-1 overflow-hidden rounded-lg xl:grid-cols-12">
        <Panel title="Deals" meta="Customer requests, from first contact to paid, and cold outreach" className="h-[34rem] xl:col-span-12">
          <PanelData result={s?.money}>{() => <DealsPanel deals={dealList} outreach={outreach} />}</PanelData>
        </Panel>
        <Panel title="Products made" meta="Delivered reports and free samples, with the data each was made from" className="h-[28rem] xl:col-span-12">
          <PanelData result={s?.money}>{(m) => <ProductsPanel products={toProducts(m, board, decisions)} />}</PanelData>
        </Panel>
        <Panel title="Costs" meta="Where the money goes" className="h-[30rem] xl:col-span-6">
          <PanelData result={s?.money}>{(m) => <CostsPanel money={m} />}</PanelData>
        </Panel>
        <Panel title="Data sources" meta="What the agents chose and why, from their decision log" className="h-[30rem] xl:col-span-6">
          {decisions ? <DataSourcesPanel sources={dataSources(decisions)} /> : <PanelData result={s?.decisions}>{() => <Quiet>Waiting for the first update.</Quiet>}</PanelData>}
        </Panel>
      </main>
    </div>
  );
}

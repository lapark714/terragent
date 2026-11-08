"use client";
/**
 * Operations (the /dashboard tab), for founders: deals and money first, then what we've made, how our price
 * compares, and where the data comes from. Reads the same cached endpoints as /dashboard; nothing new is queried.
 */
import type { Approvals, LiveSnapshot, MarketResponse } from "@/lib/dashboard/types";
import { count, usd } from "../../format";
import { usePoll } from "../../usePoll";
import { DashboardHeader } from "../DashboardHeader";
import { keepLastGood } from "../keepLastGood";
import { Panel, PanelData, Quiet } from "../Panel";
import { DealsPanel } from "./DealsPanel";
import { dataSources, deals as toDeals, dealTotals, ourPrices, products as toProducts } from "./model";
import { PricePanel } from "./PricePanel";
import { ProductsPanel } from "./ProductsPanel";
import { SourcesPanel } from "./SourcesPanel";

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

export function SalesConsole({ initialLive, initialApprovals, initialMarket }: {
  initialLive: LiveSnapshot | null;
  initialApprovals: Approvals | null;
  initialMarket: MarketResponse | null;
}) {
  const live = usePoll<LiveSnapshot>("/api/dashboard/live", 6_000, initialLive, keepLastGood);
  const suspended = live.data?.dbSuspended === true;
  const approvals = usePoll<Approvals>("/api/dashboard/approvals", suspended ? PAUSED_POLL_MS : 10_000, initialApprovals);
  const market = usePoll<MarketResponse>("/api/dashboard/market", suspended ? PAUSED_POLL_MS : 60_000, initialMarket);

  const s = live.data;
  const money = s?.money.ok ? s.money.data : null;
  const board = s?.board.ok ? s.board.data : null;
  const overview = s?.overview.ok ? s.overview.data : null;
  const dealList = money ? toDeals(money, board, approvals.data) : [];
  const totals = dealTotals(dealList);
  const paidDeals = dealList.filter((d) => d.stage === "paid");
  const paidMargin = paidDeals.reduce((t, d) => t + d.paid - d.cost, 0);
  const dash = "–";

  return (
    <div className="flex flex-col gap-2 pb-2">
      <DashboardHeader current="operations" />
      <header className="flex flex-col gap-2.5 px-2">

        <dl className="instrument grid-cols-2 overflow-hidden rounded-lg sm:grid-cols-3 xl:grid-cols-6" aria-label="Operations overview">
          <Kpi label="Open deals" value={money ? usd(totals.open) : dash} note={money && `${count(totals.byStage.quoted.n + totals.byStage.founder.n + totals.byStage.owed.n)} quoted or owed`} tone="bg-inbound" />
          <Kpi label="Delivered, not paid" value={money ? usd(totals.owed) : dash} note={money && `${count(totals.byStage.owed.n)} to follow up`} tone="bg-alert" />
          <Kpi label="Quotes waiting on a founder" value={money ? count(totals.byStage.founder.n) : dash} note={money && (totals.byStage.founder.value ? `${usd(totals.byStage.founder.value)} above the auto-approve cap` : "none above the cap")} tone="bg-human" />
          <Kpi label="Revenue paid" value={money ? usd(money.revenue.paid) : dash} note={money && `${count(money.revenue.paidCount)} payments; ${usd(money.revenue.committed)} committed`} tone="bg-forest" />
          <Kpi label="Margin on paid deals" value={money && paidDeals.length ? usd(paidMargin) : dash} note={money && `${count(paidDeals.length)} paid in the recent requests`} />
          <Kpi label="Spend" value={money ? usd(money.spend.total) : dash} note={overview ? `${count(overview.reportsDelivered)} reports delivered` : undefined} />
        </dl>
      </header>

      {suspended && (
        <div role="alert" className="mx-2 rounded-lg border border-alert/60 bg-alert/10 px-4 py-2.5 text-sm">
          <span className="font-semibold">Database paused — quota hit; a founder must check Neon (NOTES H4c).</span>{" "}
          <span className="text-fg-2">Panels keep their last numbers and check again once a minute.</span>
        </div>
      )}

      <main className="instrument mx-2 grid-cols-1 overflow-hidden rounded-lg xl:grid-cols-12">
        <Panel title="Deals" meta="Customer requests by where the money stands" className="h-[34rem] xl:col-span-12">
          <PanelData result={s?.money}>{() => <DealsPanel deals={dealList} />}</PanelData>
        </Panel>
        <Panel title="Products made" meta="Delivered reports and free samples" className="h-[30rem] xl:col-span-6">
          <PanelData result={s?.money}>{(m) => <ProductsPanel products={toProducts(m, board)} indexCells={overview?.indexCells ?? null} />}</PanelData>
        </Panel>
        <Panel title="Price vs competitors" meta="What buyers pay today, with sources" className="h-[30rem] xl:col-span-6">
          {market.data ? (
            <PanelData result={market.data}>{(m) => <PricePanel market={m} ours={money ? ourPrices(money) : { n: 0, low: null, median: null, high: null }} />}</PanelData>
          ) : (
            <Quiet>Waiting for the first update.</Quiet>
          )}
        </Panel>
        <Panel title="Data sources and cost" meta="From the agents' decision log" className="xl:col-span-12">
          <SourcesPanel
            spend={money?.spend ?? null}
            sources={s?.decisions.ok ? dataSources(s.decisions.data) : null}
            orders={approvals.data?.orders ?? null}
          />
        </Panel>
      </main>
    </div>
  );
}

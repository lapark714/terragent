"use client";
/**
 * Wordmark, whether the feed is live, and the overview strip: the eight numbers a judge asks about first.
 * Every figure is a count of something that happened (spec §11: count honestly, never inflate).
 */
import type { Money, Overview, Panel } from "@/lib/dashboard/types";
import { count, duration, usd } from "../format";
import { Wordmark } from "../site/Wordmark";
import { useNow } from "../useNow";

function Kpi({ label, value, note, human, accent }: {
  label: string;
  value: React.ReactNode;
  note?: React.ReactNode;
  human?: boolean;
  accent?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 bg-panel px-3.5 py-2.5">
      <dt className="flex items-center gap-1.5 truncate text-xs text-fg-3">
        {human && <span className="size-2 shrink-0 rounded-full border-[1.5px] border-human" aria-hidden />}
        {accent && <span className={`size-2 shrink-0 rounded-full ${accent}`} aria-hidden />}
        {label}
      </dt>
      <dd className="stretch-semi truncate text-[1.35rem] leading-tight font-semibold tabular-nums">{value}</dd>
      {note && <dd className="truncate text-xs text-fg-3">{note}</dd>}
    </div>
  );
}

const pct = (n: number, of: number) => (of > 0 ? `${Math.round((n / of) * 100)}%` : "–");

export function DashboardHeader({ overview, money, offline, updatedAt, error }: {
  overview: Panel<Overview> | undefined;
  money: Panel<Money> | undefined;
  offline: boolean;
  updatedAt: number | null;
  error: string | null;
}) {
  const now = useNow();
  const o = overview?.ok ? overview.data : null;
  const m = money?.ok ? money.data : null;
  const fresh = !error;
  const dash = "–";

  return (
    <header className="flex flex-col gap-2.5 px-2 pt-3">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-2">
        <Wordmark suffix="Mission control" />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          {offline && (
            <span className="rounded-full border border-line-strong px-2.5 py-0.5 text-xs text-fg-2" title="npm run dev:local: demo database, and no Naïve, AgentMail or Monid calls">
              Local demo data · agents, email and Monid are off
            </span>
          )}
          <p className="flex items-center gap-2 text-xs text-fg-2" role="status">
            <span className={`size-2 rounded-full ${fresh ? "beacon bg-forest text-forest" : "bg-alert"}`} aria-hidden />
            {fresh ? "Live" : "Reconnecting"}
            {now && updatedAt && <span className="text-fg-3 tabular-nums">updated {Math.max(0, Math.round((now - updatedAt) / 1000))}s ago</span>}
          </p>
        </div>
      </div>

      <dl className="instrument grid-cols-2 overflow-hidden rounded-lg sm:grid-cols-4 xl:grid-cols-8" aria-label="Overview">
        <Kpi label="Requests today" value={o ? count(o.inboundToday) : dash} note={o && `${count(o.inbound)} all time, ${count(o.active)} in progress`} accent="bg-inbound" />
        <Kpi
          label="Reports delivered"
          value={o ? count(o.reportsDelivered) : dash}
          note={o && `${count(o.verifiedReports)} verified, median answer ${duration(o.medianAnswerSeconds)}`}
        />
        <Kpi label="Free samples" value={o ? count(o.samples) : dash} note={o && `${count(o.samplesToday)} started today`} />
        <Kpi
          label="First touches"
          value={o ? count(o.firstTouches) : dash}
          note={o && (o.touchesHeld ? `${count(o.touchesHeld)} more held back` : "contact forms and email")}
        />
        <Kpi label="Replies" value={o ? count(o.replies) : dash} note={o && `${pct(o.replies, o.firstTouches)} of first touches`} />
        <Kpi
          label="Spend vs revenue"
          value={
            m ? (
              <>
                {usd(m.spend.total)} <span className="text-base font-normal text-fg-3">vs</span> {usd(m.revenue.paid)}
              </>
            ) : (
              dash
            )
          }
          note={m && `paid; ${usd(m.revenue.committed)} committed, ${usd(m.revenue.stated)} stated`}
        />
        <Kpi
          label="Naïve balance"
          value={m?.naiveBalanceUsd !== null && m?.naiveBalanceUsd !== undefined ? usd(m.naiveBalanceUsd) : dash}
          note={offline ? "not called in local mode" : m?.spend.naiveSource === "ledger" ? "live from the Naïve ledger" : "ledger not connected here"}
        />
        <Kpi
          label="Human interventions"
          value={o ? count(o.interventions) : dash}
          note={o && (o.interventions < 10 ? "goal: fewer than 10" : "over the goal of 10")}
          human
        />
      </dl>
    </header>
  );
}

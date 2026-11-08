/**
 * Our price next to what buyers pay today for the same answer, each with its cited source.
 * Ranges sit on one log scale so a $40 report and a $5,000 survey are both readable.
 */
import { dateUtc, usd } from "../../format";
import { PLAYBOOK_BG, PLAYBOOK_LABEL } from "../../palette";
import { Quiet } from "../Panel";
import type { MarketPrices } from "@/lib/dashboard/types";
import { marketByPlaybook } from "./model";

function scale(values: number[]) {
  const lo = Math.max(1, Math.min(...values) / 1.5);
  const hi = Math.max(...values) * 1.5;
  const [a, b] = [Math.log10(lo), Math.log10(hi)];
  return (v: number) => ((Math.log10(Math.max(v, lo)) - a) / (b - a)) * 100;
}

export function PricePanel({ market, ours }: { market: MarketPrices; ours: { n: number; low: number | null; median: number | null; high: number | null } }) {
  const groups = marketByPlaybook(market);
  if (!groups.length) return <Quiet>The market researcher hasn&apos;t saved any cited prices yet. They appear here with their sources.</Quiet>;

  const all = [market.ourFromUsd, ...market.rows.flatMap((r) => [r.low, r.high].filter((x): x is number => x !== null))];
  if (ours.high !== null) all.push(ours.high);
  const x = scale(all);
  const floor = x(market.ourFromUsd);

  return (
    <div className="scroll-quiet flex h-full min-h-0 flex-col gap-3 overflow-y-auto">
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
        <div className="flex items-center gap-2">
          <span className="h-3 w-0.5 bg-fg" aria-hidden />
          <dt className="text-fg-3">Our floor</dt>
          <dd className="tabular-nums">{usd(market.ourFromUsd)}</dd>
        </div>
        {ours.n > 0 && (
          <div className="flex items-center gap-2">
            <dt className="text-fg-3">Our quotes so far</dt>
            <dd className="tabular-nums">
              {usd(ours.low)}–{usd(ours.high)}, median {usd(ours.median)} <span className="text-fg-3">({ours.n})</span>
            </dd>
          </div>
        )}
      </dl>

      {groups.map((g) => (
        <section key={g.playbook} aria-label={PLAYBOOK_LABEL[g.playbook]} className="flex flex-col gap-1.5">
          <h3 className="flex items-center gap-1.5 text-xs text-fg-2">
            <span className={`size-2 rounded-full ${PLAYBOOK_BG[g.playbook]}`} aria-hidden />
            {PLAYBOOK_LABEL[g.playbook]}
          </h3>
          <ul className="flex flex-col gap-2">
            {g.rows.map((r) => {
              const lo = r.low ?? r.high;
              const hi = r.high ?? r.low;
              return (
                <li key={r.id} className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
                  <div className="min-w-0">
                    <p className="truncate text-[13px]" title={r.alternative}>{r.alternative}</p>
                    <p className="truncate text-xs text-fg-3">
                      {lo === hi ? usd(lo) : `${usd(lo)}–${usd(hi)}`} {r.unit}
                      {r.turnaround && <>, {r.turnaround}</>}
                    </p>
                  </div>
                  <div className="flex min-w-0 flex-col justify-center gap-1">
                    <div className="relative h-2.5 rounded-full bg-raised" aria-hidden>
                      {lo !== null && hi !== null && (
                        <span className={`absolute inset-y-0 rounded-full ${PLAYBOOK_BG[g.playbook]} opacity-80`} style={{ left: `${x(lo)}%`, width: `max(0.5rem, ${x(hi) - x(lo)}%)` }} />
                      )}
                      <span className="absolute -inset-y-1 w-0.5 bg-fg" style={{ left: `${floor}%` }} />
                    </div>
                    <p className="truncate text-[11px] text-fg-3">
                      {r.sourceUrl ? (
                        <a href={r.sourceUrl} target="_blank" rel="noreferrer" className="underline decoration-line-strong underline-offset-2 hover:text-fg-2">{r.sourceTitle}</a>
                      ) : (
                        r.sourceTitle
                      )}
                      , read {dateUtc(r.retrievedAt)}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <p className="text-xs text-fg-3">Bars on a log scale. The white line is our floor price for a report from free data.</p>
    </div>
  );
}

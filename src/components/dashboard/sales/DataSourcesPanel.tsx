"use client";
/**
 * Where our answers come from: how often free imagery was enough, a card per source the agents chose (provider, type,
 * resolution, how often, for which playbooks), what else they weighed, and the paid imagery they passed over.
 */
import { ago, clockUtc, count, usd } from "../../format";
import { PLAYBOOK_BG, PLAYBOOK_LABEL } from "../../palette";
import { useNow } from "../../useNow";
import { Quiet } from "../Panel";
import { type dataSources, SOURCE_INFO } from "./model";

function Access({ access }: { access: "free" | "paid" }) {
  return (
    <span className={`rounded px-1.5 py-px text-[10px] font-medium tracking-wide uppercase ${access === "free" ? "bg-forest/15 text-forest" : "bg-mining/20 text-mining"}`}>
      {access}
    </span>
  );
}

function Heading({ children, note }: { children: React.ReactNode; note?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h3 className="text-xs font-medium tracking-wide text-fg-2 uppercase">{children}</h3>
      {note && <span className="text-xs text-fg-3">{note}</span>}
    </div>
  );
}

export function DataSourcesPanel({ sources }: { sources: ReturnType<typeof dataSources> }) {
  const now = useNow();
  const decided = sources.free + sources.paid;
  const freeShare = decided ? sources.free / decided : 0;

  return (
    <div className="scroll-quiet flex h-full min-h-0 flex-col gap-5 overflow-y-auto pr-1">
      <section className="flex flex-col gap-2">
        <Heading note={decided ? `${count(decided)} free-vs-paid calls` : undefined}>Free vs paid imagery</Heading>
        {decided ? (
          <>
            <div className="flex h-3 overflow-hidden rounded-full bg-raised" role="img" aria-label={`Free ${sources.free}, paid ${sources.paid}`}>
              <span className="h-full bg-forest" style={{ width: `${(freeShare * 100).toFixed(2)}%` }} />
              <span className="h-full bg-mining" style={{ width: `${((1 - freeShare) * 100).toFixed(2)}%` }} />
            </div>
            <p className="text-[13px]">
              <span className="font-semibold text-forest tabular-nums">{Math.round(freeShare * 100)}%</span>
              <span className="text-fg-2"> of jobs were answered from free public imagery</span>
              <span className="text-fg-3 tabular-nums"> ({count(sources.free)} free, {count(sources.paid)} paid)</span>
            </p>
          </>
        ) : (
          <Quiet>No free-vs-paid decision yet.</Quiet>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <Heading note="recent decisions">Imagery chosen</Heading>
        {sources.used.length ? (
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {sources.used.map((u) => {
              const info = SOURCE_INFO[u.name];
              return (
                <li key={u.name} className="flex flex-col gap-1.5 rounded-lg border border-line bg-raised/50 px-3.5 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-[13px] font-medium">{u.name}</p>
                    {info && <Access access={info.access} />}
                  </div>
                  {info && <p className="text-xs text-fg-3">{info.provider} · {info.kind} · {info.resolution}</p>}
                  <div className="mt-auto flex items-center justify-between gap-2 pt-1 text-xs">
                    <span className="flex items-center gap-1.5">
                      <span className="stretch-semi text-lg leading-none font-semibold tabular-nums">{count(u.requests)}</span>
                      <span className="text-fg-3">{u.requests === 1 ? "request" : "requests"}</span>
                      <span className="ml-1 flex gap-1">
                        {u.playbooks.map((p) => (
                          <span key={p} className={`size-2 rounded-full ${PLAYBOOK_BG[p]}`} title={PLAYBOOK_LABEL[p]} aria-label={PLAYBOOK_LABEL[p]} />
                        ))}
                      </span>
                    </span>
                    <span className="text-fg-3 tabular-nums">last {now ? `${ago(u.last, now)} ago` : clockUtc(u.last)}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <Quiet>No source chosen in the recent decisions.</Quiet>
        )}
      </section>

      {sources.considered.length > 0 && (
        <section className="flex flex-col gap-2">
          <Heading>Also weighed, not needed</Heading>
          <ul className="flex flex-wrap gap-1.5">
            {sources.considered.map((c) => {
              const info = SOURCE_INFO[c.option];
              return (
                <li key={c.option} className="inline-flex items-center gap-2 rounded-full border border-line-strong px-2.5 py-1 text-xs text-fg-2">
                  {c.option}
                  {info && <span className="text-fg-3">{info.resolution}</span>}
                  <span className="text-fg-3 tabular-nums">×{count(c.times)}</span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <Heading>Paid imagery passed over</Heading>
        {sources.declined.length ? (
          <ul className="flex flex-col gap-2">
            {sources.declined.map((d) => {
              const info = SOURCE_INFO[d.option];
              return (
                <li key={d.option} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 rounded-lg border border-line px-3.5 py-2.5">
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 text-[13px]">
                      <span className="truncate">{d.option}</span>
                      <Access access="paid" />
                    </span>
                    {info && <span className="block truncate text-xs text-fg-3">{info.provider} · {info.resolution}</span>}
                  </span>
                  <span className="text-right">
                    <span className="block text-[13px] tabular-nums">{d.low === d.high ? usd(d.low) : `${usd(d.low)}–${usd(d.high)}`} each</span>
                    <span className="block text-xs text-fg-3 tabular-nums">skipped {count(d.times)}× because free imagery answered</span>
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <Quiet>No paid option was weighed and declined in the recent decisions.</Quiet>
        )}
      </section>
    </div>
  );
}

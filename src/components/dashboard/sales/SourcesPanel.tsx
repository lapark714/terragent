/** Where the data comes from and what it costs: spend by service, imagery the agents chose, and paid options they passed over. */
import type { Money } from "@/lib/dashboard/types";
import { count, usd } from "../../format";
import { Quiet } from "../Panel";
import type { dataSources } from "./model";

function Sub({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h3 className="text-xs text-fg-2">{title}</h3>
      {children}
    </section>
  );
}

export function SourcesPanel({ spend, sources }: { spend: Money["spend"] | null; sources: ReturnType<typeof dataSources> | null }) {
  const services = spend
    ? [
        { label: "Naïve (agents, models, browser)", usd: spend.naive },
        { label: "Monid (business data)", usd: spend.monid },
        { label: "Imagery and data", usd: spend.data },
        { label: "Other", usd: spend.other },
      ]
    : [];
  const maxService = Math.max(0.0001, ...services.map((s) => s.usd));
  const maxUsed = Math.max(1, ...(sources?.used ?? []).map((u) => u.requests));

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
      <Sub title="Spend by service">
        {spend ? (
          <ul className="flex flex-col gap-1.5">
            {services.map((s) => (
              <li key={s.label} className="grid grid-cols-[minmax(0,1fr)_4rem] items-center gap-x-2 text-xs">
                <span className="truncate text-fg-2">{s.label}</span>
                <span className="text-right tabular-nums">{usd(s.usd)}</span>
                <span className="col-span-2 h-1.5 rounded-r-full bg-fg-3" style={{ width: `${(s.usd / maxService) * 100}%` }} aria-hidden />
              </li>
            ))}
          </ul>
        ) : (
          <Quiet>Spend isn&apos;t available right now.</Quiet>
        )}
      </Sub>

      <Sub title="Imagery the agents chose">
        {sources?.used.length ? (
          <>
            <ul className="flex flex-col gap-1.5">
              {sources.used.map((u) => (
                <li key={u.name} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 text-xs">
                  <span className="truncate" title={u.name}>{u.name}</span>
                  <span className="text-fg-2 tabular-nums">{count(u.requests)} {u.requests === 1 ? "request" : "requests"}</span>
                  <span className="col-span-2 h-1.5 rounded-r-full bg-forest" style={{ width: `${(u.requests / maxUsed) * 100}%` }} aria-hidden />
                </li>
              ))}
            </ul>
            <p className="text-xs text-fg-3">
              Free vs paid: free {count(sources.free)}, paid {count(sources.paid)}, all time.
            </p>
          </>
        ) : (
          <Quiet>No data source chosen in the recent decisions.</Quiet>
        )}
      </Sub>

      <Sub title="Paid data considered and passed over">
        {sources?.declined.length ? (
          <ul className="flex flex-col divide-y divide-line text-xs">
            {sources.declined.map((d) => (
              <li key={d.option} className="flex items-baseline justify-between gap-3 py-1.5">
                <span className="min-w-0 truncate" title={d.option}>{d.option}</span>
                <span className="shrink-0 text-fg-2 tabular-nums">
                  {count(d.times)}× · {d.low === d.high ? usd(d.low) : `${usd(d.low)}–${usd(d.high)}`} each
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Quiet>No paid option was weighed and declined in the recent decisions.</Quiet>
        )}
        <p className="text-xs text-fg-3">Each time free imagery answered the question, the agents logged the paid option they didn&apos;t need.</p>
      </Sub>

    </div>
  );
}

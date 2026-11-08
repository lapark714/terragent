/**
 * Where the money goes: spend by service as one proportional bar, what a delivered report costs to make and how much
 * room the price leaves, spend by agent, and the most expensive requests. Shares only, no grand total.
 */
import type { Money } from "@/lib/dashboard/types";
import { actorLabel, count, STATUS_LABEL, usd } from "../../format";
import { PLAYBOOK_BG, PLAYBOOK_LABEL } from "../../palette";
import { costs } from "./model";

const SERVICE_TONE = ["bg-inbound", "bg-mining", "bg-forest", "bg-fg-3"];
const pct = (share: number) => (share > 0 && share < 0.01 ? "<1%" : `${Math.round(share * 100)}%`);

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-medium tracking-wide text-fg-2 uppercase">{title}</h3>
        {note && <span className="text-xs text-fg-3">{note}</span>}
      </div>
      {children}
    </section>
  );
}

export function CostsPanel({ money }: { money: Money }) {
  const c = costs(money);
  const maxAgent = Math.max(0.0001, ...c.agents.map((a) => a.usd));
  const maxReq = Math.max(0.0001, ...c.priciest.map((r) => r.cost));

  return (
    <div className="scroll-quiet grid h-full min-h-0 grid-cols-1 gap-6 overflow-y-auto pr-1 lg:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-6">
        <Section title="By service">
          <div className="flex h-3 overflow-hidden rounded-full bg-raised" role="img" aria-label={c.services.map((s) => `${s.label} ${pct(s.share)}`).join(", ")}>
            {c.services.map((s, i) => s.share > 0 && <span key={s.label} className={`${SERVICE_TONE[i]} h-full`} style={{ width: `${(s.share * 100).toFixed(2)}%` }} />)}
          </div>
          <ul className="flex flex-col divide-y divide-line">
            {c.services.map((s, i) => (
              <li key={s.label} className="grid grid-cols-[auto_minmax(0,1fr)_auto_3rem] items-center gap-x-2.5 py-1.5 text-[13px]">
                <span className={`size-2.5 rounded-sm ${SERVICE_TONE[i]}`} aria-hidden />
                <span className="truncate text-fg-2">{s.label}</span>
                <span className="tabular-nums">{usd(s.usd)}</span>
                <span className="text-right text-xs text-fg-3 tabular-nums">{pct(s.share)}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Cost of a delivered report" note={c.perReport.n ? `${count(c.perReport.n)} delivered recently` : undefined}>
          {c.perReport.median === null ? (
            <p className="text-sm text-fg-3">Nothing delivered yet.</p>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border border-line bg-raised/50 px-3.5 py-3">
                <p className="text-xs text-fg-3">Typical (median)</p>
                <p className="stretch-semi text-2xl font-semibold tabular-nums">{usd(c.perReport.median)}</p>
                <p className="text-xs text-fg-3 tabular-nums">
                  range {usd(c.perReport.low)}–{usd(c.perReport.high)}
                </p>
              </div>
              <div className="rounded-lg border border-line bg-raised/50 px-3.5 py-3">
                <p className="text-xs text-fg-3">Price over cost</p>
                <p className="stretch-semi text-2xl font-semibold tabular-nums">{c.markup === null ? "–" : `${Math.round(c.markup)}×`}</p>
                <p className="text-xs text-fg-3">median on priced customer requests</p>
              </div>
            </div>
          )}
        </Section>
      </div>

      <div className="flex min-w-0 flex-col gap-6">
        <Section title="By agent">
          <ul className="flex flex-col gap-2">
            {c.agents.map((a) => (
              <li key={a.label} className="grid grid-cols-[7.5rem_minmax(0,1fr)_3.75rem_2.75rem] items-center gap-x-2.5 text-[13px]">
                <span className="truncate text-fg-2">{actorLabel(a.label)}</span>
                <span className="h-2 rounded-r-full bg-inbound/70" style={{ width: `${((a.usd / maxAgent) * 100).toFixed(2)}%` }} aria-hidden />
                <span className="text-right tabular-nums">{usd(a.usd)}</span>
                <span className="text-right text-xs text-fg-3 tabular-nums">{pct(a.share)}</span>
              </li>
            ))}
            {!c.agents.length && <li className="text-sm text-fg-3">No agent spend recorded yet.</li>}
          </ul>
        </Section>

        <Section title="Most expensive requests">
          <ul className="flex flex-col gap-2">
            {c.priciest.map((r) => (
              <li key={r.id} className="grid grid-cols-[6.5rem_minmax(0,1fr)_3.75rem] items-center gap-x-2.5 text-[13px]">
                <span className="flex items-center gap-1.5 font-mono text-xs text-fg-2">
                  <span className={`size-2 shrink-0 rounded-full ${PLAYBOOK_BG[r.playbook]}`} title={PLAYBOOK_LABEL[r.playbook]} aria-label={PLAYBOOK_LABEL[r.playbook]} />
                  {r.id}
                </span>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="h-2 shrink-0 rounded-r-full bg-fg-3" style={{ width: `${((r.cost / maxReq) * 60).toFixed(2)}%` }} aria-hidden />
                  <span className="truncate text-xs text-fg-3">{r.sample ? "free sample" : STATUS_LABEL[r.status]}</span>
                </span>
                <span className="text-right tabular-nums">{usd(r.cost)}</span>
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </div>
  );
}

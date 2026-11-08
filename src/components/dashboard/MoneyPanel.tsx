/** Spend vs revenue, overall and per request. Counts only what happened; stated willingness is shown apart from cash. */
import type { Money } from "@/lib/dashboard/types";
import { actorLabel, usd } from "../format";
import { PLAYBOOK_BG, PLAYBOOK_LABEL } from "../palette";

function Figure({ label, value, children }: { label: string; value: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-fg-2">{label}</span>
      <span className="stretch-semi text-2xl font-semibold">{value}</span>
      <span className="text-xs leading-snug text-fg-3">{children}</span>
    </div>
  );
}

export function MoneyPanel({ money: m, offline = false }: { money: Money; offline?: boolean }) {
  const topAgents = m.byAgent.slice(0, 4);
  const maxAgent = Math.max(0.0001, ...topAgents.map((a) => a.usd));
  return (
    <div className="scroll-quiet -mr-2 flex h-full flex-col gap-4 overflow-y-auto pr-2">
      <div className="grid grid-cols-2 gap-4">
        <Figure label="Spent" value={usd(m.spend.total)}>
          Naïve {usd(m.spend.naive)}, Monid {usd(m.spend.monid)}
          {m.spend.data > 0 && <>, data {usd(m.spend.data)}</>}
          {m.naiveBalanceUsd !== null && <>. {usd(m.naiveBalanceUsd)} Naïve credit left</>}
        </Figure>
        <Figure label="Revenue" value={usd(m.revenue.paid)}>
          {m.revenue.paidCount} paid
          {m.revenue.committed > 0 && <>, {usd(m.revenue.committed)} committed</>}
          {m.revenue.stated > 0 && <>, {usd(m.revenue.stated)} stated willingness to pay</>}
        </Figure>
      </div>

      {topAgents.length > 0 && (
        <ul className="flex flex-col gap-1.5" aria-label="Spend by agent">
          {topAgents.map((a) => (
            <li key={a.agent} className="grid grid-cols-[7.5rem_1fr_3.5rem] items-center gap-2 text-xs">
              <span className="truncate text-fg-2">{actorLabel(a.agent)}</span>
              <span className="h-1.5 rounded-r-full bg-fg-3" style={{ width: `${(a.usd / maxAgent) * 100}%` }} />
              <span className="text-right text-fg-2 tabular-nums">{usd(a.usd)}</span>
            </li>
          ))}
        </ul>
      )}

      <table className="w-full text-xs">
        <caption className="mb-1.5 text-left text-fg-2">Cost and price per request</caption>
        <thead className="text-fg-3">
          <tr>
            <th scope="col" className="pb-1 text-left font-normal">Request</th>
            <th scope="col" className="pb-1 text-right font-normal">Cost</th>
            <th scope="col" className="pb-1 text-right font-normal">Price</th>
            <th scope="col" className="pb-1 text-right font-normal">Paid</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {m.perRequest.map((r) => (
            <tr key={r.id}>
              <th scope="row" className="py-1 text-left font-normal">
                <span className="flex items-center gap-1.5 font-mono text-fg-2">
                  <span className={`size-2 rounded-full ${PLAYBOOK_BG[r.playbook]}`} aria-label={PLAYBOOK_LABEL[r.playbook]} />
                  {r.id}
                  {r.sample && <span className="font-sans text-fg-3">sample</span>}
                </span>
              </th>
              <td className="py-1 text-right tabular-nums">{usd(r.cost)}</td>
              <td className="py-1 text-right tabular-nums text-fg-2">{r.sample ? "free" : usd(r.price)}</td>
              <td className="py-1 text-right tabular-nums text-fg-2">{r.paid ? usd(r.paid) : "–"}</td>
            </tr>
          ))}
          {!m.perRequest.length && (
            <tr>
              <td colSpan={4} className="py-2 text-fg-3">No requests yet.</td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="text-xs text-fg-3">
        {m.spend.naiveSource === "ledger"
          ? "Naïve spend from the live Naïve ledger."
          : offline
            ? "Local demo mode: Naïve spend from the demo rows; the live ledger isn't called."
            : "Naïve spend from recorded rows; the live ledger isn't connected here."}
      </p>
    </div>
  );
}

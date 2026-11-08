/** Conversion by event type: for each signal feed, how many businesses it produced and how far outreach got, with totals. */
import { count } from "../../format";
import { PLAYBOOK_BG, PLAYBOOK_LABEL } from "../../palette";
import { Quiet } from "../Panel";
import { type FeedConversion, rate, totalConversion } from "./outreach";
import { feedLabel } from "./signals";

const COLS = [
  { key: "signals", label: "Signals" },
  { key: "matched", label: "Businesses matched" },
  { key: "reached", label: "Reached" },
  { key: "replied", label: "Replied" },
  { key: "quoted", label: "Quoted" },
  { key: "paid", label: "Paid" },
] as const;

export function EventConversionPanel({ rows }: { rows: FeedConversion[] }) {
  if (!rows.length) return <Quiet>No signals yet, so nothing to convert.</Quiet>;
  const total = totalConversion(rows);
  const ranked = rows.filter((r) => r.reached > 0).sort((a, b) => b.replied / b.reached - a.replied / a.reached || b.replied - a.replied);
  const best = ranked[0];

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="scroll-quiet min-h-0 flex-1 overflow-auto">
        <table className="w-full min-w-[46rem] text-[13px]">
          <thead className="sticky top-0 bg-panel text-xs text-fg-3">
            <tr className="border-b border-line">
              <th scope="col" className="py-1.5 pr-3 text-left font-normal">Event type</th>
              {COLS.map((c) => (
                <th key={c.key} scope="col" className="py-1.5 pl-2 text-right font-normal">{c.label}</th>
              ))}
              <th scope="col" className="py-1.5 pl-3 text-right font-normal">Reply rate</th>
              <th scope="col" className="py-1.5 pl-3 text-right font-normal">Signal to paid</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={`${r.feed}|${r.playbook}`}>
                <th scope="row" className="py-1.5 pr-3 text-left font-normal">
                  <span className="flex items-center gap-1.5">
                    <span className={`size-2 shrink-0 rounded-full ${PLAYBOOK_BG[r.playbook]}`} title={PLAYBOOK_LABEL[r.playbook]} aria-label={PLAYBOOK_LABEL[r.playbook]} />
                    <span className="truncate">{feedLabel(r.feed)}</span>
                  </span>
                </th>
                {COLS.map((c) => (
                  <td key={c.key} className={`py-1.5 pl-2 text-right tabular-nums ${c.key === "paid" && r.paid > 0 ? "text-forest" : r[c.key] ? "" : "text-fg-3"}`}>{count(r[c.key])}</td>
                ))}
                <td className={`py-1.5 pl-3 text-right tabular-nums ${best && r === best ? "font-semibold" : "text-fg-2"}`}>{rate(r.replied, r.reached)}</td>
                <td className="py-1.5 pl-3 text-right tabular-nums text-fg-2">{rate(r.paid, r.signals)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="sticky bottom-0 border-t border-line-strong bg-panel">
            <tr>
              <th scope="row" className="py-2 pr-3 text-left font-semibold">All event types</th>
              {COLS.map((c) => (
                <td key={c.key} className="py-2 pl-2 text-right font-semibold tabular-nums">{count(total[c.key])}</td>
              ))}
              <td className="py-2 pl-3 text-right font-semibold tabular-nums">{rate(total.replied, total.reached)}</td>
              <td className="py-2 pl-3 text-right font-semibold tabular-nums">{rate(total.paid, total.signals)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="text-xs text-fg-3">
        Reply rate is replies per business reached. {best && <>{feedLabel(best.feed)} converts best so far ({count(best.replied)} of {count(best.reached)} replied).</>}
        {total.optedOut > 0 && <> {count(total.optedOut)} opted out.</>}
      </p>
    </div>
  );
}

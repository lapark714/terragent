/** What we have actually delivered: answers to paying customers and free samples, with cost to make and money back. */
import { count, usd } from "../../format";
import { PLAYBOOK_BG, PLAYBOOK_LABEL } from "../../palette";
import { Quiet } from "../Panel";
import { median, type Product } from "./model";

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs text-fg-3">{label}</span>
      <span className="stretch-semi text-xl font-semibold tabular-nums">{value}</span>
      {note && <span className="truncate text-xs text-fg-3">{note}</span>}
    </div>
  );
}

export function ProductsPanel({ products, indexCells }: { products: Product[]; indexCells: number | null }) {
  if (!products.length) return <Quiet>Nothing delivered yet. Delivered reports and free samples appear here with what each cost to make.</Quiet>;
  const paidOnes = products.filter((p) => p.paid > 0);
  const samples = products.filter((p) => p.sample).length;
  const collected = paidOnes.reduce((s, p) => s + p.paid, 0);
  const costOfPaid = paidOnes.reduce((s, p) => s + p.cost, 0);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <Stat label="Delivered" value={count(products.length)} note={`${count(products.length - samples)} to customers, ${count(samples)} free samples`} />
        <Stat label="Median cost to make" value={usd(median(products.map((p) => p.cost)))} note="agents and data, per report" />
        <Stat label="Collected" value={usd(collected)} note={`from ${count(paidOnes.length)} paid ${paidOnes.length === 1 ? "report" : "reports"}`} />
        <Stat label="Earth index" value={indexCells === null ? "–" : count(indexCells)} note="measured cells we can reuse" />
      </div>
      <div className="scroll-quiet min-h-0 flex-1 overflow-auto">
        <table className="w-full min-w-[32rem] text-[13px]">
          <thead className="sticky top-0 bg-panel text-xs text-fg-3">
            <tr className="border-b border-line">
              <th scope="col" className="py-1.5 pr-3 text-left font-normal">Report</th>
              <th scope="col" className="py-1.5 pr-3 text-left font-normal">For</th>
              <th scope="col" className="py-1.5 pl-2 text-right font-normal">Cost</th>
              <th scope="col" className="py-1.5 pl-2 text-right font-normal">Price</th>
              <th scope="col" className="py-1.5 pl-2 text-right font-normal">Paid</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {products.map((p) => (
              <tr key={p.id} className="align-top">
                <th scope="row" className="max-w-[18rem] py-2 pr-3 text-left font-normal">
                  <span className="flex items-center gap-1.5 font-mono text-xs text-fg-2">
                    <span className={`size-2 shrink-0 rounded-full ${PLAYBOOK_BG[p.playbook]}`} title={PLAYBOOK_LABEL[p.playbook]} aria-label={PLAYBOOK_LABEL[p.playbook]} />
                    {p.id}
                  </span>
                  {p.question && <p className="mt-0.5 line-clamp-1" title={p.question}>{p.question}</p>}
                </th>
                <td className="max-w-[10rem] truncate py-2 pr-3 text-fg-2">{p.sample ? <span className="text-fg-3">Free sample</span> : (p.customer ?? "–")}</td>
                <td className="py-2 pl-2 text-right tabular-nums text-fg-2">{usd(p.cost)}</td>
                <td className="py-2 pl-2 text-right tabular-nums">{p.sample ? <span className="text-fg-3">free</span> : usd(p.price)}</td>
                <td className={`py-2 pl-2 text-right tabular-nums ${p.paid > 0 ? "text-forest" : "text-fg-3"}`}>{p.paid > 0 ? usd(p.paid) : "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {paidOnes.length > 0 && (
        <p className="text-xs text-fg-3">
          Paid reports brought in {usd(collected)} against {usd(costOfPaid)} to make them.
        </p>
      )}
    </div>
  );
}

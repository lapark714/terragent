"use client";
/** What we have delivered: each report or free sample, who it was for, the data it was made from, cost and price, and a (mock) PDF. */
import { usd } from "../../format";
import { PLAYBOOK_BG, PLAYBOOK_LABEL } from "../../palette";
import { Quiet } from "../Panel";
import { downloadMockPdf, wrap } from "./mockPdf";
import type { Product } from "./model";

function download(p: Product) {
  const lines = [
    `Request: ${p.id}  (${PLAYBOOK_LABEL[p.playbook]})`,
    `For: ${p.sample ? "Free sample" : (p.customer ?? "Customer")}`,
    ...(p.location ? [`Location: ${p.location}`] : []),
    "",
    "Question",
    ...wrap(p.question ?? "Not on the board."),
    "",
    "Data sources",
    ...(p.sources.length ? p.sources.map((s) => `- ${s}`) : ["- Not in the recent decision log"]),
    ...(p.paidData === null ? [] : [p.paidData ? "Paid imagery was used." : "Answered from free public imagery."]),
    "",
    `Price: ${p.sample ? "free sample" : usd(p.price)}`,
    "",
    "This file is a mock. The real report (images, measurements, confidence, limitations, sources) is the one sent",
    "to the customer; exporting it as a PDF is not built yet.",
  ];
  downloadMockPdf(`terragent-${p.id}-mock.pdf`, p.question ? "Terragent report" : `Terragent report ${p.id}`, lines);
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" />
    </svg>
  );
}

export function ProductsPanel({ products }: { products: Product[] }) {
  if (!products.length) return <Quiet>Nothing delivered yet. Delivered reports and free samples appear here with the data each was made from.</Quiet>;

  return (
    <div className="scroll-quiet h-full min-h-0 overflow-auto">
      <table className="w-full min-w-[60rem] text-[13px]">
        <thead className="sticky top-0 bg-panel text-xs text-fg-3">
          <tr className="border-b border-line">
            <th scope="col" className="py-1.5 pr-3 text-left font-normal">Report</th>
            <th scope="col" className="py-1.5 pr-3 text-left font-normal">For</th>
            <th scope="col" className="py-1.5 pr-3 text-left font-normal">Data sources</th>
            <th scope="col" className="py-1.5 pl-2 text-right font-normal">Cost</th>
            <th scope="col" className="py-1.5 pl-2 text-right font-normal">Price</th>
            <th scope="col" className="py-1.5 pl-2 text-right font-normal">Paid</th>
            <th scope="col" className="py-1.5 pl-3 text-right font-normal">Report file</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {products.map((p) => (
            <tr key={p.id} className="align-top">
              <th scope="row" className="max-w-[22rem] py-2 pr-3 text-left font-normal">
                <span className="flex items-center gap-1.5 font-mono text-xs text-fg-2">
                  <span className={`size-2 shrink-0 rounded-full ${PLAYBOOK_BG[p.playbook]}`} title={PLAYBOOK_LABEL[p.playbook]} aria-label={PLAYBOOK_LABEL[p.playbook]} />
                  {p.id}
                </span>
                {p.question && <p className="mt-0.5 line-clamp-1" title={p.question}>{p.question}</p>}
              </th>
              <td className="max-w-[11rem] truncate py-2 pr-3 text-fg-2">{p.sample ? <span className="text-fg-3">Free sample</span> : (p.customer ?? "–")}</td>
              <td className="max-w-[16rem] py-2 pr-3">
                {p.sources.length ? (
                  <span className="flex flex-wrap gap-1">
                    {p.sources.map((s) => (
                      <span key={s} className="rounded border border-line-strong px-1.5 py-px text-xs whitespace-nowrap text-fg-2">{s}</span>
                    ))}
                    {p.paidData !== null && <span className={`rounded px-1.5 py-px text-xs ${p.paidData ? "bg-mining/20 text-mining" : "bg-forest/15 text-forest"}`}>{p.paidData ? "Paid data" : "Free data"}</span>}
                  </span>
                ) : (
                  <span className="text-xs text-fg-3">Not in the recent decision log</span>
                )}
              </td>
              <td className="py-2 pl-2 text-right tabular-nums text-fg-2">{usd(p.cost)}</td>
              <td className="py-2 pl-2 text-right tabular-nums">{p.sample ? <span className="text-fg-3">free</span> : usd(p.price)}</td>
              <td className={`py-2 pl-2 text-right tabular-nums ${p.paid > 0 ? "text-forest" : "text-fg-3"}`}>{p.paid > 0 ? usd(p.paid) : "–"}</td>
              <td className="py-2 pl-3 text-right">
                <button
                  type="button"
                  onClick={() => download(p)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-line-strong px-2 py-1 text-xs whitespace-nowrap text-fg-2 transition-colors hover:border-inbound hover:text-fg"
                  title="Downloads a mock PDF; the real export isn't built yet"
                >
                  <DownloadIcon />
                  Download PDF
                  <span className="rounded bg-raised px-1 text-[10px] tracking-wide text-fg-3 uppercase">mock</span>
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

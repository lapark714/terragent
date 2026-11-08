/** Which kinds of signal turn into business: each outbound playbook's signals followed to replies, quotes and payment. */
import type { FunnelStage } from "@/lib/dashboard/types";
import { count } from "../../format";
import { PLAYBOOK_BG, PLAYBOOK_LABEL } from "../../palette";
import { Quiet } from "../Panel";
import { conversion } from "./signals";

const COLS = [
  { key: "signals", label: "Signals" },
  { key: "prospects", label: "Matched" },
  { key: "reports", label: "Samples" },
  { key: "touches", label: "Reached" },
  { key: "replies", label: "Replied" },
  { key: "quotes", label: "Quoted" },
  { key: "paid", label: "Paid" },
] as const;

const pct = (r: number | null) => (r === null ? "–" : `${Math.round(r * 100)}%`);

export function ConversionPanel({ stages }: { stages: FunnelStage[] }) {
  const rows = conversion(stages);
  if (!rows.some((r) => r.signals > 0)) return <Quiet>No signals yet, so nothing to convert.</Quiet>;
  const best = rows.filter((r) => r.replyRate !== null).sort((a, b) => (b.replyRate ?? 0) - (a.replyRate ?? 0) || b.replies - a.replies)[0];

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="scroll-quiet min-h-0 overflow-x-auto">
        <table className="w-full min-w-[34rem] text-[13px]">
          <thead className="text-xs text-fg-3">
            <tr className="border-b border-line">
              <th scope="col" className="py-1.5 pr-3 text-left font-normal">Playbook</th>
              {COLS.map((c) => (
                <th key={c.key} scope="col" className="py-1.5 pl-2 text-right font-normal">{c.label}</th>
              ))}
              <th scope="col" className="py-1.5 pl-3 text-right font-normal">Reply rate</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={r.playbook}>
                <th scope="row" className="py-2 pr-3 text-left font-normal">
                  <span className="flex items-center gap-1.5">
                    <span className={`size-2 rounded-full ${PLAYBOOK_BG[r.playbook]}`} aria-hidden />
                    {PLAYBOOK_LABEL[r.playbook]}
                  </span>
                </th>
                {COLS.map((c) => (
                  <td key={c.key} className={`py-2 pl-2 text-right tabular-nums ${c.key === "paid" && r.paid > 0 ? "text-forest" : r[c.key] ? "" : "text-fg-3"}`}>{count(r[c.key])}</td>
                ))}
                <td className={`py-2 pl-3 text-right tabular-nums ${best && r.playbook === best.playbook ? "font-semibold text-fg" : "text-fg-2"}`}>{pct(r.replyRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {best && (
        <p className="text-xs text-fg-3">
          {PLAYBOOK_LABEL[best.playbook]} signals convert best so far: {pct(best.replyRate)} of businesses reached replied ({count(best.replies)} of {count(best.touches)}).
        </p>
      )}
    </div>
  );
}

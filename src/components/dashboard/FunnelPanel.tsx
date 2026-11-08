/** Signals → paid, by playbook. Bar length is log-scaled so late stages stay visible; numbers carry the magnitude. */
import { PLAYBOOKS, type Playbook } from "@/lib/domain";
import type { FunnelStage, FunnelStageKey } from "@/lib/dashboard/types";
import { count } from "../format";
import { PLAYBOOK_BG, PLAYBOOK_LABEL } from "../palette";

const STAGE_LABEL: Record<FunnelStageKey, string> = {
  signals: "Signals detected",
  prospects: "Businesses matched",
  reports: "Reports verified",
  touches: "First touches sent",
  replies: "Replies",
  quotes: "Quotes",
  paid: "Paid",
};

const outbound = (s: FunnelStage) => s.total - s.byPlaybook.inbound;

function stepRate(s: FunnelStage, prev: FunnelStage | undefined): string {
  if (!prev || outbound(prev) === 0) return "";
  const r = outbound(s) / outbound(prev);
  return r > 0 && r < 0.01 ? "<1%" : `${Math.round(r * 100)}%`;
}

function Bar({ stage, widthPct }: { stage: FunnelStage; widthPct: number }) {
  const parts = PLAYBOOKS.filter((p) => stage.byPlaybook[p] > 0);
  const label = parts.map((p) => `${PLAYBOOK_LABEL[p]} ${stage.byPlaybook[p]}`).join(", ");
  return (
    <div className="flex h-2 gap-[2px]" style={{ width: `${widthPct}%` }} role="img" aria-label={label || "None yet"}>
      {parts.map((p: Playbook) => (
        <span key={p} title={`${PLAYBOOK_LABEL[p]}: ${count(stage.byPlaybook[p])}`} className={`h-full rounded-full ${PLAYBOOK_BG[p]}`} style={{ flexGrow: stage.byPlaybook[p] }} />
      ))}
    </div>
  );
}

export function FunnelPanel({ stages }: { stages: FunnelStage[] }) {
  const max = Math.max(1, ...stages.map((s) => s.total));
  const width = (n: number) => (n === 0 ? 0 : Math.max(3, (Math.log10(n + 1) / Math.log10(max + 1)) * 100));
  return (
    <div className="flex flex-col gap-2">
      <table className="w-full text-sm">
        <thead className="sr-only">
          <tr>
            <th scope="col">Stage</th>
            <th scope="col">Count</th>
            <th scope="col">By playbook</th>
            <th scope="col">Step rate (outbound)</th>
          </tr>
        </thead>
        <tbody>
          {stages.map((s, i) => (
            <tr key={s.key}>
              <th scope="row" className="w-[9.5rem] py-[3px] pr-3 text-left font-normal whitespace-nowrap text-fg-2">{STAGE_LABEL[s.key]}</th>
              <td className="w-14 py-[3px] pr-4 text-right font-semibold tabular-nums">{count(s.total)}</td>
              <td className="py-[3px]">
                <Bar stage={s} widthPct={width(s.total)} />
              </td>
              <td className="w-12 py-[3px] pl-3 text-right text-fg-3 tabular-nums">{stepRate(s, stages[i - 1])}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-fg-3">Bar length on a log scale. Percentages are step-to-step conversion for outbound playbooks.</p>
    </div>
  );
}

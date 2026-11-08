"use client";
/** Every customer request as a deal: what stage the money is at, what we charged, what it cost us, what came in. */
import { useState } from "react";
import { actorLabel, ago, clockUtc, STATUS_LABEL, usd } from "../../format";
import { PLAYBOOK_BG, PLAYBOOK_LABEL } from "../../palette";
import { useNow } from "../../useNow";
import { Quiet } from "../Panel";
import { DEAL_STAGE_LABEL, DEAL_STAGES, type Deal, type DealStage, dealTotals } from "./model";

/** Stage marks: founder holds use the human colour, money owed the alert colour, paid the forest green. */
export const STAGE_STYLE: Record<DealStage, string> = {
  founder: "border-human/70 text-human",
  owed: "border-alert/70 text-alert",
  quoted: "border-inbound/70 text-inbound-hi",
  unpriced: "border-line-strong text-fg-3",
  paid: "border-forest/70 text-forest",
  lost: "border-line text-fg-3",
};

export function StageChip({ stage }: { stage: DealStage }) {
  return <span className={`inline-flex shrink-0 items-center rounded-full border px-2 py-px text-[11px] whitespace-nowrap ${STAGE_STYLE[stage]}`}>{DEAL_STAGE_LABEL[stage]}</span>;
}

export function DealsPanel({ deals }: { deals: Deal[] }) {
  const now = useNow();
  const [filter, setFilter] = useState<DealStage | "all">("all");
  const totals = dealTotals(deals);
  const shown = filter === "all" ? deals : deals.filter((d) => d.stage === filter);

  if (!deals.length) return <Quiet>No customer requests yet. Free samples to prospects are counted under Products made.</Quiet>;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div role="group" aria-label="Filter deals by stage" className="flex flex-wrap gap-1.5">
        <FilterButton active={filter === "all"} onClick={() => setFilter("all")}>
          All
        </FilterButton>
        {DEAL_STAGES.filter((s) => totals.byStage[s].n > 0).map((s) => (
          <FilterButton key={s} active={filter === s} onClick={() => setFilter(s)}>
            {DEAL_STAGE_LABEL[s]} <span className="tabular-nums text-fg-3">{totals.byStage[s].n}</span>
            {totals.byStage[s].value > 0 && <span className="tabular-nums text-fg-2">· {usd(totals.byStage[s].value)}</span>}
          </FilterButton>
        ))}
      </div>

      <div className="scroll-quiet min-h-0 flex-1 overflow-auto">
        <table className="w-full min-w-[56rem] text-[13px]">
          <thead className="sticky top-0 bg-panel text-xs text-fg-3">
            <tr className="border-b border-line">
              <th scope="col" className="py-1.5 pr-3 text-left font-normal">Stage</th>
              <th scope="col" className="py-1.5 pr-3 text-left font-normal">Request</th>
              <th scope="col" className="py-1.5 pr-3 text-left font-normal">Customer</th>
              <th scope="col" className="py-1.5 pr-3 text-left font-normal">What they asked</th>
              <th scope="col" className="py-1.5 pr-3 text-left font-normal">Step, agent</th>
              <th scope="col" className="py-1.5 pl-2 text-right font-normal">Price</th>
              <th scope="col" className="py-1.5 pl-2 text-right font-normal">Cost to make</th>
              <th scope="col" className="py-1.5 pl-2 text-right font-normal">Margin</th>
              <th scope="col" className="py-1.5 pl-2 text-right font-normal">Paid</th>
              <th scope="col" className="py-1.5 pl-3 text-right font-normal">Updated</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {shown.map((d) => (
              <tr key={d.id} className="align-top">
                <td className="py-2 pr-3"><StageChip stage={d.stage} /></td>
                <th scope="row" className="py-2 pr-3 text-left font-normal">
                  <span className="flex items-center gap-1.5 font-mono text-xs text-fg-2">
                    <span className={`size-2 shrink-0 rounded-full ${PLAYBOOK_BG[d.playbook]}`} title={PLAYBOOK_LABEL[d.playbook]} aria-label={PLAYBOOK_LABEL[d.playbook]} />
                    {d.id}
                  </span>
                </th>
                <td className="max-w-[12rem] truncate py-2 pr-3 text-fg-2" title={d.customer ?? undefined}>{d.customer ?? "–"}</td>
                <td className="max-w-[24rem] py-2 pr-3">
                  <p className="line-clamp-1" title={d.question ?? undefined}>{d.question ?? <span className="text-fg-3">Not on the board</span>}</p>
                  {d.location && <p className="truncate text-xs text-fg-3">{d.location}</p>}
                </td>
                <td className="py-2 pr-3 whitespace-nowrap text-fg-2">
                  {STATUS_LABEL[d.status]}
                  {d.owner && d.stage !== "paid" && d.stage !== "lost" && <span className="text-fg-3">, {actorLabel(d.owner)}</span>}
                </td>
                <td className="py-2 pl-2 text-right tabular-nums">{usd(d.price)}</td>
                <td className="py-2 pl-2 text-right tabular-nums text-fg-2">{usd(d.cost)}</td>
                <td className="py-2 pl-2 text-right tabular-nums text-fg-2">{usd(d.margin)}</td>
                <td className={`py-2 pl-2 text-right tabular-nums ${d.paid > 0 ? "text-forest" : "text-fg-3"}`}>{d.paid > 0 ? usd(d.paid) : "–"}</td>
                <td className="py-2 pl-3 text-right text-xs whitespace-nowrap text-fg-3 tabular-nums">{d.updatedAt ? (now ? ago(d.updatedAt, now) : clockUtc(d.updatedAt)) : "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-fg-3">The 25 most recent requests. Cost to make is what the agents and data have cost so far; margin is price minus that.</p>
    </div>
  );
}

function FilterButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${active ? "border-inbound bg-inbound/15 text-fg" : "border-line-strong text-fg-2 hover:border-fg-3 hover:text-fg"}`}
    >
      {children}
    </button>
  );
}

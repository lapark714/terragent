"use client";
/**
 * Every customer request as a deal, in four sections: outreach pending and in negotiation (what it will cost us and
 * what we quoted), then pending fulfillment and completed (where the data came from, and revenue against cost).
 * A fifth tab lists cold outreach: businesses the agents matched to a signal and contacted, or are about to.
 */
import { useState } from "react";
import { actorLabel, ago, clockUtc, count, STATUS_LABEL, usd } from "../../format";
import { PLAYBOOK_BG, PLAYBOOK_LABEL } from "../../palette";
import { useNow } from "../../useNow";
import { Quiet } from "../Panel";
import { CHANNEL_LABEL, outreachStatus, OUTREACH_GROUPS, type SignalWithProspects, statusTone } from "../signals/outreach";
import { feedLabel, UrgencyTag } from "../signals/signals";
import { byStage, type Deal, DEAL_STAGE_LABEL, DEAL_STAGES, type DealStage } from "./model";

type Tab = DealStage | "cold";
const TABS: Tab[] = [...DEAL_STAGES, "cold"];
const TAB_LABEL: Record<Tab, string> = { ...DEAL_STAGE_LABEL, cold: "Cold outreach" };

/** One row per business contacted (or about to be) from a signal: responders first, then newest. */
export function coldOutreach(signals: SignalWithProspects[]) {
  const rows = signals.flatMap((s) => s.prospects.map((p) => ({ p, s })));
  const rank = (status: string) => OUTREACH_GROUPS.indexOf(outreachStatus(status).group);
  return rows.sort((a, b) => rank(a.p.status) - rank(b.p.status) || b.p.updatedAt.localeCompare(a.p.updatedAt));
}

const EMPTY: Record<DealStage, string> = {
  outreach: "No requests waiting on a quote.",
  negotiation: "No quotes out with customers.",
  fulfillment: "Nothing being fulfilled right now.",
  completed: "Nothing delivered yet.",
};

const th = "py-1.5 font-normal";
const td = "py-2 align-top";

export function DealsPanel({ deals, outreach }: { deals: Deal[]; outreach: SignalWithProspects[] | null }) {
  const now = useNow();
  const groups = byStage(deals);
  const cold = outreach ? coldOutreach(outreach) : null;
  const [stage, setStage] = useState<Tab>(() => DEAL_STAGES.find((s) => groups[s].length) ?? "outreach");
  const rows = stage === "cold" ? [] : groups[stage];
  const size = (t: Tab) => (t === "cold" ? (cold?.length ?? 0) : groups[t].length);
  const pre = stage === "outreach" || stage === "negotiation";
  const when = (d: Deal) => (d.updatedAt ? (now ? ago(d.updatedAt, now) : clockUtc(d.updatedAt)) : "–");


  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div role="tablist" aria-label="Deal stage" className="flex flex-wrap gap-1 rounded-lg border border-line-strong p-1 self-start">
        {TABS.map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={stage === s}
            onClick={() => setStage(s)}
            className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-[13px] transition-colors ${stage === s ? "bg-raised text-fg" : "text-fg-2 hover:text-fg"}`}
          >
            {TAB_LABEL[s]}
            <span className={`rounded-full px-1.5 text-xs tabular-nums ${stage === s ? "bg-inbound/25 text-fg" : "bg-raised text-fg-3"}`}>{count(size(s))}</span>
          </button>
        ))}
      </div>

      <div role="tabpanel" aria-label={TAB_LABEL[stage]} className="scroll-quiet min-h-0 flex-1 overflow-auto">
        {stage === "cold" ? (
          <ColdOutreachTable rows={cold} />
        ) : !rows.length ? (
          <Quiet>{EMPTY[stage]}</Quiet>
        ) : (
          <table className="w-full min-w-[56rem] text-[13px]">
            <thead className="sticky top-0 bg-panel text-xs text-fg-3">
              <tr className="border-b border-line">
                <th scope="col" className={`${th} pr-3 text-left`}>Request</th>
                <th scope="col" className={`${th} pr-3 text-left`}>Customer</th>
                <th scope="col" className={`${th} pr-3 text-left`}>What they asked</th>
                {pre ? (
                  <>
                    <th scope="col" className={`${th} pr-3 text-left`}>Step, agent</th>
                    <th scope="col" className={`${th} pl-2 text-right`}>Cost to us</th>
                    <th scope="col" className={`${th} pl-2 text-right`}>Quote to customer</th>
                  </>
                ) : (
                  <>
                    <th scope="col" className={`${th} pr-3 text-left`}>Data sources</th>
                    <th scope="col" className={`${th} pl-2 text-right`}>Revenue</th>
                    <th scope="col" className={`${th} pl-2 text-right`}>Cost</th>
                    <th scope="col" className={`${th} pl-2 text-right`}>Profit</th>
                  </>
                )}
                <th scope="col" className={`${th} pl-3 text-right`}>Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((d) => (
                <tr key={d.id}>
                  <th scope="row" className={`${td} pr-3 text-left font-normal`}>
                    <span className="flex items-center gap-1.5 font-mono text-xs text-fg-2">
                      <span className={`size-2 shrink-0 rounded-full ${PLAYBOOK_BG[d.playbook]}`} title={PLAYBOOK_LABEL[d.playbook]} aria-label={PLAYBOOK_LABEL[d.playbook]} />
                      {d.id}
                    </span>
                  </th>
                  <td className={`${td} max-w-[12rem] truncate pr-3 text-fg-2`} title={d.customer ?? undefined}>{d.customer ?? "–"}</td>
                  <td className={`${td} max-w-[22rem] pr-3`}>
                    <p className="line-clamp-1" title={d.question ?? undefined}>{d.question ?? <span className="text-fg-3">Not on the board</span>}</p>
                    {d.location && <p className="truncate text-xs text-fg-3">{d.location}</p>}
                  </td>
                  {pre ? (
                    <>
                      <td className={`${td} pr-3 whitespace-nowrap text-fg-2`}>
                        {STATUS_LABEL[d.status]}
                        {d.owner && <span className="text-fg-3">, {actorLabel(d.owner)}</span>}
                      </td>
                      <td className={`${td} pl-2 text-right tabular-nums text-fg-2`}>{usd(d.cost)}</td>
                      <td className={`${td} pl-2 text-right tabular-nums`}>{d.price === null ? <span className="text-fg-3">Not priced yet</span> : usd(d.price)}</td>
                    </>
                  ) : (
                    <>
                      <td className={`${td} max-w-[16rem] pr-3`}>
                        {d.sources.length ? (
                          <span className="flex flex-wrap gap-1">
                            {d.sources.map((src) => (
                              <span key={src} className="rounded border border-line-strong px-1.5 py-px text-xs whitespace-nowrap text-fg-2">{src}</span>
                            ))}
                            {d.paidData !== null && <span className={`rounded px-1.5 py-px text-xs ${d.paidData ? "bg-mining/20 text-mining" : "bg-forest/15 text-forest"}`}>{d.paidData ? "Paid data" : "Free data"}</span>}
                          </span>
                        ) : (
                          <span className="text-xs text-fg-3">Not in the recent decision log</span>
                        )}
                      </td>
                      <td className={`${td} pl-2 text-right tabular-nums`}>
                        {usd(d.price)}
                        {d.price !== null && (
                          <span className={`block text-xs ${d.paid >= d.price ? "text-forest" : stage === "completed" ? "text-alert" : "text-fg-3"}`}>
                            {d.paid >= d.price ? "paid" : stage === "completed" ? "owed" : "on delivery"}
                          </span>
                        )}
                      </td>
                      <td className={`${td} pl-2 text-right tabular-nums text-fg-2`}>{usd(d.cost)}</td>
                      <td className={`${td} pl-2 text-right tabular-nums ${d.profit !== null && d.profit > 0 ? "" : "text-fg-3"}`}>{usd(d.profit)}</td>
                    </>
                  )}
                  <td className={`${td} pl-3 text-right text-xs whitespace-nowrap text-fg-3 tabular-nums`}>{when(d)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="text-xs text-fg-3">
        {stage === "cold"
          ? "Businesses the sourcing agent matched to a signal. Each gets one free sample report and one first touch, with an opt-out."
          : pre
          ? "Cost to us is what the agents and data have cost on this request so far; the quote is what the pricing agent set."
          : "Revenue is the quoted price; cost is what the agents and data cost to fulfil it; profit is the difference."}
      </p>
    </div>
  );
}

function ColdOutreachTable({ rows }: { rows: ReturnType<typeof coldOutreach> | null }) {
  const now = useNow();
  if (rows === null) return <Quiet>Cold outreach appears here once the prospects feed is connected.</Quiet>;
  if (!rows.length) return <Quiet>No businesses matched to a signal yet.</Quiet>;
  return (
    <table className="w-full min-w-[60rem] text-[13px]">
      <thead className="sticky top-0 bg-panel text-xs text-fg-3">
        <tr className="border-b border-line">
          <th scope="col" className={`${th} pr-3 text-left`}>Business</th>
          <th scope="col" className={`${th} pr-3 text-left`}>From signal</th>
          <th scope="col" className={`${th} pr-3 text-left`}>Channel</th>
          <th scope="col" className={`${th} pl-2 text-right`}>Fit</th>
          <th scope="col" className={`${th} pl-3 text-left`}>Status</th>
          <th scope="col" className={`${th} pl-3 text-right`}>Updated</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-line">
        {rows.map(({ p, s }) => (
          <tr key={p.id}>
            <th scope="row" className={`${td} max-w-[18rem] pr-3 text-left font-normal`}>
              <p className="truncate">
                {p.company}
                {p.domain && <span className="text-fg-3"> · {p.domain}</span>}
              </p>
              {(p.asset || p.role) && <p className="truncate text-xs text-fg-3">{[p.asset, p.role].filter(Boolean).join(" · ")}</p>}
            </th>
            <td className={`${td} max-w-[22rem] pr-3`}>
              <p className="flex items-center gap-1.5">
                <span className={`size-2 shrink-0 rounded-full ${PLAYBOOK_BG[s.playbook]}`} title={PLAYBOOK_LABEL[s.playbook]} aria-label={PLAYBOOK_LABEL[s.playbook]} />
                <span className="line-clamp-1" title={s.title}>{s.title}</span>
              </p>
              <p className="flex items-center gap-1.5 text-xs text-fg-3">
                <UrgencyTag feed={s.feed} />
                <span className="truncate">{feedLabel(s.feed)}</span>
              </p>
            </td>
            <td className={`${td} pr-3 whitespace-nowrap text-fg-2`}>{p.channel ? (CHANNEL_LABEL[p.channel] ?? p.channel) : "–"}</td>
            <td className={`${td} pl-2 text-right tabular-nums text-fg-2`}>{p.score === null ? "–" : Math.round(p.score * 100)}</td>
            <td className={`${td} pl-3`}>
              <span className={`inline-flex items-center rounded-full border px-2 py-px text-[11px] whitespace-nowrap ${statusTone(p.status)}`}>{outreachStatus(p.status).label}</span>
            </td>
            <td className={`${td} pl-3 text-right text-xs whitespace-nowrap text-fg-3 tabular-nums`}>{p.updatedAt ? (now ? ago(p.updatedAt, now) : clockUtc(p.updatedAt)) : "–"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

"use client";
/**
 * Latest signals, each opening to the businesses the sourcing agent matched to it and where outreach to each stands.
 * Filter by urgency (urgent events vs slow-moving ones) and by layer. Falls back to the plain signal list (from the
 * globe feed) while the prospects endpoint isn't available.
 */
import { useState } from "react";
import type { Layer } from "@/lib/domain";
import type { GlobeSignal } from "@/lib/dashboard/types";
import { ago, clockUtc, count } from "../../format";
import { LAYER_LABEL } from "../../palette";
import { useNow } from "../../useNow";
import { Quiet } from "../Panel";
import { CHANNEL_LABEL, countGroups, outreachStatus, type SignalWithProspects, sortProspects, statusTone } from "./outreach";
import { feedLabel, LAYER_BG, SIGNAL_LAYERS, type Urgency, URGENCY_LABEL, urgencyOf, UrgencyTag } from "./signals";

type Row = Pick<SignalWithProspects, "id" | "layer" | "feed" | "title" | "severity" | "at"> & { prospects: SignalWithProspects["prospects"] | null };

function Chevron({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}

export function SignalOutreachPanel({ signals, fallback }: { signals: SignalWithProspects[] | null; fallback: GlobeSignal[] | null }) {
  const now = useNow();
  const [layer, setLayer] = useState<Layer | "all">("all");
  const [urgency, setUrgency] = useState<Urgency | "all">("all");
  const [open, setOpen] = useState<Set<string>>(new Set());

  const rows: Row[] = signals ?? (fallback ?? []).map((s) => ({ ...s, prospects: null }));
  if (!rows.length) return <Quiet>No signals yet. The sourcing agent polls disaster, forest and mining feeds on a schedule.</Quiet>;

  const shown = [...rows]
    .sort((a, b) => b.at.localeCompare(a.at))
    .filter((s) => (layer === "all" || s.layer === layer) && (urgency === "all" || urgencyOf(s.feed) === urgency));
  const present = SIGNAL_LAYERS.filter((l) => rows.some((s) => s.layer === l));
  const toggle = (id: string) =>
    setOpen((o) => {
      const next = new Set(o);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div role="group" aria-label="Filter signals by urgency" className="flex flex-wrap gap-1.5">
          {(["all", "urgent", "slow"] as const).map((u) => (
            <Chip key={u} active={urgency === u} onClick={() => setUrgency(u)}>
              {u === "all" ? "Any urgency" : URGENCY_LABEL[u]}
            </Chip>
          ))}
        </div>
        <div role="group" aria-label="Filter signals by layer" className="flex flex-wrap gap-1.5">
          <Chip active={layer === "all"} onClick={() => setLayer("all")}>Every layer</Chip>
          {present.map((l) => (
            <Chip key={l} active={layer === l} onClick={() => setLayer(l)}>
              <span className={`size-2 rounded-full ${LAYER_BG[l]}`} aria-hidden />
              {LAYER_LABEL[l]}
            </Chip>
          ))}
        </div>
      </div>
      {signals === null && <Quiet>Matched businesses appear under each signal once the prospects feed is connected.</Quiet>}

      <ul className="scroll-quiet min-h-0 flex-1 divide-y divide-line overflow-y-auto pr-1">
        {shown.map((s) => {
          const expanded = open.has(s.id);
          const n = s.prospects?.length ?? 0;
          const g = s.prospects ? countGroups(s.prospects) : null;
          return (
            <li key={s.id} className="py-2">
              <div className="flex items-start gap-3">
                <span className={`mt-1.5 size-2 shrink-0 rounded-full ${LAYER_BG[s.layer]}`} title={LAYER_LABEL[s.layer]} aria-label={LAYER_LABEL[s.layer]} />
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-1 text-[13px]" title={s.title}>{s.title}</p>
                  <p className="flex min-w-0 items-center gap-1.5 text-xs text-fg-3">
                    <UrgencyTag feed={s.feed} />
                    <span className="truncate">
                      {feedLabel(s.feed)}
                      {s.severity && <span className="text-fg-2"> · {s.severity}</span>}
                    </span>
                  </p>
                </div>
                <span className="shrink-0 pt-0.5 text-xs text-fg-3 tabular-nums">{now ? ago(s.at, now) : clockUtc(s.at)}</span>
              </div>

              {g && (
                <div className="mt-1.5 ml-5">
                  {n === 0 ? (
                    <p className="text-xs text-fg-3">No businesses matched yet</p>
                  ) : (
                    <button
                      type="button"
                      onClick={() => toggle(s.id)}
                      aria-expanded={expanded}
                      aria-controls={`biz-${s.id}`}
                      className={`inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-xs transition-colors ${expanded ? "border-inbound bg-inbound/10 text-fg" : "border-line-strong text-fg-2 hover:border-fg-3 hover:text-fg"}`}
                    >
                      <Chevron open={expanded} />
                      <span>
                        {expanded ? "Hide" : "Show"} {count(n)} {n === 1 ? "business" : "businesses"}
                      </span>
                      {g.reached + g.responded > 0 && <span className="text-inbound-hi tabular-nums">{count(g.reached + g.responded)} reached</span>}
                      {g.responded > 0 && <span className="text-forest tabular-nums">{count(g.responded)} replied</span>}
                      {g.pending > 0 && <span className="text-fg-3 tabular-nums">{count(g.pending)} not reached yet</span>}
                    </button>
                  )}
                  {expanded && s.prospects && (
                    <ul id={`biz-${s.id}`} className="mt-1.5 flex flex-col gap-1 border-l border-line pl-3">
                      {sortProspects(s.prospects).map((p) => (
                        <li key={p.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 rounded-md bg-raised/60 px-2.5 py-1.5">
                          <span className="min-w-0">
                            <span className="block truncate text-[13px]">
                              {p.company}
                              {p.domain && <span className="text-fg-3"> · {p.domain}</span>}
                            </span>
                            <span className="block truncate text-xs text-fg-3">
                              {[p.asset, p.role, p.channel && (CHANNEL_LABEL[p.channel] ?? p.channel), p.score !== null && `fit ${Math.round(p.score * 100)}`].filter(Boolean).join(" · ")}
                            </span>
                          </span>
                          <span className={`mt-0.5 inline-flex items-center rounded-full border px-2 py-px text-[11px] whitespace-nowrap ${statusTone(p.status)}`}>{outreachStatus(p.status).label}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          );
        })}
        {!shown.length && <li className="py-3 text-sm text-fg-3">No signals match these filters.</li>}
      </ul>
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
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

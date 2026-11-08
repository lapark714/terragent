"use client";
/**
 * Latest signals, each opening to the businesses the sourcing agent matched to it and where outreach to each stands.
 * Falls back to the plain signal list (from the globe feed) while the prospects endpoint isn't available.
 */
import { useState } from "react";
import type { Layer } from "@/lib/domain";
import type { GlobeSignal } from "@/lib/dashboard/types";
import { ago, clockUtc, count } from "../../format";
import { LAYER_LABEL } from "../../palette";
import { useNow } from "../../useNow";
import { Quiet } from "../Panel";
import { CHANNEL_LABEL, countGroups, outreachStatus, type SignalWithProspects, sortProspects, statusTone } from "./outreach";
import { feedLabel, LAYER_BG, SIGNAL_LAYERS } from "./signals";

type Row = Pick<SignalWithProspects, "id" | "layer" | "feed" | "title" | "severity" | "at"> & { prospects: SignalWithProspects["prospects"] | null };

export function SignalOutreachPanel({ signals, fallback }: { signals: SignalWithProspects[] | null; fallback: GlobeSignal[] | null }) {
  const now = useNow();
  const [layer, setLayer] = useState<Layer | "all">("all");
  const [open, setOpen] = useState<Set<string>>(new Set());

  const rows: Row[] = signals ?? (fallback ?? []).map((s) => ({ ...s, prospects: null }));
  if (!rows.length) return <Quiet>No signals yet. The sourcing agent polls disaster, forest and mining feeds on a schedule.</Quiet>;

  const sorted = [...rows].sort((a, b) => b.at.localeCompare(a.at));
  const shown = layer === "all" ? sorted : sorted.filter((s) => s.layer === layer);
  const counts = Object.fromEntries(SIGNAL_LAYERS.map((l) => [l, rows.filter((s) => s.layer === l).length])) as Record<Layer, number>;
  const toggle = (id: string) =>
    setOpen((o) => {
      const next = new Set(o);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div role="group" aria-label="Filter signals by layer" className="flex flex-wrap gap-1.5">
        <Chip active={layer === "all"} onClick={() => setLayer("all")}>
          All <span className="tabular-nums text-fg-3">{rows.length}</span>
        </Chip>
        {SIGNAL_LAYERS.filter((l) => counts[l] > 0).map((l) => (
          <Chip key={l} active={layer === l} onClick={() => setLayer(l)}>
            <span className={`size-2 rounded-full ${LAYER_BG[l]}`} aria-hidden />
            {LAYER_LABEL[l]} <span className="tabular-nums text-fg-3">{counts[l]}</span>
          </Chip>
        ))}
      </div>
      {signals === null && <Quiet>Matched businesses appear under each signal once the prospects feed is connected.</Quiet>}

      <ul className="scroll-quiet min-h-0 flex-1 divide-y divide-line overflow-y-auto pr-1">
        {shown.map((s) => {
          const expanded = open.has(s.id);
          const g = s.prospects ? countGroups(s.prospects) : null;
          const n = s.prospects?.length ?? 0;
          return (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => n && toggle(s.id)}
                aria-expanded={n ? expanded : undefined}
                disabled={!n}
                className="flex w-full items-start gap-3 py-2 text-left enabled:cursor-pointer enabled:hover:bg-raised/50"
              >
                <span className={`mt-1.5 size-2 shrink-0 rounded-full ${LAYER_BG[s.layer]}`} title={LAYER_LABEL[s.layer]} aria-label={LAYER_LABEL[s.layer]} />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-1 block text-[13px]" title={s.title}>{s.title}</span>
                  <span className="block truncate text-xs text-fg-3">
                    {feedLabel(s.feed)}
                    {s.severity && <span className="text-fg-2"> · {s.severity}</span>}
                  </span>
                </span>
                {g && (
                  <span className="flex shrink-0 items-center gap-1.5 pt-0.5 text-xs tabular-nums">
                    {n === 0 ? (
                      <span className="text-fg-3">No businesses matched</span>
                    ) : (
                      <>
                        <span className="text-fg-2">{count(n)} matched</span>
                        {g.reached + g.responded > 0 && <span className="text-inbound-hi">· {count(g.reached + g.responded)} reached</span>}
                        {g.responded > 0 && <span className="text-forest">· {count(g.responded)} replied</span>}
                      </>
                    )}
                  </span>
                )}
                <span className="w-8 shrink-0 pt-0.5 text-right text-xs text-fg-3 tabular-nums">{now ? ago(s.at, now) : clockUtc(s.at)}</span>
                <span aria-hidden className={`w-3 shrink-0 pt-0.5 text-xs text-fg-3 transition-transform ${n ? "" : "invisible"} ${expanded ? "rotate-90" : ""}`}>›</span>
              </button>
              {expanded && s.prospects && (
                <ul className="mb-2 ml-5 flex flex-col gap-1 border-l border-line pl-3">
                  {sortProspects(s.prospects).map((p) => (
                    <li key={p.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-0.5 rounded-md bg-raised/60 px-2.5 py-1.5">
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
            </li>
          );
        })}
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

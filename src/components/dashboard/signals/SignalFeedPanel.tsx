"use client";
/** The latest signals the sourcing agent picked up: what happened, where, from which feed, how severe. Filter by layer. */
import { useState } from "react";
import type { Layer } from "@/lib/domain";
import type { GlobeSignal } from "@/lib/dashboard/types";
import { ago, clockUtc } from "../../format";
import { LAYER_LABEL } from "../../palette";
import { useNow } from "../../useNow";
import { Quiet } from "../Panel";
import { feedLabel, LAYER_BG, SIGNAL_LAYERS } from "./signals";

export function SignalFeedPanel({ signals }: { signals: GlobeSignal[] }) {
  const now = useNow();
  const [layer, setLayer] = useState<Layer | "all">("all");
  if (!signals.length) return <Quiet>No signals yet. The sourcing agent polls disaster, forest and mining feeds on a schedule.</Quiet>;

  const sorted = [...signals].sort((a, b) => b.at.localeCompare(a.at));
  const shown = layer === "all" ? sorted : sorted.filter((s) => s.layer === layer);
  const counts = Object.fromEntries(SIGNAL_LAYERS.map((l) => [l, signals.filter((s) => s.layer === l).length])) as Record<Layer, number>;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div role="group" aria-label="Filter signals by layer" className="flex flex-wrap gap-1.5">
        <Chip active={layer === "all"} onClick={() => setLayer("all")}>
          All <span className="tabular-nums text-fg-3">{signals.length}</span>
        </Chip>
        {SIGNAL_LAYERS.filter((l) => counts[l] > 0).map((l) => (
          <Chip key={l} active={layer === l} onClick={() => setLayer(l)}>
            <span className={`size-2 rounded-full ${LAYER_BG[l]}`} aria-hidden />
            {LAYER_LABEL[l]} <span className="tabular-nums text-fg-3">{counts[l]}</span>
          </Chip>
        ))}
      </div>
      <ul className="scroll-quiet min-h-0 flex-1 divide-y divide-line overflow-y-auto">
        {shown.map((s) => (
          <li key={s.id} className="flex items-start gap-3 py-2">
            <span className={`mt-1.5 size-2 shrink-0 rounded-full ${LAYER_BG[s.layer]}`} title={LAYER_LABEL[s.layer]} aria-label={LAYER_LABEL[s.layer]} />
            <div className="min-w-0 flex-1">
              <p className="line-clamp-1 text-[13px]" title={s.title}>{s.title}</p>
              <p className="truncate text-xs text-fg-3">
                {feedLabel(s.feed)}
                {s.severity && <span className="text-fg-2"> · {s.severity}</span>}
              </p>
            </div>
            <span className="shrink-0 text-xs text-fg-3 tabular-nums">{now ? ago(s.at, now) : clockUtc(s.at)}</span>
          </li>
        ))}
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

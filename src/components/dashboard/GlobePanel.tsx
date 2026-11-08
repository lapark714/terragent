"use client";
/** The globe region: layer toggles, live counts, and the globe itself (the activity feed has its own panel). */
import { useMemo, useState } from "react";
import { LAYERS, type Layer } from "@/lib/domain";
import type { GlobeData } from "@/lib/dashboard/types";
import { STATUS_LABEL } from "../format";
import { LAYER_HEX, LAYER_LABEL } from "../palette";
import { GlobeLoader } from "./GlobeLoader";

const ALL_ON = Object.fromEntries(LAYERS.map((l) => [l, true])) as Record<Layer, boolean>;

function Toggle({ on, color, label, onClick }: { on: boolean; color: string; label: string; onClick: () => void }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick}
      className={`flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs backdrop-blur-sm transition-colors ${on ? "border-line-strong bg-space/70 text-fg" : "border-line bg-space/40 text-fg-3"}`}>
      <span className="size-2 rounded-full" style={{ background: on ? color : "transparent", boxShadow: `inset 0 0 0 1.5px ${color}` }} aria-hidden />
      {label}
    </button>
  );
}

export function GlobePanel({ data, className = "" }: { data: GlobeData | null; className?: string }) {
  const [visible, setVisible] = useState(ALL_ON);
  const [signals, setSignals] = useState(true);

  // Follow the newest live customer request: when a judge submits one, the globe swings to it.
  const live = useMemo(() => (data?.requests ?? []).filter((r) => r.active && !r.sample).sort((a, b) => b.at.localeCompare(a.at)), [data]);
  const focus = live[0] ? { id: live[0].id, lat: live[0].lat, lng: live[0].lng } : null;

  return (
    <section aria-labelledby="globe-title" className={`relative min-h-0 overflow-hidden bg-[radial-gradient(ellipse_at_center,#13274a_0%,var(--color-panel)_62%)] ${className}`}>
      {data && <GlobeLoader data={data} visible={visible} showSignals={signals} focus={focus} />}

      <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-wrap items-start justify-between gap-3 p-4">
        <div className="pointer-events-auto flex flex-col gap-2.5">
          <h2 id="globe-title" className="stretch-semi text-[0.95rem] font-semibold">Earth index</h2>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Globe layers">
            {LAYERS.map((l) => (
              <Toggle key={l} on={visible[l]} color={LAYER_HEX[l]} label={LAYER_LABEL[l]} onClick={() => setVisible((v) => ({ ...v, [l]: !v[l] }))} />
            ))}
            <Toggle on={signals} color="#a6b7ca" label="Signals" onClick={() => setSignals((s) => !s)} />
          </div>
        </div>
        {data && (
          <p className="text-xs leading-relaxed text-fg-2 sm:text-right">
            {data.cells.world.length} regions measured, {data.signals.length} recent signals
            <br />
            {live[0] ? (
              <span className="text-fg">Following {live[0].id}, {STATUS_LABEL[live[0].status].toLowerCase()}</span>
            ) : (
              <span className="text-fg-3">Zoom in for finer cells</span>
            )}
          </p>
        )}
      </div>
      {!data && <p className="absolute inset-x-0 bottom-0 p-4 text-sm text-fg-3">Loading the Earth index.</p>}
    </section>
  );
}

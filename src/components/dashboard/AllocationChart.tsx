"use client";
/**
 * The coordinator's outreach effort split over time: a 100% stacked step chart (allocations change in
 * discrete decisions). Hover shows the split and the measured reason at that moment.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { AllocationPoint, OutboundPlaybook } from "@/lib/dashboard/types";
import { clockUtc } from "../format";
import { PLAYBOOK_LABEL, playbookHex } from "../palette";
import { useNow } from "../useNow";
import { PlaybookLegend } from "./Legend";

const SERIES: OutboundPlaybook[] = ["disasters", "deforestation", "mining"];
const H = 132;
const LABEL_W = 136;
const pct = (w: number) => `${Math.round(w * 100)}%`;

export function AllocationChart({ points }: { points: AllocationPoint[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const now = useNow();

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const geom = useMemo(() => {
    const plotW = Math.max(0, width - LABEL_W);
    const real = points.filter((p) => p.at).map((p) => Date.parse(p.at!));
    const end = Math.max(now ?? 0, ...real, 1);
    const firstReal = real.length ? real[0] : end - 3_600_000;
    const start = firstReal - Math.max(600_000, (end - firstReal) * 0.08);
    const xs = points.map((p) => (p.at ? Date.parse(p.at) : start)).map((t) => ((t - start) / Math.max(1, end - start)) * plotW);
    // Step-after bands, stacked bottom-up in SERIES order; y=0 is the top.
    const bands = SERIES.map((s, si) => {
      const lo = (i: number) => SERIES.slice(0, si).reduce((a, k) => a + points[i].weights[k], 0);
      const hi = (i: number) => lo(i) + points[i].weights[s];
      const y = (v: number) => H - v * H;
      let top = "";
      let bottom = "";
      points.forEach((_, i) => {
        const x0 = xs[i];
        const x1 = i + 1 < points.length ? xs[i + 1] : plotW;
        top += `${i ? "L" : "M"}${x0} ${y(hi(i))}H${x1}`;
        bottom = `L${x1} ${y(lo(i))}H${x0}` + bottom;
      });
      return { s, d: `${top}${bottom}Z`, mid: y((lo(points.length - 1) + hi(points.length - 1)) / 2) };
    });
    return { plotW, xs, bands };
  }, [points, width, now]);

  const last = points[points.length - 1];
  const shown = hover !== null ? points[hover] : last;

  function onMove(e: React.PointerEvent<SVGRectElement>) {
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
    let i = 0;
    while (i + 1 < geom.xs.length && geom.xs[i + 1] <= x) i++;
    setHover(i);
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div ref={box} className="relative" style={{ height: H }}>
        {width > 0 && (
          <svg width={width} height={H} role="img" aria-label={`Current split: ${SERIES.map((s) => `${PLAYBOOK_LABEL[s]} ${pct(last.weights[s])}`).join(", ")}`}>
            {geom.bands.map((b) => (
              <path key={b.s} d={b.d} fill={playbookHex(b.s)} fillOpacity={0.85} className="stroke-panel" strokeWidth={2} />
            ))}
            {[0, 0.5, 1].map((v) => (
              <line key={v} x1={0} x2={geom.plotW} y1={H - v * H} y2={H - v * H} className="stroke-line-strong" strokeWidth={1} strokeOpacity={v === 0.5 ? 0.6 : 0} />
            ))}
            {hover !== null && <line x1={geom.xs[hover]} x2={geom.xs[hover]} y1={0} y2={H} className="stroke-fg" strokeWidth={1} />}
            {geom.bands.map((b) => (
              <g key={b.s} transform={`translate(${geom.plotW + 8} ${b.mid})`}>
                <rect x={0} y={-4} width={8} height={8} rx={2} fill={playbookHex(b.s)} />
                <text x={13} y={4} className="fill-fg-2 text-[11px]">
                  {PLAYBOOK_LABEL[b.s]} <tspan className="fill-fg">{pct(last.weights[b.s])}</tspan>
                </text>
              </g>
            ))}
            <rect x={0} y={0} width={geom.plotW} height={H} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
          </svg>
        )}
      </div>
      <div className="min-h-0 text-[13px] leading-snug">
        <p className="text-xs text-fg-3">
          {shown.at ? `${clockUtc(shown.at)} UTC, ${shown.by === "coordinator" ? "coordinator" : shown.by}` : "Starting split"}
          {hover !== null && `: ${SERIES.map((s) => `${PLAYBOOK_LABEL[s]} ${pct(shown.weights[s])}`).join(", ")}`}
        </p>
        <p className="mt-0.5 line-clamp-3 text-fg-2">{points.length > 1 || hover !== null ? shown.reason : "The coordinator hasn't shifted effort yet. It reallocates once reply rates and cost per report come in."}</p>
      </div>
      <div className="mt-auto text-xs text-fg-3">
        <PlaybookLegend playbooks={SERIES} />
      </div>
    </div>
  );
}

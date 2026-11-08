"use client";
/**
 * Ten years of synthetic signals for both offices: parking occupancy or night-time light, monthly, with the
 * remote-batch years and the 20th Street construction marked. Hover (or tap) for a month's values.
 */
import { useState } from "react";
import { demoSeries, SENSORS, type MonthPoint } from "@/lib/demo/yc";

const W = 720;
const H = 280;
const PAD = { l: 40, r: 12, t: 16, b: 28 };
const T0 = 2016;
const T1 = 2026.85;

type Metric = "parking" | "light";
const METRIC: Record<Metric, { label: string; unit: string; sf: (p: MonthPoint) => number; mv: (p: MonthPoint) => number; max: number; fmt: (v: number) => string }> = {
  parking: { label: "Parking occupancy", unit: "%", sf: (p) => p.sf * 100, mv: (p) => p.mv * 100, max: 100, fmt: (v) => `${Math.round(v)}%` },
  light: { label: "Night-time light", unit: "nW/cm²/sr", sf: (p) => p.lightSf, mv: (p) => p.lightMv, max: 50, fmt: (v) => v.toFixed(1) },
};

const SERIES = demoSeries();
const x = (t: number) => PAD.l + ((t - T0) / (T1 - T0)) * (W - PAD.l - PAD.r);

export function SignalChart() {
  const series = SERIES;
  const [metric, setMetric] = useState<Metric>("parking");
  const [hover, setHover] = useState<number | null>(null);
  const m = METRIC[metric];
  const y = (v: number) => PAD.t + (1 - v / m.max) * (H - PAD.t - PAD.b);
  const path = (f: (p: MonthPoint) => number) => series.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(f(p)).toFixed(1)}`).join("");
  const hp = hover !== null ? series[hover] : null;

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const t = T0 + (((e.clientX - r.left) / r.width) * W - PAD.l) / (W - PAD.l - PAD.r) * (T1 - T0);
    const i = Math.round((t - T0) * 12);
    setHover(i >= 0 && i < series.length ? i : null);
  }

  return (
    <figure className="flex flex-col gap-3 rounded-lg border border-line bg-panel p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-lg border border-line-strong bg-space p-1">
          {(Object.keys(METRIC) as Metric[]).map((k) => (
            <button key={k} type="button" onClick={() => setMetric(k)} aria-pressed={metric === k}
              className={`rounded-md px-3 py-1 text-sm transition-colors ${metric === k ? "bg-raised text-fg" : "text-fg-3 hover:text-fg"}`}>
              {METRIC[k].label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-4 text-sm text-fg-2">
          <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded bg-inbound-hi" aria-hidden />Dogpatch, SF</span>
          <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 rounded bg-mining" aria-hidden />Mountain View</span>
        </div>
      </div>

      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full touch-none" role="img" aria-label={`${m.label} at both YC offices, monthly, 2016 to 2026 (simulated)`}
          onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          <defs>
            <pattern id="demo-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="6" stroke="var(--color-inbound)" strokeOpacity="0.35" strokeWidth="2" />
            </pattern>
          </defs>
          {/* Remote batches */}
          <rect x={x(2020.2)} y={PAD.t} width={x(2022) - x(2020.2)} height={H - PAD.t - PAD.b} fill="var(--color-fg)" fillOpacity="0.04" />
          <text x={x(2021.1)} y={PAD.t + 12} textAnchor="middle" className="fill-fg-3 text-[11px]">Remote batches</text>
          {/* Construction flagged by radar */}
          <rect x={x(2021.5)} y={H - PAD.b - 10} width={x(2023.25) - x(2021.5)} height={10} fill="url(#demo-hatch)" />
          <text x={x(2022.37)} y={H - PAD.b - 14} textAnchor="middle" className="fill-fg-3 text-[10px]">20th St construction (radar)</text>
          {/* Grid */}
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <g key={f}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(f * m.max)} y2={y(f * m.max)} stroke="var(--color-line)" />
              <text x={PAD.l - 6} y={y(f * m.max) + 4} textAnchor="end" className="fill-fg-3 font-mono text-[10px]">{metric === "parking" ? `${f * 100}` : (f * m.max).toFixed(0)}</text>
            </g>
          ))}
          {Array.from({ length: 11 }, (_, i) => T0 + i).map((yr) => (
            <text key={yr} x={x(yr)} y={H - 8} textAnchor="middle" className="fill-fg-3 font-mono text-[10px]">{`'${String(yr).slice(2)}`}</text>
          ))}
          <path d={path(m.mv)} fill="none" stroke="var(--color-mining)" strokeWidth="1.8" strokeLinejoin="round" />
          <path d={path(m.sf)} fill="none" stroke="var(--color-inbound-hi)" strokeWidth="2.2" strokeLinejoin="round" />
          {hp && (
            <g>
              <line x1={x(hp.t)} x2={x(hp.t)} y1={PAD.t} y2={H - PAD.b} stroke="var(--color-fg-3)" strokeDasharray="3 3" />
              <circle cx={x(hp.t)} cy={y(m.sf(hp))} r="4" fill="var(--color-inbound-hi)" stroke="var(--color-space)" strokeWidth="1.5" />
              <circle cx={x(hp.t)} cy={y(m.mv(hp))} r="4" fill="var(--color-mining)" stroke="var(--color-space)" strokeWidth="1.5" />
            </g>
          )}
        </svg>
        {hp && (
          <div className="pointer-events-none absolute top-2 rounded-md border border-line-strong bg-space/95 px-3 py-2 font-mono text-xs shadow-lg"
            style={{ left: `${Math.min(70, Math.max(2, (x(hp.t) / W) * 100 - 10))}%` }}>
            <p className="mb-1 text-fg">{new Date(`${hp.month}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })}</p>
            <p className="text-inbound-hi">SF {m.fmt(m.sf(hp))}</p>
            <p className="text-mining">MV {m.fmt(m.mv(hp))}</p>
          </div>
        )}
      </div>
      <figcaption className="text-xs text-fg-3">
        Monthly, Jan 2016 – Oct 2026. {metric === "parking" ? "Share of marked stalls filled, calibrated on counted cars." : "VIIRS day/night band, monthly median, " + m.unit + "."} Simulated for this demo.
      </figcaption>
    </figure>
  );
}

function Spark({ values, tone }: { values: number[]; tone: string }) {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const d = values.map((v, i) => `${i ? "L" : "M"}${((i / (values.length - 1)) * 100).toFixed(1)},${(28 - ((v - lo) / (hi - lo || 1)) * 26).toFixed(1)}`).join("");
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="h-8 w-full" aria-hidden>
      <path d={d} fill="none" stroke={tone} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const TONES = ["var(--color-human)", "var(--color-mining)", "var(--color-inbound-hi)", "var(--color-alert)", "var(--color-forest)"];

/** One card per modality: what it measures, how much of it, a sparkline, and the finding. */
export function SensorCards() {
  const series = SERIES;
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {SENSORS.map((s, i) => (
        <li key={s.name} className="flex flex-col gap-2 rounded-lg border border-line bg-panel p-4">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="font-medium">{s.name}</h3>
            <span className="font-mono text-[11px] text-fg-3">{s.res}</span>
          </div>
          <p className="text-sm text-fg-2">{s.what} · <span className="text-fg-3">{s.scenes}</span></p>
          <Spark values={series.map((p) => p[s.key])} tone={TONES[i % TONES.length]} />
          <p className="text-sm leading-relaxed text-fg-3">{s.finding}</p>
        </li>
      ))}
    </ul>
  );
}

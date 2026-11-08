/**
 * Measurements as instrument cards: one headline number each, with before → after underneath.
 * Reads on a phone without sideways scrolling, unlike the table.
 */
import type { PublicReport } from "@/lib/dashboard/public";
import { delta, fmtMetric, metricLabel, unitLabel } from "./metrics";

type Row = PublicReport["measurements"][number];

function Change({ before, after, unit }: { before: number | null; after: number | null; unit: string }) {
  const d = delta(before, after);
  if (d === null) return null;
  // Direction only: whether a change is good or bad depends on the question, so no red/green judgement.
  const arrow = d > 0 ? "↑" : d < 0 ? "↓" : "→";
  return (
    <p className="flex flex-wrap items-baseline gap-x-2 font-mono text-[13px] text-fg-3 tabular-nums">
      <span>
        {fmtMetric(before)} <span aria-hidden>→</span>
        <span className="sr-only">to</span> {fmtMetric(after)}
      </span>
      <span className="text-fg-2">
        <span aria-hidden>{arrow} </span>
        {d > 0 ? "+" : ""}
        {fmtMetric(d)}
        {unit && unit !== "%" ? ` ${unit}` : unit}
      </span>
    </p>
  );
}

function Card({ m }: { m: Row }) {
  const unit = unitLabel(m.unit);
  // Prefer the stated value; otherwise the after reading is the headline.
  const headline = m.value ?? m.after;
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-line bg-panel p-4 sm:p-5">
      <h3 className="text-sm text-fg-2">{metricLabel(m.metric, m.unit)}</h3>
      <p className="flex items-baseline gap-1.5">
        <span className="stretch-semi text-3xl font-semibold tracking-[-0.01em] tabular-nums">{fmtMetric(headline)}</span>
        {unit && <span className="text-fg-2">{unit}</span>}
      </p>
      <Change before={m.before} after={m.after} unit={unit} />
      {m.note && <p className="text-sm leading-relaxed text-fg-3">{m.note}</p>}
    </li>
  );
}

export function MeasurementCards({ rows }: { rows: PublicReport["measurements"] }) {
  if (!rows.length) return null;
  return (
    <ul className={`grid grid-cols-1 gap-3 ${rows.length > 1 ? "sm:grid-cols-2" : ""} ${rows.length > 2 ? "lg:grid-cols-3" : ""}`}>
      {rows.map((m) => (
        <Card key={m.metric} m={m} />
      ))}
    </ul>
  );
}

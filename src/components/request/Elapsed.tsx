"use client";
/** A ticking "time since you asked". Freezes at the final duration once the request is finished. */
import { useNow } from "@/components/useNow";

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  // Unit letters, not "19:03", which reads as a time of day.
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

export function Elapsed({ since, until, className = "" }: {
  since: string;
  /** Set when the request is finished: shows the fixed total instead of a running clock. */
  until?: string | null;
  className?: string;
}) {
  const now = useNow();
  const start = Date.parse(since);
  const end = until ? Date.parse(until) : now;
  // Server render and hydration have no clock: render a stable placeholder of the same width.
  const text = end === null ? "–m ––s" : clock(end - start);
  return (
    <span className={`font-mono tabular-nums ${className}`}>
      <span className="sr-only">{until ? "Took " : "Elapsed "}</span>
      <time dateTime={`PT${end === null ? 0 : Math.max(0, Math.floor((end - start) / 1000))}S`}>{text}</time>
    </span>
  );
}

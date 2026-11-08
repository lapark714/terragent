import type { Confidence } from "@/lib/domain";

const LEVEL: Record<Confidence, { filled: number; label: string; note: string }> = {
  high: { filled: 3, label: "High confidence", note: "Clear, recent imagery and measurements that agree." },
  medium: { filled: 2, label: "Medium confidence", note: "The data supports the answer with some gaps (clouds, dates or resolution)." },
  low: { filled: 1, label: "Low confidence", note: "Treat this as a lead to check, not a conclusion." },
};

/** Three-segment meter: confidence is ordered, so it reads as a level, not a colour. */
export function ConfidenceMeter({ level }: { level: Confidence }) {
  const l = LEVEL[level];
  return (
    <div className="flex items-center gap-3" role="img" aria-label={`${l.label}. ${l.note}`}>
      <span className="flex gap-1" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span key={i} className={`h-2 w-6 rounded-full ${i < l.filled ? "bg-fg" : "bg-line-strong"}`} />
        ))}
      </span>
      <span className="font-medium">{l.label}</span>
      <span className="hidden text-sm text-fg-3 sm:inline">{l.note}</span>
    </div>
  );
}

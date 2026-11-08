/** Every source with its capture date first, so a reader can see how fresh the evidence is at a glance. */
import { dateUtc } from "@/components/format";
import type { PublicReport } from "@/lib/dashboard/public";

export function SourceList({ sources }: { sources: PublicReport["sources"] }) {
  if (!sources.length) {
    return <p className="text-sm text-fg-3">No external sources were recorded for this report.</p>;
  }
  const sorted = [...sources].sort((a, b) => (a.datetime ?? "").localeCompare(b.datetime ?? ""));
  return (
    <ol className="flex flex-col divide-y divide-line border-y border-line">
      {sorted.map((s, i) => (
        <li key={`${s.itemId ?? s.name}-${i}`} className="grid grid-cols-[6.5rem_1fr] gap-x-4 gap-y-1 py-3 text-sm sm:grid-cols-[8rem_1fr]">
          <time dateTime={s.datetime ?? undefined} className="font-mono text-[13px] text-fg tabular-nums">
            {s.datetime ? dateUtc(s.datetime) : "Undated"}
          </time>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span>
              {s.url ? (
                <a href={s.url} rel="noreferrer" className="underline decoration-line-strong underline-offset-4 hover:decoration-fg">
                  {s.name}
                </a>
              ) : (
                s.name
              )}
              {s.license && <span className="text-fg-3"> · {s.license}</span>}
            </span>
            {s.itemId && <span className="font-mono text-xs break-all text-fg-3">{s.itemId}</span>}
          </div>
        </li>
      ))}
    </ol>
  );
}

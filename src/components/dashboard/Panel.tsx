/** A region of the instrument grid: title row, optional meta on the right, body that may scroll. */
import type { Panel as PanelResult } from "@/lib/dashboard/types";

export function Panel({ title, meta, className = "", bodyClassName = "px-4 pb-4", children }: {
  title: string;
  meta?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}) {
  const id = `panel-${title.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  return (
    <section aria-labelledby={id} className={`flex min-h-0 min-w-0 flex-col bg-panel ${className}`}>
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 pt-3.5 pb-3">
        <h2 id={id} className="stretch-semi text-[0.95rem] font-semibold">
          {title}
        </h2>
        {meta && <div className="text-[13px] text-fg-3">{meta}</div>}
      </header>
      <div className={`min-h-0 flex-1 ${bodyClassName}`}>{children}</div>
    </section>
  );
}

/** Renders a panel's data, or a plain explanation when that query failed (other panels keep working). */
export function PanelData<T>({ result, children }: { result: PanelResult<T> | undefined; children: (data: T) => React.ReactNode }) {
  if (!result) return <Quiet>Waiting for the first update.</Quiet>;
  if (!result.ok && result.suspended) return <Quiet>Paused with the database (Neon quota, NOTES H4c). This panel fills in again once a founder resumes it.</Quiet>;
  if (!result.ok) return <Quiet>This panel couldn&apos;t load ({result.error}). It retries on the next update.</Quiet>;
  return <>{children(result.data)}</>;
}

export function Quiet({ children }: { children: React.ReactNode }) {
  return <p className="text-sm leading-relaxed text-fg-3">{children}</p>;
}

import { dateUtc } from "@/components/format";
import type { PublicReport } from "@/lib/dashboard/public";

const ROLE_LABEL: Record<string, string> = { before: "Before", after: "After", index: "Index map", change: "Change" };
const ROLE_ORDER = ["before", "after", "change", "index"];

/** Before/after first, then derived maps. Plain <img>: sources are short-lived file links we don't optimise. */
export function ReportImages({ images }: { images: PublicReport["images"] }) {
  if (!images.length) return null;
  const sorted = [...images].sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {sorted.map((img) => (
        <figure key={img.src} className="overflow-hidden rounded-lg border border-line bg-panel">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={img.src} alt={img.caption || ROLE_LABEL[img.role] || "Satellite image"} loading="lazy" className="aspect-square w-full bg-raised object-cover" />
          <figcaption className="flex flex-col gap-1 p-4 text-sm">
            <span className="font-medium">
              {ROLE_LABEL[img.role] ?? img.role}
              {img.date && <span className="font-normal text-fg-2">, {dateUtc(img.date)}</span>}
            </span>
            {img.caption && <span className="text-fg-2">{img.caption}</span>}
            {img.source && <span className="text-fg-3">{img.source}</span>}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

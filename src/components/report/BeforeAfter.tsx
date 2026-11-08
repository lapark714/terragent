"use client";
/**
 * Drag to compare the before and after scenes of the same box. The control is a native range input
 * laid over the images, so touch, mouse and keyboard (arrow keys) all work and screen readers get a slider.
 */
import { useId, useState } from "react";
import { dateUtc } from "@/components/format";
import type { PublicReport } from "@/lib/dashboard/public";
import { SatImage } from "./SatImage";

type Img = PublicReport["images"][number];

function Tag({ side, img }: { side: "left" | "right"; img: Img }) {
  return (
    <span
      className={`pointer-events-none absolute top-3 ${side === "left" ? "left-3 items-start" : "right-3 items-end"} flex flex-col rounded bg-space/80 px-2 py-1 font-mono text-[11px] leading-snug tracking-wide text-fg backdrop-blur-sm`}
    >
      <span>{side === "left" ? "BEFORE" : "AFTER"}</span>
      {img.date && <span className="text-fg-2">{dateUtc(img.date)}</span>}
    </span>
  );
}

export function BeforeAfter({ before, after }: { before: Img; after: Img }) {
  const [pos, setPos] = useState(50);
  const id = useId();

  return (
    <figure className="flex flex-col overflow-hidden rounded-lg border border-line bg-panel">
      <div className="relative aspect-square w-full select-none has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-inbound-hi has-[input:focus-visible]:ring-inset sm:aspect-[4/3]">
        <div className="absolute inset-0">
          <SatImage src={before.src} alt={before.caption || "Before"} label="Before" className="!aspect-auto h-full" />
        </div>
        <div className="absolute inset-0" style={{ clipPath: `inset(0 0 0 ${pos}%)` }}>
          <SatImage src={after.src} alt={after.caption || "After"} label="After" className="!aspect-auto h-full" />
        </div>
        <Tag side="left" img={before} />
        <Tag side="right" img={after} />
        {/* Divider and grip follow the slider value. */}
        <div className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-fg/90 shadow-[0_0_0_1px_rgba(10,21,35,0.4)]" style={{ left: `${pos}%` }} aria-hidden>
          <span className="absolute top-1/2 left-1/2 flex size-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-fg/80 bg-space/85 text-fg backdrop-blur-sm">
            <svg viewBox="0 0 16 16" className="size-4">
              <path d="M6 4 2 8l4 4M10 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </div>
        <label htmlFor={id} className="sr-only">
          Compare before and after. Left shows more of the before image, right shows more of the after image.
        </label>
        <input
          id={id}
          type="range"
          min={0}
          max={100}
          step={1}
          value={pos}
          onChange={(e) => setPos(Number(e.target.value))}
          aria-valuetext={`${pos}% after`}
          className="absolute inset-0 h-full w-full cursor-ew-resize appearance-none bg-transparent opacity-0"
        />
      </div>
      <figcaption className="flex flex-col gap-1 p-4 text-sm sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
        <span className="text-fg-2">Drag to compare the same area before and after.</span>
        <span className="text-fg-3">{after.source || before.source}</span>
      </figcaption>
    </figure>
  );
}

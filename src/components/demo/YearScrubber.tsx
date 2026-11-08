"use client";
/**
 * Real imagery, synthetic overlay: the yearly Sentinel-2 cloudless mosaics (EOX, CC BY 4.0) over each YC office,
 * crossfading year by year, with a made-up "activity heat" layer whose strength follows the demo series.
 * Every year's tiles are mounted at once so scrubbing never waits on the network.
 */
import { useEffect, useMemo, useState } from "react";
import { demoSeries, mosaicLayer, MOSAIC_YEARS, SITES, type DemoSite } from "@/lib/demo/yc";

const Z = 16;
const TILE = 256;
const SCALE = 1;

function worldPx(lat: number, lng: number) {
  const n = 2 ** Z;
  const x = ((lng + 180) / 360) * n * TILE;
  const r = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n * TILE;
  return { x, y };
}

const tileUrl = (year: number, tx: number, ty: number) => `https://tiles.maps.eox.at/wmts/1.0.0/${mosaicLayer(year)}/default/g/${Z}/${ty}/${tx}.jpg`;

/** Yearly average of the site's synthetic occupancy, 0–1, for the heat overlay. */
function useYearly(site: DemoSite["key"]) {
  return useMemo(() => {
    const by = new Map<number, number[]>();
    for (const p of demoSeries()) {
      const y = Math.floor(p.t);
      by.set(y, [...(by.get(y) ?? []), site === "sf" ? p.sf : p.mv]);
    }
    return (year: number) => {
      const v = by.get(year) ?? [0];
      return v.reduce((a, b) => a + b, 0) / v.length;
    };
  }, [site]);
}

export function YearScrubber() {
  const [siteKey, setSiteKey] = useState<DemoSite["key"]>("sf");
  const [yi, setYi] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [heat, setHeat] = useState(true);
  const site = SITES[siteKey];
  const year = MOSAIC_YEARS[yi];
  const yearly = useYearly(siteKey);

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setYi((i) => (i + 1) % MOSAIC_YEARS.length), 1400);
    return () => clearInterval(t);
  }, [playing]);

  const c = worldPx(site.lat, site.lng);
  const cx = Math.floor(c.x / TILE);
  const cy = Math.floor(c.y / TILE);
  const tiles: { tx: number; ty: number }[] = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -2; dx <= 2; dx++) tiles.push({ tx: cx + dx, ty: cy + dy });

  const intensity = yearly(year);

  return (
    <figure className="flex flex-col overflow-hidden rounded-lg border border-line bg-panel">
      <div className="relative h-[22rem] w-full overflow-hidden bg-raised sm:h-[26rem]">
        <div className="absolute top-1/2 left-1/2" style={{ transform: `scale(${SCALE})` }}>
          {MOSAIC_YEARS.map((y) => (
            <div key={y} className="absolute inset-0 transition-opacity duration-700" style={{ opacity: y === year ? 1 : 0 }} aria-hidden={y !== year}>
              {tiles.map(({ tx, ty }) => (
                // eslint-disable-next-line @next/next/no-img-element -- public WMTS tiles, positioned by hand
                <img
                  key={`${y}-${tx}-${ty}`}
                  src={tileUrl(y, tx, ty)}
                  alt=""
                  width={TILE}
                  height={TILE}
                  draggable={false}
                  className="absolute max-w-none select-none"
                  style={{ left: tx * TILE - c.x, top: ty * TILE - c.y }}
                />
              ))}
            </div>
          ))}
        </div>

        {/* Synthetic activity heat over the building and its lot. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 mix-blend-screen transition-opacity duration-700"
          style={{
            opacity: heat ? 0.25 + intensity * 0.75 : 0,
            background: `radial-gradient(circle at 50% 50%, rgba(242,167,192,${0.25 + intensity * 0.55}) 0, rgba(240,138,122,${intensity * 0.35}) 9%, transparent 22%),
              radial-gradient(circle at 56% 44%, rgba(154,157,245,${intensity * 0.5}) 0, transparent 14%)`,
          }}
        />

        {/* The office */}
        <div className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-full">
          <svg viewBox="0 0 24 32" className="h-8 w-6 drop-shadow-[0_2px_6px_rgba(0,0,0,0.7)]" aria-hidden>
            <path d="M12 31s10-9.3 10-17A10 10 0 0 0 2 14c0 7.7 10 17 10 17Z" fill="var(--color-human)" stroke="var(--color-space)" strokeWidth="1.5" />
            <circle cx="12" cy="13" r="3.6" fill="var(--color-space)" />
          </svg>
        </div>

        <span className="pointer-events-none absolute top-3 left-3 flex flex-col rounded bg-space/80 px-2 py-1 font-mono text-[11px] leading-snug tracking-wide text-fg backdrop-blur-sm">
          <span>{site.short.toUpperCase()}</span>
          <span className="text-fg-2">{site.detail}</span>
        </span>
        <span className="pointer-events-none absolute top-3 right-3 rounded bg-space/80 px-2.5 py-1 font-mono text-2xl font-semibold text-fg tabular-nums backdrop-blur-sm">
          {year}
        </span>
        {heat && (
          <span className="pointer-events-none absolute right-3 bottom-3 rounded bg-space/80 px-2 py-1 font-mono text-[11px] text-fg-2 backdrop-blur-sm">
            Activity index {Math.round(intensity * 100)}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-3 border-t border-line p-4">
        <div className="flex flex-wrap items-center gap-2">
          {(["sf", "mv"] as const).map((k) => (
            <button key={k} type="button" onClick={() => setSiteKey(k)} aria-pressed={siteKey === k}
              className={`rounded-full border px-3 py-1 text-sm transition-colors ${siteKey === k ? "border-inbound-hi bg-inbound/20 text-fg" : "border-line-strong text-fg-2 hover:text-fg"}`}>
              {SITES[k].short}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-line-strong" aria-hidden />
          <button type="button" onClick={() => setHeat((h) => !h)} aria-pressed={heat}
            className={`rounded-full border px-3 py-1 text-sm transition-colors ${heat ? "border-human/70 bg-human/10 text-fg" : "border-line-strong text-fg-2 hover:text-fg"}`}>
            Activity heat
          </button>
          <button type="button" onClick={() => setPlaying((v) => !v)} className="ml-auto rounded-full border border-line-strong px-3 py-1 text-sm text-fg-2 hover:text-fg">
            {playing ? "Pause" : "Play"}
          </button>
        </div>
        <div className="flex gap-1" role="group" aria-label="Year">
          {MOSAIC_YEARS.map((y, i) => (
            <button key={y} type="button" onClick={() => { setPlaying(false); setYi(i); }} aria-pressed={i === yi}
              className={`flex-1 rounded py-1.5 font-mono text-xs tabular-nums transition-colors ${i === yi ? "bg-raised text-fg" : "text-fg-3 hover:text-fg"}`}>
              {y}
            </button>
          ))}
        </div>
        <figcaption className="text-xs leading-relaxed text-fg-3">
          Real imagery: Sentinel-2 cloudless yearly mosaics, <a href="https://s2maps.eu" rel="noreferrer" className="underline underline-offset-2 hover:text-fg">© EOX, CC BY 4.0</a>.
          The activity heat layer is simulated for this demo.
        </figcaption>
      </div>
    </figure>
  );
}

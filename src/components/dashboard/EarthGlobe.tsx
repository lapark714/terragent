"use client";
/**
 * The hero: Earth index cells as H3 hexes coloured by layer (height = how many measurements), recent signals
 * as dots, live requests as pulsing rings. Zooming in swaps to finer cells. New inbound requests pull focus.
 * Import through GlobeLoader (react-globe.gl touches `window` at import).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Globe, { type GlobeMethods } from "react-globe.gl";
import type { Layer } from "@/lib/domain";
import type { GlobeCell, GlobeData, GlobeRequest } from "@/lib/dashboard/types";
import { STATUS_LABEL } from "../format";
import { LAYER_HEX, LAYER_LABEL } from "../palette";

export interface GlobeFocus { id: string; lat: number; lng: number }

const REGION_ALTITUDE = 1.1;

type PointDatum = { lat: number; lng: number; layer: Layer; r: number; label: string };

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** three.js colours take rgba() for transparency, not 8-digit hex. */
const alpha = (hex: string, a: number) => `rgba(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(",")},${a})`;
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export default function EarthGlobe({ data, visible, showSignals, focus }: {
  data: GlobeData;
  visible: Record<Layer, boolean>;
  showSignals: boolean;
  focus: GlobeFocus | null;
}) {
  const globe = useRef<GlobeMethods | undefined>(undefined);
  const box = useRef<HTMLDivElement>(null);
  const resumeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const focused = useRef<string | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [regional, setRegional] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      clearTimeout(resumeTimer.current);
    };
  }, []);

  /** Stop the slow spin while someone is looking at a spot; pick it back up later. */
  const holdStill = useCallback((ms: number) => {
    const controls = globe.current?.controls();
    if (!controls) return;
    controls.autoRotate = false;
    clearTimeout(resumeTimer.current);
    if (!reducedMotion()) resumeTimer.current = setTimeout(() => (controls.autoRotate = true), ms);
  }, []);

  const flyTo = useCallback(
    (f: GlobeFocus) => {
      focused.current = f.id;
      globe.current?.pointOfView({ lat: f.lat, lng: f.lng, altitude: 1.2 }, reducedMotion() ? 0 : 1800);
      holdStill(30_000);
    },
    [holdStill],
  );

  const onReady = useCallback(() => {
    const g = globe.current;
    if (!g) return;
    const controls = g.controls();
    controls.autoRotate = !reducedMotion();
    controls.autoRotateSpeed = 0.3;
    controls.addEventListener("start", () => holdStill(20_000));
    g.pointOfView({ lat: 22, lng: -50, altitude: 1.75 }, 0);
  }, [holdStill]);

  useEffect(() => {
    if (focus && focus.id !== focused.current) flyTo(focus);
  }, [focus, flyTo]);

  const cells = useMemo(
    () => (regional ? data.cells.region : data.cells.world).filter((c) => visible[c.layer]),
    [data, regional, visible],
  );
  const points = useMemo<PointDatum[]>(
    () => [
      ...(showSignals ? data.signals : [])
        .filter((s) => visible[s.layer])
        .map((s) => ({ lat: s.lat, lng: s.lng, layer: s.layer, r: 0.3, label: `${escapeHtml(s.title)}<br><span class="muted">${escapeHtml(s.feed)} signal</span>` })),
      ...data.requests
        .filter((r) => !r.active && visible[r.layer])
        .map((r) => ({ lat: r.lat, lng: r.lng, layer: r.layer, r: 0.45, label: `${r.sample ? "Free sample" : "Request"} ${r.id}<br><span class="muted">${STATUS_LABEL[r.status]}</span>` })),
    ],
    [data, visible, showSignals],
  );
  const rings = useMemo(() => data.requests.filter((r) => r.active && visible[r.layer]), [data, visible]);

  const cellOf = (h: { points: object[] }) => h.points[0] as GlobeCell;
  const maxN = Math.max(1, ...cells.map((c) => c.n));
  const height = (n: number) => 0.006 + 0.05 * (Math.log10(1 + n) / Math.log10(1 + maxN));

  return (
    <div ref={box} className="absolute inset-0">
      {size && (
        <Globe
          ref={globe}
          width={size.w}
          height={size.h}
          backgroundColor="rgba(0,0,0,0)"
          globeImageUrl="/globe/earth-night.jpg"
          bumpImageUrl="/globe/earth-topology.png"
          showAtmosphere
          atmosphereColor="#5d7fd8"
          atmosphereAltitude={0.16}
          onGlobeReady={onReady}
          onZoom={(pov) => setRegional(pov.altitude < REGION_ALTITUDE)}
          hexBinPointsData={cells}
          hexBinPointLat="lat"
          hexBinPointLng="lng"
          hexBinPointWeight="n"
          hexBinResolution={regional ? data.resolutions.region : data.resolutions.world}
          hexMargin={0.12}
          hexAltitude={(h) => height(cellOf(h).n)}
          hexTopColor={(h) => LAYER_HEX[cellOf(h).layer]}
          hexSideColor={(h) => alpha(LAYER_HEX[cellOf(h).layer], 0.55)}
          hexBinMerge={cells.length > 300}
          hexTransitionDuration={0}
          hexLabel={(h) => {
            const c = cellOf(h);
            return `${LAYER_LABEL[c.layer]}<br><span class="muted">${c.n} measurement${c.n === 1 ? "" : "s"}${c.changed ? ", change detected" : ""}</span>`;
          }}
          pointsData={points}
          pointLat="lat"
          pointLng="lng"
          pointColor={(d) => LAYER_HEX[(d as PointDatum).layer]}
          pointAltitude={0.008}
          pointRadius="r"
          pointLabel="label"
          ringsData={rings}
          ringLat="lat"
          ringLng="lng"
          ringColor={(d: object) => (t: number) => alpha(LAYER_HEX[(d as GlobeRequest).layer], 1 - t)}
          ringMaxRadius={3}
          ringPropagationSpeed={1.8}
          ringRepeatPeriod={1300}
        />
      )}
    </div>
  );
}

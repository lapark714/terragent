"use client";
/**
 * The landing globe. Idle: night Earth, slow spin. Given a target: stops, flies down to it, swaps in
 * Sentinel-2 cloudless imagery tiles so the close-up is a real satellite view, and drops a pin.
 * Tapping the globe reports the point (tap-to-pin). Import through HeroGlobeLoader (touches `window`).
 *
 * Touch screens: rotate/zoom gestures are off so the page still scrolls; a tap still drops a pin.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Globe, { type GlobeMethods } from "react-globe.gl";
import { MARK_TIP_X, markAspect, markSrc } from "../Logo";
import type { LatLng } from "./coords";

/** EOX Sentinel-2 cloudless 2016 (CC BY 4.0, attribution shown by the caller). WMTS order is level/row/col. */
const S2_TILES = (x: number, y: number, level: number) =>
  `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/${level}/${y}/${x}.jpg`;

const IDLE_POV = { lat: 18, lng: -40, altitude: 2.3 };
const FLY_MS = 2200;

export interface GlobeTarget extends LatLng {
  altitude: number;
  /** Changes whenever a new target is chosen, so the same spot picked twice still re-flies. */
  key: string;
}

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const isCoarse = () => window.matchMedia("(pointer: coarse)").matches;

/** The Terragent mark is itself a globe on a pin: it's the marker, planted by its spike tip. */
const PIN_H = 56;
function pinElement(): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("aria-hidden", "true");
  el.style.cssText = `transform: translate(-${MARK_TIP_X * 100}%, -100%); pointer-events: none; filter: drop-shadow(0 6px 14px rgba(0,0,0,.6)) drop-shadow(0 0 10px rgba(127,131,240,.45));`;
  const inner = document.createElement("div");
  const url = `url(${markSrc})`;
  inner.style.cssText = `height:${PIN_H}px; width:${Math.round(PIN_H * markAspect)}px; background:#e7eef6;
    mask-image:${url}; -webkit-mask-image:${url}; mask-size:contain; -webkit-mask-size:contain;
    mask-repeat:no-repeat; -webkit-mask-repeat:no-repeat;`;
  el.appendChild(inner);
  return el;
}

export default function HeroGlobe({ target, onPick, onSettled, onReady: onReadyProp }: {
  target: GlobeTarget | null;
  /** Fires once the globe has its texture and is drawing. */
  onReady?: () => void;
  onPick?: (c: LatLng) => void;
  /** Fires when the camera finishes flying to a target. */
  onSettled?: () => void;
}) {
  const globe = useRef<GlobeMethods | undefined>(undefined);
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [ready, setReady] = useState(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      clearTimeout(settleTimer.current);
    };
  }, []);

  const onReady = useCallback(() => {
    const g = globe.current;
    if (!g) return;
    const c = g.controls();
    c.autoRotate = !prefersReducedMotion();
    c.autoRotateSpeed = 0.45;
    c.enableZoom = false; // never hijack the page's scroll wheel
    if (isCoarse()) {
      c.enableRotate = false;
      c.enablePan = false;
    }
    g.pointOfView(IDLE_POV, 0);
    setReady(true);
    onReadyProp?.();
  }, [onReadyProp]);

  // Fly to the target, or back out to the spinning idle view.
  useEffect(() => {
    const g = globe.current;
    if (!g || !ready) return;
    const c = g.controls();
    clearTimeout(settleTimer.current);
    const ms = prefersReducedMotion() ? 0 : FLY_MS;
    if (target) {
      c.autoRotate = false;
      g.pointOfView({ lat: target.lat, lng: target.lng, altitude: target.altitude }, ms);
      settleTimer.current = setTimeout(() => onSettled?.(), ms + 50);
    } else {
      g.pointOfView(IDLE_POV, ms);
      settleTimer.current = setTimeout(() => (c.autoRotate = !prefersReducedMotion()), ms);
    }
    // onSettled is a callback prop; re-flying when its identity changes would be wrong.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.key, ready]);

  const pins = target ? [{ lat: target.lat, lng: target.lng }] : [];

  /**
   * Our own tap detection. globe.gl's onGlobeClick only knows what's under the pointer after a hover move,
   * which a finger tap often never sends, so phones would miss taps. A press that barely moves is a tap;
   * anything longer is a drag-to-rotate.
   */
  const press = useRef<{ x: number; y: number; t: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    press.current = { x: e.clientX, y: e.clientY, t: e.timeStamp };
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const p = press.current;
    press.current = null;
    if (!p || !onPick || !box.current) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 8 || e.timeStamp - p.t > 600) return;
    const r = box.current.getBoundingClientRect();
    const hit = globe.current?.toGlobeCoords(e.clientX - r.left, e.clientY - r.top);
    if (hit) onPick({ lat: hit.lat, lng: hit.lng });
  };

  return (
    <div ref={box} onPointerDown={onPointerDown} onPointerUp={onPointerUp} className={`absolute inset-0 cursor-crosshair transition-opacity duration-1000 ${ready ? "opacity-100" : "opacity-0"}`}>
      {size && (
        <Globe
          ref={globe}
          width={size.w}
          height={size.h}
          backgroundColor="rgba(0,0,0,0)"
          globeImageUrl="/globe/earth-night.jpg"
          bumpImageUrl="/globe/earth-topology.png"
          globeTileEngineUrl={target ? S2_TILES : null}
          showAtmosphere
          atmosphereColor="#5d7fd8"
          atmosphereAltitude={0.18}
          onGlobeReady={onReady}
          ringsData={pins}
          ringLat="lat"
          ringLng="lng"
          ringColor={() => (t: number) => `rgba(154,157,245,${1 - t})`}
          ringMaxRadius={target ? Math.max(0.4, target.altitude * 6) : 1}
          ringPropagationSpeed={target ? Math.max(0.3, target.altitude * 4) : 1}
          ringRepeatPeriod={1400}
          htmlElementsData={pins}
          htmlLat="lat"
          htmlLng="lng"
          htmlAltitude={0}
          htmlElement={pinElement}
        />
      )}
    </div>
  );
}

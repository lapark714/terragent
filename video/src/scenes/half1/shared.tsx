import React from "react";
import { Beacon, Panel, Working } from "../../components/Primitives";
import { project } from "../../choreography";
import { lerp, seeded } from "../../motion";
import { C, FONT, hit } from "../../tokens";

export type Pt = readonly [number, number];
export type Rect = { x: number; y: number; w: number; h: number };

/** Scenes render inside a Sequence, so their useCurrentFrame is relative; this turns a timing label into a local frame. */
export const localHit = (sceneFrom: number) => (label: string): number => hit(label) - sceneFrom;

export const lerpRect = (a: Rect, b: Rect, t: number): Rect => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
  w: lerp(a.w, b.w, t),
  h: lerp(a.h, b.h, t),
});

/** The closed state of an agent node: the pin's tip touches the middle of its top edge. */
export const pillRect = (tip: Pt, w = 240, h = 72): Rect => ({ x: tip[0] - w / 2, y: tip[1], w, h });

/** Agent stops, shared so a scene can pre-build the next one during its outgoing frames. */
export const PLANNER_TIP: Pt = [360, 300];
export const ACQUISITION_TIP: Pt = [260, 560];
export const PRICING_TIP: Pt = [960, 300];
export const ANALYTICS_TIP: Pt = [300, 400];
export const INTERPRETER_TIP: Pt = [960, 400];
export const VERIFIER_TIP: Pt = [1620, 400];

/** Node name in a fixed spot, so a pill and the card it opens into read as one object. */
export const NodeHead: React.FC<{ name: string; color?: string; right?: React.ReactNode }> = ({ name, color = C.accent, right }) => (
  <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: 72, display: "flex", alignItems: "center", paddingLeft: 48, paddingRight: 24, justifyContent: "space-between" }}>
    <Beacon x={26} y={36} color={color} size={11} />
    <span style={{ fontFamily: FONT.mono, fontSize: 23, fontWeight: 500, color: C.text, whiteSpace: "nowrap" }}>{name}</span>
    {right}
  </div>
);

/** An agent node that can morph between a pill and an open card; content is clipped while it opens. */
export const Node: React.FC<{
  rect: Rect;
  name: string;
  color?: string;
  border?: string;
  working?: boolean;
  o?: number;
  right?: React.ReactNode;
  children?: React.ReactNode;
}> = ({ rect, name, color, border, working = false, o = 1, right, children }) => (
  <Panel x={rect.x} y={rect.y} w={rect.w} h={rect.h} o={o} border={border} style={{ padding: 0, overflow: "hidden" }}>
    <NodeHead name={name} color={color} right={right} />
    {children}
    <Working on={working} color={color ?? C.accent} />
  </Panel>
);

/** Point on the same quadratic an Edge draws, so a mark can ride it. Negative `bend` lifts a left-to-right path. */
export const quad = (a: Pt, b: Pt, bend: number, t: number): Pt => {
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  const nx = -(b[1] - a[1]);
  const ny = b[0] - a[0];
  const len = Math.hypot(nx, ny) || 1;
  const cx = mx + (nx / len) * bend;
  const cy = my + (ny / len) * bend;
  return [(1 - t) * (1 - t) * a[0] + 2 * (1 - t) * t * cx + t * t * b[0], (1 - t) * (1 - t) * a[1] + 2 * (1 - t) * t * cy + t * t * b[1]];
};

/** The carrying object: a satellite dot riding a hairline that links this scene's agent stops, there and back. */
export const StopOrbit: React.FC<{ stops: Pt[]; bend: number; abs: number; o?: number; period?: number; phase?: number }> = ({ stops, bend, abs, o = 1, period = 170, phase = 0 }) => {
  const segs = stops.length - 1;
  const u = ((1 - Math.cos(((abs + phase) / period) * Math.PI * 2)) / 2) * segs;
  const i = Math.min(segs - 1, Math.floor(u));
  const [x, y] = quad(stops[i], stops[i + 1], bend, u - i);
  return (
    <Stage o={o}>
      {stops.slice(0, -1).map((a, k) => {
        const n = 32;
        const pts = Array.from({ length: n + 1 }, (_, j) => quad(a, stops[k + 1], bend, j / n).map((v) => v.toFixed(1)).join(" "));
        return <path key={k} d={`M${pts.join("L")}`} fill="none" stroke={C.lineStrong} strokeWidth={1.25} />;
      })}
      <circle cx={x} cy={y} r={6.5} fill={C.accentHi} />
    </Stage>
  );
};

/** A full-frame SVG layer in screen coordinates. */
export const Stage: React.FC<{ children: React.ReactNode; o?: number }> = ({ children, o = 1 }) => (
  <svg width={1920} height={1080} style={{ position: "absolute", inset: 0, opacity: o, overflow: "visible" }}>
    {children}
  </svg>
);

/** H3 cells are pointy-topped hexagons. */
export const hexPath = (cx: number, cy: number, r: number): string => {
  const pts = Array.from({ length: 6 }, (_, i) => {
    const a = ((-90 + i * 60) * Math.PI) / 180;
    return `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)}`;
  });
  return `M${pts.join("L")}Z`;
};

/** A check mark drawn with a stroke, `t` from 0 to 1. */
export const Check: React.FC<{ x: number; y: number; size: number; t: number; color?: string; width?: number }> = ({ x, y, size, t, color = C.forest, width = 4 }) => (
  <path
    d={`M${x - size * 0.5} ${y + size * 0.02}L${x - size * 0.12} ${y + size * 0.38}L${x + size * 0.5} ${y - size * 0.36}`}
    pathLength={1}
    fill="none"
    stroke={color}
    strokeWidth={width}
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeDasharray={`${t} 1`}
  />
);

export const CheckIcon: React.FC<{ size?: number; t: number; color?: string }> = ({ size = 26, t, color = C.forest }) => (
  <svg width={size} height={size} viewBox="0 0 26 26" style={{ flex: "none", display: "block" }}>
    <Check x={13} y={13} size={18} t={t} color={color} width={3} />
  </svg>
);

export const CrossIcon: React.FC<{ size?: number; t: number; color?: string }> = ({ size = 26, t, color = C.disaster }) => (
  <svg width={size} height={size} viewBox="0 0 26 26" style={{ flex: "none", display: "block" }}>
    <path d="M6 6L20 20M20 6L6 20" pathLength={2} fill="none" stroke={color} strokeWidth={3} strokeLinecap="round" strokeDasharray={`${t * 2} 2`} />
  </svg>
);

/** The Earth index: answered cells scattered across the Americas, tracked to the turning globe. */
const REGIONS = [
  [28, 48, -122, -78],
  [14, 26, -105, -85],
  [-30, 4, -74, -44],
  [36, 52, -8, 22],
  [4, 16, -14, 14],
] as const;
const INDEX_CELLS = Array.from({ length: 52 }, (_, i) => {
  const [latA, latB, lonA, lonB] = REGIONS[Math.floor(seeded(i + 21) * REGIONS.length)];
  return { lat: lerp(latA, latB, seeded(i + 11)), lon: lerp(lonA, lonB, seeded(i * 3 + 7)), order: seeded(i * 5 + 3) };
});

/** `grown` is how much of the index has appeared, 0 to 1. Takes the absolute film frame. */
export const IndexHexes: React.FC<{ abs: number; grown: number; o?: number; r?: number }> = ({ abs, grown, o = 1, r = 13 }) => (
  <Stage o={o}>
    {INDEX_CELLS.map((c, i) => {
      const p = project(c.lat, c.lon, abs);
      const local = Math.max(0, Math.min(1, (grown - c.order * 0.85) / 0.15));
      if (!p.visible || local <= 0) {
        return null;
      }
      return <path key={i} d={hexPath(p.x, p.y, r * lerp(0.2, 1, local))} fill={C.accent} fillOpacity={0.34 * local} stroke={C.accentHi} strokeOpacity={local} strokeWidth={1.25} />;
    })}
  </Stage>
);

/** Text that a mask reveals upward at `from`. */
export const MaskUp: React.FC<{ t: number; children: React.ReactNode; style?: React.CSSProperties }> = ({ t, children, style }) => (
  <span style={{ display: "block", overflow: "hidden", ...style }}>
    <span style={{ display: "block", transform: `translateY(${lerp(110, 0, t)}%)` }}>{children}</span>
  </span>
);


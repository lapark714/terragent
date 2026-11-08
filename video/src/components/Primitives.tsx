import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { C, FONT } from "../tokens";
import { breathe, EASE, lerp, pop, prog } from "../motion";

type Pt = readonly [number, number];

/** Glass panel on the instrument grid. Children are positioned inside; never place type over imagery without one. */
export const Panel: React.FC<{
  x: number;
  y: number;
  w: number;
  h?: number;
  o?: number;
  scale?: number;
  origin?: string;
  border?: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
}> = ({ x, y, w, h, o = 1, scale = 1, origin = "center", border = C.lineStrong, children, style }) => (
  <div
    style={{
      position: "absolute",
      left: x,
      top: y,
      width: w,
      height: h,
      opacity: o,
      transform: `scale(${scale})`,
      transformOrigin: origin,
      background: "rgba(14, 28, 45, 0.94)",
      border: `1px solid ${border}`,
      borderRadius: 8,
      padding: "16px 20px",
      boxSizing: "border-box",
      color: C.text,
      fontFamily: FONT.sans,
      ...style,
    }}
  >
    {children}
  </div>
);

/** Mono diagram label: agent names, sensors, coordinates. */
export const Mono: React.FC<{ children: React.ReactNode; size?: number; color?: string; style?: React.CSSProperties }> = ({
  children,
  size = 18,
  color = C.text2,
  style,
}) => <span style={{ fontFamily: FONT.mono, fontSize: size, color, letterSpacing: "0.02em", ...style }}>{children}</span>;

/** Display type that reveals word by word from a mask, then leaves the same way. */
export const Title: React.FC<{
  text: string;
  from: number;
  to: number;
  x: number;
  y: number;
  w?: number;
  size?: number;
  align?: "left" | "center";
  color?: string;
  stagger?: number;
}> = ({ text, from, to, x, y, w = 1728, size = 76, align = "left", color = C.text, stagger = 3 }) => {
  const frame = useCurrentFrame();
  const words = text.split(" ");
  const exit = prog(frame, to - 12, 12, EASE.in);
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: w,
        textAlign: align,
        fontFamily: FONT.sans,
        fontSize: size,
        fontWeight: 600,
        fontStretch: "125%",
        letterSpacing: "-0.025em",
        lineHeight: 1.08,
        color,
      }}
    >
      {words.map((word, i) => {
        const t = prog(frame, from + i * stagger, 20);
        return (
          <span key={i} style={{ display: "inline-block", overflow: "hidden", verticalAlign: "top", paddingBottom: "0.12em", marginRight: "0.26em" }}>
            <span style={{ display: "inline-block", transform: `translateY(${lerp(108, 0, t) - exit * 108}%)` }}>{word}</span>
          </span>
        );
      })}
    </div>
  );
};

/** Sensor or data chip, springs in at `from`. */
export const Chip: React.FC<{ from: number; children: React.ReactNode; color?: string; x?: number; y?: number; size?: number; style?: React.CSSProperties }> = ({
  from,
  children,
  color = C.accent,
  x,
  y,
  size = 18,
  style,
}) => {
  const frame = useCurrentFrame();
  const s = pop(frame, from);
  return (
    <div
      style={{
        ...(x === undefined ? {} : { position: "absolute" as const, left: x, top: y }),
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 14px",
        background: C.raised,
        border: `1px solid ${C.lineStrong}`,
        borderRadius: 6,
        fontFamily: FONT.mono,
        fontSize: size,
        color: C.text,
        whiteSpace: "nowrap",
        opacity: Math.min(1, s * 1.4),
        transform: `scale(${lerp(0.82, 1, s)})`,
        transformOrigin: "left center",
        ...style,
      }}
    >
      <span style={{ width: 9, height: 9, borderRadius: 9, background: color, flex: "none" }} />
      {children}
    </div>
  );
};

/** Live dot with an expanding ring. */
export const Beacon: React.FC<{ x: number; y: number; color?: string; size?: number; phase?: number; o?: number }> = ({
  x,
  y,
  color = C.accent,
  size = 10,
  phase = 0,
  o = 1,
}) => {
  const frame = useCurrentFrame();
  const ring = ((frame + phase) % 80) / 80;
  return (
    <div style={{ position: "absolute", left: x, top: y, width: 0, height: 0, opacity: o }}>
      <div
        style={{
          position: "absolute",
          left: -size * (1 + ring * 1.6),
          top: -size * (1 + ring * 1.6),
          width: size * (1 + ring * 1.6) * 2,
          height: size * (1 + ring * 1.6) * 2,
          borderRadius: "50%",
          border: `1.5px solid ${color}`,
          opacity: (1 - ring) * 0.8,
          boxSizing: "border-box",
        }}
      />
      <div style={{ position: "absolute", left: -size / 2, top: -size / 2, width: size, height: size, borderRadius: "50%", background: color }} />
    </div>
  );
};

/** An edge that draws from a to b as a travelling pulse, leaving a hairline behind. */
export const Edge: React.FC<{
  a: Pt;
  b: Pt;
  from: number;
  dur?: number;
  color?: string;
  bend?: number;
  until?: number;
  width?: number;
}> = ({ a, b, from, dur = 22, color = C.accent, bend = 0, until = Infinity, width = 2 }) => {
  const frame = useCurrentFrame();
  const t = prog(frame, from, dur, EASE.travel);
  const gone = until === Infinity ? 0 : prog(frame, until - 10, 10, EASE.in);
  if (t <= 0 || gone >= 1) {
    return null;
  }
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  const nx = -(b[1] - a[1]);
  const ny = b[0] - a[0];
  const len = Math.hypot(nx, ny) || 1;
  const cx = mx + (nx / len) * bend;
  const cy = my + (ny / len) * bend;
  const d = `M${a[0]} ${a[1]}Q${cx} ${cy} ${b[0]} ${b[1]}`;
  const px = (1 - t) * (1 - t) * a[0] + 2 * (1 - t) * t * cx + t * t * b[0];
  const py = (1 - t) * (1 - t) * a[1] + 2 * (1 - t) * t * cy + t * t * b[1];
  const travelling = t < 1;
  return (
    <svg style={{ position: "absolute", inset: 0, opacity: 1 - gone }} width={1920} height={1080}>
      <path d={d} pathLength={1} fill="none" stroke={color} strokeOpacity={0.75} strokeWidth={width} strokeDasharray={`${t} 1`} />
      {travelling ? <circle cx={px} cy={py} r={width + 3} fill={color === C.accent ? C.accentHi : color} /> : null}
    </svg>
  );
};

/** A number that counts up with easing. */
export const Count: React.FC<{ to: number; from: number; dur?: number; start?: number; suffix?: string; prefix?: string }> = ({
  to,
  from,
  dur = 40,
  start = 0,
  suffix = "",
  prefix = "",
}) => {
  const frame = useCurrentFrame();
  const value = lerp(start, to, prog(frame, from, dur));
  return (
    <>
      {prefix}
      {Math.round(value)}
      {suffix}
    </>
  );
};

/** Faint H3-style hexagon field, fading out from one corner. */
export const HexField: React.FC<{ corner?: string; o?: number }> = ({ corner = "100% 0%", o = 0.55 }) => {
  const s = 30;
  const w = Math.sqrt(3) * s;
  const d = `M${w / 2} 0L${w} ${s / 2}V${1.5 * s}L${w / 2} ${2 * s}L0 ${1.5 * s}V${s / 2}ZM${w / 2} ${2 * s}V${3 * s}`;
  const mask = `radial-gradient(1100px 760px at ${corner}, black, transparent 72%)`;
  return (
    <svg width={1920} height={1080} style={{ position: "absolute", inset: 0, opacity: o, maskImage: mask, WebkitMaskImage: mask }}>
      <defs>
        <pattern id="hexf" width={w} height={3 * s} patternUnits="userSpaceOnUse">
          <path d={d} fill="none" stroke={C.line} strokeWidth={1} />
        </pattern>
      </defs>
      <rect width={1920} height={1080} fill="url(#hexf)" />
    </svg>
  );
};

/** Three-segment level, the product's confidence meter. */
export const Confidence: React.FC<{ from: number; level?: 1 | 2 | 3; label?: string }> = ({ from, level = 3, label = "High confidence" }) => {
  const frame = useCurrentFrame();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <span style={{ display: "flex", gap: 5 }}>
        {[0, 1, 2].map((i) => {
          const t = prog(frame, from + i * 5, 12);
          return (
            <span key={i} style={{ position: "relative", width: 34, height: 9, borderRadius: 9, background: C.lineStrong, overflow: "hidden" }}>
              {i < level ? <span style={{ position: "absolute", inset: 0, width: `${t * 100}%`, background: C.text, borderRadius: 9 }} /> : null}
            </span>
          );
        })}
      </span>
      <span style={{ fontFamily: FONT.sans, fontSize: 21, fontWeight: 500, color: C.text }}>{label}</span>
    </div>
  );
};

/** The product's segmented step track. `active` is a fractional step count. */
export const StepTrack: React.FC<{ steps: number; active: number; w: number; color?: string }> = ({ steps, active, w, color = C.accent }) => (
  <div style={{ display: "flex", gap: 4, width: w }}>
    {Array.from({ length: steps }, (_, i) => (
      <div key={i} style={{ flex: 1, height: 6, background: C.lineStrong, borderRadius: 2, overflow: "hidden" }}>
        <div style={{ width: `${interpolate(active - i, [0, 1], [0, 100], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}%`, height: "100%", background: color }} />
      </div>
    ))}
  </div>
);

/** A soft breathing outline for a node that is currently working. */
export const Working: React.FC<{ on: boolean; color?: string }> = ({ on, color = C.accent }) => {
  const frame = useCurrentFrame();
  return on ? (
    <div
      style={{
        position: "absolute",
        inset: -1,
        borderRadius: 8,
        border: `1.5px solid ${color}`,
        opacity: 0.35 + 0.65 * breathe(frame, 36),
        pointerEvents: "none",
      }}
    />
  ) : null;
};

/** Reveals children with a satellite-pass sweep (left to right by default). Never a cross-fade. */
export const Sweep: React.FC<{ from: number; dur?: number; children: React.ReactNode; dir?: "right" | "down"; color?: string; w?: number; h?: number }> = ({
  from,
  dur = 30,
  children,
  dir = "right",
  color = C.accentHi,
  w = 1920,
  h = 1080,
}) => {
  const frame = useCurrentFrame();
  const t = prog(frame, from, dur, EASE.travel);
  const clip = dir === "right" ? `inset(0 ${(1 - t) * 100}% 0 0)` : `inset(0 0 ${(1 - t) * 100}% 0)`;
  const scanning = t > 0 && t < 1;
  return (
    <div style={{ position: "absolute", inset: 0, width: w, height: h }}>
      <div style={{ position: "absolute", inset: 0, clipPath: clip }}>{children}</div>
      {scanning ? (
        <div
          style={
            dir === "right"
              ? { position: "absolute", top: 0, bottom: 0, left: `${t * 100}%`, width: 2, background: color }
              : { position: "absolute", left: 0, right: 0, top: `${t * 100}%`, height: 2, background: color }
          }
        />
      ) : null}
    </div>
  );
};

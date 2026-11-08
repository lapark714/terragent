import React from "react";
import { Easing, Img, staticFile, useCurrentFrame } from "remotion";
import { MONTAGE_PIN, MontageKey } from "../../choreography";
import { Chip, Mono, Panel } from "../../components/Primitives";
import { EASE, lerp, pop, prog, settle } from "../../motion";
import { C, COPY, FONT, H, hit, TIMING, W } from "../../tokens";
import { OVERLAY_DATA } from "./overlay-data";

export { OVERLAY_DATA };

/** Local frames of a scenario's hits. Scenes sit inside a Sequence, so absolute hit frames are converted here. */
export const hits = (key: MontageKey) => {
  const { from, to } = TIMING.scenes[key];
  return {
    from,
    dur: to - from,
    pin: hit(`${key}: pin`) - from,
    chip: hit(`${key}: chip`) - from,
    sweep: hit(`${key}: sweep`) - from,
    answer: hit(`${key}: answer`) - from,
  };
};

/** The camera for one plate. (ax, ay) is the point in close-plate pixels that sits under the pin tip. */
export type Cam = {
  key: MontageKey;
  ax: number;
  ay: number;
  sEnd: number;
  s0?: number;
  push?: number;
  /** Frames the dive takes after the pin hit (default: pin to sweep). */
  diveFrames?: number;
  /** No dive: the plate is simply there and keeps a slow push. */
  cut?: boolean;
  /** Moves the anchor over time, in plate pixels: a tracking shot. */
  track?: (frame: number) => readonly [number, number];
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

const diveFrames = (cam: Cam): number => {
  const { pin, sweep } = hits(cam.key);
  return cam.diveFrames ?? sweep - pin;
};

export const camScale = (cam: Cam, frame: number): number => {
  const { pin, dur } = hits(cam.key);
  const start = cam.cut ? 0 : pin;
  const logS = cam.cut ? Math.log(cam.sEnd) : lerp(Math.log(cam.s0 ?? 0.34), Math.log(cam.sEnd), prog(frame, pin, diveFrames(cam), EASE.travel));
  // The push speeds up slightly to the end of the scenario, so a hold never settles into a still.
  const t = clamp01((frame - start) / (dur - start));
  return Math.exp(logS) * (1 + (cam.push ?? 0.06) * (0.55 * t + 0.45 * t * t));
};

/** The anchor under the pin; a tracking shot moves it. */
const anchor = (cam: Cam, frame: number): [number, number] => {
  const [dx, dy] = cam.track ? cam.track(frame) : [0, 0];
  return [cam.ax + dx, cam.ay + dy];
};

export const toScreen = (cam: Cam, frame: number, x: number, y: number): [number, number] => {
  const s = camScale(cam, frame);
  const p = MONTAGE_PIN[cam.key];
  const [ax, ay] = anchor(cam, frame);
  return [p.x + (x - ax) * s, p.y + (y - ay) * s];
};

/** Starts fast, with the scan line already in frame on the hit, so the first colour lands on the whoosh. */
const SWEEP_EASE = Easing.bezier(0.25, 0.5, 0.35, 1);
export const Sweep: React.FC<{ from: number; dur?: number; children: React.ReactNode; dir?: "right" | "down"; color?: string; w?: number; h?: number }> = ({
  from,
  dur = 30,
  children,
  dir = "right",
  color = C.accentHi,
  w = W,
  h = H,
}) => {
  const frame = useCurrentFrame();
  const t = prog(frame, from - 2, dur, SWEEP_EASE);
  const clip = dir === "right" ? `inset(0 ${(1 - t) * 100}% 0 0)` : `inset(0 0 ${(1 - t) * 100}% 0)`;
  return (
    <div style={{ position: "absolute", inset: 0, width: w, height: h }}>
      <div style={{ position: "absolute", inset: 0, clipPath: clip }}>{children}</div>
      {t > 0 && t < 1 ? (
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

/** Everything inside shares the plate's camera: 1 unit = 1 close-plate pixel. */
export const PlateLayer: React.FC<{ cam: Cam; children: React.ReactNode; style?: React.CSSProperties }> = ({ cam, children, style }) => {
  const frame = useCurrentFrame();
  const s = camScale(cam, frame);
  const p = MONTAGE_PIN[cam.key];
  const [ax, ay] = anchor(cam, frame);
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: 2048,
        height: 1280,
        transformOrigin: "0 0",
        transform: `translate(${p.x - ax * s}px, ${p.y - ay * s}px) scale(${s})`,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

export const CoverImg: React.FC<{ src: string; style?: React.CSSProperties }> = ({ src, style }) => (
  <Img src={staticFile(src)} style={{ position: "absolute", left: 0, top: 0, width: 2048, height: 1280, ...style }} />
);

/** The optical plates: the wide mosaic, registered exactly under the close one, so one camera moves through both. */
export const Plate: React.FC<{ cam: Cam; filter?: string }> = ({ cam, filter = "brightness(0.8) saturate(0.92)" }) => {
  const reg = OVERLAY_DATA.reg[cam.key];
  return (
    <PlateLayer cam={cam} style={{ filter }}>
      <Img
        src={staticFile(`tiles/${cam.key}-wide.jpg`)}
        style={{ position: "absolute", left: reg.wideX, top: reg.wideY, width: 1024 * 8, height: 768 * 8 }}
      />
      <CoverImg src={`tiles/${cam.key}.jpg`} />
    </PlateLayer>
  );
};

const irisMax = (key: MontageKey) => {
  const p = MONTAGE_PIN[key];
  return Math.hypot(Math.max(p.x, W - p.x), Math.max(p.y, H - p.y)) + 30;
};

/** The hole the camera dives through, centred on the pin tip. Children are in screen space. */
export const Iris: React.FC<{ cam: Cam; column?: { x: number; w: number }; ring?: string; children: React.ReactNode }> = ({ cam, column, ring = C.accentHi, children }) => {
  const frame = useCurrentFrame();
  const { pin } = hits(cam.key);
  const open = cam.cut ? 1 : prog(frame, pin, diveFrames(cam), EASE.travel);
  const tip = MONTAGE_PIN[cam.key];
  const max = irisMax(cam.key);
  const r = lerp(0, max, open);
  return (
    <div style={{ position: "absolute", inset: 0, width: W, height: H }}>
      <div style={{ position: "absolute", inset: 0, width: W, height: H, clipPath: open >= 1 ? undefined : `circle(${Math.max(r, 0.01)}px at ${tip.x}px ${tip.y}px)` }}>
        {children}
        {column ? (
          <div
            style={{
              position: "absolute",
              left: column.x,
              top: 0,
              width: column.w,
              height: H,
              background: C.space,
              borderLeft: column.x > 0 ? `1px solid ${C.lineStrong}` : undefined,
              borderRight: column.x === 0 ? `1px solid ${C.lineStrong}` : undefined,
            }}
          />
        ) : null}
      </div>
      {open > 0 && open < 1 ? (
        <svg width={W} height={H} style={{ position: "absolute", inset: 0 }}>
          <circle cx={tip.x} cy={tip.y} r={r} fill="none" stroke={ring} strokeWidth={2} opacity={1 - open} />
        </svg>
      ) : null}
    </div>
  );
};

/** Horizontal whip: blurred along the travel direction only, which is what makes it read as camera speed. */
export const Whip: React.FC<{ id: string; dx: number; blur: number; children: React.ReactNode }> = ({ id, dx, blur, children }) => (
  <>
    {blur > 0.5 ? (
      <svg width={0} height={0} style={{ position: "absolute" }}>
        <filter id={id} x="-20%" y="0" width="140%" height="100%" colorInterpolationFilters="sRGB">
          <feGaussianBlur stdDeviation={`${blur} 0`} />
        </filter>
      </svg>
    ) : null}
    <div style={{ position: "absolute", inset: 0, transform: `translateX(${dx}px)`, filter: blur > 0.5 ? `url(#${id})` : undefined }}>{children}</div>
  </>
);

/** The question: mostly on screen on its first frame, finished within 0.3 s, then stays. `at` delays it. */
export const Question: React.FC<{ text: string; x: number; y: number; w: number; size?: number; at?: number }> = ({ text, x, y, w, size = 50, at = 0 }) => {
  const frame = useCurrentFrame();
  const s = settle(frame, at - 10);
  const shown = Math.ceil(text.length * prog(frame, at - 6, 18));
  const typing = shown < text.length;
  return (
    <Panel x={x} y={y} w={w} o={Math.min(1, s * 1.8)} style={{ transform: `translateY(${lerp(16, 0, s)}px)`, padding: "18px 24px 20px" }}>
      <div style={{ fontFamily: FONT.sans, fontSize: size, fontWeight: 500, lineHeight: 1.14, letterSpacing: "-0.012em", color: C.text, textWrap: "balance" }}>
        <span>{text.slice(0, shown)}</span>
        {typing ? <span style={{ borderRight: `3px solid ${C.accentHi}` }} /> : null}
        <span style={{ opacity: 0 }}>{text.slice(shown)}</span>
      </div>
    </Panel>
  );
};

/** Sensor chip: names the data type and why. */
export const SensorChip: React.FC<{ scene: MontageKey; x: number; y: number; color?: string; children: React.ReactNode }> = ({ scene, x, y, color, children }) => (
  <Chip from={hits(scene).chip} x={x} y={y} size={22} color={color}>
    {children}
  </Chip>
);

/** The answer card: one number or verdict, and the confidence meter. Lands on the answer hit. */
export const AnswerCard: React.FC<{
  scene: MontageKey;
  x: number;
  y: number;
  w: number;
  h?: number;
  rule?: string;
  children: React.ReactNode;
  level?: 1 | 2 | 3;
  label?: string;
  origin?: string;
}> = ({ scene, x, y, w, h, rule = C.accent, children, level = 3, label, origin = "right bottom" }) => {
  const frame = useCurrentFrame();
  const { answer } = hits(scene);
  // Starts early so the card is fully there on the hit frame.
  const s = pop(frame, answer - 9, 15);
  const line = prog(frame, answer - 6, 16, EASE.travel);
  return (
    <Panel x={x} y={y} w={w} h={h} o={Math.min(1, s * 1.5)} scale={lerp(0.92, 1, s)} origin={origin} style={{ padding: "22px 28px 24px" }}>
      <div style={{ position: "absolute", left: -1, top: -1, height: 3, width: `${line * 100}%`, background: rule, borderRadius: 2 }} />
      {children}
      <div style={{ marginTop: 16 }}>
        <Confidence from={answer - 2} level={level} label={label} />
      </div>
    </Panel>
  );
};

/** The product's three-segment meter, at the film's 22 px label floor. */
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
      <span style={{ fontFamily: FONT.sans, fontSize: 22, fontWeight: 500, color: C.text }}>{label}</span>
    </div>
  );
};

/** Answer line type: at least 48 px, wide cut. */
export const AnswerText: React.FC<{ size?: number; children: React.ReactNode; style?: React.CSSProperties }> = ({ size = 52, children, style }) => (
  <div style={{ fontFamily: FONT.sans, fontSize: size, fontWeight: 600, fontStretch: "125%", lineHeight: 1.06, letterSpacing: "-0.025em", color: C.text, textWrap: "balance", ...style }}>{children}</div>
);

/** Data credit for the imagery: on screen for every frame a tile is. `from` is when the imagery first shows. */
export const Credit: React.FC<{ scene: MontageKey; x: number; y: number; from?: number }> = ({ scene, x, y, from }) => {
  const frame = useCurrentFrame();
  const { pin } = hits(scene);
  const start = from ?? pin - 6;
  return (
    <Panel x={x} y={y} w={395} o={start <= 0 ? 1 : prog(frame, start, 6)} style={{ padding: "6px 12px", borderRadius: 5, textAlign: "center" }}>
      <Mono size={18} color={C.text2}>
        {COPY.eox}
      </Mono>
    </Panel>
  );
};

/** A small key panel for a data layer. */
export const Legend: React.FC<{ x: number; y: number; w: number; from: number; items: { color: string; label: string; ring?: boolean; dashed?: boolean }[] }> = ({ x, y, w, from, items }) => {
  const frame = useCurrentFrame();
  const s = pop(frame, from, 16);
  return (
    <Panel x={x} y={y} w={w} o={Math.min(1, s * 1.5)} scale={lerp(0.94, 1, s)} origin="left bottom" style={{ padding: "12px 16px" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {items.map((it) => (
          <div key={it.label} style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span
              style={{
                width: 18,
                height: 18,
                borderRadius: 3,
                flex: "none",
                background: it.ring ? "transparent" : it.color,
                border: it.ring ? `2px solid ${it.color}` : it.dashed ? `2px dashed ${C.text}` : undefined,
                boxSizing: "border-box",
              }}
            />
            <Mono size={22} color={C.text}>
              {it.label}
            </Mono>
          </div>
        ))}
      </div>
    </Panel>
  );
};

/** Polygon boundary traced around the plate, drawn on from `from`. */
export const Boundary: React.FC<{ pts: readonly (readonly [number, number])[]; from: number; dur?: number; color?: string; width?: number }> = ({
  pts,
  from,
  dur = 26,
  color = C.text,
  width = 4,
}) => {
  const frame = useCurrentFrame();
  const t = prog(frame, from, dur, EASE.travel);
  const d = `M${pts.map((p) => p.join(" ")).join("L")}Z`;
  return (
    <svg width={2048} height={1280} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
      <path d={d} fill="none" stroke={color} strokeWidth={width} pathLength={1} strokeDasharray={`${t} 1`} strokeLinejoin="round" />
    </svg>
  );
};

import React from "react";
import { Img, staticFile, useCurrentFrame } from "remotion";
import { Mono, Panel } from "../../components/Primitives";
import { breathe, EASE, lerp, prog, settle } from "../../motion";
import { C } from "../../tokens";
import { AnswerCard, AnswerText, Cam, camScale, Credit, hits, Legend, OVERLAY_DATA, Question, SensorChip, Sweep } from "./shared";

const KEY = "factory" as const;
const BASE = "saturate(0.15) brightness(0.55)";
const H_ = 1080;

type Rect = readonly [number, number, number, number];
const ROOFS = OVERLAY_DATA.factoryRoofs as unknown as Rect[];
const centreOf = (r: Rect) => [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2] as const;
const near = (a: readonly number[], b: readonly number[], d: number) => Math.hypot(a[0] - b[0], a[1] - b[1]) < d;

/** One plant: the tightest cluster of detected roofs. Its largest buildings existed; the rest are new. */
const SEED = ROOFS.map(centreOf).reduce((best, c) => {
  const n = (p: readonly number[]) => ROOFS.filter((r) => near(centreOf(r), p, 150)).length;
  return n(c) > n(best) ? c : best;
});
const PLANT = [...ROOFS].filter((r) => near(centreOf(r), SEED, 150)).sort((a, b) => (b[2] - b[0]) * (b[3] - b[1]) - (a[2] - a[0]) * (a[3] - a[1]));
const areaOf = (r: Rect) => (r[2] - r[0]) * (r[3] - r[1]);
const TOTAL = PLANT.reduce((s, r) => s + areaOf(r), 0);
/** The smallest roofs are the new ones, up to 18% of what already stood, to match the +18% on the card. */
const ADDED_COUNT = (() => {
  let area = 0;
  let n = 0;
  for (const r of [...PLANT].reverse()) {
    if ((area + areaOf(r)) / (TOTAL - area - areaOf(r)) > 0.18) {
      break;
    }
    area += areaOf(r);
    n += 1;
  }
  return n;
})();
const EXISTING = PLANT.slice(0, PLANT.length - ADDED_COUNT);
const ADDED = PLANT.slice(PLANT.length - ADDED_COUNT);
const CX = PLANT.reduce((s, r) => s + centreOf(r)[0], 0) / PLANT.length;
const CY = PLANT.reduce((s, r) => s + centreOf(r)[1], 0) / PLANT.length;

const CAM: Cam = { key: KEY, ax: CX, ay: CY, sEnd: 2.5, cut: true, push: 0.05 };

/** A window onto the plant at the shared camera, centred on (cx, cy) of the window. */
const PlantView: React.FC<{ x: number; w: number; cx: number; cy: number; frame: number; children: React.ReactNode }> = ({ x, w, cx, cy, frame, children }) => {
  const s = camScale(CAM, frame);
  return (
    <div style={{ position: "absolute", left: x, top: 0, width: w, height: H_, overflow: "hidden", background: C.space }}>
      <div style={{ position: "absolute", left: 0, top: 0, width: 2048, height: 1280, transformOrigin: "0 0", transform: `translate(${cx - CAM.ax * s}px, ${cy - CAM.ay * s}px) scale(${s})` }}>
        <Img src={staticFile("tiles/factory.jpg")} style={{ position: "absolute", left: 0, top: 0, width: 2048, height: 1280, filter: BASE }} />
        {children}
      </div>
    </div>
  );
};

const Footprints: React.FC<{ rects: Rect[]; fill: string; stroke: string; opacity?: number; dashOffset?: number }> = ({ rects, fill, stroke, opacity = 1, dashOffset }) => (
  <svg width={2048} height={1280} style={{ position: "absolute", inset: 0 }}>
    {rects.map((r, i) => (
      <rect
        key={i}
        x={r[0]}
        y={r[1]}
        width={r[2] - r[0]}
        height={r[3] - r[1]}
        fill={fill}
        fillOpacity={opacity}
        stroke={stroke}
        strokeWidth={1.4}
        strokeDasharray={dashOffset === undefined ? undefined : "5 3"}
        strokeDashoffset={dashOffset}
      />
    ))}
  </svg>
);

const SERIES = [0, 1.5, 3.8, 7.2, 11.6, 18];
const CHART = { x: 1264, y: 330, w: 560, h: 300, pad: 44 };
const BEFORE_W = 456;
const AFTER_X = BEFORE_W + 4;
const AFTER_W = 1240 - AFTER_X;
const PIN_Y = 560;

/** Two windows on the same plant: the small footprint it had, and what stands there now. */
export const Factory: React.FC = () => {
  const frame = useCurrentFrame();
  const { sweep, answer } = hits(KEY);
  const chartIn = prog(frame, sweep - 14, 18);
  const draw = prog(frame, sweep, answer - sweep + 14, EASE.travel);
  const cw = CHART.w - CHART.pad * 2;
  const ch = CHART.h - CHART.pad * 2 - 34;
  const x0 = CHART.x + CHART.pad;
  const y0 = CHART.y + CHART.h - CHART.pad;
  const px = (i: number) => x0 + (i / (SERIES.length - 1)) * cw;
  const py = (v: number) => y0 - (v / 20) * ch;
  const line = SERIES.map((v, i) => `${i ? "L" : "M"}${px(i)} ${py(v)}`).join("");
  const headIdx = Math.min(draw * (SERIES.length - 1), SERIES.length - 1 - 1e-6);
  const lo = Math.floor(headIdx);
  const hx = lerp(px(lo), px(lo + 1), headIdx - lo);
  const hy = lerp(py(SERIES[lo]), py(SERIES[lo + 1]), headIdx - lo);
  const beforeLabel = settle(frame, sweep + 4);
  const afterLabel = settle(frame, sweep + 22);
  return (
    <>
      <div style={{ position: "absolute", left: 0, top: 0, width: 1240, height: H_, background: C.space }} />
      <div style={{ position: "absolute", left: 1240, top: 0, width: 680, height: H_, background: C.space, borderLeft: `1px solid ${C.lineStrong}` }} />
      <PlantView x={0} w={BEFORE_W} cx={BEFORE_W / 2 + 40} cy={PIN_Y} frame={frame}>
        <Footprints rects={EXISTING} fill={C.accent} stroke={C.text} opacity={0.42} />
      </PlantView>
      <PlantView x={AFTER_X} w={AFTER_W} cx={860 - AFTER_X} cy={PIN_Y} frame={frame}>
        <Footprints rects={EXISTING} fill={C.accent} stroke={C.text} opacity={0.42} />
      </PlantView>
      <div style={{ position: "absolute", left: AFTER_X, top: 0, width: AFTER_W, height: H_ }}>
        <Sweep from={sweep} dur={40} color={C.accentHi} w={AFTER_W} h={H_}>
          <PlantView x={0} w={AFTER_W} cx={860 - AFTER_X} cy={PIN_Y} frame={frame}>
            <Footprints rects={EXISTING} fill={C.accent} stroke={C.text} opacity={0.42} />
            {/* New roofs keep a travelling outline for the whole hold. */}
            <Footprints rects={ADDED} fill={C.accentHi} stroke={C.text} opacity={0.62 + 0.2 * breathe(frame, 40)} dashOffset={-frame * 0.5} />
          </PlantView>
        </Sweep>
      </div>
      <div style={{ position: "absolute", left: BEFORE_W, top: 0, width: 4, height: H_, background: C.text }} />

      <SensorChip scene={KEY} x={96} y={64} color={C.accent}>
        30 cm optical · before / after change detection
      </SensorChip>
      <Panel x={96} y={132} w={330} o={beforeLabel} style={{ padding: "6px 12px", textAlign: "center" }}>
        <Mono size={22} color={C.text}>
          Footprint · 6 mo ago
        </Mono>
      </Panel>
      <Panel x={924} y={132} w={300} o={afterLabel} style={{ padding: "6px 12px", textAlign: "center" }}>
        <Mono size={22} color={C.text}>
          Footprint · now
        </Mono>
      </Panel>
      <Question text="How fast is this factory expanding?" x={1264} y={160} w={560} size={46} />
      <Panel x={CHART.x} y={CHART.y} w={CHART.w} h={CHART.h} o={chartIn} style={{ transform: `translateX(${lerp(24, 0, chartIn)}px)`, padding: "12px 22px" }}>
        <Mono size={22} color={C.text2}>
          BUILT AREA · CHANGE
        </Mono>
      </Panel>
      <svg width={1920} height={1080} style={{ position: "absolute", inset: 0, opacity: chartIn }}>
        {[0, 10, 20].map((v) => (
          <line key={v} x1={x0} y1={py(v)} x2={x0 + cw} y2={py(v)} stroke={C.line} strokeWidth={1} />
        ))}
        <path d={line} fill="none" stroke={C.accentHi} strokeWidth={4} pathLength={1} strokeDasharray={`${draw} 1`} strokeLinecap="round" strokeLinejoin="round" />
        <circle cx={hx} cy={hy} r={8 + 3 * breathe(frame, 30)} fill={C.accentHi} />
        <text x={px(0)} y={y0 + 28} fill={C.text3} fontFamily="'JetBrains Mono', monospace" fontSize={22} textAnchor="middle">
          −6 mo
        </text>
        <text x={px(SERIES.length - 1)} y={y0 + 28} fill={C.text3} fontFamily="'JetBrains Mono', monospace" fontSize={22} textAnchor="middle">
          now
        </text>
      </svg>
      <AnswerCard scene={KEY} x={1264} y={648} w={560} h={344} rule={C.accent}>
        <AnswerText size={116} style={{ color: C.accentHi }}>
          +18%
        </AnswerText>
        <AnswerText size={50} style={{ marginTop: 10 }}>
          built area in 6 months.
        </AnswerText>
      </AnswerCard>
      <Legend
        x={96}
        y={870}
        w={395}
        from={sweep + 26}
        items={[
          { color: C.accentHi, label: "New roofs", dashed: true },
          { color: C.accent, label: "Existing roofs" },
        ]}
      />
      <Credit scene={KEY} x={96} y={972} from={0} />
    </>
  );
};

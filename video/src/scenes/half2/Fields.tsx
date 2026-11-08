import React from "react";
import { useCurrentFrame } from "remotion";
import { Beacon, Mono, Panel, Title } from "../../components/Primitives";
import { breathe, EASE, lerp, prog } from "../../motion";
import { C } from "../../tokens";
import { AnswerCard, AnswerText, Cam, Credit, hits, Iris, OVERLAY_DATA, Plate, PlateLayer, Question, SensorChip, toScreen, Sweep } from "./shared";

const KEY = "fields" as const;
const CAM: Cam = { key: KEY, ax: 700, ay: 700, sEnd: 1.06, cut: true };
const QUESTION = "Which of my fields are drought-stressed this week?";

/** Pivots visible on the plate at the settled camera, ranked by measured stress. */
const VISIBLE = OVERLAY_DATA.fields
  .map((p) => ({ ...p, screen: [640 + (p.x - CAM.ax) * CAM.sEnd, 610 + (p.y - CAM.ay) * CAM.sEnd] as const }))
  .filter((p) => p.screen[0] > 130 && p.screen[0] < 1190 && p.screen[1] > 230 && p.screen[1] < 930)
  .sort((a, b) => b.stress - a.stress);

/** Greedy by stress, spaced so no two field labels collide and none sits under the pin. */
const LIST = VISIBLE.reduce<typeof VISIBLE>((kept, p, i) => {
  const clear = kept.every((k) => Math.hypot(k.x - p.x, k.y - p.y) > 210) && Math.hypot(p.x - CAM.ax, p.y - CAM.ay) > 130;
  // After the three worst, step down the ranking so the list spans the range.
  return clear && kept.length < 7 && (kept.length < 3 || i % 5 === 0) ? [...kept, p] : kept;
}, []);
const TOP = LIST.slice(0, 3);
const ORDER = [4, 2, 6, 0, 3, 1, 5]; // starting rows, before the ranking settles
const LABELS = ["F-12", "F-07", "F-31", "F-04", "F-22", "F-18", "F-27"];
const SHOWN = [94, 91, 87, 41, 36, 28, 19];

const ROW_H = 72;
/** Green to amber by listed stress; the top three are fully amber. */
const stressColor = (i: number) => {
  if (i < 3) {
    return C.mining;
  }
  const hex = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  const t = SHOWN[i] / 100;
  return `#${hex(lerp(0x1b, 0xb2, t))}${hex(lerp(0xa2, 0x8e, t))}${hex(lerp(0x94, 0x1e, t))}`;
};
/** Opens on the question alone, full-frame; the hard cut into the overhead lands with the pin on the beat. */
export const Fields: React.FC = () => {
  const frame = useCurrentFrame();
  const { pin, sweep, answer } = hits(KEY);
  if (frame < pin) {
    return (
      <>
        <div style={{ position: "absolute", inset: 0, background: C.space }} />
        <Title text={QUESTION} from={-14} to={pin + 40} x={96} y={330} w={1728} size={104} stagger={1} />
      </>
    );
  }
  const rank = prog(frame, sweep + 16, answer - sweep - 6, EASE.travel);
  const listIn = prog(frame, sweep - 14, 20);
  return (
    <>
      <Iris cam={CAM} column={{ x: 1224, w: 696 }}>
        <Plate cam={CAM} />
        <Sweep from={sweep} dur={34} dir="down" color={C.forest}>
          <PlateLayer cam={CAM}>
            <svg width={2048} height={1280} style={{ position: "absolute", inset: 0 }}>
              {LIST.map((p, i) => (
                <circle key={i} cx={p.x} cy={p.y} r={p.r} fill={stressColor(i)} fillOpacity={0.88} stroke={C.text} strokeWidth={2} />
              ))}
            </svg>
          </PlateLayer>
        </Sweep>
        {/* Only the three named fields are amber. Each gets its pivot arm sweeping: this is where the water goes. */}
        <PlateLayer cam={CAM}>
          <svg width={2048} height={1280} style={{ position: "absolute", inset: 0 }}>
            {TOP.map((p, i) => {
              const t = prog(frame, sweep + 18 + i * 5, 12);
              const a = (frame * 3.6 + i * 100) * (Math.PI / 180);
              return (
                <g key={i} opacity={t}>
                  <line x1={p.x} y1={p.y} x2={p.x + Math.cos(a) * p.r} y2={p.y + Math.sin(a) * p.r} stroke={C.space} strokeWidth={4} strokeLinecap="round" />
                </g>
              );
            })}
          </svg>
        </PlateLayer>
        {LIST.map((p, i) => {
          const [x, y] = toScreen(CAM, frame, p.x, p.y);
          const t = prog(frame, i < 3 ? answer - 12 + i * 5 : sweep + 26 + i * 3, 16);
          return (
            <React.Fragment key={i}>
              {i < 3 ? <Beacon x={x} y={y} color={C.mining} size={14} phase={i * 22} o={t} /> : null}
              <Panel x={x > 1060 ? x - 128 : x + 24} y={y - 46} w={104} o={t} style={{ padding: "4px 10px", textAlign: "center" }}>
                <Mono size={22} color={C.text}>
                  {LABELS[i]}
                </Mono>
              </Panel>
            </React.Fragment>
          );
        })}
      </Iris>
      <Question text={QUESTION} x={96} y={60} w={1104} size={46} at={pin - 16} />
      <SensorChip scene={KEY} x={96} y={182} color={C.forest}>
        Vegetation index + thermal
      </SensorChip>
      <Panel x={1248} y={160} w={576} h={578} o={listIn} style={{ transform: `translateX(${lerp(24, 0, listIn)}px)`, padding: "16px 22px" }}>
        <Mono size={22} color={C.text2}>
          FIELD · WATER STRESS
        </Mono>
        {LIST.map((_, i) => {
          const y = lerp(ORDER[i], i, rank);
          // Readings keep settling after the rank locks.
          const bar = prog(frame, sweep + 4 + ORDER[i] * 3, 24) * (1 + 0.035 * Math.sin((frame + i * 11) / 7) * prog(frame, answer - 4, 14) * (1 - prog(frame, answer + 60, 40) * 0.6));
          const top = i < 3;
          const emph = prog(frame, answer - 4, 12);
          return (
            <div key={i} style={{ position: "absolute", left: 22, right: 22, top: 58 + y * ROW_H, height: ROW_H - 10, display: "flex", alignItems: "center", gap: 16 }}>
              <span style={{ width: 94, flex: "none" }}>
                <Mono size={24} color={top ? C.text : C.text2}>
                  {LABELS[i]}
                </Mono>
              </span>
              <span style={{ flex: 1, height: 16, borderRadius: 3, background: C.line, overflow: "hidden" }}>
                <span style={{ display: "block", height: "100%", width: `${SHOWN[i] * bar}%`, background: stressColor(i), borderRadius: 3 }} />
              </span>
              <span style={{ width: 92, flex: "none", textAlign: "right" }}>
                <Mono size={22} color={top ? C.mining : C.text3} style={{ opacity: top ? (0.35 + 0.65 * emph) * (0.82 + 0.18 * breathe(frame, 24)) : 1 }}>
                  {Math.round(SHOWN[i] * bar)}%
                </Mono>
              </span>
            </div>
          );
        })}
      </Panel>
      <AnswerCard scene={KEY} x={1248} y={754} w={576} h={236} rule={C.mining} origin="right bottom">
        <AnswerText size={62}>3 fields need water first.</AnswerText>
      </AnswerCard>
      <Credit scene={KEY} x={96} y={972} from={0} />
    </>
  );
};

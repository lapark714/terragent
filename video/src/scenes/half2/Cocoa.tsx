import React from "react";
import { Img, staticFile, useCurrentFrame } from "remotion";
import { Beacon, Chip, Mono, Panel } from "../../components/Primitives";
import { EASE, lerp, pop, prog, seeded, settle } from "../../motion";
import { C } from "../../tokens";
import { Boundary, Cam, Confidence, Credit, hits, Iris, OVERLAY_DATA, Plate, Question, SensorChip, Sweep } from "./shared";

const KEY = "cocoa" as const;
const CAM: Cam = { key: KEY, ax: 1620, ay: 460, sEnd: 1.06, diveFrames: 18 };
const PARCEL = { x: 1305, y: 716 };
const YEARS = ["Dec 2020", "2021", "2022", "2023", "2024", "2025"];
const CELL_W = 276;
const GAP = 14;
const STRIP_X = 96;
const STRIP_Y = 252;
const CELL_H = 400;
const RAIL_Y = 690;
const COUNT = YEARS.length;
const CENTRE = (i: number) => STRIP_X + i * (CELL_W + GAP) + CELL_W / 2;

/** One year's layer on a shared, greyed base map: only the coloured index and alert grid is per-year. */
const Cell: React.FC<{ i: number; active: number; from: number; frame: number; dur: number }> = ({ i, active, from, frame, dur }) => {
  const x = STRIP_X + i * (CELL_W + GAP);
  const s = settle(frame, from + i * 3);
  const scale = 1.14 + 0.08 * Math.min(1, Math.max(0, (frame - from) / (dur - from)));
  const on = Math.abs(active - i) < 0.5;
  const cx = CELL_W / 2;
  const cy = 200;
  const layer = prog(frame, from + 8 + i * 5, 12);
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: STRIP_Y,
        width: CELL_W,
        height: CELL_H,
        overflow: "hidden",
        borderRadius: 6,
        border: `2px solid ${on ? C.forest : C.lineStrong}`,
        opacity: s,
        transform: `translateY(${lerp(18, 0, s)}px)`,
        background: C.panel,
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: 2048,
          height: 1280,
          transformOrigin: "0 0",
          transform: `translate(${cx - PARCEL.x * scale}px, ${cy - PARCEL.y * scale}px) scale(${scale})`,
        }}
      >
        <Img src={staticFile("tiles/cocoa.jpg")} style={{ position: "absolute", left: 0, top: 0, width: 2048, height: 1280, filter: "saturate(0.12) brightness(0.62)" }} />
        <Img src={staticFile(`overlays/cocoa-year-${i}.png`)} style={{ position: "absolute", left: 0, top: 0, width: 2048, height: 1280, opacity: layer }} />
        <Boundary pts={OVERLAY_DATA.cocoa.property} from={from + 4 + i * 3} color={C.text} width={3} />
      </div>
      {/* The alert grid scans: each cell's pass is staggered, so the strip never rests. */}
      <div style={{ position: "absolute", left: 0, right: 0, top: ((frame + i * 17) % 90) / 90 * CELL_H, height: 2, background: C.forest, opacity: layer * 0.85 }} />
      <Panel x={8} y={8} w={i === 0 ? 140 : 88} style={{ padding: "4px 8px", textAlign: "center", borderRadius: 4 }}>
        <Mono size={22} color={C.text}>
          {YEARS[i]}
        </Mono>
      </Panel>
      <Panel x={8} y={CELL_H - 48} w={CELL_W - 20} o={layer} style={{ padding: "3px 8px", textAlign: "center", borderRadius: 4, whiteSpace: "nowrap" }}>
        <Mono size={22} color={C.text}>
          <span style={{ color: C.forest }}>0</span> inside
        </Mono>
      </Panel>
    </div>
  );
};

export const Cocoa: React.FC = () => {
  const frame = useCurrentFrame();
  const { sweep, answer, chip, dur } = hits(KEY);
  const firstPass = prog(frame, sweep + 8, answer - sweep + 6, EASE.travel);
  // After the verdict the head keeps scrubbing back through the years, so the hold is never still.
  const secondPass = Math.sin(((frame - answer - 12) / (dur - answer - 12)) * Math.PI);
  const scrub = (frame < answer + 12 ? firstPass : 1 - 0.75 * Math.max(0, secondPass)) * (COUNT - 1);
  const stripIn = settle(frame, sweep);
  const answerS = pop(frame, answer - 9, 15);
  const headX = lerp(CENTRE(0), CENTRE(COUNT - 1), scrub / (COUNT - 1));
  const label = YEARS[Math.round(scrub)];
  const ticks = Array.from({ length: 22 }, (_, i) => ({ x: STRIP_X + 30 + seeded(i * 7 + 1) * (CELL_W * 6 + GAP * 5 - 60), h: 12 + seeded(i * 7 + 3) * 16 })).sort((a, b) => a.x - b.x);
  return (
    <>
      <Iris cam={CAM}>
        <Plate cam={CAM} filter={`brightness(${lerp(0.8, 0.3, stripIn)}) saturate(${lerp(0.85, 0.3, stripIn)})`} />
        <Sweep from={sweep} dur={30} color={C.forest}>
          {Array.from({ length: COUNT }, (_, i) => (
            <Cell key={i} i={i} active={scrub} from={sweep + 6} frame={frame} dur={dur} />
          ))}
        </Sweep>
      </Iris>
      <Beacon x={CENTRE(COUNT - 1)} y={STRIP_Y + 200} color={C.forest} size={14} o={prog(frame, answer - 4, 12)} />
      <Question text="Was this cocoa farm cleared after 2020?" x={96} y={60} w={1120} size={52} />
      <SensorChip scene={KEY} x={96} y={174} color={C.forest}>
        Sentinel-2 base map · forest-loss alerts
      </SensorChip>
      <Chip from={chip + 12} x={776} y={174} size={22} color={C.forest}>
        EU deforestation rule check
      </Chip>
      <svg width={1920} height={1080} style={{ position: "absolute", inset: 0, opacity: stripIn }}>
        <line x1={STRIP_X} y1={RAIL_Y} x2={STRIP_X + 6 * CELL_W + 5 * GAP} y2={RAIL_Y} stroke={C.lineStrong} strokeWidth={2} />
        {ticks.map((t, i) => (
          <line key={i} x1={t.x} y1={RAIL_Y} x2={t.x} y2={RAIL_Y - t.h * (headX >= t.x ? 1 : 0.2)} stroke={C.alert} strokeWidth={3} strokeOpacity={headX >= t.x ? 1 : 0.45} />
        ))}
      </svg>
      <div style={{ position: "absolute", left: headX - 96, top: RAIL_Y + 2, width: 192, opacity: stripIn, textAlign: "center" }}>
        <div style={{ width: 2, height: 12, background: C.forest, margin: "0 auto" }} />
        <div style={{ padding: "2px 10px", background: C.forest, borderRadius: 4, display: "inline-block" }}>
          <Mono size={24} color={C.space}>
            {label}
          </Mono>
        </div>
      </div>
      <Panel x={96} y={786} w={1728} h={152} o={Math.min(1, answerS * 1.5)} scale={lerp(0.95, 1, answerS)} origin="center bottom" style={{ padding: "20px 28px" }}>
        <div style={{ position: "absolute", left: -1, top: -1, height: 3, width: `${prog(frame, answer - 6, 16, EASE.travel) * 100}%`, background: C.forest }} />
        <div style={{ fontFamily: "Archivo, sans-serif", fontSize: 50, fontWeight: 600, fontStretch: "125%", letterSpacing: "-0.025em", lineHeight: 1.06, color: C.text, whiteSpace: "nowrap" }}>
          No clearing detected since Dec 2020 · <span style={{ color: C.forest }}>Compliant.</span>
        </div>
        <div style={{ marginTop: 14 }}>
          <Confidence from={answer - 2} />
        </div>
      </Panel>
      <Credit scene={KEY} x={96} y={972} />
    </>
  );
};

import React from "react";
import { useCurrentFrame } from "remotion";
import { Beacon, Mono } from "../../components/Primitives";
import { breathe, EASE, lerp, pop, prog } from "../../motion";
import { C, FONT } from "../../tokens";
import { AnswerText, Cam, Confidence, CoverImg, Credit, hits, Iris, OVERLAY_DATA, Plate, PlateLayer, Question, SensorChip, toScreen, Sweep } from "./shared";

const KEY = "methane" as const;
const m = OVERLAY_DATA.methane;
const STRIP_Y = 846;

/** The camera runs up the pipeline and stops at the leak: the plume is what it was tracking toward. */
const CAM: Cam = {
  key: KEY,
  ax: m.source[0],
  ay: m.source[1],
  sEnd: 1.12,
  cut: true,
  push: 0.05,
  track: (frame) => {
    const t = 1 - prog(frame, -4, 24, EASE.out);
    return [-620 * t, 398 * t];
  },
};

/** The plume's centre line in plate pixels, matching make_overlays.py. */
const THETA = (201 * Math.PI) / 180;
const pointAt = (along: number): [number, number] => {
  const k = Math.min(1, Math.max(0, along / 380));
  const meander = 44 * Math.sin(along / 92) * (k * k * (3 - 2 * k));
  return [m.source[0] + along * Math.cos(THETA) - meander * Math.sin(THETA), m.source[1] + along * Math.sin(THETA) + meander * Math.cos(THETA)];
};

export const Methane: React.FC = () => {
  const frame = useCurrentFrame();
  const { sweep, answer, dur } = hits(KEY);
  const [sx, sy] = toScreen(CAM, frame, m.source[0], m.source[1]);
  const drawn = prog(frame, -6, 26, EASE.travel);
  const pipe = `M${m.pipeline.map((p) => p.join(" ")).join("L")}`;
  const s = pop(frame, answer - 9, 15);
  const growth = prog(frame, sweep, dur - sweep, EASE.out);
  const packets = Array.from({ length: 7 }, (_, i) => (((frame - sweep + i * 26) % 180) + 180) % 180);
  return (
    <>
      <Iris cam={CAM}>
        <Plate cam={CAM} />
        <PlateLayer cam={CAM}>
          <svg width={2048} height={1280} style={{ position: "absolute", inset: 0 }}>
            <path d={pipe} fill="none" stroke={C.text} strokeWidth={3} strokeLinejoin="round" pathLength={1} strokeDasharray={`${drawn} 1`} opacity={0.75} />
          </svg>
        </PlateLayer>
        <Sweep from={sweep} dur={34} color={C.alert}>
          <PlateLayer cam={CAM} style={{ opacity: 0.84 + 0.16 * breathe(frame, 42) }}>
            {/* The plume keeps growing downwind for the whole hold. */}
            <CoverImg
              src="overlays/methane-plume.png"
              style={{ transformOrigin: `${m.source[0]}px ${m.source[1]}px`, transform: `scale(${1 + 0.1 * growth})` }}
            />
            <svg width={2048} height={1280} style={{ position: "absolute", inset: 0 }}>
              {packets.map((p, i) => {
                const [x, y] = pointAt(p * 2.6);
                return <circle key={i} cx={x} cy={y} r={7 + p * 0.06} fill={C.text} opacity={(1 - p / 180) * 0.85 * prog(frame, sweep + 18, 12)} />;
              })}
            </svg>
          </PlateLayer>
        </Sweep>
        <Beacon x={sx} y={sy} color={C.disaster} size={14} o={prog(frame, sweep + 14, 10)} />
      </Iris>

      <div style={{ position: "absolute", left: 0, top: STRIP_Y, width: 1920, height: 1080 - STRIP_Y, background: C.space, borderTop: `1px solid ${C.lineStrong}` }} />
      <div style={{ position: "absolute", left: 0, top: STRIP_Y - 1, height: 3, width: `${prog(frame, answer - 6, 16, EASE.travel) * 100}%`, background: C.alert }} />

      <Question text="Is this pipeline leaking methane?" x={96} y={868} w={800} size={50} />
      <SensorChip scene={KEY} x={96} y={972} color={C.alert}>
        Methane-sensing satellite · plume overlay
      </SensorChip>

      <div style={{ position: "absolute", left: 956, top: 868, width: 868, opacity: Math.min(1, s * 1.5), transform: `translateY(${lerp(14, 0, s)}px)` }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
          <div>
            <AnswerText size={52}>Plume detected</AnswerText>
            <div style={{ marginTop: 18 }}>
              <Confidence from={answer - 2} />
            </div>
            <div style={{ marginTop: 14 }}>
              <Mono size={22} color={C.text2}>
                est. rate
              </Mono>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
            <span style={{ fontFamily: FONT.mono, fontSize: 132, lineHeight: 1, fontWeight: 600, letterSpacing: "-0.04em", color: C.alert }}>120</span>
            <span style={{ fontFamily: FONT.mono, fontSize: 48, color: C.text }}>kg/h</span>
          </div>
        </div>
      </div>
      <Credit scene={KEY} x={96} y={786} from={0} />
    </>
  );
};

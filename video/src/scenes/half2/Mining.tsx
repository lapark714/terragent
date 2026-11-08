import React from "react";
import { Img, staticFile, useCurrentFrame } from "remotion";
import { MONTAGE_PIN } from "../../choreography";
import { Mono, Panel } from "../../components/Primitives";
import { EASE, lerp, prog, settle } from "../../motion";
import { C, W } from "../../tokens";
import { AnswerCard, AnswerText, Cam, camScale, Credit, hits, Question, SensorChip, toScreen, Sweep } from "./shared";

const KEY = "mining" as const;
const CAM: Cam = { key: KEY, ax: 1600, ay: 330, sEnd: 1.05, cut: true };
const BANDS = ["450 nm", "560 nm", "665 nm", "865 nm", "1610 nm", "2190 nm"];
const N = BANDS.length;
const STRIP = W / N;
const SPREAD = 22;
const dxOf = (i: number) => (i - (N - 1) / 2) * SPREAD;
/** The strip the film cuts in through: the one the pin will land in. */
const LEAD = Math.floor(MONTAGE_PIN[KEY].x / STRIP);

const plateTransform = (frame: number, x: number): string => {
  const s = camScale(CAM, frame);
  const p = MONTAGE_PIN[KEY];
  return `translate(${p.x - CAM.ax * s - x}px, ${p.y - CAM.ay * s}px) scale(${s})`;
};

const Fill: React.CSSProperties = { position: "absolute", left: 0, top: 0, width: 2048, height: 1280 };

/** One spectral band: a vertical slice of the claim in that band's ramp. Opens from its own centre line. */
const Strip: React.FC<{ i: number; frame: number; dim: number }> = ({ i, frame, dim }) => {
  const x = i * STRIP;
  const open = prog(frame, Math.abs(i - LEAD) * 2.5 - 6, 13, EASE.travel);
  const inset = (1 - open) * 50;
  return (
    <div style={{ position: "absolute", left: x + dxOf(i), top: 0, width: STRIP - 2, height: 1080, overflow: "hidden", clipPath: `inset(0 ${inset}% 0 ${inset}%)` }}>
      <div style={{ ...Fill, transformOrigin: "0 0", transform: plateTransform(frame, x) }}>
        <Img src={staticFile(`overlays/mining-band-${i}.jpg`)} style={{ ...Fill, filter: `saturate(${lerp(0.8, 0.32, dim)}) brightness(${lerp(0.92, 0.6, dim)})` }} />
      </div>
    </div>
  );
};

const IndicatorStrip: React.FC<{ i: number; frame: number; live: number }> = ({ i, frame, live }) => {
  const x = i * STRIP;
  return (
    <div style={{ position: "absolute", left: x + dxOf(i), top: 0, width: STRIP - 2, height: 1080, overflow: "hidden" }}>
      <div style={{ ...Fill, transformOrigin: "0 0", transform: plateTransform(frame, x) }}>
        <Img src={staticFile("overlays/mining-indicators.png")} style={{ ...Fill, opacity: 1 - live * 0.34 * (0.5 + 0.5 * Math.sin((frame + i * 20) / 11)) }} />
      </div>
    </div>
  );
};

/** No globe, no plate: a hard cut onto a single band of light that opens into the spectrum. */
export const Mining: React.FC = () => {
  const frame = useCurrentFrame();
  const { sweep, answer } = hits(KEY);
  const dim = prog(frame, sweep + 6, 30, EASE.travel);
  const labels = settle(frame, 8);
  const [bx0, by0] = toScreen(CAM, frame, 1180, 30);
  const [bx1, by1] = toScreen(CAM, frame, 2040, 540);
  const bo = prog(frame, answer - 14, 14);
  const left = Math.max(bx0, 96);
  const top = Math.max(by0, 200);
  const scanY = top + (((frame - answer + 200) % 72) / 72) * (by1 - top);
  return (
    <>
      <div style={{ position: "absolute", inset: 0, background: C.space }} />
      {BANDS.map((_, i) => (
        <Strip key={i} i={i} frame={frame} dim={dim} />
      ))}
      <Sweep from={sweep} dur={36} color={C.mining}>
        {BANDS.map((_, i) => (
          <IndicatorStrip key={i} i={i} frame={frame} live={prog(frame, answer, 20)} />
        ))}
      </Sweep>
      {BANDS.map((b, i) => (
        <Panel key={b} x={Math.min(1680, Math.max(96, i * STRIP + dxOf(i) + STRIP / 2 - 72))} y={154} w={144} o={labels} style={{ padding: "4px 8px", textAlign: "center", transform: `translateY(${lerp(-12, 0, labels)}px)` }}>
          <Mono size={22} color={C.text}>
            {b}
          </Mono>
        </Panel>
      ))}
      <svg width={1920} height={1080} style={{ position: "absolute", inset: 0, opacity: bo }}>
        <rect x={left} y={top} width={Math.min(bx1, 1824) - left} height={by1 - top} fill="none" stroke={C.mining} strokeWidth={3} strokeDasharray="14 10" strokeDashoffset={-frame * 0.8} rx={6} />
        <line x1={left} y1={scanY} x2={Math.min(bx1, 1824)} y2={scanY} stroke={C.mining} strokeWidth={3} opacity={0.85} />
      </svg>
      <Panel x={left + 12} y={top + 12} w={200} o={bo} style={{ padding: "6px 12px", textAlign: "center" }}>
        <Mono size={22} color={C.text}>
          NE quadrant
        </Mono>
      </Panel>
      <SensorChip scene={KEY} x={96} y={726} color={C.mining}>
        Hyperspectral bands · mineral indicators
      </SensorChip>
      <Question text="Any signs of iron-oxide alteration on this claim?" x={96} y={790} w={760} size={48} />
      <AnswerCard scene={KEY} x={1176} y={726} w={648} h={276} rule={C.mining} level={2} label="Medium confidence">
        <AnswerText size={56}>Strong iron-oxide indicators in the NE quadrant.</AnswerText>
      </AnswerCard>
      <Credit scene={KEY} x={96} y={972} from={0} />
    </>
  );
};

import React from "react";
import { useCurrentFrame } from "remotion";
import { Mono, Panel } from "../../components/Primitives";
import { breathe, EASE, lerp, prog, settle } from "../../motion";
import { C } from "../../tokens";
import { AnswerCard, AnswerText, Boundary, Cam, CoverImg, Credit, hits, Iris, OVERLAY_DATA, Plate, PlateLayer, Question, SensorChip, toScreen, Whip, Sweep } from "./shared";

const KEY = "vineyard" as const;
const CAM: Cam = { key: KEY, ax: 1360, ay: 820, sEnd: 1.12, cut: true };

/** No globe: this plate is caught mid-whip from the flood plate. */
export const Vineyard: React.FC = () => {
  const frame = useCurrentFrame();
  const { sweep } = hits(KEY);
  const arrive = prog(frame, 0, 16, EASE.out);
  const v = OVERLAY_DATA.vineyard;
  const [ex, ey] = v.fireEdge;
  const [px, py] = v.propertyEdge;
  const measure = prog(frame, sweep + 22, 24, EASE.travel);
  const [, fy] = toScreen(CAM, frame, ex, ey);
  const [qx, qy] = toScreen(CAM, frame, px, py);
  const labelS = settle(frame, sweep + 30);
  const my = (fy + qy) / 2;
  return (
    <Whip id="whip-vineyard" dx={2400 * (1 - arrive)} blur={(1 - arrive) * 70}>
      <Iris cam={CAM} column={{ x: 0, w: 640 }}>
        <Plate cam={CAM} />
        <div style={{ position: "absolute", left: 640, top: 0, width: 1280, height: 1080, overflow: "hidden" }}>
          <Sweep from={sweep} dur={36} color={C.disaster} w={1280} h={1080}>
            <div style={{ position: "absolute", left: -640, top: 0, width: 1920, height: 1080 }}>
              <PlateLayer cam={CAM}>
                <CoverImg src="overlays/vineyard-burn.png" style={{ opacity: 0.86 + 0.14 * breathe(frame, 46) }} />
              </PlateLayer>
            </div>
          </Sweep>
        </div>
        <PlateLayer cam={CAM}>
          <Boundary pts={v.property} from={sweep + 18} color={C.text} width={4} />
          {/* A pulse keeps walking the boundary: the vines are still being watched. */}
          <svg width={2048} height={1280} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
            <path d={`M${v.property.map((p) => p.join(" ")).join("L")}Z`} fill="none" stroke={C.accentHi} strokeWidth={5} pathLength={1} strokeDasharray="0.09 0.91" strokeDashoffset={-frame / 110} strokeLinecap="round" opacity={prog(frame, sweep + 44, 12)} />
          </svg>
        </PlateLayer>
        <svg width={1920} height={1080} style={{ position: "absolute", inset: 0 }}>
          <g opacity={measure > 0 ? 1 : 0}>
            <line x1={qx} y1={qy} x2={qx} y2={lerp(qy, fy, measure)} stroke={C.text} strokeWidth={4} />
            <line x1={qx - 16} y1={qy} x2={qx + 16} y2={qy} stroke={C.text} strokeWidth={4} />
            <line x1={qx - 16} y1={lerp(qy, fy, measure)} x2={qx + 16} y2={lerp(qy, fy, measure)} stroke={C.text} strokeWidth={4} />
          </g>
        </svg>
        <Panel x={qx - 208} y={my - 34} w={176} o={labelS} scale={lerp(0.86, 1, labelS)} origin="right center" style={{ padding: "10px 12px", textAlign: "center" }}>
          <Mono size={36} color={C.text} style={{ fontWeight: 600, opacity: 0.8 + 0.2 * breathe(frame, 30) }}>
            340 m
          </Mono>
        </Panel>
      </Iris>
      <Question text="Did the fire reach this vineyard?" x={96} y={190} w={480} size={52} at={6} />
      <SensorChip scene={KEY} x={96} y={424} color={C.disaster}>
        Burn severity · dNBR
      </SensorChip>
      <AnswerCard scene={KEY} x={96} y={540} w={510} h={344} rule={C.disaster} origin="left bottom">
        <AnswerText size={50}>Fire stopped</AnswerText>
        <AnswerText size={118} style={{ margin: "10px 0 6px", color: C.alert }}>
          340<span style={{ fontSize: 56 }}> m</span>
        </AnswerText>
        <AnswerText size={50}>from the vines.</AnswerText>
      </AnswerCard>
      <Credit scene={KEY} x={1429} y={972} from={0} />
    </Whip>
  );
};

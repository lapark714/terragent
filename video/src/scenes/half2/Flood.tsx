import React from "react";
import { useCurrentFrame } from "remotion";
import { EASE, prog } from "../../motion";
import { C } from "../../tokens";
import { AnswerCard, AnswerText, Cam, Credit, CoverImg, hits, Iris, Legend, OVERLAY_DATA, Plate, PlateLayer, Question, SensorChip, Whip, Sweep } from "./shared";
import { MontageSlam } from "./Tag";

const KEY = "flood" as const;
const CAM: Cam = { key: KEY, ax: 985, ay: 720, sEnd: 1.07 };

/** Flood is the only full orbit-to-ground dive; it leaves on a whip that the vineyard plate catches. */
export const Flood: React.FC = () => {
  const frame = useCurrentFrame();
  const { sweep, answer, dur } = hits(KEY);
  const whip = prog(frame, dur - 12, 12, EASE.in);
  const sites = OVERLAY_DATA.floodSites;
  const ring = (i: number) => (((frame - answer + 8 + 140 - (i % 7) * 14) % 70) + 70) % 70 / 70;
  return (
    <>
      <Whip id="whip-flood" dx={-2400 * whip} blur={whip * 70}>
        <Iris cam={CAM}>
          <Plate cam={CAM} />
          <Sweep from={sweep} dur={36} color={C.water}>
            <PlateLayer cam={CAM}>
              {/* The pass turns the optical plate into radar tones; blue is left for water alone. */}
              <CoverImg src="tiles/flood.jpg" style={{ filter: "grayscale(1) brightness(0.56) contrast(1.08)" }} />
              {/* The extent keeps creeping outward from the river through the hold. */}
              <CoverImg src="overlays/flood.png" style={{ transformOrigin: "985px 720px", transform: `scale(${1 + 0.03 * prog(frame, sweep, dur - sweep, EASE.travel)})` }} />
              <svg width={2048} height={1280} style={{ position: "absolute", inset: 0 }}>
                {sites.map((p, i) => {
                  const lit = prog(frame, sweep + 16 + (p.x / 2048) * 16, 8);
                  const size = p.wet ? 22 : 13;
                  return p.wet ? (
                    <g key={i} opacity={lit}>
                      <rect x={p.x - size / 2} y={p.y - size / 2} width={size} height={size} fill={C.disaster} stroke={C.text} strokeWidth={2.5} rx={3} />
                      {/* After the answer, each wet site pings in turn. */}
                      <circle cx={p.x} cy={p.y} r={size * (1 + 2.2 * ring(i))} fill="none" stroke={C.disaster} strokeWidth={3} opacity={(1 - ring(i)) * (frame >= answer - 8 ? 0.95 : 0)} />
                    </g>
                  ) : (
                    <rect key={i} x={p.x - size / 2} y={p.y - size / 2} width={size} height={size} fill={C.space} fillOpacity={0.4} stroke={C.text2} strokeWidth={2} rx={2} opacity={lit} />
                  );
                })}
              </svg>
            </PlateLayer>
          </Sweep>
        </Iris>
        <Question text="Which of our 40 warehouses flooded last night?" x={96} y={64} w={930} size={52} at={34} />
        <SensorChip scene={KEY} x={96} y={228} color={C.water}>
          SAR radar · sees through storm cloud at night
        </SensorChip>
        <Legend
          x={96}
          y={784}
          w={395}
          from={sweep + 24}
          items={[
            { color: C.water, label: "Flood extent" },
            { color: C.disaster, label: "Site under water" },
            { color: C.text2, label: "Site dry", ring: true },
          ]}
        />
        <AnswerCard scene={KEY} x={1200} y={764} w={624} h={252} rule={C.water}>
          <AnswerText size={92}>7 of 40</AnswerText>
          <AnswerText size={48} style={{ marginTop: 8 }}>
            sites under water
          </AnswerText>
        </AnswerCard>
        <Credit scene={KEY} x={96} y={972} />
      </Whip>
      <MontageSlam />
    </>
  );
};

import React from "react";
import { Img, staticFile, useCurrentFrame } from "remotion";
import { LOCKUP, project } from "../../choreography";
import { Beacon, Title } from "../../components/Primitives";
import { EASE, prog } from "../../motion";
import { C, COPY, f, TIMING } from "../../tokens";

const { from: FROM, to: TO } = TIMING.scenes.signoff;
const DUR = TO - FROM;
const LAND = f(57.5) - FROM;
/** Answers the film has already given, still lit as the planet turns under the sign-off. */
const SITES = [[31, 35], [25, 55], [28, 77], [20, 85], [35, 105], [13, 100]] as const;
const MARK_RIGHT = 153 / 805; // the mark's right edge inside the lockup file

/**
 * The lockup file is shown only from the wordmark onward: the mark inside it is the global pin, which has landed on
 * the same pixels and stays on screen. So the mark is never drawn twice.
 */
export const Signoff: React.FC = () => {
  const frame = useCurrentFrame();
  const reveal = prog(frame, LAND + 2, 34, EASE.travel);
  const left = MARK_RIGHT * 100;
  const right = (1 - reveal) * (100 - left);
  const url = `url(${staticFile("brand/lockup.png")})`;
  const orbit = (Math.PI * (200 + (frame / DUR) * 140)) / 180;
  return (
    <>
      {/* A soft veil so the lines hold over the limb; the globe still reads through it. */}
      <div style={{ position: "absolute", left: 260, top: 450, width: 1400, height: 210, background: "radial-gradient(closest-side, rgba(10,21,35,0.82), rgba(10,21,35,0))", opacity: prog(frame, LAND - 6, 24) }} />
      <Title text={COPY.signoffA} from={LAND} to={DUR + 40} x={96} y={486} w={1728} size={70} align="center" />
      <Title text={COPY.signoffB} from={f(58.15) - FROM} to={DUR + 40} x={96} y={588} w={1728} size={40} align="center" color={C.text2} stagger={2} />
      {SITES.map(([lat, lon], i) => {
        const p = project(lat, lon, frame + FROM);
        return p.visible && p.y > 690 ? <Beacon key={i} x={p.x} y={p.y} color={C.accentHi} size={10} phase={i * 26} o={prog(frame, LAND + 10 + i * 8, 14)} /> : null;
      })}
      {/* A satellite keeps crossing above the turning limb to the last frame. */}
      <Beacon x={960 + Math.cos(orbit) * 500} y={1180 + Math.sin(orbit) * 500} color={C.text} size={9} o={prog(frame, 6, 14)} />
      <div
        style={{
          position: "absolute",
          left: LOCKUP.cx - LOCKUP.w / 2,
          top: LOCKUP.cy - LOCKUP.h / 2,
          width: LOCKUP.w,
          height: LOCKUP.h,
          background: C.text,
          maskImage: url,
          WebkitMaskImage: url,
          maskSize: "100% 100%",
          WebkitMaskSize: "100% 100%",
          maskRepeat: "no-repeat",
          WebkitMaskRepeat: "no-repeat",
          clipPath: `inset(0 ${right}% 0 ${left}%)`,
        }}
      >
        <Img src={staticFile("brand/lockup.png")} style={{ width: 0, height: 0, opacity: 0 }} />
      </div>
    </>
  );
};

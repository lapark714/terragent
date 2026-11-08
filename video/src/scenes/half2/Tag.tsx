import React from "react";
import { useCurrentFrame } from "remotion";
import { Mono } from "../../components/Primitives";
import { EASE, lerp, prog, settle } from "../../motion";
import { C, COPY, FONT, hit, TIMING } from "../../tokens";

const PANEL = { x: 1408, y: 54, w: 416, h: 92 };
const TEXT = { cx: PANEL.x + PANEL.w / 2, cy: PANEL.y + 32 };
const SIZE = 30;
const SLAM_SCALE = 4.4;
const SLAM = { cx: 960, cy: 420 };

/** Shrink finishes after the flood pin lands; the slam holds for the whole fall. */
const LAND = hit("flood: pin") - TIMING.scenes.flood.from;

const tagText: React.CSSProperties = {
  fontFamily: FONT.sans,
  fontSize: SIZE,
  fontWeight: 600,
  fontStretch: "125%",
  letterSpacing: "-0.02em",
  color: C.text,
  whiteSpace: "nowrap",
};

const Backing: React.FC<{ o: number }> = ({ o }) => (
  <div
    style={{
      position: "absolute",
      left: PANEL.x,
      top: PANEL.y,
      width: PANEL.w,
      height: PANEL.h,
      background: "rgba(14, 28, 45, 0.94)",
      border: `1px solid ${C.lineStrong}`,
      borderRadius: 8,
      opacity: o,
    }}
  />
);

const Sub: React.FC<{ o: number }> = ({ o }) => (
  <div style={{ position: "absolute", left: PANEL.x, width: PANEL.w, top: PANEL.y + 54, textAlign: "center", opacity: o }}>
    <Mono size={22} color={C.text2}>
      Illustrative scenarios
    </Mono>
  </div>
);

/** The settled tag: the same pixels in every scenario, so it reads as one persistent object. */
export const MontageTag: React.FC = () => (
  <>
    <Backing o={1} />
    <div style={{ position: "absolute", left: PANEL.x, width: PANEL.w, top: TEXT.cy - 21, textAlign: "center", ...tagText }}>{COPY.montageTag}</div>
    <Sub o={1} />
  </>
);

/** Frame 1800: the line slams in full-frame on the drop, holds through the pin's fall, then shrinks into the tag. */
export const MontageSlam: React.FC = () => {
  const frame = useCurrentFrame();
  const landed = settle(frame, -3);
  const shrink = prog(frame, LAND - 2, 22, EASE.travel);
  const scale = lerp(SLAM_SCALE * lerp(1.05, 1, landed), 1, shrink);
  return (
    <>
      <Backing o={prog(frame, LAND + 10, 10)} />
      <div
        style={{
          position: "absolute",
          left: lerp(SLAM.cx, TEXT.cx, shrink),
          top: lerp(SLAM.cy, TEXT.cy, shrink),
          transform: `translate(-50%, -50%) scale(${scale})`,
          ...tagText,
        }}
      >
        {COPY.montageTag}
      </div>
      <Sub o={prog(frame, LAND + 22, 10)} />
    </>
  );
};

/** Adds the persistent tag on top of a scenario. */
export const withTag = (Scene: React.FC): React.FC => {
  const Tagged: React.FC = () => (
    <>
      <Scene />
      <MontageTag />
    </>
  );
  return Tagged;
};

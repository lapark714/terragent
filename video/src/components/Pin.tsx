import { Img, staticFile, useCurrentFrame } from "remotion";
import { MARK_ASPECT, MARK_TIP_X, MARK_TIP_Y, pinAt } from "../choreography";
import { C } from "../tokens";

/** The founders' mark, drawn only from the supplied file: a mask filled with the brand text colour. */
export const Mark: React.FC<{ h: number; color?: string; style?: React.CSSProperties }> = ({ h, color = C.text, style }) => {
  const url = `url(${staticFile("brand/mark.png")})`;
  return (
    <div
      style={{
        width: h * MARK_ASPECT,
        height: h,
        background: color,
        maskImage: url,
        WebkitMaskImage: url,
        maskSize: "contain",
        WebkitMaskSize: "contain",
        maskRepeat: "no-repeat",
        WebkitMaskRepeat: "no-repeat",
        ...style,
      }}
    >
      {/* Forces Remotion to wait for the mask image to load before capturing the frame. */}
      <Img src={staticFile("brand/mark.png")} style={{ width: 0, height: 0, opacity: 0 }} />
    </div>
  );
};

/** A small independent pin at a fixed tip position, for tiles and converging pins. */
export const SmallPin: React.FC<{ x: number; y: number; h: number; o?: number }> = ({ x, y, h, o = 1 }) => (
  <div style={{ position: "absolute", left: x - h * MARK_ASPECT * MARK_TIP_X, top: y - h * MARK_TIP_Y, opacity: o }}>
    <Mark h={h} />
  </div>
);

/** The film's one pin. It sits above every scene, driven only by PIN in choreography.ts. */
export const PinLayer: React.FC = () => {
  const frame = useCurrentFrame();
  const p = pinAt(frame);
  if (p.o <= 0.001) {
    return null;
  }
  const width = p.h * MARK_ASPECT;
  return (
    <div
      style={{
        position: "absolute",
        left: p.x - width * MARK_TIP_X,
        top: p.y - p.h * MARK_TIP_Y,
        opacity: p.o,
        transform: `scale(${1 + p.squash}, ${1 - p.squash})`,
        transformOrigin: `${MARK_TIP_X * 100}% ${MARK_TIP_Y * 100}%`,
        filter: "drop-shadow(0 6px 18px rgba(10, 21, 35, 0.8))",
      }}
    >
      <Mark h={p.h} />
    </div>
  );
};

import { Easing, interpolate, spring } from "remotion";
import { TIMING } from "./tokens";

const fps = TIMING.fps;
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** Ease families. Nothing in this film moves linearly. */
export const EASE = {
  /** Arrive slowly enough to read, leave fast. */
  travel: Easing.bezier(0.7, 0, 0.18, 1),
  out: Easing.bezier(0.16, 1, 0.3, 1),
  in: Easing.bezier(0.6, 0, 0.9, 0.3),
};

/** 0→1 over [from, from+dur], eased out. */
export const prog = (frame: number, from: number, dur: number, easing = EASE.out): number =>
  interpolate(frame, [from, from + Math.max(dur, 1)], [0, 1], { ...clamp, easing });

/** A spring with slight overshoot: nodes opening, cards landing. */
export const pop = (frame: number, from: number, damping = 13): number =>
  spring({ frame: frame - from, fps, config: { damping, stiffness: 170, mass: 0.7 } });

/** A settled spring without overshoot. */
export const settle = (frame: number, from: number): number =>
  spring({ frame: frame - from, fps, config: { damping: 200, stiffness: 120, mass: 0.8 } });

/** In at `from`, out before `to`: use for an element's opacity or reveal across its scene. */
export const inOut = (frame: number, from: number, to: number, inDur = 14, outDur = 10): number =>
  Math.min(prog(frame, from, inDur), 1 - prog(frame, to - outDur, outDur, EASE.in));

/** Deterministic random in [0, 1). Never use Math.random in a render. */
export const seeded = (seed: number): number => {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453123;
  return x - Math.floor(x);
};

/** Pulse in [0, 1], for beacons and breathing holds. */
export const breathe = (frame: number, period = 60, phase = 0): number =>
  0.5 + 0.5 * Math.sin(((frame + phase) / period) * Math.PI * 2);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

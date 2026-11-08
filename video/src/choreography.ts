/**
 * The film's two continuous objects: the pin and the globe. Scenes do not own them. Each station is a place the
 * object arrives at a given frame, so the pin occupies the same pixels on both sides of every scene boundary.
 * Scene builders anchor their nodes to these coordinates; change a station here and the handoff moves with it.
 */
import { EASE, lerp } from "./motion";
import { f, H, hit, TIMING, W } from "./tokens";

export type PinStation = {
  /** Frame the pin arrives. */
  at: number;
  /** Frames spent travelling to get here. */
  dur: number;
  /** Tip position in screen pixels. */
  x: number;
  y: number;
  /** Rendered mark height in pixels. */
  h: number;
  /** Lift of the travel path in pixels. */
  arc?: number;
  /** Falls straight down and lands with a squash. */
  drop?: boolean;
  /** 0 hides the pin. */
  o?: number;
};

const S = TIMING.scenes;

/** Where the pin lands in each montage scenario. The camera dive and scene layout are built around this point. */
export const MONTAGE_PIN = {
  flood: { x: 960, y: 640 },
  vineyard: { x: 1290, y: 600 },
  fields: { x: 640, y: 610 },
  // On the latest frame of the filmstrip.
  cocoa: { x: 1686, y: 452 },
  // In the indicator cluster of the NE quadrant: the pin lands on the answer.
  mining: { x: 1420, y: 330 },
  methane: { x: 1300, y: 660 },
  // On the plant, in the "after" window.
  factory: { x: 860, y: 560 },
} as const;
export type MontageKey = keyof typeof MONTAGE_PIN;

/** `continuous` means the pin is already in the air (the drop at 30 s) and falls straight onto this scenario. */
const montagePin = (key: MontageKey, continuous = false): PinStation[] => {
  const at = hit(`${key}: pin`);
  const p = MONTAGE_PIN[key];
  return [
    ...(continuous ? [] : [{ at: S[key].from, dur: 1, x: p.x, y: -40, h: 110, o: 0 }]),
    { at, dur: at - S[key].from, x: p.x, y: p.y, h: 110, drop: true, o: 1 },
    { at: at + f(0.5), dur: f(0.5), x: p.x, y: p.y, h: 92, o: 1 },
    // Leaves upward just before the next scenario begins.
    { at: S[key].to, dur: f(0.25), x: p.x, y: -60, h: 92, o: 1 },
  ];
};

export const PIN: PinStation[] = [
  // Frame one is the pin mid-drop over the globe.
  { at: 0, dur: 1, x: 960, y: 452, h: 170 },
  { at: hit("pin lands on globe"), dur: 30, x: 960, y: 650, h: 170, drop: true },
  { at: f(3.25), dur: f(0.5), x: 1400, y: 640, h: 90, arc: 70 },
  { at: hit("signal to sourcing"), dur: f(0.4), x: 1040, y: 330, h: 64, arc: 60 },
  { at: hit("sourcing to outreach"), dur: f(0.35), x: 1040, y: 770, h: 64, arc: 40 },
  { at: S.planner.from, dur: f(0.5), x: 360, y: 300, h: 64, arc: 90 },
  { at: S.routing.from, dur: f(0.5), x: 260, y: 560, h: 64, arc: 40 },
  { at: S.pricing.from, dur: f(0.5), x: 960, y: 300, h: 64, arc: 40 },
  { at: S.analysis.from, dur: f(0.5), x: 300, y: 400, h: 64, arc: 70 },
  { at: hit("interpreter"), dur: f(0.35), x: 960, y: 400, h: 64, arc: 60 },
  { at: hit("verifier rejects"), dur: f(0.35), x: 1620, y: 400, h: 64, arc: 60 },
  // Rejected: the loop snaps back over the top of the cards.
  { at: hit("loop back") + f(0.15), dur: f(0.15), x: 960, y: 400, h: 64, arc: 110 },
  { at: hit("verifier passes 92/100"), dur: f(0.35), x: 1620, y: 400, h: 64, arc: 60 },
  { at: S.delivery.from, dur: f(0.5), x: 620, y: 240, h: 64, arc: 50 },
  { at: hit("report emailed"), dur: f(0.5), x: 1500, y: 330, h: 64, arc: 60 },
  { at: hit("hex joins index"), dur: f(0.35), x: 1500, y: 770, h: 64, arc: 30 },
  { at: S.mission.from, dur: f(0.6), x: 960, y: 590, h: 120, arc: 40 },
  // Rises above the full-frame line, once the first line has read.
  { at: f(27.7), dur: f(0.5), x: 960, y: 330, h: 96 },
  // Apex on the drop; the same pin then falls in one motion onto the first scenario.
  { at: f(30), dur: f(0.5), x: 960, y: 170, h: 120 },
  ...montagePin("flood", true),
  ...montagePin("vineyard"),
  ...montagePin("fields"),
  ...montagePin("cocoa"),
  ...montagePin("mining"),
  ...montagePin("methane"),
  ...montagePin("factory"),
  { at: S.rapid.from + 1, dur: 1, x: 960, y: -60, h: 58, o: 0 },
  // The rapid scene's lead pin arrives here at 57.0; this pin takes over on the same pixels, with no overlap.
  { at: f(57) - 1, dur: 1, x: 960, y: 500, h: 120, o: 0 },
  { at: f(57), dur: 1, x: 960, y: 500, h: 120, o: 1 },
  // Final position is computed so the mark overlays the mark inside the lockup; see Signoff.
  { at: f(57.5), dur: f(0.5), x: 0, y: 0, h: 0, o: 1, arc: 34 },
];

/**
 * Lockup geometry for the sign-off, measured from the alpha of public/brand/{lockup,mark}.png.
 * Inside the 805×147 lockup the mark spans x 4–153 and ends at y 139. In the 512×474 mark file it spans x 2–508.
 */
export const LOCKUP = { h: 124, w: (124 * 805) / 147, cx: 960, cy: 400 } as const;
export const MARK_ASPECT = 512 / 474;
export const MARK_TIP_X = 0.439;
/** Share of the mark file's height where the pin's tip ends. */
export const MARK_TIP_Y = 468 / 474;
const lockupScale = LOCKUP.h / 147;
const finalMarkWidth = (149 * lockupScale * 512) / 506;
const finalPin = PIN[PIN.length - 1];
finalPin.h = finalMarkWidth / MARK_ASPECT;
finalPin.x = LOCKUP.cx - LOCKUP.w / 2 + 4 * lockupScale - (2 * finalMarkWidth) / 512 + finalMarkWidth * MARK_TIP_X;
finalPin.y = LOCKUP.cy - LOCKUP.h / 2 + 139 * lockupScale;

const stationsSorted = [...PIN].sort((a, b) => a.at - b.at);

export type PinPose = { x: number; y: number; h: number; o: number; squash: number };

export const pinAt = (frame: number): PinPose => {
  let i = 0;
  while (i + 1 < stationsSorted.length && stationsSorted[i + 1].at <= frame) {
    i += 1;
  }
  const cur = stationsSorted[i];
  const next = stationsSorted[i + 1];
  const landed = frame - cur.at;
  // A damped wobble after landing: follow-through, no pop.
  const squash = cur.drop && landed >= 0 && landed < 20 ? Math.exp(-landed / 6) * Math.cos(landed / 2.2) * 0.16 : 0;
  const base = { x: cur.x, y: cur.y, h: cur.h, o: cur.o ?? 1, squash };
  if (!next || frame < next.at - next.dur) {
    return base;
  }
  const raw = (frame - (next.at - next.dur)) / next.dur;
  const t = next.drop ? raw * raw : EASE.travel(raw);
  return {
    x: lerp(cur.x, next.x, t),
    y: lerp(cur.y, next.y, t) - (next.arc ?? 0) * 4 * t * (1 - t),
    h: lerp(cur.h, next.h, t),
    o: lerp(cur.o ?? 1, next.o ?? 1, t),
    squash: 0,
  };
};

export type GlobeStation = {
  at: number;
  dur: number;
  lat: number;
  lon: number;
  /** Camera distance in globe radii. */
  dist: number;
  /** Screen position of the globe centre. */
  cx: number;
  cy: number;
  /** Brightness multiplier. */
  dim: number;
  /** Share of the constant slow turn applied here: 0 while aiming at a target. */
  drift: number;
};

const PLACE = {
  flood: [30.45, -91.18],
  vineyard: [38.5, -122.35],
  fields: [37.9, -100.9],
  cocoa: [5.8, -6.6],
  mining: [-22.7, 117.8],
  methane: [31.9, -102.3],
  factory: [25.75, -100.2],
} as const;

/** Hard cut to a start pose, a short approach, then the dive. `frames` is the dive length after the pin hit. */
const dive = (key: MontageKey, start?: readonly [number, number, number], frames?: number, approachDim = 1): GlobeStation[] => {
  const [lat, lon] = PLACE[key];
  const p = MONTAGE_PIN[key];
  const from = S[key].from;
  const pin = hit(`${key}: pin`);
  const end = pin + (frames ?? hit(`${key}: sweep`) - pin);
  const [sLat, sLon, sDist] = start ?? [lat - 8, lon - 18, 3.5];
  return [
    { at: from, dur: 1, lat: sLat, lon: sLon, dist: sDist, cx: p.x, cy: p.y, dim: approachDim, drift: 0 },
    { at: pin, dur: pin - from, lat, lon, dist: 2.2, cx: p.x, cy: p.y, dim: approachDim, drift: 0 },
    // The dive itself ends when the plate has taken over the frame.
    { at: end, dur: end - pin, lat, lon, dist: 1.06, cx: p.x, cy: p.y, dim: 1, drift: 0 },
  ];
};

export const GLOBE: GlobeStation[] = [
  { at: 0, dur: 1, lat: 14, lon: -68, dist: 3.1, cx: 960, cy: 740, dim: 1, drift: 1 },
  { at: f(3.25), dur: f(0.5), lat: 28, lon: -96, dist: 4.2, cx: 1400, cy: 560, dim: 0.9, drift: 1 },
  { at: f(7), dur: f(0.5), lat: 22, lon: -100, dist: 5.6, cx: 1500, cy: 620, dim: 0.42, drift: 1 },
  { at: f(11), dur: f(0.4), lat: 20, lon: -105, dist: 7, cx: 960, cy: 560, dim: 0.3, drift: 1 },
  { at: f(21), dur: f(0.4), lat: 34, lon: -110, dist: 4.4, cx: 1480, cy: 600, dim: 0.78, drift: 1 },
  { at: f(25), dur: f(0.6), lat: 10, lon: -112, dist: 3.8, cx: 960, cy: 625, dim: 0.5, drift: 1 },
  // Dims under the full-frame line.
  { at: f(27.7), dur: f(0.5), lat: 10, lon: -112, dist: 3.8, cx: 960, cy: 625, dim: 0.14, drift: 1 },
  { at: f(30), dur: f(0.25), lat: 22, lon: -100, dist: 3.5, cx: 960, cy: 640, dim: 1, drift: 0 },
  // Held dim until the slam shrinks, so city lights do not run through the line.
  ...dive("flood", [22, -100, 3.5], undefined, 0.35),
  ...dive("vineyard"),
  ...dive("fields"),
  // Comes from an Africa-facing globe.
  ...dive("cocoa", [6, 18, 2.7], 18),
  ...dive("mining"),
  ...dive("methane", [36, -58, 2.5], 18),
  ...dive("factory"),
  { at: S.rapid.from, dur: 1, lat: 12, lon: -40, dist: 5, cx: 960, cy: 540, dim: 0.3, drift: 1 },
  // Turns at three times the base rate; lon is offset so the pose is continuous where the rate changes.
  { at: S.signoff.from, dur: f(0.7), lat: 14, lon: -60 - 2 * 0.035 * S.signoff.from, dist: 2.8, cx: 960, cy: 1180, dim: 0.95, drift: 3 },
].sort((a, b) => a.at - b.at);

/** Slow constant turn, degrees per frame. */
const DRIFT = 0.035;

export const globeAt = (frame: number): GlobeStation => {
  let i = 0;
  while (i + 1 < GLOBE.length && GLOBE[i + 1].at <= frame) {
    i += 1;
  }
  const a = GLOBE[i];
  const b = GLOBE[i + 1];
  const pose = (s: GlobeStation, t: number) => ({ ...s, lon: s.lon + DRIFT * t * s.drift });
  if (!b || frame < b.at - b.dur) {
    return pose(a, frame);
  }
  const t = EASE.travel((frame - (b.at - b.dur)) / b.dur);
  const pa = pose(a, frame);
  const pb = pose(b, frame);
  return {
    at: frame,
    dur: 0,
    lat: lerp(pa.lat, pb.lat, t),
    lon: lerp(pa.lon, pb.lon, t),
    // Distance interpolates in log space, so a dive accelerates perceptually evenly.
    dist: Math.exp(lerp(Math.log(a.dist), Math.log(b.dist), t)),
    cx: lerp(a.cx, b.cx, t),
    cy: lerp(a.cy, b.cy, t),
    dim: lerp(a.dim, b.dim, t),
    drift: 1,
  };
};

export const GLOBE_FOV = 40;

/** Screen position of a lat/lon at the given frame, for HTML labels tracked to the 3D globe. */
export const project = (lat: number, lon: number, frame: number): { x: number; y: number; visible: boolean } => {
  const g = globeAt(frame);
  const phi = (lat * Math.PI) / 180;
  const lam = (lon * Math.PI) / 180;
  // Texture convention of THREE.SphereGeometry.
  const px = Math.cos(phi) * Math.cos(lam);
  const py = Math.sin(phi);
  const pz = -Math.cos(phi) * Math.sin(lam);
  const ry = (-(90 + g.lon) * Math.PI) / 180;
  const rx = (g.lat * Math.PI) / 180;
  const x1 = px * Math.cos(ry) + pz * Math.sin(ry);
  const z1 = -px * Math.sin(ry) + pz * Math.cos(ry);
  const y2 = py * Math.cos(rx) - z1 * Math.sin(rx);
  const z2 = py * Math.sin(rx) + z1 * Math.cos(rx);
  const scale = H / 2 / Math.tan((GLOBE_FOV * Math.PI) / 360);
  const depth = g.dist - z2;
  return { x: g.cx + (x1 * scale) / depth, y: g.cy - (y2 * scale) / depth, visible: z2 > 0.1 };
};

export const SCREEN = { W, H };

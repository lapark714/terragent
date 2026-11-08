import timingJson from "./timing.json";

/** Brand colours, exact hexes from src/app/globals.css in the product. Layer colours mean data, never decoration. */
export const C = {
  space: "#0a1523",
  panel: "#0e1c2d",
  raised: "#142739",
  line: "#1d3249",
  lineStrong: "#2c4864",
  text: "#e7eef6",
  text2: "#a6b7ca",
  text3: "#7d92a9",
  accent: "#7f83f0",
  accentHi: "#9a9df5",
  disaster: "#d9434f",
  forest: "#1ba294",
  mining: "#b28e1e",
  water: "#4aa3df",
  human: "#f2a7c0",
  alert: "#f08a7a",
} as const;

export const FONT = {
  sans: "Archivo, sans-serif",
  mono: "'JetBrains Mono', monospace",
} as const;

export const W = 1920;
export const H = 1080;
/** 5% safe margin: nothing readable sits outside it. */
export const SAFE = { x: 96, y: 54 } as const;

export type TimedEvent = { t: number; frame: number; kind: string; label: string };
export type SceneKey = keyof typeof timingJson.scenes;

export const TIMING = timingJson as unknown as {
  fps: number;
  bpm: number;
  durationInFrames: number;
  beats: number[];
  drop: number;
  lockup: number;
  scenes: Record<SceneKey, { from: number; to: number }>;
  cuts: number[];
  events: TimedEvent[];
};

/** Seconds to frames. All authored times are on the 0.25 s grid, so this is always an integer. */
export const f = (seconds: number): number => Math.round(seconds * TIMING.fps);

/** Frame of the event whose label matches exactly. Throws on a typo, so a mistimed hit fails loudly. */
export const hit = (label: string): number => {
  const event = TIMING.events.find((e) => e.label === label);
  if (!event) {
    throw new Error(`No timing event labelled "${label}"`);
  }
  return event.frame;
};

/** All on-screen sentences live here, so copy can be changed and fact-checked in one place. */
export const COPY = {
  ask: "Ask anything. Anywhere on Earth.",
  signals: "Or we find you first.",
  planner: "An agent plans the job.",
  routing: "Routes it to the right satellites.",
  pricing: "Prices it. Gets paid.",
  analysis: "Analyzes it. Checks its own work.",
  delivery: "Delivers the answer.",
  missionA: "12 agents. Zero humans in the loop.",
  missionB: "The whole company runs itself.",
  credit: "Orchestrated on Naïve",
  montageTag: "What you could ask",
  signoffA: "Ask about any place on Earth.",
  signoffB: "Run by AI agents.",
  eox: "Sentinel-2 cloudless 2016 © EOX",
} as const;

export const AGENTS = [
  "Coordinator",
  "Customer comms",
  "Supplier comms",
  "Outreach",
  "Planner",
  "Acquisition",
  "Pricing",
  "Interpreter",
  "Analytics",
  "Verifier",
  "Sourcing",
  "Market research",
] as const;

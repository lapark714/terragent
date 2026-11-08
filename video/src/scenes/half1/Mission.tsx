import { useCurrentFrame } from "remotion";
import { Beacon, Mono, Title } from "../../components/Primitives";
import { breathe, EASE, lerp, prog } from "../../motion";
import { AGENTS, C, COPY, f, FONT, hit, TIMING } from "../../tokens";
import { IndexHexes, Stage } from "./shared";

const S = TIMING.scenes.mission;
/** The ring and pin rise together, then the first line clears for the second. */
const RISE = f(27.2) - S.from;
const LINE_A_END = f(27.6) - S.from;
const LINE_B_FROM = f(27.4) - S.from;
const LINE_B_END = f(29.5) - S.from;
const COLLAPSE = f(29.2) - S.from;

const ORDER: readonly (typeof AGENTS)[number][] = ["Coordinator", "Customer comms", "Planner", "Acquisition", "Supplier comms", "Pricing", "Analytics", "Interpreter", "Verifier", "Sourcing", "Outreach", "Market research"];

const PILL_H = 48;

const ringAt = (local: number) => {
  const enter = prog(local, -18, 26);
  const rise = prog(local, RISE, 30, EASE.travel);
  const collapse = prog(local, COLLAPSE, 22, EASE.in);
  return {
    enter,
    collapse,
    cy: lerp(590, 330, rise),
    rx: lerp(lerp(720, 620, rise), 0, collapse) * enter,
    ry: lerp(lerp(285, 170, rise), 0, collapse) * enter,
  };
};

/** Twelve agents orbiting the pin. Absolute frame, so the ring opens out of the pin before the cut. */
export const MissionRing: React.FC<{ abs: number }> = ({ abs }) => {
  const local = abs - S.from;
  const { enter, collapse, cy, rx, ry } = ringAt(local);
  const cx = 960;
  // The ring turns as a whole with a slight surge; the satellite laps it.
  const spin = ((local + 18) / 320) * Math.PI * 2 * 0.62 + Math.sin(local / 50) * 0.05;
  const sat = spin + ((local + 18) / 88) * Math.PI * 2;
  return (
    <>
      <Stage o={enter * (1 - collapse)}>
        <ellipse cx={cx} cy={cy} rx={Math.max(rx, 0.01)} ry={Math.max(ry, 0.01)} fill="none" stroke={C.lineStrong} strokeWidth={1.25} />
        <circle cx={cx + Math.sin(sat) * rx} cy={cy - Math.cos(sat) * ry} r={7} fill={C.accentHi} />
      </Stage>
      {ORDER.map((name, i) => {
        const at = hit(`agent ${i + 1}`);
        const pulse = abs >= at ? 1 - prog(abs, at, 28) : 0;
        const a = (i / 12) * Math.PI * 2 + spin;
        const x = cx + Math.sin(a) * rx;
        const y = cy - Math.cos(a) * ry;
        const near = Math.pow(Math.max(0, Math.cos(sat - a)), 22);
        const lit = Math.max(pulse, near);
        const w = 26 + name.length * 13.4 + 52;
        return (
          <div key={name} style={{ position: "absolute", left: x - w / 2, top: y - PILL_H / 2, width: w, height: PILL_H, opacity: Math.min(1, enter * 1.4) * (1 - collapse), transform: `scale(${(lerp(0.72, 1, enter) + pulse * 0.24) * lerp(1, 0.4, collapse)})`, background: "rgba(14, 28, 45, 0.94)", border: `1px solid ${lit > 0.3 ? C.accent : C.lineStrong}`, borderRadius: 8, boxSizing: "border-box" }}>
            <div style={{ position: "absolute", inset: 0, background: C.accent, opacity: pulse * 0.8, borderRadius: 7 }} />
            <Beacon x={22} y={PILL_H / 2} color={pulse > 0.4 ? C.text : C.accent} size={9} phase={i * 13} />
            <span style={{ position: "absolute", left: 40, top: 0, lineHeight: `${PILL_H - 2}px`, fontFamily: FONT.mono, fontSize: 22, color: C.text, whiteSpace: "nowrap" }}>{name}</span>
          </div>
        );
      })}
    </>
  );
};

export const MissionCounters: React.FC<{ abs: number }> = ({ abs }) => {
  const local = abs - S.from;
  const agents = ORDER.reduce((n, _, i) => n + (abs >= hit(`agent ${i + 1}`) ? 1 : 0), 0);
  const steps = Math.round(lerp(0, 7, prog(local, 8, 40, EASE.travel)));
  const enter = prog(local, -14, 14);
  const gone = prog(local, COLLAPSE, 16, EASE.in);
  return (
    <div style={{ position: "absolute", left: 360, top: 906, width: 1200, height: 110, opacity: enter * (1 - gone), transform: `translateY(${lerp(20, 0, enter)}px)`, background: "rgba(14, 28, 45, 0.94)", border: `1px solid ${C.lineStrong}`, borderRadius: 8, display: "flex", boxSizing: "border-box" }}>
      {[
        { label: "Job steps run by agents", value: `${steps}`, color: C.text },
        { label: "Agents working", value: `${agents}`, color: C.text },
        { label: "Human interventions", value: "0", color: C.human },
      ].map((c, i) => (
        <div key={c.label} style={{ flex: 1, position: "relative", borderLeft: i ? `1px solid ${C.line}` : "none", display: "flex", alignItems: "center", gap: 18, padding: "0 28px" }}>
          <span style={{ fontFamily: FONT.mono, fontSize: 56, fontWeight: 500, color: c.color, letterSpacing: "-0.02em", minWidth: 62 }}>{c.value}</span>
          <span style={{ fontFamily: FONT.mono, fontSize: 22, color: i === 2 ? C.human : C.text2, lineHeight: 1.15, opacity: i === 2 ? 0.85 + 0.15 * breathe(abs, 50) : 1 }}>{c.label}</span>
        </div>
      ))}
    </div>
  );
};

export const Mission: React.FC = () => {
  const frame = useCurrentFrame();
  const abs = frame + S.from;
  const scrim = Math.min(prog(frame, LINE_B_FROM, 14), 1 - prog(frame, LINE_B_END - 12, 12, EASE.in));

  return (
    <>
      <IndexHexes abs={abs} grown={1} o={1 - prog(frame, 16, 50, EASE.in)} />
      <MissionRing abs={abs} />
      <Title text={COPY.missionA} from={0} to={LINE_A_END} x={96} y={62} size={72} align="center" />

      {/* A dark band separates the full-frame line from the globe's limb. */}
      <div style={{ position: "absolute", left: 0, right: 0, top: 560, height: 310, opacity: scrim, background: "linear-gradient(to bottom, rgba(10, 21, 35, 0) 0%, rgba(10, 21, 35, 0.94) 26%, rgba(10, 21, 35, 0.94) 74%, rgba(10, 21, 35, 0) 100%)" }} />
      <Title text={COPY.missionB} from={LINE_B_FROM} to={LINE_B_END} x={96} y={640} size={84} align="center" stagger={2} />
      <div style={{ position: "absolute", left: 0, right: 0, top: 770, textAlign: "center", opacity: prog(frame, LINE_B_FROM + 16, 14) * (1 - prog(frame, LINE_B_END - 12, 12, EASE.in)) }}>
        <Mono size={25} color={C.text2}>{COPY.credit}</Mono>
      </div>

      <MissionCounters abs={abs} />
    </>
  );
};

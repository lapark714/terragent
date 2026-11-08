import { useCurrentFrame } from "remotion";
import { Edge, Mono, Title } from "../../components/Primitives";
import { breathe, EASE, lerp, pop, prog, seeded, settle } from "../../motion";
import { C, COPY, FONT, TIMING } from "../../tokens";
import { ACQUISITION_TIP, Check, hexPath, lerpRect, localHit, MaskUp, Node, pillRect, PLANNER_TIP, Stage, type Pt, type Rect } from "./shared";
import { SourceRows } from "./Routing";
import { OutreachEmail, ReplyPulse } from "./Signals";

const S = TIMING.scenes.planner;
const h = localHit(S.from);
const END = S.to - S.from;

const OPEN: Rect = { x: 240, y: PLANNER_TIP[1], w: 860, h: 540 };
const CENTER: Pt = [1500, 620];
const R = 52;

const ROWS = [
  { k: "AREA", v: "38.50°N 122.35°W", at: "spec area" },
  { k: "DATES", v: "Before and after the fire", at: "spec dates" },
  { k: "SENSOR", v: "Sentinel-2", at: "spec sensor" },
  { k: "METHOD", v: "Burn severity (dNBR)", at: "spec method" },
];

const CELLS: { q: number; r: number; ring: number }[] = [];
for (let q = -2; q <= 2; q += 1) {
  for (let r = Math.max(-2, -q - 2); r <= Math.min(2, -q + 2); r += 1) {
    CELLS.push({ q, r, ring: Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) });
  }
}
const cellXY = (q: number, r: number): Pt => [CENTER[0] + R * Math.sqrt(3) * (q + r / 2), CENTER[1] + R * 1.5 * r];
const KNOWN: Pt = cellXY(1, -1);
/** Search order for the index scan, ending on the cell that turns out to be known. */
const SCAN = CELLS.map((c, i) => ({ i, known: c.q === 1 && c.r === -1, angle: Math.atan2(c.r, c.q) + c.ring * 2 })).sort((a, b) => Number(a.known) - Number(b.known) || a.angle - b.angle);

export const Planner: React.FC = () => {
  const frame = useCurrentFrame();
  const abs = frame + S.from;
  const openAt = h("planner opens");
  const handoff = h("planner to acquisition");
  const known = h("index hit: already known");
  const areaAt = h("spec area");
  const open = pop(frame, openAt, 16);
  const close = settle(frame, handoff - 20);
  const rect = lerpRect(pillRect(PLANNER_TIP), OPEN, open * (1 - close));
  const content = Math.min(prog(frame, openAt + 6, 12), 1 - prog(frame, handoff - 22, 12, EASE.in));
  const indexStart = 2;
  const scanFrom = h("spec dates") + 8;
  const scanStep = (known - scanFrom) / SCAN.length;
  const indexGone = prog(frame, END - 34, 28, EASE.in);
  const lit = pop(frame, known, 11);
  const ring = prog(frame, known, 34);
  const hexDraw = prog(frame, areaAt, 28, EASE.travel);
  const acq = prog(frame, END - 20, 18);

  return (
    <>
      {frame < 40 ? <OutreachEmail abs={abs} /> : null}
      {frame < 20 ? <ReplyPulse abs={abs} /> : null}
      <Edge a={[1400, 654]} b={[PLANNER_TIP[0], PLANNER_TIP[1] + 72]} from={5} dur={10} bend={340} until={30} />
      {frame >= END - 16 ? <SourceRows abs={abs} /> : null}
      <Title text={COPY.planner} from={0} to={END} x={1130} y={92} w={700} size={72} />

      {/* The index the Planner checks before it buys anything. */}
      <Stage o={1 - indexGone}>
        {CELLS.map((c, i) => {
          const s = pop(frame, indexStart + c.ring * 6 + i * 0.7, 14);
          const [x, y] = cellXY(c.q, c.r);
          const measured = seeded(i + 40) > 0.42;
          const order = SCAN.findIndex((o) => o.i === i);
          const flash = Math.max(0, 1 - Math.abs(frame - (scanFrom + order * scanStep)) / 9);
          if (s <= 0.001) {
            return null;
          }
          return (
            <path
              key={i}
              d={hexPath(x, y, (R - 2) * Math.min(1.04, s))}
              fill={C.accent}
              fillOpacity={(measured ? 0.1 + 0.08 * breathe(frame, 70, i * 9) : 0.02) + flash * 0.6}
              stroke={C.accent}
              strokeOpacity={Math.min(1, (measured ? 0.85 : 0.42) + flash)}
              strokeWidth={1.25}
            />
          );
        })}
        <path d={hexPath(KNOWN[0], KNOWN[1], 49 + ring * 58)} fill="none" stroke={C.forest} strokeWidth={2} strokeOpacity={frame >= known ? 1 - ring : 0} />
        {frame >= known ? (
          <>
            <path d={hexPath(KNOWN[0], KNOWN[1], 50 * Math.min(1.1, lit))} fill={C.forest} />
            <Check x={KNOWN[0]} y={KNOWN[1]} size={38} t={prog(frame, known + 2, 12)} color={C.text} width={4.5} />
          </>
        ) : null}
      </Stage>
      <Edge a={[OPEN.x + OPEN.w, 470]} b={[KNOWN[0] - 42, KNOWN[1]]} from={known - 18} dur={18} bend={36} until={handoff - 8} />
      <Edge a={[KNOWN[0], KNOWN[1] + 50]} b={[1500, 884]} from={known + 2} dur={12} color={C.forest} until={END - 16} bend={-30} />
      <div style={{ position: "absolute", left: 1190, top: 884, width: 620, height: 112, opacity: prog(frame, known + 4, 12) * (1 - indexGone), transform: `scale(${lerp(0.9, 1, prog(frame, known + 4, 14))})` }}>
        <div style={{ position: "absolute", inset: 0, background: "rgba(14, 28, 45, 0.94)", border: `1px solid ${C.forest}`, borderRadius: 8, padding: "12px 20px", boxSizing: "border-box", fontFamily: FONT.sans }}>
          <Mono size={24} color={C.text2}>EARTH INDEX</Mono>
          <div style={{ fontSize: 30, fontWeight: 600, color: C.text, marginTop: 2, whiteSpace: "nowrap" }}>Baseline known · needs fresh imagery</div>
        </div>
      </div>

      <Node rect={rect} name="Planner" working={frame > openAt && frame < handoff - 20} right={<Mono size={22} color={C.text3} style={{ opacity: content, whiteSpace: "nowrap" }}>DATA SPEC</Mono>}>
        <div style={{ position: "absolute", left: 0, top: 72, width: OPEN.w, height: OPEN.h - 72, opacity: content }}>
          <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: 1, background: C.line }} />
          <div style={{ position: "absolute", left: 0, top: 20 + ROWS.reduce((y, row, i) => y + (i ? prog(frame, h(row.at) - 14, 14, EASE.travel) * 110 : 0), 0), width: 4, height: 84, background: C.accent, borderRadius: 2 }} />
          {ROWS.map((row, i) => {
            const at = h(row.at);
            const t = prog(frame, at, 18);
            return (
              <div key={row.k} style={{ position: "absolute", left: 24, top: 22 + i * 110, width: 540 }}>
                <Mono size={22} color={frame >= at ? C.accentHi : C.text3}>{row.k}</Mono>
                <MaskUp t={t} style={{ marginTop: 6 }}>
                  <span style={{ fontSize: 33, fontWeight: 500, color: C.text, whiteSpace: "nowrap" }}>{row.v}</span>
                </MaskUp>
                <div style={{ marginTop: 14, height: 1, width: 500, background: C.line, transform: `scaleX(${t})`, transformOrigin: "left" }} />
              </div>
            );
          })}
          <svg width={280} height={460} style={{ position: "absolute", left: 572, top: 0 }}>
            <path d={hexPath(140, 195, 124)} pathLength={1} fill={C.accent} fillOpacity={0.1 * hexDraw} stroke={C.accentHi} strokeWidth={2} strokeDasharray={`${hexDraw} 1`} />
            <circle cx={140} cy={195} r={7} fill={C.accentHi} opacity={hexDraw} />
            <circle cx={140} cy={195} r={14 + 12 * breathe(frame, 44)} fill="none" stroke={C.accentHi} strokeWidth={1.25} opacity={hexDraw * 0.6} />
          </svg>
          <div style={{ position: "absolute", left: 572, top: 352, width: 280, textAlign: "center", opacity: hexDraw }}>
            <Mono size={22} color={C.text}>H3 hex outline</Mono>
          </div>
        </div>
      </Node>

      <Edge a={[PLANNER_TIP[0], PLANNER_TIP[1] + 72]} b={ACQUISITION_TIP} from={handoff} dur={END - handoff} until={END + 30} />
      <Node rect={pillRect(ACQUISITION_TIP)} name="Acquisition" o={acq} />
    </>
  );
};

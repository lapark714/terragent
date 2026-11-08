import { Img, staticFile, useCurrentFrame } from "remotion";
import { Edge, Mono, StepTrack, Sweep, Title } from "../../components/Primitives";
import { breathe, EASE, lerp, pop, prog, seeded, settle } from "../../motion";
import { C, COPY, FONT, TIMING } from "../../tokens";
import { AnalysisStops } from "./AnalysisStops";
import { REPORT_RECT, ReportBody } from "./Delivery";
import { ANALYTICS_TIP, CheckIcon, CrossIcon, INTERPRETER_TIP, lerpRect, localHit, Node, pillRect, VERIFIER_TIP, type Rect } from "./shared";

const S = TIMING.scenes.analysis;
const h = localHit(S.from);
const END = S.to - S.from;
const TOP = 400;
const HEIGHT = 470;

const ANALYTICS: Rect = { x: 96, y: TOP, w: 540, h: HEIGHT };
const INTERPRETER: Rect = { x: 704, y: TOP, w: 512, h: HEIGHT };
const VERIFIER: Rect = { x: 1284, y: TOP, w: 540, h: HEIGHT };
/** The sandbox fills the frame while it works, then gives up the room to the next two agents. */
export const SANDBOX_RECT: Rect = { x: 96, y: TOP, w: 1728, h: 500 };
const TILE = { w: 348, h: 316 };
const LINE_STEP = 11;
const ANSWER = "Fire stopped 340 m from the vines.";

const TERMINAL: { text: string; done?: boolean; color?: string }[] = [
  { text: "$ start sandbox" },
  { text: "$ load sentinel-2 before, after" },
  { text: "water extent", done: true, color: C.water },
  { text: "burn severity (dNBR)", done: true, color: C.disaster },
  { text: "vegetation change", done: true, color: C.forest },
  { text: "before/after change", done: true },
  { text: "fire edge to vines  340 m" },
  { text: "$ write measurements" },
  { text: "$ hand off to interpreter" },
];

const clampGrid = (fn: (col: number, row: number) => number) =>
  Array.from({ length: 29 * 29 }, (_, n) => {
    const col = n % 29;
    const row = Math.floor(n / 29);
    return { col, row, v: fn(col, row) };
  }).filter((c) => c.v > 0.5);

const METHODS = [
  { label: "Water extent", line: 2, color: C.water, cells: clampGrid((c, r) => (Math.abs(r - 14 - 3 * Math.sin(c / 4)) < 2.2 ? 0.8 : 0)) },
  { label: "Burn severity", line: 3, color: C.disaster, cells: clampGrid((c, r) => (c < 16 + 4 * Math.sin(r / 3) ? 0.6 + seeded(c * 31 + r) * 0.4 : 0)) },
  { label: "Vegetation change", line: 4, color: C.forest, cells: clampGrid((c, r) => (c > 13 + 3 * Math.sin(r / 4) && seeded(c * 13 + r * 7) > 0.3 ? 0.7 : 0)) },
];

/** One method computing over the same place: imagery, then its result raster swept across it. */
const MethodTile: React.FC<{ m: (typeof METHODS)[number]; at: number; x: number }> = ({ m, at, x }) => (
  <div style={{ position: "absolute", left: x, top: 24, width: TILE.w, height: TILE.h, borderRadius: 6, overflow: "hidden", border: `1px solid ${C.lineStrong}`, background: C.raised }}>
    <Img src={staticFile("tiles/vineyard.jpg")} style={{ position: "absolute", left: -100, top: -40, width: TILE.w * 2, height: (TILE.w * 2 * 1280) / 2048, opacity: 0.55 }} />
    <Sweep from={at} dur={40} w={TILE.w} h={TILE.h}>
      <svg width={TILE.w} height={TILE.h} style={{ position: "absolute", inset: 0 }}>
        {m.cells.map((c) => (
          <rect key={`${c.col}-${c.row}`} x={c.col * 12} y={c.row * 12} width={11} height={11} fill={m.color} fillOpacity={0.35 + c.v * 0.55} />
        ))}
      </svg>
    </Sweep>
  </div>
);

const CHECKS = ["Answers the question", "Before and after images", "Dated sources", "Limitations"];

/** The sandbox's contents, in Analysis-local time. `shift` converts when a preceding scene is rendering it. */
export const SandboxBody: React.FC<{ shift?: number; tilesO?: number }> = ({ shift = 0, tilesO = 1 }) => {
  const frame = useCurrentFrame() + shift;
  const openAt = h("analytics opens");
  return (
    <div style={{ position: "absolute", left: 0, right: 0, top: 72, bottom: 0, overflow: "hidden" }}>
      <div style={{ position: "absolute", left: 0, right: 0, top: 0, height: 1, background: C.line }} />
      {/* The sandbox is already up and waiting for its first command when the scene cuts in. */}
      <div style={{ position: "absolute", left: 24, top: 28, width: 13, height: 24, background: C.accentHi, opacity: frame < openAt + 2 ? 0.35 + 0.65 * breathe(frame, 18) : 0 }} />
      <div style={{ position: "absolute", left: 24, width: 490, top: 18 }}>
        {TERMINAL.map((line, i) => {
          const at = openAt + 2 + i * LINE_STEP;
          const t = prog(frame, at, 8);
          const done = prog(frame, at + 8, 10);
          return (
            <div key={line.text} style={{ height: 42, display: "flex", alignItems: "center", justifyContent: "space-between", opacity: t, transform: `translateY(${lerp(10, 0, t)}px)`, fontFamily: FONT.mono, fontSize: 22, color: line.text.startsWith("$") ? C.text2 : C.text, whiteSpace: "nowrap" }}>
              <span>{line.text}</span>
              {line.done ? (
                <span style={{ width: 90, height: 6, borderRadius: 3, background: C.lineStrong, overflow: "hidden" }}>
                  <span style={{ display: "block", width: `${done * 100}%`, height: "100%", background: line.color ?? C.accent }} />
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
      <div style={{ position: "absolute", left: 590, top: 0, width: 1114, height: 420, opacity: tilesO }}>
        {METHODS.map((m, i) => {
          const at = openAt + 2 + m.line * LINE_STEP;
          return (
            <div key={m.label}>
              <MethodTile m={m} at={at - shift} x={i * (TILE.w + 25)} />
              <div style={{ position: "absolute", left: i * (TILE.w + 25), top: 348, width: TILE.w, whiteSpace: "nowrap" }}>
                <Mono size={24} color={frame >= at ? C.text : C.text3}>{m.label}</Mono>
              </div>
            </div>
          );
        })}
        <div style={{ position: "absolute", left: 0, top: 388 }}>
          <Mono size={20} color={C.text2}>{COPY.eox}</Mono>
        </div>
      </div>
    </div>
  );
};

export const Analysis: React.FC = () => {
  const frame = useCurrentFrame();
  const openAt = h("analytics opens");
  const toInterp = h("analytics to interpreter");
  const interpAt = h("interpreter");
  const toVerifier = h("interpreter to verifier");
  const rejectAt = h("verifier rejects");
  const loopAt = h("loop back");
  const passAt = h("verifier passes 92/100");

  const leaving = prog(frame, END - 34, 22, EASE.in);
  const interp = pop(frame, interpAt, 15);
  const verifier = pop(frame, rejectAt - 20, 15);
  const lastLine = 28 + (TERMINAL.length - 1) * LINE_STEP;
  const retract = settle(frame, toInterp - 16);
  const words = ANSWER.split(" ");
  const rejected = frame >= rejectAt && frame < passAt;
  const shake = frame >= rejectAt && frame < rejectAt + 18 ? Math.sin((frame - rejectAt) * 1.6) * 10 * (1 - (frame - rejectAt) / 18) : 0;
  const redraftAt = loopAt + 10;
  const limits = prog(frame, redraftAt, 14);
  const passed = frame >= passAt ? 1 : 0;
  const passPop = frame >= passAt ? lerp(1.22, 1, prog(frame, passAt, 12)) : 1;
  const morph = prog(frame, END - 32, 32, EASE.travel);
  const reportO = Math.max(0, Math.min(1, (morph - 0.3) / 0.4));
  const interpBase = lerpRect(pillRect(INTERPRETER_TIP), INTERPRETER, interp);
  const interpRect = lerpRect(interpBase, REPORT_RECT, morph);
  const answerSize = lerp(36, 46, morph);

  return (
    <>
      <Title text={COPY.analysis} from={0} to={END} x={96} y={82} size={72} align="center" />

      <AnalysisStops abs={frame + S.from} o={1 - leaving} interpreter={frame < interpAt - 1 ? retract : 0} verifier={frame < rejectAt - 20 ? retract : 0} />

      <div style={{ position: "absolute", inset: 0, opacity: 1 - leaving, transform: `translateX(${-leaving * 120}px)` }}>
        <Node
          rect={lerpRect(SANDBOX_RECT, ANALYTICS, retract)}
          name="Analytics"
          working={frame >= openAt && frame < toInterp}
          right={<Mono size={24} color={C.text2} style={{ whiteSpace: "nowrap" }}>SANDBOX</Mono>}
        >
          <SandboxBody tilesO={1 - Math.min(1, retract * 2.5)} />
        </Node>
      </div>

      <Edge a={[ANALYTICS_TIP[0], TOP]} b={INTERPRETER_TIP} from={toInterp} dur={interpAt - toInterp} bend={-140} until={END - 34} />
      <Edge a={INTERPRETER_TIP} b={VERIFIER_TIP} from={toVerifier} dur={rejectAt - toVerifier} bend={-140} until={loopAt + 6} />
      {/* The rejection: a red arc that snaps back along the pin's path. */}
      <Edge a={VERIFIER_TIP} b={INTERPRETER_TIP} from={loopAt} dur={10} bend={220} color={C.disaster} until={passAt} width={4} />
      <Edge a={INTERPRETER_TIP} b={VERIFIER_TIP} from={loopAt + 9} dur={passAt - loopAt - 9} bend={-140} until={END - 34} />

      {frame >= interpAt - 1 ? (
        <Node
          rect={interpRect}
          name={morph > 0.5 ? "Report" : "Interpreter"}
          border={rejected && frame >= loopAt ? C.disaster : undefined}
          working={frame > interpAt && frame < toVerifier}
          right={<Mono size={22} color={frame >= redraftAt ? C.accentHi : C.text2} style={{ opacity: prog(frame, interpAt + 4, 10) * (1 - morph), whiteSpace: "nowrap" }}>{frame >= redraftAt ? "DRAFT 2" : "DRAFT 1"}</Mono>}
        >
          <div style={{ position: "absolute", left: 24, right: 24, top: 96, fontSize: answerSize, fontWeight: 600, lineHeight: 1.16, color: C.text, opacity: prog(frame, interpAt + 2, 10) }}>
            {words.map((w, i) => {
              const t = prog(frame, interpAt + 6 + i * 3, 8);
              return <span key={i} style={{ opacity: t, display: "inline-block", marginRight: "0.26em" }}>{w}</span>;
            })}
          </div>
          <div style={{ position: "absolute", inset: 0, opacity: reportO }}>
            <ReportBody sceneFrom={S.from} showAnswer={false} />
          </div>
          <div style={{ position: "absolute", left: 24, right: 24, top: 262, opacity: limits * (1 - morph * 3) }}>
            <Mono size={22} color={C.accentHi}>LIMITATIONS</Mono>
            <div style={{ marginTop: 8, fontSize: 28, color: C.text2, lineHeight: 1.2 }}>Smoke over the site on one date.</div>
          </div>
        </Node>
      ) : null}

      {frame >= rejectAt - 20 ? (
        <div style={{ position: "absolute", inset: 0, transform: `translateX(${shake - leaving * -120}px)`, opacity: 1 - leaving }}>
          <Node
            rect={lerpRect(pillRect(VERIFIER_TIP), VERIFIER, verifier)}
            name="Verifier"
            color={rejected ? C.disaster : passed > 0 ? C.forest : undefined}
            border={rejected ? C.disaster : passed > 0 ? C.forest : undefined}
          >
            <div style={{ position: "absolute", left: 24, right: 24, top: 86 }}>
              {CHECKS.map((c, i) => {
                const last = i === CHECKS.length - 1;
                const at = last ? passAt : rejectAt - 12 + i * 4;
                const t = last ? passed : prog(frame, at, 10);
                const x = last && rejected ? 1 : 0;
                return (
                  <div key={c} style={{ display: "flex", alignItems: "center", gap: 12, height: 50, fontSize: 28, color: last && rejected ? C.alert : C.text, whiteSpace: "nowrap" }}>
                    <span style={{ width: 26, height: 26, position: "relative" }}>
                      <span style={{ position: "absolute", inset: 0, display: x > 0 ? "none" : "block" }}><CheckIcon t={t} /></span>
                      <span style={{ position: "absolute", inset: 0, display: x > 0 ? "block" : "none" }}><CrossIcon t={x} /></span>
                    </span>
                    {c}
                  </div>
                );
              })}
            </div>
            <div style={{ position: "absolute", left: 24, right: 24, top: 318, height: 1, background: C.line }} />
            <div style={{ position: "absolute", left: 24, top: 336, opacity: rejected ? 1 : 0, transform: `scale(${frame >= rejectAt ? lerp(1.08, 1, prog(frame, rejectAt, 10)) : 1})`, transformOrigin: "left center" }}>
              <span style={{ fontFamily: FONT.sans, fontSize: 56, fontWeight: 600, fontStretch: "125%", letterSpacing: "-0.025em", color: C.disaster }}>Sent back</span>
            </div>
            <div style={{ position: "absolute", left: 24, top: 326, display: "flex", alignItems: "center", gap: 18, opacity: passed, transform: `scale(${passPop})`, transformOrigin: "left center" }}>
              <CheckIcon size={78} t={passed} />
              <span style={{ fontFamily: FONT.mono, fontSize: 84, fontWeight: 500, letterSpacing: "-0.02em", color: C.text }}>
                92
                <span style={{ fontSize: 42, color: C.text2 }}>/100</span>
              </span>
            </div>
          </Node>
        </div>
      ) : null}

      <div style={{ position: "absolute", left: 96, top: 930, opacity: prog(frame, 6, 14) * (1 - leaving) }}>
        <StepTrack steps={3} active={lerp(0, 1, prog(frame, openAt, lastLine, EASE.travel)) + prog(frame, interpAt, 30, EASE.travel) + prog(frame, rejectAt - 10, passAt - rejectAt + 10, EASE.travel)} w={1728} />
      </div>
    </>
  );
};

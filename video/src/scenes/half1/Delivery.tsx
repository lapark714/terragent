import { Img, staticFile, useCurrentFrame } from "remotion";
import { Confidence, Edge, Mono, Sweep, Title } from "../../components/Primitives";
import { breathe, EASE, lerp, pop, prog, seeded, settle } from "../../motion";
import { C, COPY, FONT, hit, TIMING } from "../../tokens";
import { MissionCounters, MissionRing } from "./Mission";
import { CheckIcon, hexPath, IndexHexes, localHit, Node, Stage, StopOrbit, type Rect } from "./shared";

const S = TIMING.scenes.delivery;
const h = localHit(S.from);
const END = S.to - S.from;

export const REPORT_RECT: Rect = { x: 180, y: 240, w: 880, h: 770 };
const EMAIL_TIP = [1500, 330] as const;
const HEX_TIP = [1500, 770] as const;
const IMG = { w: 404, h: 244 };
const ANSWER = "Fire stopped 340 m from the vines.";

/** Diagrammatic burn-severity bands, seeded so they are identical every frame. */
const band = (offset: number, seed: number): string => {
  const pts = Array.from({ length: 22 }, (_, i) => {
    const y = (IMG.h * i) / 21;
    const x = offset + 34 * Math.sin(i * 0.8 + seed) + 22 * seeded(i + 9 + seed);
    return `${x.toFixed(1)} ${y.toFixed(1)}`;
  });
  return `M0 0L${pts.join("L")}L0 ${IMG.h}Z`;
};
const BURN_LOW = band(186, 0);
const BURN_HIGH = band(108, 2.4);

const Tile: React.FC<{ label: string; children?: React.ReactNode; color?: string }> = ({ label, children, color = C.text2 }) => (
  <div style={{ position: "relative", width: IMG.w, height: IMG.h, borderRadius: 6, overflow: "hidden", border: `1px solid ${C.lineStrong}` }}>
    <Img src={staticFile("tiles/vineyard.jpg")} style={{ width: IMG.w * 1.5, height: (IMG.w * 1.5 * 1280) / 2048, position: "absolute", left: -90, top: -30 }} />
    {children}
    <span style={{ position: "absolute", left: 10, top: 10, background: "rgba(10, 21, 35, 0.86)", padding: "3px 9px", borderRadius: 4 }}>
      <Mono size={22} color={color}>{label}</Mono>
    </span>
  </div>
);

/** The report's contents, populated from the morph; each hit seals its section. Renders in Analysis or Delivery. */
export const ReportBody: React.FC<{ sceneFrom: number; showAnswer: boolean }> = ({ sceneFrom, showAnswer }) => {
  const local = useCurrentFrame();
  const abs = local + sceneFrom;
  const imageryAt = hit("report imagery");
  const confAt = hit("report confidence");
  const sourcesAt = hit("report sources");
  return (
    <>
      {showAnswer ? <div style={{ position: "absolute", left: 24, right: 24, top: 96, fontSize: 46, fontWeight: 600, lineHeight: 1.16, color: C.text, whiteSpace: "nowrap" }}>{ANSWER}</div> : null}
      <div style={{ position: "absolute", left: 24, top: 176, display: "flex", gap: 24 }}>
        <Tile label="Before" />
        <div style={{ position: "relative", width: IMG.w, height: IMG.h }}>
          <Tile label="After" />
          <Sweep from={imageryAt - sceneFrom} dur={24} w={IMG.w} h={IMG.h}>
            <Tile label="After">
              <svg width={IMG.w} height={IMG.h} style={{ position: "absolute", inset: 0 }}>
                <path d={BURN_LOW} fill={C.alert} fillOpacity={0.42} />
                <path d={BURN_HIGH} fill={C.disaster} fillOpacity={0.72} />
                <rect x={292} y={84} width={92} height={92} fill="none" stroke={C.forest} strokeWidth={3} />
                <path d="M228 130H292" stroke={C.text} strokeWidth={2} strokeDasharray="5 5" />
              </svg>
              <span style={{ position: "absolute", left: 200, top: 138, background: "rgba(10, 21, 35, 0.86)", padding: "2px 7px", borderRadius: 4, opacity: prog(abs, imageryAt + 16, 10) }}>
                <Mono size={22} color={C.text}>340 m</Mono>
              </span>
            </Tile>
          </Sweep>
        </div>
      </div>
      <div style={{ position: "absolute", left: 24, top: 430 }}>
        <Mono size={20} color={C.text2}>{COPY.eox}</Mono>
      </div>
      <div style={{ position: "absolute", left: 24, right: 24, top: 474, height: 1, background: C.line }} />
      <div style={{ position: "absolute", left: 24, top: 492 }}>
        <Mono size={22} color={C.text3}>CONFIDENCE</Mono>
        <div style={{ marginTop: 10, display: "flex", alignItems: "center" }}>
          <Confidence from={confAt - sceneFrom} label="" />
          <span style={{ fontSize: 24, fontWeight: 500, color: abs >= confAt ? C.text : C.text3 }}>High confidence</span>
        </div>
      </div>
      <div style={{ position: "absolute", left: 452, top: 492 }}>
        <Mono size={22} color={C.text3}>LIMITATIONS</Mono>
        <div style={{ marginTop: 8, fontSize: 24, color: C.text2, whiteSpace: "nowrap" }}>Smoke over the site on one date</div>
      </div>
      <div style={{ position: "absolute", left: 24, right: 24, top: 584, height: 1, background: C.line }} />
      <div style={{ position: "absolute", left: 24, top: 598 }}>
        <Mono size={22} color={C.text3}>SOURCES</Mono>
        {["Sentinel-2 · before", "Sentinel-2 · after", "Landsat · cross-check"].map((row, i) => {
          const at = sourcesAt + i * 4;
          return (
            <div key={row} style={{ marginTop: i === 0 ? 6 : 2, display: "flex", alignItems: "center", gap: 8 }}>
              <CheckIcon size={22} t={prog(abs, at, 10)} />
              <Mono size={22} color={abs >= at ? C.text : C.text3}>{row}</Mono>
            </div>
          );
        })}
      </div>
    </>
  );
};

export const Delivery: React.FC = () => {
  const frame = useCurrentFrame();
  const abs = frame + S.from;
  const answerAt = h("report answer");
  const emailAt = h("report emailed");
  const hexAt = h("hex joins index");
  const email = settle(frame, emailAt - 16);
  const leave = settle(frame, END - 32);
  const stamp = pop(frame, answerAt, 12);
  const hexIn = pop(frame, hexAt, 11);
  const hexRing = prog(frame, hexAt, 40);
  const grown = prog(frame, hexAt, 44);
  const emailOff = prog(frame, hexAt + 6, 18, EASE.in);
  const replyT = prog(frame, emailAt, 14);
  const toCentre = (x: number, y: number) => `translate(${(960 - x) * leave}px, ${(590 - y) * leave}px) scale(${lerp(1, 0.08, leave)})`;

  return (
    <>
      <IndexHexes abs={abs} grown={grown} o={prog(frame, hexAt, 10)} />
      <Title text={COPY.delivery} from={0} to={END} x={96} y={66} size={72} />

      <StopOrbit stops={[[620, 240], [EMAIL_TIP[0], EMAIL_TIP[1]], [HEX_TIP[0], HEX_TIP[1]]]} bend={-110} abs={abs} period={210} o={prog(frame, 8, 16) * (1 - leave)} />
      <Stage>
        {[0, 1, 2].map((n) => {
          const at = hexAt + 26 + n * 16;
          const t = prog(frame, at, 40);
          return <path key={n} d={hexPath(HEX_TIP[0], HEX_TIP[1], 34 + t * 150)} fill="none" stroke={C.accentHi} strokeWidth={1.5} strokeOpacity={frame >= at ? (1 - t) * 0.75 * (1 - leave) : 0} />;
        })}
        <path d={hexPath(HEX_TIP[0], HEX_TIP[1], 34 + hexRing * 54)} fill="none" stroke={C.forest} strokeWidth={2} strokeOpacity={frame >= hexAt ? (1 - hexRing) * (1 - leave) : 0} />
        {frame >= hexAt ? <path d={hexPath(HEX_TIP[0], HEX_TIP[1], 34 * Math.min(1.1, hexIn))} fill={C.forest} fillOpacity={(0.75 + 0.2 * breathe(frame, 30)) * (1 - leave)} stroke={C.text} strokeWidth={1.5} strokeOpacity={1 - leave} /> : null}
      </Stage>

      <div style={{ position: "absolute", inset: 0, opacity: 1 - prog(frame, END - 12, 10, EASE.in), transform: toCentre(620, 620), transformOrigin: "620px 620px" }}>
        <Node
          rect={REPORT_RECT}
          name="Report"
          color={C.forest}
          right={
            <span style={{ display: "flex", alignItems: "center", gap: 10, opacity: Math.min(1, stamp), transform: `scale(${lerp(0.7, 1, Math.min(1, stamp))})` }}>
              <CheckIcon size={26} t={Math.min(1, stamp)} />
              <Mono size={22} color={C.text}>Verified 92/100</Mono>
            </span>
          }
        >
          <ReportBody sceneFrom={S.from} showAnswer />
        </Node>
      </div>

      <Edge a={[REPORT_RECT.x + REPORT_RECT.w, 420]} b={[1208, 430]} from={emailAt - 16} dur={16} until={hexAt + 12} bend={-30} />

      <div style={{ position: "absolute", inset: 0, opacity: Math.min(1, email * 1.6) * (1 - prog(frame, END - 12, 10, EASE.in)), transform: `translate(${lerp(40, 0, email) + emailOff * 780}px, 0) ${toCentre(1500, 450)}`, transformOrigin: "1500px 450px" }}>
        <div style={{ position: "absolute", left: 1208, top: EMAIL_TIP[1], width: 616, height: 262, background: "rgba(14, 28, 45, 0.94)", border: `1px solid ${C.lineStrong}`, borderRadius: 8, padding: "18px 22px", boxSizing: "border-box", color: C.text, fontFamily: FONT.sans }}>
          <Mono size={22} color={C.accentHi}>SAME EMAIL THREAD</Mono>
          <div style={{ marginTop: 12, padding: "10px 14px", background: C.raised, borderRadius: 8, fontSize: 25, color: C.text2, width: "fit-content" }}>Did the fire reach our vineyard?</div>
          <div style={{ marginTop: 10, marginLeft: 70, padding: "10px 14px", background: C.accent, color: "#0a1523", borderRadius: 8, fontSize: 25, fontWeight: 600, opacity: replyT, transform: `translateY(${lerp(14, 0, replyT)}px)`, whiteSpace: "nowrap" }}>
            Your verified report is ready.
          </div>
          <div style={{ marginTop: 10, marginLeft: 70, opacity: prog(frame, emailAt + 8, 12) }}>
            <Mono size={22} color={C.text}>Share link attached</Mono>
          </div>
        </div>
      </div>

      <div style={{ position: "absolute", left: 1296, top: 846, width: 408, height: 112, opacity: prog(frame, hexAt + 6, 12) * (1 - prog(frame, END - 20, 16, EASE.in)), background: "rgba(14, 28, 45, 0.94)", border: `1px solid ${C.lineStrong}`, borderRadius: 8, padding: "12px 20px", boxSizing: "border-box", fontFamily: FONT.sans }}>
        <Mono size={24} color={C.text2}>EARTH INDEX</Mono>
        <div style={{ fontSize: 28, fontWeight: 600, color: C.text, marginTop: 2 }}>Next answer is faster</div>
      </div>

      {frame >= END - 18 ? (
        <>
          <MissionRing abs={abs} />
          <MissionCounters abs={abs} />
        </>
      ) : null}
    </>
  );
};

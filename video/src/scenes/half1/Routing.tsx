import { useCurrentFrame } from "remotion";
import { Edge, Mono, Title } from "../../components/Primitives";
import { breathe, EASE, lerp, pop, prog } from "../../motion";
import { C, COPY, FONT, hit, TIMING } from "../../tokens";
import { QuoteSkeleton } from "./Pricing";
import { ACQUISITION_TIP, localHit, Node, pillRect, PLANNER_TIP } from "./shared";

const S = TIMING.scenes.routing;
const h = localHit(S.from);
const END = S.to - S.from;

const ROW_X = 760;
const ROW_W = 1064;
const ROW_H = 104;
/** Rows fold toward the quote option they become, clear of the Pricing node. */
const FOLD_Y = 640;

const SOURCES = [
  { name: "Sentinel-2", tag: "Free", y: 244, at: "route sentinel-2", fold: 530 },
  { name: "Landsat", tag: "Free", y: 358, at: "route landsat", fold: 530 },
  { name: "Sentinel-1 radar", tag: "Free", y: 472, at: "route sentinel-1", fold: 530 },
  { name: "30 cm optical", tag: "Paid", y: 658, at: "route paid optical", fold: 960 },
  { name: "SAR radar", tag: "Paid", y: 772, at: "route paid radar", fold: 1390 },
  { name: "Thermal", tag: "Paid", y: 886, at: "route thermal", fold: 1390 },
];

const TIERS = [
  { label: "Free first", y: 188, at: "route sentinel-2" },
  { label: "Paid marketplaces", y: 602, at: "route paid optical" },
];

/** The diagram's rows and tier heads on the absolute frame: dark from before the cut, each lights on its hit. */
export const SourceRows: React.FC<{ abs: number }> = ({ abs }) => (
  <>
    {TIERS.map((tier, i) => {
      const enter = prog(abs, S.from - 12 + i * 6, 16);
      const lit = prog(abs, hit(tier.at) - 8, 12);
      const gone = prog(abs, S.to - 20, 12, EASE.in);
      return (
        <div key={tier.label} style={{ position: "absolute", left: ROW_X, top: tier.y, opacity: enter * (1 - gone), transform: `translateX(${lerp(-24, 0, enter)}px)`, fontFamily: FONT.sans, fontSize: 36, fontWeight: 600, fontStretch: "125%", letterSpacing: "-0.02em", color: lit > 0.5 ? C.text : C.text3, whiteSpace: "nowrap" }}>
          {tier.label}
        </div>
      );
    })}
    {SOURCES.map((s, i) => {
      const at = hit(s.at) + 16;
      const enter = prog(abs, S.from - 16 + i * 2, 18);
      const land = pop(abs, at - 6, 14);
      const on = abs >= at - 6;
      const leave = prog(abs, S.to - 24 + i * 2, 16, EASE.in);
      const free = s.tag === "Free";
      const dx = (s.fold - (ROW_X + ROW_W / 2)) * leave;
      const dy = (FOLD_Y - (s.y + ROW_H / 2)) * leave;
      const fill = prog(abs, at - 2, 46, EASE.travel);
      const sat = (1 - Math.cos(((abs + i * 23) / 64) * Math.PI * 2)) / 2;
      return (
        <div key={s.name} style={{ position: "absolute", left: ROW_X, top: s.y, width: ROW_W, height: ROW_H, opacity: enter * (1 - leave * leave), transform: `translate(${dx + lerp(-30, 0, enter)}px, ${dy}px) scale(${lerp(1, 0.4, leave) * (on ? lerp(0.97, 1, Math.min(land, 1)) : 1)})` }}>
          <div style={{ position: "absolute", inset: 0, background: on ? "rgba(20, 39, 57, 0.96)" : "rgba(14, 28, 45, 0.9)", border: `1px solid ${on ? C.lineStrong : C.line}`, borderRadius: 8, display: "flex", alignItems: "center", padding: "0 30px", boxSizing: "border-box" }}>
            <span style={{ width: 16, height: 16, borderRadius: 16, background: on ? C.accent : C.lineStrong, opacity: on ? 0.55 + 0.45 * breathe(abs, 42, i * 11) : 1, flex: "none" }} />
            <span style={{ marginLeft: 20, width: 460 }}>
              <Mono size={42} color={on ? C.text : C.text3} style={{ fontWeight: 500, whiteSpace: "nowrap" }}>{s.name}</Mono>
            </span>
            {/* A satellite pass over this source, then the scene count of bar filled. */}
            <span style={{ position: "relative", width: 330, height: 22, flex: "none", opacity: on ? 1 : 0.4 }}>
              <span style={{ position: "absolute", left: 0, right: 0, top: 10, height: 2, background: C.lineStrong }} />
              <span style={{ position: "absolute", left: 0, top: 10, height: 2, width: `${fill * 100}%`, background: C.accentHi }} />
              {on ? <span style={{ position: "absolute", left: `calc(${sat * 100}% - 7px)`, top: 4, width: 14, height: 14, borderRadius: 14, background: C.accentHi }} /> : null}
            </span>
            <span style={{ marginLeft: "auto" }}>
              <Mono size={30} color={!on ? C.text3 : free ? C.accentHi : C.text2}>{s.tag}</Mono>
            </span>
          </div>
        </div>
      );
    })}
  </>
);

export const Routing: React.FC = () => {
  const frame = useCurrentFrame();
  const openAt = h("acquisition opens");
  const open = pop(frame, openAt, 12);
  const out: readonly [number, number] = [410, 635];
  const exit = prog(frame, END - 26, 24, EASE.in);
  const quote = prog(frame, END - 18, 16, EASE.travel);
  const pill = pillRect(ACQUISITION_TIP);
  const big = { x: ACQUISITION_TIP[0] - 150, y: ACQUISITION_TIP[1], w: 300, h: 150 };
  const t = Math.min(open, 1) * (1 - exit);
  const plannerGone = prog(frame, 0, 16, EASE.in);

  return (
    <>
      <Edge a={[PLANNER_TIP[0], PLANNER_TIP[1] + 72]} b={ACQUISITION_TIP} from={-60} dur={1} until={14} />
      <div style={{ position: "absolute", inset: 0, opacity: 1 - plannerGone }}>
        <Node rect={pillRect(PLANNER_TIP)} name="Planner" />
      </div>
      <Title text={COPY.routing} from={0} to={END} x={96} y={72} size={72} />

      {SOURCES.map((s) => (
        <Edge key={s.name} a={out} b={[ROW_X, s.y + ROW_H / 2]} from={h(s.at)} dur={16} bend={(s.y + ROW_H / 2 - out[1]) * 0.12} until={END - 8} />
      ))}

      {quote > 0 ? <QuoteSkeleton t={quote} /> : null}
      <SourceRows abs={frame + S.from} />

      <Node
        rect={{ x: lerp(pill.x, big.x, t), y: pill.y, w: lerp(pill.w, big.w, t), h: lerp(pill.h, big.h, t) }}
        name="Acquisition"
        working={frame > openAt && frame < END - 26}
        o={1 - prog(frame, END - 16, 14, EASE.in)}
      >
        <div style={{ position: "absolute", left: 22, top: 84, opacity: t, whiteSpace: "nowrap", fontSize: 30, fontWeight: 500, color: C.text2 }}>Finds the data</div>
      </Node>

    </>
  );
};

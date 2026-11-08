import { useCurrentFrame } from "remotion";
import { Mono, Title } from "../../components/Primitives";
import { EASE, lerp, pop, prog, settle } from "../../motion";
import { C, COPY, FONT, TIMING } from "../../tokens";
import { AnalysisStops } from "./AnalysisStops";
import { SANDBOX_RECT, SandboxBody } from "./Analysis";
import { CheckIcon, lerpRect, localHit, NodeHead, pillRect, PRICING_TIP, type Rect } from "./shared";

const S = TIMING.scenes.pricing;
const h = localHit(S.from);
const END = S.to - S.from;

export const QUOTE: Rect = { x: 300, y: 300, w: 1320, h: 460 };
const HEAD = "Nothing runs until you accept";
const RECEIPT: Rect = { x: 620, y: 300, w: 680, h: 460 };
/** Centre of option A's accept button: the customer taps here. */
const TAP = [530, 640] as const;

const OPTIONS = [
  { id: "A", kind: "Analysis fee", data: "Free satellite imagery", price: "$85", at: "option A" },
  { id: "B", kind: "Paid imagery · 30 cm", data: "Commercial optical", price: "$240", at: "option B" },
  { id: "C", kind: "Paid radar · SAR", data: "Sees through cloud", price: "$890", at: "option C" },
];

const BUTTON: React.CSSProperties = { position: "absolute", left: 24, top: 224, width: 352, height: 60, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", gap: 10, boxSizing: "border-box" };

/** One option's frame: present from before the cut, so source rows have somewhere to fold into. */
const OptionBox: React.FC<{ i: number; id: string; border?: string; o?: number; children?: React.ReactNode }> = ({ i, id, border = C.line, o = 1, children }) => (
  <div style={{ position: "absolute", left: 30 + i * 430, top: 86, width: 400, height: 346, opacity: o }}>
    <div style={{ position: "absolute", inset: 0, background: C.raised, border: `1.5px solid ${border}`, borderRadius: 8 }} />
    <div style={{ position: "absolute", left: 24, top: 18 }}>
      <Mono size={22} color={C.text3}>OPTION {id}</Mono>
    </div>
    {children}
  </div>
);

/** The quote card before any option has landed. Routing opens it during its outgoing frames. */
export const QuoteSkeleton: React.FC<{ t: number }> = ({ t }) => {
  const rect = lerpRect(pillRect(PRICING_TIP), QUOTE, t);
  return (
    <div style={{ position: "absolute", left: rect.x, top: rect.y, width: rect.w, height: rect.h, background: "rgba(14, 28, 45, 0.97)", border: `1px solid ${C.lineStrong}`, borderRadius: 8, overflow: "hidden", fontFamily: FONT.sans, color: C.text, opacity: Math.min(1, t * 3) }}>
      <NodeHead name="Pricing" right={<span style={{ fontSize: 32, fontWeight: 500, opacity: t, whiteSpace: "nowrap" }}>{HEAD}</span>} />
      <div style={{ position: "absolute", left: 0, top: 0, width: QUOTE.w, height: QUOTE.h, opacity: t }}>
        {OPTIONS.map((o, i) => (
          <OptionBox key={o.id} i={i} id={o.id}>
            <div style={{ ...BUTTON, border: `1px solid ${C.lineStrong}` }} />
          </OptionBox>
        ))}
      </div>
    </div>
  );
};

/** The customer, distinct from the agents' pin: a cursor with a tag that makes the only human choice in the film. */
const CustomerCursor: React.FC<{ frame: number; acceptAt: number }> = ({ frame, acceptAt }) => {
  const arrive = settle(frame, acceptAt - 34);
  const leave = prog(frame, acceptAt + 6, 12, EASE.in);
  const x = lerp(150, TAP[0], arrive) - leave * 26;
  const y = lerp(1000, TAP[1], arrive) + leave * 34;
  const press = frame >= acceptAt && frame < acceptAt + 8 ? 0.86 : 1;
  return (
    <div style={{ position: "absolute", left: x, top: y, opacity: Math.min(1, arrive * 2.5) * (1 - leave) }}>
      <svg width={44} height={52} viewBox="0 0 44 52" style={{ position: "absolute", left: -3, top: -2, transform: `scale(${press})`, transformOrigin: "3px 2px" }}>
        <path d="M3 2L3 42L14 32L22 50L30 46L22 29L38 29Z" fill={C.text} stroke={C.space} strokeWidth={2.5} strokeLinejoin="round" />
      </svg>
      <div style={{ position: "absolute", left: 42, top: 44, background: C.text, borderRadius: 6, padding: "5px 12px", fontFamily: FONT.mono, fontSize: 24, color: C.space, whiteSpace: "nowrap" }}>Customer</div>
    </div>
  );
};

export const Pricing: React.FC = () => {
  const frame = useCurrentFrame();
    const acceptAt = h("customer accepts");
  const paidAt = h("payment confirmed");
  const flip = prog(frame, paidAt - 18, 16, EASE.travel);
  const leave = prog(frame, END - 24, 24, EASE.travel);
  const tap = prog(frame, acceptAt, 24);
  const chosen = prog(frame, acceptAt, 12);
  const flipped = lerpRect(QUOTE, RECEIPT, flip);
  const rect = lerpRect(flipped, SANDBOX_RECT, leave);
  const content = 1 - prog(frame, END - 26, 10, EASE.in);
  const rotation = flip * 180;
  const contentO = content;
  const face: React.CSSProperties = { position: "absolute", inset: 0, backfaceVisibility: "hidden", WebkitBackfaceVisibility: "hidden", background: "rgba(14, 28, 45, 0.97)", border: `1px solid ${C.lineStrong}`, borderRadius: 8, overflow: "hidden", fontFamily: FONT.sans, color: C.text };
  const receiptIn = prog(frame, paidAt - 7, 7);
  const analyticsLabel = prog(frame, END - 16, 12);

  return (
    <>
      {frame >= END - 16 ? <AnalysisStops abs={frame + S.from} interpreter={0} verifier={0} /> : null}
      <div style={{ position: "absolute", left: rect.x, top: rect.y, width: rect.w, height: rect.h, perspective: 1600 }}>
        <div style={{ position: "absolute", inset: 0, transformStyle: "preserve-3d", transform: `rotateY(${rotation}deg)` }}>
          <div style={face}>
            <NodeHead name="Pricing" right={<span style={{ fontSize: 32, fontWeight: 500, color: C.text, opacity: contentO, whiteSpace: "nowrap" }}>{HEAD}</span>} />
            <div style={{ position: "absolute", left: 0, top: 0, width: QUOTE.w, height: QUOTE.h, opacity: contentO }}>
              {OPTIONS.map((o, i) => {
                const land = frame >= h(o.at) ? pop(frame, h(o.at), 14) : 0;
                const pick = o.id === "A";
                const shown = Math.min(1, land * 1.5);
                return (
                  <OptionBox key={o.id} i={i} id={o.id} border={pick && chosen > 0.5 ? C.accent : C.line} o={lerp(1, 0.3, pick ? 0 : chosen)}>
                    <div style={{ position: "absolute", inset: 0, opacity: shown, transform: `translateY(${lerp(22, 0, land)}px)` }}>
                      <div style={{ position: "absolute", left: 24, top: 52, fontFamily: FONT.mono, fontSize: 62, fontWeight: 500, color: C.text, letterSpacing: "-0.02em" }}>{o.price}</div>
                      <div style={{ position: "absolute", left: 24, top: 138, fontSize: 28, fontWeight: 500, color: C.text, whiteSpace: "nowrap" }}>{o.kind}</div>
                      <div style={{ position: "absolute", left: 24, top: 174 }}>
                        <Mono size={22} color={C.text2}>{o.data}</Mono>
                      </div>
                    </div>
                    {/* The customer's cursor taps the centre of A's button, at screen (530, 640). */}
                    <div style={{ ...BUTTON, background: pick && chosen > 0.05 ? C.accent : "transparent", border: `1px solid ${pick && shown > 0.5 ? C.accent : C.lineStrong}` }}>
                      {pick && chosen > 0 ? <CheckIcon t={chosen} size={26} color={C.text} /> : null}
                      <span style={{ fontSize: 25, fontWeight: 600, color: C.text, opacity: shown }}>{pick && chosen > 0 ? "Accepted" : `Accept option ${o.id}`}</span>
                      {pick && frame >= acceptAt ? (
                        <span style={{ position: "absolute", left: "50%", top: "50%", width: 54, height: 54, marginLeft: -27, marginTop: -27, borderRadius: "50%", border: `2px solid ${C.accentHi}`, opacity: 1 - tap, transform: `scale(${lerp(0.4, 2.4, tap)})` }} />
                      ) : null}
                    </div>
                  </OptionBox>
                );
              })}
            </div>
          </div>
          <div style={{ ...face, transform: "rotateY(180deg)", borderColor: C.forest }}>
            <div style={{ position: "absolute", inset: 0, opacity: content }}>
              <div style={{ position: "absolute", left: 32, top: 28 }}><Mono size={22} color={C.text2}>RECEIPT</Mono></div>
              <div style={{ position: "absolute", right: 32, top: 26 }}><Mono size={23} color={C.text}>Option A</Mono></div>
              <div style={{ position: "absolute", left: 32, top: 84, fontFamily: FONT.mono, fontSize: 92, fontWeight: 500, color: C.text, letterSpacing: "-0.02em", opacity: receiptIn }}>$85</div>
              <div style={{ position: "absolute", left: 32, top: 196, fontSize: 28, color: C.text2 }}>Analysis fee · free imagery</div>
              <div style={{ position: "absolute", left: 0, right: 0, top: 246, height: 1, background: C.line }} />
              <div style={{ position: "absolute", left: 32, top: 310, display: "flex", alignItems: "center", gap: 16 }}>
                <CheckIcon t={receiptIn} size={62} />
                <span style={{ fontSize: 60, fontWeight: 600, fontStretch: "125%", letterSpacing: "-0.025em", color: C.text }}>Paid</span>
              </div>
              <div style={{ position: "absolute", right: 32, top: 346 }}><Mono size={22} color={C.text2}>Collected by agents</Mono></div>
            </div>
            <div style={{ position: "absolute", inset: 0, opacity: analyticsLabel }}>
              <NodeHead name="Analytics" right={<Mono size={24} color={C.text2} style={{ whiteSpace: "nowrap" }}>SANDBOX</Mono>} />
              <SandboxBody shift={-(TIMING.scenes.analysis.from - S.from)} />
            </div>
          </div>
        </div>
      </div>
      <CustomerCursor frame={frame} acceptAt={acceptAt} />
      <Title text={COPY.pricing} from={0} to={END - 6} x={96} y={880} size={76} align="center" />
    </>
  );
};

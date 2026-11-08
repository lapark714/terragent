import { useCurrentFrame } from "remotion";
import { project } from "../../choreography";
import { Beacon, Edge, Mono, Panel, Title } from "../../components/Primitives";
import { EASE, lerp, pop, prog, settle } from "../../motion";
import { C, COPY, f, FONT, hit, TIMING } from "../../tokens";
import { CheckIcon, localHit, NodeHead, pillRect, PLANNER_TIP, StopOrbit, type Pt } from "./shared";

const S = TIMING.scenes.signals;
const h = localHit(S.from);
const END = S.to - S.from;

const FEEDS = [
  { label: "NOAA weather alerts", color: C.disaster, lat: 33, lon: -97 },
  { label: "NASA fire detections", color: C.disaster, lat: 38.5, lon: -122.35 },
  { label: "USGS earthquakes", color: C.disaster, lat: 35.8, lon: -117.6 },
  { label: "River flood gauges", color: C.water, lat: 30.4, lon: -91.2 },
  { label: "FEMA declarations", color: C.disaster, lat: 27.9, lon: -82.4 },
  { label: "Global Forest Watch", color: C.forest, lat: -4, lon: -62 },
  { label: "BLM mining claims", color: C.mining, lat: 40.8, lon: -116.2 },
  { label: "News", color: C.accent, lat: 40.7, lon: -74 },
] as const;

const FIRE = FEEDS[1];
const SOURCING: Pt = [1040, 330];
const OUTREACH: Pt = [1040, 770];
const NODE_X = 720;
const NODE_W = 340;

/** The sample outreach email. Takes the absolute frame so it can outlive the scene and leave during the next one. */
export const OutreachEmail: React.FC<{ abs: number }> = ({ abs }) => {
  const landing = hit("sample email in inbox");
  const open = settle(abs, hit("outreach node") - 4);
  const exit = prog(abs, S.to + f(0.1), f(0.3), EASE.in);
  const sent = prog(abs, landing, 14);
  const line = (at: number) => prog(abs, hit("outreach node") + at, 14);
  if (open <= 0.001 || exit >= 1) {
    return null;
  }
  return (
    <div style={{ position: "absolute", inset: 0, opacity: Math.min(1, open * 1.6) * (1 - exit), transform: `translate(${lerp(-36, 0, open)}px, ${exit * 90}px)` }}>
      <Panel x={1120} y={700} w={620} h={254} style={{ padding: "20px 26px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", height: 30 }}>
          <Mono size={22} color={C.accentHi}>FREE SAMPLE ANALYSIS</Mono>
          <span style={{ display: "flex", alignItems: "center", gap: 8, opacity: sent }}>
            <CheckIcon t={sent} size={24} />
            <Mono size={22} color={C.text}>In their inbox</Mono>
          </span>
        </div>
        <div style={{ fontSize: 33, fontWeight: 600, marginTop: 16, lineHeight: 1.16, opacity: line(0) }}>Fire detected near your site</div>
        <div style={{ fontSize: 25, color: C.text2, marginTop: 12, opacity: line(8) }}>We ran a free sample analysis.</div>
        <div style={{ marginTop: 16, opacity: line(14) }}>
          <Mono size={22} color={C.text3}>Written and sent by an AI agent</Mono>
        </div>
      </Panel>
    </div>
  );
};

/** The feed rack, on the absolute frame: chips sit dark from the cut and each lights on its own hit. */
export const FeedRack: React.FC<{ abs: number }> = ({ abs }) => (
  <>
    {FEEDS.map((feed, i) => {
      const lit = pop(abs, hit(`feed chip ${i + 1}`));
      const on = abs >= hit(`feed chip ${i + 1}`);
      const enter = prog(abs, S.from - 12 + i * 2, 16);
      const gone = prog(abs, hit("sample email in inbox") - 4 + i * 2, 16, EASE.in);
      return (
        <div
          key={feed.label}
          style={{
            position: "absolute",
            left: 96,
            top: 248 + i * 84,
            width: 386,
            boxSizing: "border-box",
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 14px",
            background: on ? C.raised : C.panel,
            border: `1px solid ${on ? C.lineStrong : C.line}`,
            borderRadius: 6,
            fontFamily: FONT.mono,
            fontSize: 22,
            color: on ? C.text : C.text3,
            whiteSpace: "nowrap",
            opacity: enter * (1 - gone),
            transform: `translateX(${lerp(-60, 0, enter) - gone * 120}px) scale(${on ? lerp(0.94, 1, Math.min(lit, 1)) : 1})`,
            transformOrigin: "left center",
          }}
        >
          <span style={{ width: 9, height: 9, borderRadius: 9, background: on ? feed.color : C.lineStrong, flex: "none" }} />
          {feed.label}
        </div>
      );
    })}
  </>
);

/** The customer's reply: appears over the email, then flies into the Planner and lands as it opens. */
const REPLY_FROM: Pt = [1560, 654];
const FLIGHT = 10;
export const ReplyPulse: React.FC<{ abs: number }> = ({ abs }) => {
  // After the email lands, so the story order holds: delivered, then answered.
  const show = hit("sample email in inbox") + 4;
  const lands = hit("planner opens");
  const fly = prog(abs, lands - FLIGHT, FLIGHT, EASE.travel);
  const open = pop(abs, show, 12);
  if (abs < show || fly >= 1) {
    return null;
  }
  const tx = PLANNER_TIP[0];
  const ty = PLANNER_TIP[1] + 72;
  const lift = 4 * fly * (1 - fly) * 170;
  const x = lerp(REPLY_FROM[0], tx, fly);
  const y = lerp(REPLY_FROM[1], ty, fly) - lift;
  return (
    <div style={{ position: "absolute", left: x, top: y, transform: `translate(-50%, -50%) scale(${lerp(lerp(0.7, 1, Math.min(open, 1)), 0.34, fly * fly)})`, opacity: Math.min(1, open * 1.5) * (1 - prog(abs, lands - 4, 4)), background: C.text, borderRadius: 10, padding: "10px 18px", whiteSpace: "nowrap", fontFamily: FONT.sans, zIndex: 3 }}>
      <div style={{ fontFamily: FONT.mono, fontSize: 22, color: C.space }}>Reply</div>
      <div style={{ fontSize: 31, fontWeight: 600, color: C.space, lineHeight: 1.1 }}>Yes, please check.</div>
    </div>
  );
};

export const Signals: React.FC = () => {
  const frame = useCurrentFrame();
  const abs = frame + S.from;
  const firstChip = h("feed chip 1");
  const sourcingAt = h("sourcing node");
  const outreachAt = h("outreach node");
  const leave = h("sample email in inbox");
  const exit = prog(frame, leave + 4, END - leave - 8, EASE.in);
  const sourcing = pop(frame, sourcingAt);
  const outreach = pop(frame, outreachAt);
  const firePos = project(FIRE.lat, FIRE.lon, abs);
  const plannerIn = prog(frame, END - 22, 18);

  return (
    <>
      <Title text={COPY.signals} from={0} to={END} x={96} y={78} size={78} />

      {FEEDS.map((feed, i) => {
        const at = firstChip + i * (h("feed chip 2") - firstChip);
        const y = 248 + i * 84;
        const p = project(feed.lat, feed.lon, abs);
        const lands = at + 18;
        const fired = prog(frame, lands, 8);
        return (
          <div key={feed.label}>
            <Edge a={[482, y + 22]} b={[p.x, p.y]} from={at} dur={18} color={feed.color} bend={i % 2 ? -40 : 40} until={Math.min(at + 58, leave)} width={1.5} />
            <Beacon x={p.x} y={p.y} color={feed.color} size={i === 1 ? 13 : 9} phase={i * 17} o={fired * (1 - exit)} />
          </div>
        );
      })}

      <FeedRack abs={abs} />

      <StopOrbit stops={[SOURCING, OUTREACH]} bend={-90} abs={abs} o={Math.min(sourcing, 1) * (1 - exit)} period={120} />

      {/* The signal trails the pin into Sourcing, which matches it to a site. */}
      <Edge a={[firePos.x, firePos.y]} b={[NODE_X + NODE_W, SOURCING[1] + 60]} from={sourcingAt} dur={16} color={C.disaster} bend={30} until={leave + 6} />
      <Edge a={[NODE_X + NODE_W - 170, SOURCING[1] + 128]} b={[NODE_X + NODE_W - 170, OUTREACH[1]]} from={outreachAt} dur={16} until={leave + 6} />
      <Edge a={[NODE_X + NODE_W, OUTREACH[1] + 66]} b={[1120, OUTREACH[1] + 66]} from={outreachAt + 8} dur={14} until={END} />

      <Panel x={NODE_X} y={SOURCING[1]} w={NODE_W} h={128} o={Math.min(1, sourcing * 1.5) * (1 - exit)} scale={lerp(0.7, 1, sourcing)} origin="80% 0%" style={{ padding: 0 }}>
        <NodeHead name="Sourcing" color={C.disaster} />
        <div style={{ position: "absolute", left: 22, top: 72, fontSize: 24, color: C.text2 }}>Fire matched to a site</div>
      </Panel>
      <Panel x={NODE_X} y={OUTREACH[1]} w={NODE_W} h={128} o={Math.min(1, outreach * 1.5) * (1 - exit)} scale={lerp(0.7, 1, outreach)} origin="80% 0%" style={{ padding: 0 }}>
        <NodeHead name="Outreach" />
        <div style={{ position: "absolute", left: 22, top: 72, fontSize: 24, color: C.text2 }}>Writes to the business</div>
      </Panel>

      <OutreachEmail abs={abs} />

      <ReplyPulse abs={abs} />
      {/* The reply is on the way: the Planner node is already forming under the pin. */}
      <Panel x={pillRect(PLANNER_TIP).x} y={PLANNER_TIP[1]} w={240} h={72} o={plannerIn} scale={lerp(0.7, 1, plannerIn)} origin="50% 0%" style={{ padding: 0 }}>
        <NodeHead name="Planner" />
      </Panel>
    </>
  );
};

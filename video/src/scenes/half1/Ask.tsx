import { useCurrentFrame } from "remotion";
import { Edge, Mono, Panel, Title } from "../../components/Primitives";
import { EASE, lerp, pop, prog, settle } from "../../motion";
import { C, COPY, FONT, hit, TIMING } from "../../tokens";
import { quad, Stage, type Pt } from "./shared";
import { FeedRack } from "./Signals";

const { to } = TIMING.scenes.ask;
const TIP = [960, 650] as const;
const LINES: { a: Pt; bend: number; at: number }[] = [
  { a: [534, 490], bend: -46, at: hit("email chip") },
  { a: [1386, 490], bend: 46, at: hit("web chip") },
  { a: [960, 862], bend: 0, at: hit("api chip") },
];

/** Once a channel is connected it keeps sending: pulses run down each line into the pin, which ripples as they arrive. */
const Pulses: React.FC<{ frame: number }> = ({ frame }) => {
  const period = 36;
  const leave = prog(frame, to - 16, 14, EASE.in);
  const rings = prog(frame, hit("email chip") + 24, 10) * (1 - leave);
  return (
    <Stage o={1 - leave}>
      {LINES.flatMap((line, l) => {
        const start = line.at + 22;
        return [0, 1].map((k) => {
          const age = frame - start - k * (period / 2) - l * 7;
          if (age < 0) {
            return null;
          }
          const u = (age % period) / period;
          const [x, y] = quad(line.a, TIP, line.bend, u * u * (3 - 2 * u));
          return <circle key={`${l}-${k}`} cx={x} cy={y} r={5.5} fill={C.accentHi} opacity={Math.min(1, u * 6, (1 - u) * 8)} />;
        });
      })}
      {[0, 1].map((k) => {
        const u = ((frame + k * 22) % 44) / 44;
        return <circle key={k} cx={TIP[0]} cy={TIP[1]} r={10 + 58 * (1 - (1 - u) * (1 - u))} fill="none" stroke={C.accentHi} strokeWidth={1.5} opacity={(1 - u) * 0.7 * rings} />;
      })}
    </Stage>
  );
};

/** Slides in from `dx` so it arrives exactly on its hit, then leaves toward the pin. */
const useInput = (at: number, dx: number, dy: number) => {
  const frame = useCurrentFrame();
  const s = settle(frame, at - 22);
  const exit = prog(frame, to - 14, 14);
  return {
    o: Math.min(s * 1.6, 1) * (1 - exit),
    t: `translate(${lerp(dx, 0, s) + exit * -dx * 0.25}px, ${lerp(dy, 0, s) + exit * -dy * 0.25}px)`,
  };
};

export const Ask: React.FC = () => {
  const frame = useCurrentFrame();
  const emailAt = hit("email chip");
  const webAt = hit("web chip");
  const apiAt = hit("api chip");
  const email = useInput(emailAt, -420, 0);
  const web = useInput(webAt, 420, 0);
  const api = useInput(apiAt, 0, 200);
  const tap = pop(frame, webAt);

  return (
    <>
      {frame >= to - 14 ? <FeedRack abs={frame} /> : null}
      <Title text={COPY.ask} from={hit("pin lands on globe") - 8} to={to} x={96} y={100} size={80} align="center" />
      <Edge a={[534, 490]} b={TIP} from={emailAt} until={to} bend={-46} />
      <Edge a={[1386, 490]} b={TIP} from={webAt} until={to} bend={46} />
      <Edge a={[960, 862]} b={TIP} from={apiAt} until={to} color={C.accentHi} />

      <Pulses frame={frame} />

      <div style={{ opacity: email.o, transform: email.t }}>
        <Panel x={126} y={420} w={408} h={150}>
          <Mono size={22} color={C.accentHi}>EMAIL</Mono>
          <div style={{ fontFamily: FONT.sans, fontSize: 30, fontWeight: 500, marginTop: 10, lineHeight: 1.18 }}>
            Did the fire reach our vineyard?
          </div>
        </Panel>
      </div>

      <div style={{ opacity: web.o, transform: web.t }}>
        <Panel x={1386} y={420} w={408} h={150}>
          <Mono size={22} color={C.accentHi}>WEB GLOBE</Mono>
          <div
            style={{
              marginTop: 12,
              padding: "10px 16px",
              border: `1px solid ${C.lineStrong}`,
              background: C.raised,
              borderRadius: 6,
              fontSize: 26,
              color: C.text2,
              position: "relative",
            }}
          >
            Where on Earth?
            <span
              style={{
                position: "absolute",
                right: 36,
                top: 26,
                width: 34,
                height: 34,
                marginLeft: -17,
                borderRadius: "50%",
                border: `2px solid ${C.accentHi}`,
                opacity: (1 - prog(frame, webAt, 26)) * Math.min(tap, 1),
                transform: `translate(0, -50%) scale(${lerp(0.4, 1.7, prog(frame, webAt, 26))})`,
              }}
            />
          </div>
        </Panel>
      </div>

      <div style={{ opacity: api.o, transform: api.t }}>
        <Panel x={636} y={862} w={648} h={108}>
          <Mono size={22} color={C.accentHi}>API · MCP</Mono>
          <div style={{ marginTop: 8 }}>
            <Mono size={26} color={C.text}>POST /api/requests</Mono>
          </div>
        </Panel>
      </div>
    </>
  );
};

import { prog } from "../../motion";
import { C, TIMING } from "../../tokens";
import { ANALYTICS_TIP, INTERPRETER_TIP, Node, pillRect, StopOrbit, VERIFIER_TIP } from "./shared";

const S = TIMING.scenes.analysis;

/** The three stops of the analysis chain, dark until they work, linked by the satellite's hairline. Absolute frame. */
export const AnalysisStops: React.FC<{ abs: number; o?: number; interpreter?: number; verifier?: number }> = ({ abs, o = 1, interpreter = 1, verifier = 1 }) => {
  const enter = prog(abs, S.from - 14, 14) * o;
  return (
    <>
      <StopOrbit stops={[ANALYTICS_TIP, INTERPRETER_TIP, VERIFIER_TIP]} bend={-140} abs={abs} o={enter} period={200} phase={-S.from} />
      <div style={{ position: "absolute", inset: 0, opacity: enter * 0.72 }}>
        <Node rect={pillRect(INTERPRETER_TIP)} name="Interpreter" color={C.lineStrong} border={C.line} o={interpreter} />
        <Node rect={pillRect(VERIFIER_TIP)} name="Verifier" color={C.lineStrong} border={C.line} o={verifier} />
      </div>
    </>
  );
};

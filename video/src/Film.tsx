import { loadFont } from "@remotion/fonts";
import { useState } from "react";
import { AbsoluteFill, Audio, cancelRender, continueRender, delayRender, Sequence, staticFile } from "remotion";
import { Globe } from "./components/Globe";
import { PinLayer } from "./components/Pin";
import { HexField } from "./components/Primitives";
import { HALF_1 } from "./scenes/half1";
import { HALF_2 } from "./scenes/half2";
import { C, SceneKey, TIMING } from "./tokens";

const SCENES: Partial<Record<SceneKey, React.FC>> = { ...HALF_1, ...HALF_2 };
const FONT_HANDLE = "Loading fonts";

/** Pinned local font files. Archivo keeps its width axis for the expanded display cut. */
const useFonts = () => {
  useState(() => {
    const handle = delayRender(FONT_HANDLE);
    Promise.all([
      loadFont({ family: "Archivo", url: staticFile("fonts/archivo-latin-wdth-normal.woff2"), weight: "100 900", stretch: "62% 125%" }),
      loadFont({ family: "JetBrains Mono", url: staticFile("fonts/jetbrains-mono-latin-wght-normal.woff2"), weight: "100 800" }),
    ])
      .then(() => continueRender(handle))
      .catch((err) => cancelRender(err));
    return handle;
  });
};

export const Film: React.FC<{ muted?: boolean }> = ({ muted = false }) => {
  useFonts();
  return (
    <AbsoluteFill style={{ background: C.space, overflow: "hidden" }}>
      <HexField />
      <Globe />
      {(Object.keys(TIMING.scenes) as SceneKey[]).map((key) => {
        const Scene = SCENES[key];
        const { from, to } = TIMING.scenes[key];
        return Scene ? (
          <Sequence key={key} from={from} durationInFrames={to - from} name={key} layout="none">
            <Scene />
          </Sequence>
        ) : null;
      })}
      <PinLayer />
      {muted ? null : <Audio src={staticFile("audio/mix.wav")} />}
    </AbsoluteFill>
  );
};

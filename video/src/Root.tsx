import { Composition, Still } from "remotion";
import { Film } from "./Film";
import { H, TIMING, W } from "./tokens";

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="TerragentFilm"
      component={Film}
      durationInFrames={TIMING.durationInFrames}
      fps={TIMING.fps}
      width={W}
      height={H}
      defaultProps={{ muted: false }}
    />
    <Still id="Frame" component={Film} width={W} height={H} defaultProps={{ muted: true }} />
  </>
);

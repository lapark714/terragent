import type { SceneKey } from "../../tokens";
import { Cocoa } from "./Cocoa";
import { Factory } from "./Factory";
import { Fields } from "./Fields";
import { Flood } from "./Flood";
import { Methane } from "./Methane";
import { Mining } from "./Mining";
import { Rapid } from "./Rapid";
import { Signoff } from "./Signoff";
import { withTag } from "./Tag";
import { Vineyard } from "./Vineyard";

export const HALF_2: Partial<Record<SceneKey, React.FC>> = {
  // Flood builds the tag itself, out of the full-frame slam.
  flood: Flood,
  vineyard: withTag(Vineyard),
  fields: withTag(Fields),
  cocoa: withTag(Cocoa),
  mining: withTag(Mining),
  methane: withTag(Methane),
  factory: withTag(Factory),
  rapid: Rapid,
  signoff: Signoff,
};

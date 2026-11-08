import type { SceneKey } from "../../tokens";
import { Analysis } from "./Analysis";
import { Ask } from "./Ask";
import { Delivery } from "./Delivery";
import { Mission } from "./Mission";
import { Planner } from "./Planner";
import { Pricing } from "./Pricing";
import { Routing } from "./Routing";
import { Signals } from "./Signals";

export const HALF_1: Partial<Record<SceneKey, React.FC>> = {
  ask: Ask,
  signals: Signals,
  planner: Planner,
  routing: Routing,
  pricing: Pricing,
  analysis: Analysis,
  delivery: Delivery,
  mission: Mission,
};

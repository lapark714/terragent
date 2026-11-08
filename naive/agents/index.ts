import type { AgentName } from "../../src/lib/domain";
import { acquisition } from "./acquisition";
import { analytics } from "./analytics";
import { commsCustomer } from "./comms-customer";
import { commsOutreach } from "./comms-outreach";
import { commsSuppliers } from "./comms-suppliers";
import { coordinator } from "./coordinator";
import { interpreter } from "./interpreter";
import { marketResearcher } from "./market-researcher";
import { planner } from "./planner";
import { pricing } from "./pricing";
import { sourcing } from "./sourcing";
import type { AgentDefinition } from "./types";
import { verifier } from "./verifier";

/** The 12-agent roster (spec §3.1). Keyed by AgentName, so a roster change fails typecheck here. */
export const AGENTS: Record<AgentName, AgentDefinition> = {
  coordinator,
  "comms-customer": commsCustomer,
  "comms-suppliers": commsSuppliers,
  "comms-outreach": commsOutreach,
  planner,
  acquisition,
  pricing,
  interpreter,
  analytics,
  verifier,
  sourcing,
  "market-researcher": marketResearcher,
};

export type { AgentDefinition } from "./types";

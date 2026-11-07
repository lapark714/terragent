/** All tool groups. The MCP server registers every group; a test checks catalog coverage. */
import type { RegisterGroup } from "../types";
import { register as core } from "./core";
import { register as planning } from "./planning";
import { register as acquisition } from "./acquisition";
import { register as suppliers } from "./suppliers";
import { register as pricing } from "./pricing";
import { register as analysis } from "./analysis";
import { register as reports } from "./reports";
import { register as customer } from "./customer";
import { register as signals } from "./signals";
import { register as prospects } from "./prospects";
import { register as outreach } from "./outreach";
import { register as coordinator } from "./coordinator";
import { register as monitoring } from "./monitoring";
import { register as market } from "./market";

export const TOOL_GROUPS: Record<string, RegisterGroup> = {
  core, planning, acquisition, suppliers, pricing, analysis, reports, customer,
  signals, prospects, outreach, coordinator, monitoring, market,
};

/** Everything the mission-control dashboard polls every few seconds, each panel isolated from the others. */
import { isOffline } from "../env";
import { getAllocationHistory } from "./allocation";
import { getBoard } from "./board";
import { getDecisions } from "./decisions";
import { getFunnel } from "./funnel";
import { getInterventions } from "./interventions";
import { getMoney } from "./money";
import { getActivity, getOverview } from "./overview";
import { anySuspended, panel } from "./rows";
import type { LiveSnapshot } from "./types";

export async function getLiveSnapshot(): Promise<LiveSnapshot> {
  const [overview, funnel, board, decisions, money, interventions, allocation, activity] = await Promise.all([
    panel(getOverview),
    panel(getFunnel),
    panel(getBoard),
    panel(() => getDecisions()),
    panel(getMoney),
    panel(() => getInterventions()),
    panel(getAllocationHistory),
    panel(() => getActivity(30)), // the Activity panel scrolls through the latest 30
  ]);
  return {
    generatedAt: new Date().toISOString(),
    offline: isOffline(),
    dbSuspended: anySuspended(overview, funnel, board, decisions, money, interventions, allocation, activity),
    overview, funnel, board, decisions, money, interventions, allocation, activity,
  };
}

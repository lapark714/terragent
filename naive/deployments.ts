/**
 * Cron schedules (Naïve deployments). Each fire is a new session of the agent; its input is the
 * prompt plus the scheduled time. The first prompt line names the board's standing card
 * ("Recurring: <first line>") and carries a [tg:<key>] marker so provisioning can find it again.
 * Per-run budgets are sized so every fire of an agent fits inside its share of the daily cap.
 */
import { AGENT_BUDGETS, type AgentBudget, type Window } from "../src/lib/config";
import type { AgentName } from "../src/lib/domain";

export const DEPLOYMENT_TIMEZONE = "America/Los_Angeles";

/**
 * Share of an agent's daily cap its scheduled fires may spend. The coordinator also gets one board-digest
 * session per tick in which cards finished or got blocked, so 30% of its cap stays free for those.
 */
export const SCHEDULED_SHARE: Partial<Record<AgentName, number>> = { coordinator: 0.7 };

export interface DeploymentSpec {
  key: string;
  agent: AgentName;
  cron: string;
  window: Window;
  prompt: string;
}

const sweep = (playbook: "disasters" | "deforestation" | "mining") =>
  `Playbook: ${playbook}. Read skill playbook-${playbook}, then terragent.poll_signals({ "playbook": "${playbook}" }), ` +
  "match affected businesses, score them, and request free samples for the best prospects within this playbook's share " +
  "of terragent.get_allocation. End with terragent.log_decision summarising the run.";

export const DEPLOYMENTS: readonly DeploymentSpec[] = [
  {
    key: "sourcing-disasters",
    agent: "sourcing",
    cron: "5 * * * *",
    window: AGENT_BUDGETS.sourcing.window,
    prompt: `Disasters signal sweep [tg:sourcing-disasters]\n${sweep("disasters")}`,
  },
  {
    key: "sourcing-deforestation",
    agent: "sourcing",
    cron: "25 * * * *",
    window: AGENT_BUDGETS.sourcing.window,
    prompt: `Deforestation signal sweep [tg:sourcing-deforestation]\n${sweep("deforestation")}`,
  },
  {
    key: "sourcing-mining",
    agent: "sourcing",
    cron: "45 * * * *",
    window: AGENT_BUDGETS.sourcing.window,
    prompt: `Mining signal sweep [tg:sourcing-mining]\n${sweep("mining")}`,
  },
  {
    key: "coordinator-review",
    agent: "coordinator",
    cron: "50 */3 * * *",
    window: AGENT_BUDGETS.coordinator.window,
    prompt:
      "Company review [tg:coordinator-review]\n" +
      "Measure and steer: terragent.get_metrics, terragent.get_allocation, terragent.get_spend_summary, then " +
      "terragent.set_playbook_allocation with the metrics and the reason. Then terragent.list_stuck_requests and unstick or close each one.",
  },
  {
    key: "analytics-monitors",
    agent: "analytics",
    cron: "35 */6 * * *",
    window: AGENT_BUDGETS.analytics.window,
    prompt:
      "Check due monitors [tg:analytics-monitors]\n" +
      "Call terragent.list_due_monitors. For each due monitor call terragent.run_analysis({ request_id, monitor_id }): it re-runs " +
      "the analysis on the newest clear scene and records the re-check on the monitor itself. Stop when none are left.",
  },
  {
    key: "outreach-followups",
    agent: "comms-outreach",
    cron: "15 1,7,13,19 * * *",
    window: AGENT_BUDGETS["comms-outreach"].window,
    prompt:
      "Follow-up run [tg:outreach-followups]\n" +
      "No request: start with terragent.list_followups (only prospects with NEW information: a new clear image or a detected change). " +
      "For each item send ONE terragent.send_outreach_email kind=followup carrying its new_info; never a plain reminder, and skip anyone " +
      "list_followups doesn't return. End with terragent.log_decision kind outreach: who was contacted, who was blocked and why.",
  },
  {
    key: "market-research",
    agent: "market-researcher",
    cron: "0 9 * * *",
    window: AGENT_BUDGETS["market-researcher"].window,
    prompt:
      "Market price research [tg:market-research]\n" +
      "Refresh the cited table of what today's alternatives cost for the disasters, deforestation and mining playbooks " +
      "and save it with terragent.save_market_prices.",
  },
];

export const deploymentMarker = (key: string) => `[tg:${key}]`;

/** Fires per day from the hour field of a 5-field cron ("*", "*\/n" or a comma list; minute fixed). */
export function firesPerDay(cron: string): number {
  const [minute, hour, dom, month, dow] = cron.trim().split(/\s+/);
  if (!/^\d+$/.test(minute) || dom !== "*" || month !== "*" || dow !== "*") throw new Error(`unsupported cron: ${cron}`);
  if (hour === "*") return 24;
  const step = /^\*\/(\d+)$/.exec(hour);
  if (step) return Math.ceil(24 / Number(step[1]));
  if (/^\d+(,\d+)*$/.test(hour)) return hour.split(",").length;
  throw new Error(`unsupported cron hour field: ${cron}`);
}

/** Per-run budget (USD): the agent's per-task ceiling, shrunk so all its fires fit in its scheduled share of the daily cap. */
export function runBudgetUsd(
  spec: DeploymentSpec,
  all: readonly DeploymentSpec[] = DEPLOYMENTS,
  budgets: Record<AgentName, AgentBudget> = AGENT_BUDGETS,
): number {
  const fires = all.filter((d) => d.agent === spec.agent).reduce((n, d) => n + firesPerDay(d.cron), 0);
  const b = budgets[spec.agent];
  const scheduledCap = b.capUsdPerDay * (SCHEDULED_SHARE[spec.agent] ?? 1);
  return Math.floor(Math.min(b.maxTaskUsd, scheduledCap / fires) * 100) / 100;
}

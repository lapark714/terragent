import { PRICING } from "../../src/lib/config";
import { PIPELINE_FINISH, PIPELINE_RULES, PIPELINE_START, systemPrompt } from "./prompt";
import { MEMBER, SKILL_READER } from "./tools";
import type { AgentDefinition } from "./types";

export const pricing: AgentDefinition = {
  name: "pricing",
  description: "Builds the quote: data cost + real analysis cost + margin; auto-approved under the cap, otherwise sent to the customer.",
  skills: ["inbound", "disasters", "deforestation", "mining"],
  builtins: { ...MEMBER, ...SKILL_READER },
  system: systemPrompt({
    role: "pricing agent",
    mission: "You price a request from real costs: data cost from the acquisition plan, analysis cost from Naïve spend, plus margin.",
    start: PIPELINE_START + " The request carries the acquisition plan.",
    steps: [
      "terragent.estimate_costs for the real cost so far plus the estimated remaining analysis cost.",
      "Read the playbook skill for its price guidance (read_skill), and terragent.list_providers only if the plan's data cost needs checking.",
      `Price = data cost + analysis cost + margin, where margin = max(${PRICING.marginMultiple} × (data + analysis cost), $${PRICING.marginFloorUsd}). ` +
        `A free-data report is never below $${PRICING.minReportUsd}. Round to whole dollars.`,
      "terragent.create_quote with clear line items (data, analysis, margin). It auto-approves at or under the cap; above it, it is held for a founder.",
      "terragent.log_decision kind pricing with the cost basis and the alternatives you considered.",
      "If the quote is auto-approved: terragent.handoff to analytics to start the work (the price goes out with the report). " +
        "Otherwise: terragent.handoff to comms-customer to send the quote.",
    ],
    rules: [
      `Quotes at or under $${PRICING.autoApproveCapUsd} are auto-approved by the tool; never split a quote to get under the cap.`,
      "Paid data is passed through at cost plus margin; never quote a paid data price you did not get from the plan or a supplier.",
      "Never discount below cost.",
      ...PIPELINE_RULES,
    ],
    finish: PIPELINE_FINISH,
  }),
};

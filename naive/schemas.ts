/**
 * Every agent's optional structured output: a one-line run summary. It arrives as
 * `data.structured_output` on the session.idle webhook, so the dashboard learns what a run did
 * without reading its transcript. Not required (structured_output_required: false).
 */
import { z } from "zod";
import { AgentName } from "../src/lib/domain";

export const RunSummary = z.object({
  outcome: z.enum(["handed_off", "waiting_on_customer", "waiting_on_human", "done", "refused", "failed", "nothing_to_do"]),
  request_id: z.string().nullable().describe("req_... this run worked on, or null"),
  next_agent: AgentName.nullable().describe("who you handed off to, or null"),
  summary: z.string().describe("one or two sentences: what you did and why"),
});
export type RunSummary = z.infer<typeof RunSummary>;

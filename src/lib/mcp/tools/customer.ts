/** Catalog group "customer": Comms 2 (hello@) screening, replies and updates, quotes, delivery, opt-outs and monitoring. */
import { z } from "zod";
import { Recipe, ScreeningResult } from "../../domain";
import { deliverReport, recordCustomerOptOut, sendCustomerMessage, sendQuote } from "../../pipeline/deliver";
import { createMonitor } from "../../pipeline/monitors";
import { recordScreening } from "../../pipeline/screening";
import type { ToolRegistrar } from "../types";

export function register(r: ToolRegistrar): void {
  r.tool("record_screening", { request_id: z.string(), ...ScreeningResult.shape }, async ({ request_id, ...result }, ctx) =>
    recordScreening(request_id, result, ctx.agent),
  );

  r.tool(
    "send_customer_message",
    {
      request_id: z.string(),
      kind: z.enum(["clarifying_question", "refusal", "update"]).describe(
        "clarifying_question parks the request; refusal only after record_screening refused it; update = a status update, " +
          "or the delivery of a monitoring follow-up (closes that request as delivered)",
      ),
      text: z.string().min(5).max(2000).describe(
        "the one question to ask, the plain reason for the refusal, or the update itself (what changed, with dates and image links); the greeting and sign-off are added",
      ),
    },
    async (a, ctx) => sendCustomerMessage({ requestId: a.request_id, kind: a.kind, text: a.text }, ctx.agent),
  );

  r.tool("send_quote", { request_id: z.string() }, async ({ request_id }, ctx) => sendQuote(request_id, ctx.agent));

  r.tool("deliver_report", { request_id: z.string() }, async ({ request_id }, ctx) => deliverReport(request_id, ctx.agent));

  r.tool(
    "record_opt_out",
    {
      request_id: z.string(),
      email: z.string().max(320).optional().describe("who asked to stop: default the request's customer; must be them or someone who wrote in its thread"),
      reason: z.string().min(3).max(500).describe("what they said, in a few words (e.g. 'replied: please stop emailing me')"),
    },
    async (a, ctx) => recordCustomerOptOut({ requestId: a.request_id, email: a.email, reason: a.reason }, ctx.agent),
  );

  r.tool(
    "create_monitor",
    {
      request_id: z.string(),
      metric: z.string().min(2).describe("metric to watch, e.g. ndvi_mean or dnbr_mean"),
      threshold: z.number().nullable().optional().describe("change that triggers a follow-up (default: the recipe's change threshold)"),
      cadence: z.string().optional().describe('5-field cron, default weekly "0 14 * * 1"'),
      recipe: Recipe.optional(),
    },
    async (a, ctx) => createMonitor({ requestId: a.request_id, metric: a.metric, threshold: a.threshold, cadence: a.cadence, recipe: a.recipe }, ctx.agent),
  );
}

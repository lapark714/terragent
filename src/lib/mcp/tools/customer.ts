/** Catalog group "customer": Comms 2 (hello@) screening, replies, quotes, delivery and monitoring. */
import { z } from "zod";
import { Recipe, ScreeningResult } from "../../domain";
import { deliverReport, sendCustomerMessage, sendQuote } from "../../pipeline/deliver";
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
      kind: z.enum(["clarifying_question", "refusal"]),
      text: z.string().min(5).max(2000).describe("the question to ask, or the plain reason for the refusal"),
    },
    async (a, ctx) => sendCustomerMessage({ requestId: a.request_id, kind: a.kind, text: a.text }, ctx.agent),
  );

  r.tool("send_quote", { request_id: z.string() }, async ({ request_id }, ctx) => sendQuote(request_id, ctx.agent));

  r.tool("deliver_report", { request_id: z.string() }, async ({ request_id }, ctx) => deliverReport(request_id, ctx.agent));

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

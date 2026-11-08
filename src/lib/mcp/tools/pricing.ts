/** Catalog group "pricing" (pricing v2): our cost view, the server's priced options, and saving the quote. */
import { z } from "zod";
import { QuoteOption, QuoteOptionId } from "../../domain";
import { createQuote, estimateCosts, priceOptions } from "../../pipeline/quotes";
import type { ToolRegistrar } from "../types";

const epochs = z.number().int().min(1).max(500).optional().describe(
  "dates/scenes the question needs when the data spec's before/after windows don't say it (e.g. 10 for ten yearly images); " +
    "default 2 with a before window, else 1. Capped at what the analysis compares today (the result's notes say so). " +
    "Pass the same value to price_options and create_quote",
);

export function register(r: ToolRegistrar): void {
  r.tool("estimate_costs", { request_id: z.string() }, async ({ request_id }) => estimateCosts(request_id));

  r.tool("price_options", { request_id: z.string(), epochs }, async (a) => priceOptions(a.request_id, { epochs: a.epochs }));

  r.tool(
    "create_quote",
    {
      request_id: z.string(),
      options: z.array(QuoteOption).min(1).max(3).optional().describe(
        "price_options' options, with labels/answers/notes adjusted if needed; prices and data items as returned (the server re-prices). Leave out to use the server's options as they are",
      ),
      recommended_option_id: QuoteOptionId.optional().describe(
        "the cheapest option that answers the question (price_options' recommendation); required if you dropped that option",
      ),
      epochs,
      notes: z.string().max(1000).optional().describe("pricing rationale for the decision log"),
    },
    async (a, ctx) =>
      createQuote(
        { requestId: a.request_id, options: a.options, recommendedOptionId: a.recommended_option_id, epochs: a.epochs, notes: a.notes }, ctx.agent,
      ),
  );
}

/** Catalog group "pricing": real cost so far + formula quote (auto-approved under the cap). */
import { z } from "zod";
import { createQuote, estimateCosts } from "../../pipeline/quotes";
import type { ToolRegistrar } from "../types";

export function register(r: ToolRegistrar): void {
  r.tool("estimate_costs", { request_id: z.string() }, async ({ request_id }) => estimateCosts(request_id));

  r.tool(
    "create_quote",
    {
      request_id: z.string(),
      data_cost_usd: z.number().nonnegative().optional().describe("override the plan's data cost, e.g. with a real supplier quote in USD"),
      note: z.string().max(1000).optional().describe("pricing rationale for the decision log"),
    },
    async (a, ctx) => createQuote({ requestId: a.request_id, dataCostUsd: a.data_cost_usd, note: a.note }, ctx.agent),
  );
}

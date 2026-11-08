/** OWNER: outbound builder. Catalog group "market" (Market researcher): cited prices of today's alternatives. */
import { z } from "zod";
import { guarded } from "../../outbound/errors";
import { MarketPriceRow, saveMarketPrices } from "../../outbound/market";
import type { ToolRegistrar } from "../types";

export function register(registrar: ToolRegistrar): void {
  const r = guarded(registrar);

  r.tool(
    "save_market_prices",
    { rows: z.array(MarketPriceRow).min(1).max(100).describe("one row per alternative per source; re-saving the same source updates it") },
    (a, ctx) => saveMarketPrices({ rows: a.rows, actor: ctx.agent }),
  );
}

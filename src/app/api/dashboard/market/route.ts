/**
 * "What it costs today": the market researcher's cited prices (market_prices) next to our floor price. Public,
 * read from the same per-instance cache as the other dashboard reads, refreshed every ten minutes (NOTES H4c).
 */
import { json } from "@/app/_lib/http";
import { cachedMarket } from "@/lib/dashboard/cache";

export async function GET() {
  return json(await cachedMarket());
}

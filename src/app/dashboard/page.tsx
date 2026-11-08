import type { Metadata } from "next";
import { SalesConsole } from "@/components/dashboard/sales/SalesConsole";
import { cachedLiveSnapshot, cachedMarket } from "@/lib/dashboard/cache";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Operations",
  description: "Terragent's operations, run by AI agents: deals, what we've delivered, our price against today's alternatives, and where the data comes from.",
};

/** The dashboard's main tab. Server-renders from the same short cache the JSON endpoints use. */
export default async function OperationsPage() {
  const [live, market] = await Promise.all([cachedLiveSnapshot(), cachedMarket().catch(() => null)]);
  return <SalesConsole initialLive={live} initialMarket={market} />;
}

import type { Metadata } from "next";
import { SalesConsole } from "@/components/dashboard/sales/SalesConsole";
import { cachedApprovals, cachedLiveSnapshot, cachedMarket } from "@/lib/dashboard/cache";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Operations",
  description: "Terragent's operations, run by AI agents: deals, what we've delivered, our price against today's alternatives, and where the data comes from.",
};

/** The dashboard's main tab. Server-renders from the same short cache the JSON endpoints use. */
export default async function OperationsPage() {
  const [live, approvals, market] = await Promise.all([
    cachedLiveSnapshot(),
    cachedApprovals().catch(() => null),
    cachedMarket().catch(() => null),
  ]);
  return <SalesConsole initialLive={live} initialApprovals={approvals} initialMarket={market} />;
}

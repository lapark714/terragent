import type { Metadata } from "next";
import { SalesConsole } from "@/components/dashboard/sales/SalesConsole";
import { cachedLiveSnapshot } from "@/lib/dashboard/cache";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Operations",
  description: "Terragent's operations, run by AI agents: deals, what we've delivered, what it costs, and where the data comes from.",
};

/** The dashboard's main tab. Server-renders from the same short cache the JSON endpoints use. */
export default async function OperationsPage() {
  return <SalesConsole initialLive={await cachedLiveSnapshot()} />;
}

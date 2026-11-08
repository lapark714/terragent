import type { Metadata } from "next";
import { MissionControl } from "@/components/dashboard/MissionControl";
import { cachedApprovals, cachedGlobe, cachedLiveSnapshot } from "@/lib/dashboard/cache";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Signal Engine",
  description: "Terragent's signal engine, run by AI agents: the signals they pick up around the world, and which ones turn into business.",
};

/** Server-renders from the same short cache the JSON endpoints use, so a page load is not an extra database read. */
export default async function DashboardPage() {
  const [live, globe, approvals] = await Promise.all([
    cachedLiveSnapshot(),
    cachedGlobe().catch(() => null),
    cachedApprovals().catch(() => null),
  ]);
  return <MissionControl initialLive={live} initialGlobe={globe} initialApprovals={approvals} />;
}

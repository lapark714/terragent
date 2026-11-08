import type { Metadata } from "next";
import { MissionControl } from "@/components/dashboard/MissionControl";
import { cachedGlobe, cachedLiveSnapshot } from "@/lib/dashboard/cache";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Signal Engine",
  description: "Terragent's signal engine, run by AI agents: the signals they pick up around the world, and which ones turn into business.",
};

/** Server-renders from the same short cache the JSON endpoints use, so a page load is not an extra database read. */
export default async function SignalEnginePage() {
  const [live, globe] = await Promise.all([cachedLiveSnapshot(), cachedGlobe().catch(() => null)]);
  return <MissionControl initialLive={live} initialGlobe={globe} />;
}

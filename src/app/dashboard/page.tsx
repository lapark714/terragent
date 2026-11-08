import type { Metadata } from "next";
import { MissionControl } from "@/components/dashboard/MissionControl";
import { getApprovals } from "@/lib/dashboard/approvals";
import { getGlobeData } from "@/lib/dashboard/globe";
import { getLiveSnapshot } from "@/lib/dashboard/snapshot";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Mission control",
  description: "Terragent's agents at work: the Earth index, the funnel, the board, every decision and every human step.",
};

export default async function DashboardPage() {
  const [live, globe, approvals] = await Promise.all([
    getLiveSnapshot(),
    getGlobeData().catch(() => null),
    getApprovals().catch(() => null),
  ]);
  return <MissionControl initialLive={live} initialGlobe={globe} initialApprovals={approvals} />;
}

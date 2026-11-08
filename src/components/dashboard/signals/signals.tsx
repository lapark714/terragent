/** Signal-engine helpers: layers, readable feed names, and how urgent each feed is. */
import type { Layer } from "@/lib/domain";

/** Layers a signal can be on (inbound requests are customers, not signals). */
export const SIGNAL_LAYERS: Layer[] = ["disasters", "forest", "mining"];

export const LAYER_BG: Record<Layer, string> = { disasters: "bg-disasters", forest: "bg-forest", mining: "bg-mining", inbound: "bg-inbound" };

const FEED_LABEL: Record<string, string> = {
  gfw: "Global Forest Watch alerts",
  firms: "NASA FIRMS fire detections",
  usgs_quake: "USGS earthquakes",
  nws: "National Weather Service warnings",
  nwps_flood: "NOAA river flood gauges",
  openfema: "OpenFEMA disaster declarations",
  blm_claims: "BLM mining claims",
  mrds: "USGS mineral sites",
  news: "News",
};

/** "usgs_quake" → "USGS earthquakes"; unknown feeds become readable words. */
export function feedLabel(feed: string): string {
  if (FEED_LABEL[feed]) return FEED_LABEL[feed];
  const words = feed.replace(/[._-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * How time-sensitive a signal is. Urgent: an event just happened (a warning, a quake, a fire, a flood, a declaration)
 * and the business needs an answer now. Slow-moving: something is building (claims filed, mineral sites, forest
 * clearing, news), so the pitch is monitoring rather than an emergency check. Unknown feeds count as slow-moving.
 */
export type Urgency = "urgent" | "slow";
export const URGENCY_LABEL: Record<Urgency, string> = { urgent: "Urgent", slow: "Slow-moving" };
const URGENT_FEEDS = new Set(["nws", "usgs_quake", "firms", "nwps_flood", "openfema"]);
export const urgencyOf = (feed: string): Urgency => (URGENT_FEEDS.has(feed) ? "urgent" : "slow");

export function UrgencyTag({ feed }: { feed: string }) {
  const u = urgencyOf(feed);
  return (
    <span className={`inline-flex shrink-0 items-center rounded px-1.5 py-px text-[10px] font-medium tracking-wide uppercase ${u === "urgent" ? "bg-alert/15 text-alert" : "bg-raised text-fg-2"}`}>
      {URGENCY_LABEL[u]}
    </span>
  );
}

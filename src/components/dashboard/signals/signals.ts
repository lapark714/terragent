/** Signal-engine helpers: layers and readable feed names. */
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

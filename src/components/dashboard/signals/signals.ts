/** Signal-engine helpers: feed names, per-feed counts, and per-playbook conversion from the funnel. Pure functions. */
import type { Layer, Playbook } from "@/lib/domain";
import type { FunnelStage, FunnelStageKey, GlobeSignal } from "@/lib/dashboard/types";

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

export interface FeedCount { feed: string; layer: Layer; n: number }

/** Signals per feed, biggest first; a feed that spans layers is listed once per layer. */
export function feedCounts(signals: GlobeSignal[]): FeedCount[] {
  const m = new Map<string, FeedCount>();
  for (const s of signals) {
    const key = `${s.feed}|${s.layer}`;
    const c = m.get(key) ?? { feed: s.feed, layer: s.layer, n: 0 };
    c.n += 1;
    m.set(key, c);
  }
  return [...m.values()].sort((a, b) => b.n - a.n || a.feed.localeCompare(b.feed) || a.layer.localeCompare(b.layer));
}

export const OUTBOUND: Exclude<Playbook, "inbound">[] = ["disasters", "deforestation", "mining"];

export type Conversion = { playbook: Exclude<Playbook, "inbound"> } & Record<FunnelStageKey, number> & {
  /** Replies per first touch; null before any touch. */
  replyRate: number | null;
  /** Replies per 100 signals; null before any signal. */
  repliesPer100: number | null;
};

/** One row per outbound playbook: how its signals moved through the funnel. */
export function conversion(stages: FunnelStage[]): Conversion[] {
  const at = (key: FunnelStageKey, p: Playbook) => stages.find((s) => s.key === key)?.byPlaybook[p] ?? 0;
  return OUTBOUND.map((p) => {
    const row = {
      playbook: p,
      signals: at("signals", p),
      prospects: at("prospects", p),
      reports: at("reports", p),
      touches: at("touches", p),
      replies: at("replies", p),
      quotes: at("quotes", p),
      paid: at("paid", p),
    };
    return {
      ...row,
      replyRate: row.touches ? row.replies / row.touches : null,
      repliesPer100: row.signals ? (row.replies / row.signals) * 100 : null,
    };
  });
}

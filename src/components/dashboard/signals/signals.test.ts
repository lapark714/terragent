import { describe, expect, it } from "vitest";
import type { FunnelStage, GlobeSignal } from "@/lib/dashboard/types";
import { conversion, feedCounts, feedLabel } from "./signals";

const sig = (feed: string, layer: GlobeSignal["layer"]): GlobeSignal => ({ id: Math.random().toString(), lat: 0, lng: 0, layer, title: "t", feed, severity: null, at: "2026-11-07T00:00:00Z" });

describe("feedLabel", () => {
  it("names known feeds and tidies unknown ones", () => {
    expect(feedLabel("usgs_quake")).toBe("USGS earthquakes");
    expect(feedLabel("some_new.feed")).toBe("Some new feed");
  });
});

describe("feedCounts", () => {
  it("counts per feed and layer, biggest first", () => {
    expect(feedCounts([sig("news", "mining"), sig("gfw", "forest"), sig("gfw", "forest"), sig("news", "disasters")])).toEqual([
      { feed: "gfw", layer: "forest", n: 2 },
      { feed: "news", layer: "disasters", n: 1 },
      { feed: "news", layer: "mining", n: 1 },
    ]);
  });
});

describe("conversion", () => {
  it("follows each outbound playbook through the funnel", () => {
    const stage = (key: FunnelStage["key"], d: number, f: number, m: number): FunnelStage => ({ key, total: d + f + m, byPlaybook: { disasters: d, deforestation: f, mining: m, inbound: 0 } });
    const rows = conversion([stage("signals", 20, 10, 0), stage("touches", 4, 0, 0), stage("replies", 2, 0, 0), stage("paid", 1, 0, 0)]);
    expect(rows[0]).toMatchObject({ playbook: "disasters", signals: 20, touches: 4, replies: 2, paid: 1, prospects: 0, replyRate: 0.5, repliesPer100: 10 });
    expect(rows[1]).toMatchObject({ playbook: "deforestation", replyRate: null, repliesPer100: 0 });
    expect(rows[2]).toMatchObject({ playbook: "mining", replyRate: null, repliesPer100: null });
  });
});

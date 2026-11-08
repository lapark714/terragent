import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SIGNAL_FEEDS, type SignalFeed } from "../domain";
import { mockFetch, text } from "./__fixtures__/fetch-mock";
import { FEEDS_BY_PLAYBOOK, pollFeed, pollPlaybook } from "./index";

const signal = (id: string, severity: string | null, event_time: string | null, extra: object = {}) => ({
  playbook: "disasters", feed: "usgs_quake", external_id: id, title: id, severity, event_time, geometry: null, lat: 1, lon: 2, raw: {}, ...extra,
});

vi.mock("./usgs-quake", () => ({
  fetchUsgsQuakes: vi.fn(async () => ({
    signals: [
      signal("old-minor", "minor", "2026-11-01T00:00:00.000Z"),
      signal("new-minor", "minor", "2026-11-07T00:00:00.000Z"),
      signal("severe", "severe", "2026-11-02T00:00:00.000Z"),
      signal("severe", "severe", "2026-11-02T00:00:00.000Z"), // duplicate
      signal("bad", "minor", null, { playbook: "weather" }), // not a playbook
    ],
    warnings: ["something odd"],
  })),
}));

describe("pollFeed", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("every feed belongs to a playbook", () => {
    expect(new Set(Object.values(FEEDS_BY_PLAYBOOK).flat())).toEqual(new Set(SIGNAL_FEEDS));
  });

  it("validates, dedupes, ranks by severity then recency, and limits", async () => {
    const { signals, warnings } = await pollFeed("usgs_quake", { limit: 2 });
    expect(signals.map((s) => s.external_id)).toEqual(["severe", "new-minor"]);
    expect(warnings).toEqual(["usgs_quake: something odd", expect.stringMatching(/^usgs_quake: dropped bad/)]);
  });

  it("turns a failing feed into a warning instead of throwing", async () => {
    mockFetch([["", text("boom", 500)]]);
    const res = await pollFeed("openfema");
    expect(res.signals).toEqual([]);
    expect(res.warnings).toEqual([expect.stringMatching(/^openfema: .*HTTP 500 boom/)]);
  });

  it("polls a whole playbook and counts per feed", async () => {
    mockFetch([["", text("down", 503)]]);
    const res = await pollPlaybook("mining", { bbox: [-116, 39.5, -115.5, 40] });
    expect(res.counts).toEqual({ blm_claims: 0, mrds: 0, news: 0 });
    expect(res.warnings.some((w) => w.startsWith("blm_claims: ") && w.includes("HTTP 503"))).toBe(true);
    expect(res.warnings.some((w) => w.startsWith("mrds: "))).toBe(true);
    expect(res.warnings.some((w) => w.startsWith("news: paid feed"))).toBe(true);
  });

  it("mining polls the BLM claims feed first, so a free sweep has a what's-new feed", () => {
    expect(FEEDS_BY_PLAYBOOK.mining[0]).toBe("blm_claims");
  });
});

describe("playbook skills", () => {
  /** Feed names in the first column of the skill's "## Signals" table (other backticked names are data tools). */
  function skillFeeds(playbook: string): Set<string> {
    const md = readFileSync(path.join(import.meta.dirname, "../../../naive/skills", playbook, "SKILL.md"), "utf8");
    const section = md.split(/^## Signals.*$/m)[1]?.split(/^## /m)[0] ?? "";
    const firstCells = section.split("\n").filter((l) => l.startsWith("|")).map((l) => l.split("|")[1] ?? "");
    const feeds = firstCells.flatMap((cell) => [...cell.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]));
    return new Set(feeds.filter((f) => (SIGNAL_FEEDS as readonly string[]).includes(f)));
  }

  it.each(Object.entries(FEEDS_BY_PLAYBOOK))("the %s skill lists exactly the feeds poll_signals polls", (playbook, feeds) => {
    expect(skillFeeds(playbook)).toEqual(new Set<SignalFeed>(feeds));
  });
});

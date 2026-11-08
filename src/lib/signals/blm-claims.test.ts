import { afterEach, describe, expect, it, vi } from "vitest";
import { SignalInput } from "../domain";
import { fixture, json, mockFetch } from "./__fixtures__/fetch-mock";
import { claimStem, fetchBlmClaims, stakingSize } from "./blm-claims";

describe("blm_claims", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("groups new claims into one signal per staked block, paging past the transfer limit", async () => {
    const calls = mockFetch([
      [/resultOffset=0&/, new Response(fixture("blm-claims-not-closed.json"))],
      [/resultOffset=2000&/, json({ type: "FeatureCollection", features: [] })],
    ]);
    const { signals, warnings } = await fetchBlmClaims({ since: new Date("2026-11-04T09:00:00Z") });
    expect(warnings).toEqual([]);
    expect(calls).toHaveLength(2);
    const q = new URL(calls[0].url).searchParams;
    expect(q.get("where")).toBe("Created >= DATE '2026-11-04'");
    expect(q.get("outSR")).toBe("4326");

    // Once "blm_claims" is in SIGNAL_FEEDS these are plain SignalInputs.
    for (const s of signals) expect(SignalInput.safeParse({ ...s, feed: "mrds" }).success).toBe(true);
    expect(signals.map((s) => s.raw.claims)).toEqual([...signals.map((s) => s.raw.claims as number)].sort((a, b) => b - a));

    const roc = signals.filter((s) => (s.raw.name_stems as string[]).includes("ROC"));
    expect(roc.reduce((n, s) => n + (s.raw.claims as number), 0)).toBe(18); // 12 located + 6 without a shape
    expect(roc.every((s) => (s.raw.states as string[]).join() === "AK")).toBe(true);
    const rocBlock = roc.find((s) => (s.raw.located_claims as number) < (s.raw.claims as number))!;
    expect(rocBlock).toMatchObject({ playbook: "mining", feed: "blm_claims", geometry: { type: "Polygon" } });
    expect(rocBlock.external_id).toMatch(/^claims:AK\d{9}$/);
    expect(rocBlock.lat).toBeGreaterThan(60);

    // RAD L and RADIUM MINE AURA claims touch: one block, two names.
    const colorado = signals.find((s) => (s.raw.states as string[]).includes("CO"))!;
    expect(colorado.raw.name_stems).toEqual(expect.arrayContaining(["RAD L", "RADIUM MINE AURA"]));
    expect(colorado.raw.kinds).toEqual({ "LODE CLAIM": 4, "PLACER CLAIM": 3 });

    const gulch = signals.find((s) => (s.raw.name_stems as string[])[0] === "Treasure Gulch")!;
    expect(gulch).toMatchObject({ severity: "minor", event_time: "2026-11-07T00:00:00.000Z" });
    expect(gulch.title).toBe('New mining claims: 3 claims "Treasure Gulch" (60 acres), AZ');
  });

  it("names and sizes claim blocks", () => {
    expect(claimStem("ROC 3560")).toBe("ROC");
    expect(claimStem("RADIUM MINE AURA NO 3")).toBe("RADIUM MINE AURA");
    expect(claimStem("Gehrke #4")).toBe("Gehrke");
    expect(claimStem("1234")).toBe("1234");
    expect([stakingSize(150), stakingSize(30), stakingSize(5), stakingSize(1)]).toEqual(["extreme", "severe", "moderate", "minor"]);
  });
});

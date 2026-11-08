/** Live, free, read-only: one small poll per free feed. Run: npx vitest run --config vitest.live.config.mts src/lib/signals */
import { beforeAll, describe, expect, it } from "vitest";
import { createDb, setDb } from "../db/client";
import { migrate } from "../db/migrate";
import { SignalInput, type SignalFeed } from "../domain";
import { fetchBlmClaims } from "./blm-claims";
import { pollFeed, type FeedOptions } from "./index";

// The live config loads .env (production DATABASE_URL); the zone cache and continuity check use a throwaway DB.
beforeAll(async () => {
  const db = await createDb({ memory: true });
  await migrate(db);
  setDb(db);
});

const day = 86_400_000;
const cases: [SignalFeed, FeedOptions][] = [
  ["nws", { limit: 5 }],
  ["usgs_quake", { since: new Date(Date.now() - day) }],
  ["nwps_flood", { limit: 5 }],
  ["firms", { limit: 10 }],
  ["openfema", { since: new Date(Date.now() - 30 * day), limit: 10 }],
  ["gfw", { bbox: [-63, -10, -62, -9], limit: 10 }],
  ["mrds", { bbox: [-116, 39.5, -115.5, 40], limit: 10 }],
];

describe.each(cases)("live %s", (feed, opts) => {
  it("returns valid signals or explains why not", async () => {
    const { signals, warnings } = await pollFeed(feed, opts);
    for (const s of signals) SignalInput.parse(s);
    console.log(`${feed}: ${signals.length} signal(s)`, signals[0] ? `first: ${signals[0].title} [${signals[0].severity}]` : "", warnings);
    expect(signals.length + warnings.length).toBeGreaterThan(0);
  });
});

it("live blm_claims: new claim blocks from the BLM Hub layer", async () => {
  const { signals, warnings } = await fetchBlmClaims({ since: new Date(Date.now() - 2 * day) });
  console.log(`blm_claims: ${signals.length} block(s)`, signals[0]?.title ?? "", warnings);
  for (const s of signals) SignalInput.parse(s);
  expect(signals.length + warnings.length).toBeGreaterThan(0);
});

it("news stays off without allowPaid (no Monid call)", async () => {
  const { signals, warnings } = await pollFeed("news");
  expect(signals).toEqual([]);
  expect(warnings[0]).toMatch(/paid feed/);
});

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../db/client";
import { saveMarketPrices } from "./market";
import { freshDb, reset } from "./testing";

const row = (over: Record<string, unknown> = {}) => ({
  playbook: "disasters", alternative: "drone roof inspection", price_low: 150, price_high: 400, unit: "per site",
  turnaround: "2-5 days", source_title: "HomeGuide: drone inspection cost", source_url: "https://homeguide.com/costs/drone-inspection-cost",
  retrieved_at: "2026-11-07", notes: null, ...over,
});

let db: Db;
beforeAll(async () => {
  db = await freshDb();
});
beforeEach(async () => {
  await reset(db);
});

describe("saveMarketPrices", () => {
  it("inserts, then updates the same (playbook, alternative, source)", async () => {
    expect(await saveMarketPrices({ rows: [row(), row({ alternative: "insurance adjuster visit", price_low: null })], actor: "market-researcher" }))
      .toMatchObject({ saved: 2, inserted: 2, updated: 0 });
    expect(await saveMarketPrices({ rows: [row({ price_high: 450 })], actor: "market-researcher" })).toMatchObject({ saved: 1, inserted: 0, updated: 1 });
    const rows = await db.query<{ price_high: string }>("SELECT price_high FROM market_prices WHERE alternative = 'drone roof inspection'");
    expect(rows).toEqual([{ price_high: "450.00" }]);
  });

  it.each([
    [{ source_url: "javascript:alert(1)" }, /source_url/],
    [{ source_url: "ftp://example.com/x" }, /source_url/],
    [{ price_low: 500, price_high: 100 }, /price_low must be ≤ price_high/],
    [{ price_low: null, price_high: null }, /give price_low, price_high or both/],
    [{ retrieved_at: "2099-01-01" }, /in the future/],
    [{ retrieved_at: "yesterday" }, /retrieved_at/],
    [{ playbook: "crypto" }, /playbook/],
  ])("rejects %o and saves nothing", async (bad, message) => {
    await expect(saveMarketPrices({ rows: [row({ alternative: "ok row" }), row(bad)], actor: "market-researcher" })).rejects.toThrow(message);
    const [{ n }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM market_prices");
    expect(n).toBe(0);
  });
});

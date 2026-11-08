/** Live, FREE calls only (balance, discover, inspect). Never monidRun here: it spends money. */
import { expect, it } from "vitest";
import { monidBalance, monidDiscover, monidInspect } from "./client";

it("reads the wallet balance", async () => {
  const b = await monidBalance();
  console.log("monid balance", b);
  expect(b.balance_usd).toBeGreaterThanOrEqual(0);
});

it("discovers endpoints and flags allowlisted ones", async () => {
  const items = await monidDiscover("company news business events", 5);
  console.log(items.map((i) => [i.provider, i.endpoint, i.price_usd, i.allowlisted]));
  expect(items.length).toBeGreaterThan(0);
});

it("inspects an allowlisted endpoint's live price card", async () => {
  const i = await monidInspect("hunterio", "/email-finder");
  console.log(i.price, i.price_usd);
  expect(i.allowlisted).toBe(true);
  expect(i.price_usd).not.toBeNull();
});

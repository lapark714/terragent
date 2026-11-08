import { describe, expect, it } from "vitest";
import { fixtureJson } from "../signals/__fixtures__/fetch-mock";
import { findAllowed, MONID_ALLOWLIST, normalizeInput } from "./allowlist";
import { cardPriceUsd, estimateCostUsd, reportedCostUsd } from "./price";
import type { MonidPrice } from "./types";

const usd = (value: number) => ({ value, currency: "USD" });
const FIX = `${import.meta.dirname}/__fixtures__`;

describe("price cards", () => {
  it("estimates PER_RESULT with flat fee from the live akta card", () => {
    const { price } = fixtureJson<{ price: MonidPrice }>("inspect-akta-news.json", FIX);
    expect(estimateCostUsd(price, { queryParams: { limit: 10 } }, 10)).toBe(0.01);
    expect(cardPriceUsd(price)).toBe(0.0055);
  });

  it("adds tiers whose `when` matches the input, and picks matching variants", () => {
    const tiered: MonidPrice = {
      type: "TIERED",
      default: { type: "PER_CALL", amount: usd(0.026) },
      tiers: [{ label: "Mobile phone", when: { reveal_phone_number: "true" }, price: { type: "PER_CALL", amount: usd(0.208) } }],
    };
    expect(estimateCostUsd(tiered, { queryParams: {} })).toBe(0.026);
    expect(estimateCostUsd(tiered, { queryParams: { reveal_phone_number: true } })).toBe(0.234);
    const variant: MonidPrice = { type: "VARIANT", variants: [{ when: { mode: "deep" }, price: { type: "PER_CALL", amount: usd(0.5) } }], default: { type: "PER_CALL", amount: usd(0.01) } };
    expect(estimateCostUsd(variant, { body: { mode: "deep" } })).toBe(0.5);
  });

  it("refuses to guess unit-metered or missing prices (unless they are zero)", () => {
    expect(estimateCostUsd(undefined, {})).toBeNull();
    expect(estimateCostUsd({ type: "PER_UNIT", amount: usd(0.002) }, {})).toBeNull();
    expect(estimateCostUsd({ type: "PER_UNIT", amount: usd(0) }, {})).toBe(0);
  });

  it("converts reported cost units", () => {
    expect(reportedCostUsd({ reportedCost: { value: 7500, unit: "MICRO_DOLLAR" } })).toBe(0.0075);
    expect(reportedCostUsd({ reportedCost: { value: 3, unit: "CENT" } })).toBe(0.03);
    expect(reportedCostUsd({ reportedCost: { value: 1, unit: "SATOSHI" } })).toBeNull();
    expect(reportedCostUsd(undefined)).toBeNull();
  });
});

describe("allowlist", () => {
  it("contains exactly the monid.md picks", () => {
    expect(MONID_ALLOWLIST.map((e) => `${e.provider} ${e.endpoint}`)).toEqual([
      "akta /v1/news",
      "akta /v1/company/search",
      "apollo /mixed_people/api_search",
      "hunterio /email-finder",
      "zillow /get_zestimate",
      "api.kadec0.xyz /v1/weather",
      "api.kadec0.xyz /v1/geocode",
    ]);
    expect(findAllowed("apollo", "/people/match")).toBeUndefined();
  });

  it("wraps flat input, clamps result counts and defaults them to the ceiling", () => {
    const news = findAllowed("akta", "/v1/news")!;
    expect(normalizeInput(news, { query: "gold", limit: 500 })).toEqual({ input: { queryParams: { query: "gold", limit: 10 } }, results: 10 });
    expect(normalizeInput(news, { query: "gold", limit: 3 }).results).toBe(3);
    expect(normalizeInput(news, { queryParams: { query: "gold" } })).toEqual({ input: { queryParams: { query: "gold", limit: 10 } }, results: 10 });
    const people = findAllowed("apollo", "/mixed_people/api_search")!;
    expect(normalizeInput(people, { "person_titles[]": ["Owner"] }).input.queryParams).toEqual({ "person_titles[]": ["Owner"], per_page: 10 });
  });
});

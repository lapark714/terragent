import { describe, expect, it } from "vitest";
import { PROVIDERS } from "../../../db/seeds/providers";
import { PRICING } from "../config";
import { QuoteOption } from "../domain";
import {
  analysisCost, buildQuoteOptions, friendlyPrice, isHighStakesQuestion, isTimely, itemMode, minOrderKm2, type PricedProvider,
  priceMismatch, priceOption, registryPriceBand, repriceOption, UnknownProviderError, unitPriceUsd,
} from "./pricing-engine";
import { samplePlan, sampleSpec } from "./testing";

/** The seeded registry as DB rows (the engine also accepts numeric columns as strings, as Postgres returns them). */
const REGISTRY: PricedProvider[] = PROVIDERS.map((p) => ({
  id: p.id, name: p.name, data_type: p.data_type, resolution_m: p.resolution_m === null ? null : String(p.resolution_m), is_free: p.is_free,
  pricing_model: p.pricing_model, currency: p.currency, archive_usd_per_km2: p.archive_per_km2, tasking_usd_per_km2: p.tasking_per_km2,
  min_order_km2: p.min_order_km2, delivery_time: p.delivery_time, notes: p.notes, active: true,
}));
const P = (id: string) => REGISTRY.find((p) => p.id === id)!;
const TODAY = new Date("2026-11-07T12:00:00Z");

const item = (id: string, over: Partial<Parameters<typeof priceOption>[0]["data_items"][number]> = {}) => {
  const p = P(id);
  return { provider: p, product: "archive", data_type: p.data_type, resolution_m: Number(p.resolution_m ?? 1), epochs: 1, ...over };
};
const opt = (area_km2: number, data_items: ReturnType<typeof item>[], over: Partial<Parameters<typeof priceOption>[0]> = {}) =>
  priceOption({ area_km2, epochs: Math.max(1, ...data_items.map((i) => i.epochs)), data_items, recipe: "change_detection", ...over });

describe("friendlyPrice", () => {
  it("rounds up to $1 under $100, $5 under $1,000, $50 above, and never below the input", () => {
    expect([29, 21.5, 99.01, 101, 454, 999.2, 1001, 3131].map(friendlyPrice)).toEqual([29, 22, 100, 105, 455, 1000, 1050, 3150]);
    expect(friendlyPrice(29.000000001)).toBe(29); // float noise is not a dollar
  });
});

describe("registry reads", () => {
  it("infers tasking from the product or a tasking-only provider, and reads tasking minimums from the notes", () => {
    expect(itemMode(P("pc-sentinel-2-l2a"), "anything")).toBe("free");
    expect(itemMode(P("sw-vantor-50cm"), "tasking 50 cm")).toBe("tasking");
    expect(itemMode(P("sw-vantor-50cm"), "archive 50 cm")).toBe("archive");
    expect(itemMode(P("sw-umbra-25cm"), "archive")).toBe("tasking"); // no archive price
    expect(minOrderKm2(P("sw-vantor-50cm"), "archive")).toBe(1);
    expect(minOrderKm2(P("sw-vantor-50cm"), "tasking")).toBe(25); // "Tasking minimum 25 km²"
    expect(minOrderKm2(P("up42-pleiades-neo"), "tasking")).toBe(100);
    expect(minOrderKm2(P("planet-skysat"), "tasking")).toBe(25);
  });

  it("converts EUR prices and returns null without a public price", () => {
    expect(unitPriceUsd(P("up42-spot"), "archive")).toBeCloseTo(2 * PRICING.eurToUsd);
    expect(unitPriceUsd(P("arlula-archive"), "archive")).toBeNull();
    expect(registryPriceBand(REGISTRY, "optical", "archive")).toEqual([2 * PRICING.eurToUsd, 22.5]);
    expect(registryPriceBand(REGISTRY, "elevation", "archive")).toEqual(PRICING.unknownPriceBandUsdPerKm2);
  });
});

describe("priceOption", () => {
  it("free data costs nothing but is never a free answer: analysis + margin, floored at the minimum price", () => {
    const o = opt(4, [item("pc-sentinel-2-l2a", { product: "public optical scenes", epochs: 2 })]);
    expect(o).toMatchObject({ kind: "free_data", analysis_cost_usd: PRICING.analysisBaseUsd, risk_buffer_usd: 0, price_usd: PRICING.minReportUsd, price_range_usd: null });
    expect(o.data[0]).toMatchObject({ unit_price_usd: 0, data_cost_usd: 0, billable_km2: 4, needs_supplier_quote: false });
    expect(o.analysis_cost_usd + o.risk_buffer_usd + o.margin_usd).toBeCloseTo(o.price_usd!, 2);
  });

  it("per-km² archive: unit × area × epochs; value margin on analysis, reseller markup on data; friendly rounding", () => {
    const o = opt(4, [item("sw-vantor-50cm", { product: "archive 50 cm", epochs: 2 })]);
    const data = 14 * 4 * 2;
    const cost = data + PRICING.analysisBaseUsd;
    expect(o.data[0]).toMatchObject({ unit_price_usd: 14, data_cost_usd: data, billable_km2: 4 });
    expect(o.kind).toBe("archive");
    const margin = Math.max(PRICING.analysisMarginMultiple * PRICING.analysisBaseUsd + PRICING.dataMarkup * data, PRICING.marginFloorUsd);
    expect(o.price_usd).toBe(friendlyPrice(cost + margin));
    expect(data + o.analysis_cost_usd + o.risk_buffer_usd + o.margin_usd).toBeCloseTo(o.price_usd!, 2);
  });

  it("bills the provider's minimum order", () => {
    const o = opt(1, [item("sw-pneo-30cm", { product: "archive 30 cm" })]);
    expect(o.data[0]).toMatchObject({ area_km2: 1, billable_km2: 5, data_cost_usd: 112.5 });
    expect(o.notes.join(" ")).toMatch(/5 km² minimum order/);
  });

  it("tasking: the tasking price and minimum, plus the 25% risk buffer", () => {
    const o = opt(4, [item("sw-vantor-50cm", { product: "tasking 50 cm" })]);
    expect(o.kind).toBe("tasking");
    expect(o.data[0]).toMatchObject({ unit_price_usd: 25, billable_km2: 25, data_cost_usd: 625 });
    expect(o.risk_buffer_usd).toBeCloseTo(625 * PRICING.riskTaskingPct);
  });

  it("an unknown supplier price gives a range (high end with an assumed minimum order) and a 15% buffer on the high end", () => {
    const o = opt(4, [item("arlula-archive", { product: "archive 50 cm", resolution_m: 0.5, price_band_usd_per_km2: [2, 20] })]);
    expect(o.price_usd).toBeNull();
    expect(o.data[0]).toMatchObject({ unit_price_usd: null, data_cost_usd: null, data_cost_range_usd: [8, 20 * PRICING.unknownMinOrderKm2], needs_supplier_quote: true });
    expect(o.risk_buffer_usd).toBeCloseTo(20 * PRICING.unknownMinOrderKm2 * PRICING.riskUnknownPricePct);
    const [lo, hi] = o.price_range_usd!;
    expect(lo).toBeLessThan(hi);
    expect(() => QuoteOption.parse({ option_id: "A", label: "x x", answers: "x x", confidence: "low", ...o })).not.toThrow();
  });

  it("a supplier's real quote replaces the unknown price", () => {
    const o = opt(4, [item("arlula-archive", { product: "archive 50 cm", resolution_m: 0.5, supplier_quote_usd: 76 })]);
    expect(o.price_range_usd).toBeNull();
    expect(o.data[0]).toMatchObject({ data_cost_usd: 76, needs_supplier_quote: false });
  });

  it("cloudy climates add 10% on paid optical data only", () => {
    const clear = opt(4, [item("sw-vantor-50cm", { product: "archive" })]);
    const cloudy = opt(4, [item("sw-vantor-50cm", { product: "archive" })], { cloudy_climate: true });
    expect(clear.risk_buffer_usd).toBe(0);
    expect(cloudy.risk_buffer_usd).toBeCloseTo(56 * PRICING.riskCloudyOpticalPct);
    expect(opt(4, [item("pc-sentinel-2-l2a")], { cloudy_climate: true }).risk_buffer_usd).toBe(0);
  });

  it("refuses an option without an area", () => {
    expect(() => opt(0, [])).toThrow(/area_km2/);
  });
});

describe("analysisCost", () => {
  it("base + extra dates + extra data types + compute above the included area (+ high stakes), capped", () => {
    expect(analysisCost({ area_km2: 4, epochs: 2, data_types: 1 })).toBe(PRICING.analysisBaseUsd);
    const expected = PRICING.analysisBaseUsd + 8 * PRICING.analysisPerExtraEpochUsd + PRICING.analysisPerExtraDataTypeUsd +
      (525 - PRICING.analysisIncludedKm2) * PRICING.analysisComputePerKm2Usd + PRICING.analysisHighStakesUsd;
    expect(analysisCost({ area_km2: 525, epochs: 10, data_types: 2, high_stakes: true })).toBeCloseTo(expected);
    expect(analysisCost({ area_km2: 1e6, epochs: 1, data_types: 1 })).toBe(PRICING.analysisCapUsd);
  });
});

describe("buildQuoteOptions", () => {
  const ROOF_PLAN = samplePlan("req_t", {
    choice: "paid",
    free_option: { provider_id: "pc-sentinel-2-l2a", before_scene: null, after_scene: null, sufficient: false, why: "10 m can't see roofs." },
    paid_options: [{ provider_id: "sw-vantor-50cm", product: "archive 50 cm", resolution_m: 0.5, est_cost_usd: 112, min_order_km2: 1, delivery_time: null, license_terms: null, preview_available: true, why: "roofs" }],
    justification: "Roof-level damage needs sub-metre imagery; Sentinel-2 at 10 m cannot resolve individual buildings.",
  });

  it("free data that answers: recommended at the floor, plus a sharper archive option; no tasking for an old window", () => {
    const r = buildQuoteOptions(samplePlan("req_t"), sampleSpec("req_t"), REGISTRY, { today: TODAY });
    expect(r.options.map((o) => [o.option_id, o.kind])).toEqual([["A", "free_data"], ["B", "archive"]]);
    expect(r.recommended_option_id).toBe("A");
    expect(r.options[0]).toMatchObject({ price_usd: PRICING.minReportUsd, confidence: "medium" });
    expect(r.options[1].data[0].resolution_m).toBeLessThanOrEqual(1); // property / asset scale → ≤ 1 m
    expect(r.options[1].price_usd!).toBeGreaterThan(r.options[0].price_usd!);
    for (const o of r.options) expect(() => QuoteOption.parse(o)).not.toThrow();
  });

  it("free data that can't answer: recommends the paid archive option and says why; adds tasking when timeliness matters", () => {
    const spec = sampleSpec("req_t", { min_resolution_m: 0.5, after: { start: "2026-11-01", end: "2026-11-06" } });
    const r = buildQuoteOptions(ROOF_PLAN, spec, REGISTRY, { today: TODAY });
    expect(r.options.map((o) => o.kind)).toEqual(["free_data", "archive", "tasking"]);
    expect(r.options[0]).toMatchObject({ confidence: "low" });
    expect(r.options[0].notes.join(" ")).toMatch(/Can't fully answer/);
    expect(r.recommended_option_id).toBe("B");
    expect(r.options[1].data[0].provider_id).toBe("sw-vantor-50cm"); // the plan's comparison wins over registry candidates
    expect(r.options[1].notes[0]).toBe("Recommended because the free-data option can't fully answer this: it needs 50 cm detail and free data is 10 m.");
    // With the resolution enough, acquisition's own reason is what the customer reads.
    const cloudy = buildQuoteOptions(ROOF_PLAN, sampleSpec("req_t"), REGISTRY, { today: TODAY });
    expect(cloudy.options.find((o) => o.option_id === cloudy.recommended_option_id)!.notes[0]).toMatch(/can't fully answer this: 10 m can't see roofs\.$/);
    const tasking = r.options[2];
    expect(tasking.data.map((d) => d.product)).toEqual(["archive 50 cm", "tasking 50 cm"]); // archive "before" + new "after"
    expect(tasking.risk_buffer_usd).toBeGreaterThan(0);
    expect(r.options.every((o) => (o.price_usd ?? o.price_range_usd![0]) >= PRICING.minReportUsd)).toBe(true);
  });

  it("an Earth-index answer is one option with no data to buy, still priced", () => {
    const r = buildQuoteOptions(samplePlan("req_t", { choice: "existing_index", free_option: null }), sampleSpec("req_t"), REGISTRY, { today: TODAY });
    expect(r.options[0]).toMatchObject({ option_id: "A", kind: "free_data", data: [], price_usd: PRICING.minReportUsd });
    expect(r.recommended_option_id).toBe("A");
  });

  it("long multi-date jobs over a large area cost more to analyse; unknown supplier prices become ranges", () => {
    const plan = samplePlan("req_t", {
      paid_options: [{ provider_id: "arlula-archive", product: "archive 50 cm", resolution_m: 0.5, est_cost_usd: 0, min_order_km2: null, delivery_time: null, license_terms: null, preview_available: false, why: "history" }],
    });
    const spec = sampleSpec("req_t", { area_km2: 400, min_resolution_m: 30 });
    const r = buildQuoteOptions(plan, spec, REGISTRY, { today: TODAY, epochs: 10 });
    expect(r.options[0].analysis_cost_usd).toBeGreaterThan(PRICING.analysisBaseUsd);
    expect(r.options[0].price_usd!).toBeGreaterThan(PRICING.minReportUsd);
    expect(r.options[1]).toMatchObject({ price_usd: null });
    expect(r.options[1].data[0]).toMatchObject({ epochs: 10, needs_supplier_quote: true });
  });

  it("returns no options (and says why) when nothing in the registry fits", () => {
    const r = buildQuoteOptions(samplePlan("req_t", { free_option: null }), sampleSpec("req_t", { data_type: "elevation" }), REGISTRY, { today: TODAY });
    expect(r.options).toEqual([]);
    expect(r.recommended_option_id).toBeNull();
    expect(r.notes.join(" ")).toMatch(/No provider/);
  });
});

describe("repriceOption / priceMismatch", () => {
  const spec = sampleSpec("req_t", { min_resolution_m: 0.5, after: { start: "2026-11-01", end: "2026-11-06" } });
  const plan = samplePlan("req_t");
  const built = buildQuoteOptions(plan, spec, REGISTRY, { today: TODAY });

  it("reproduces the server's own options exactly (so create_quote accepts price_options' output)", () => {
    expect(built.options.length).toBe(3);
    for (const o of built.options) {
      const again = repriceOption(o, plan, spec, REGISTRY, { today: TODAY });
      expect(again).toEqual(o);
      expect(priceMismatch(o, again)).toBeNull();
    }
  });

  it("keeps the agent's words but always the server's numbers; flags prices more than 5% off", () => {
    const [, b] = built.options;
    const edited = { ...b, label: "Roof-level view", price_usd: Math.round(b.price_usd! * 0.5), margin_usd: 1 };
    const server = repriceOption(edited, plan, spec, REGISTRY, { today: TODAY });
    expect(server).toMatchObject({ label: "Roof-level view", price_usd: b.price_usd, margin_usd: b.margin_usd });
    expect(priceMismatch(edited, server)).toMatch(/server price/);
    expect(priceMismatch({ price_usd: b.price_usd! * 1.04, price_range_usd: null }, server)).toBeNull();
    expect(priceMismatch({ price_usd: null, price_range_usd: [1, 2] }, server)).toMatch(/server price/);
  });

  it("refuses providers that aren't in the registry", () => {
    const fake = { ...built.options[1], data: [{ ...built.options[1].data[0], provider_id: "made-up-sat" }] };
    expect(() => repriceOption(fake, plan, spec, REGISTRY)).toThrow(UnknownProviderError);
  });
});

describe("context", () => {
  it("high stakes and timeliness", () => {
    expect(isHighStakesQuestion("Is this roof damage enough for our insurance claim?")).toBe(true);
    expect(isHighStakesQuestion("Is the vineyard greener than last year?")).toBe(false);
    expect(isTimely(sampleSpec("req_t"), { today: TODAY })).toBe(false);
    expect(isTimely(sampleSpec("req_t"), { today: TODAY, urgency: "urgent" })).toBe(true);
    expect(isTimely(sampleSpec("req_t", { after: { start: "2026-11-01", end: "2026-11-06" } }), { today: TODAY })).toBe(true);
  });
});

describe("price realism (Laurence's examples: one home vs a long multi-sensor job)", () => {
  it("resold imagery carries a reseller markup, not a 3x multiple", () => {
    const o = opt(4, [item("sw-vantor-50cm", { product: "archive 50 cm", epochs: 2 })]); // $112 of imagery
    expect(o.price_usd!).toBeLessThan(250);
    expect(o.price_usd!).toBeGreaterThan(112);
  });
});

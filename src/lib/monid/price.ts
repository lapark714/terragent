/**
 * Price-card arithmetic. Monid has no max-price field on a run, so we estimate the worst case from the
 * card returned by inspect and refuse anything we can't estimate (never assume free).
 */
import type { MonidInput, MonidPrice, MonidPriceLeaf } from "./types";

const params = (input: MonidInput): Record<string, unknown> => ({ ...input.pathParams, ...input.queryParams, ...input.body });

const matches = (when: Record<string, unknown>, p: Record<string, unknown>) =>
  Object.entries(when).every(([k, v]) => p[k] !== undefined && String(p[k]) === String(v));

function leafCost(leaf: MonidPriceLeaf, results: number): number | null {
  const amount = leaf.amount?.value;
  if (amount === undefined) return null;
  if (leaf.type === "PER_CALL") return amount;
  if (leaf.type === "PER_RESULT") return (leaf.flatFee?.value ?? 0) + amount * results;
  return amount === 0 ? 0 : null; // PER_UNIT / METERED: units are unknown before the run
}

/** Worst-case USD for one run returning up to `results` billed results; null = can't estimate. */
export function estimateCostUsd(price: MonidPrice | undefined, input: MonidInput, results = 1): number | null {
  if (!price) return null;
  const p = params(input);
  const base = price.variants?.find((v) => matches(v.when, p))?.price ?? price.default ?? price;
  let total = leafCost(base, results);
  for (const tier of price.tiers ?? []) {
    if (total === null) break;
    if (tier.when && !matches(tier.when, p)) continue;
    const add = leafCost(tier.price, results);
    total = add === null ? null : total + add;
  }
  return total === null ? null : Math.round(total * 1e6) / 1e6;
}

/** Price of a minimal call (one result), for listings. */
export const cardPriceUsd = (price: MonidPrice | undefined) => estimateCostUsd(price, {}, 1);

const UNIT_USD: Record<string, number> = { MICRO_DOLLAR: 1e-6, CENT: 0.01, DOLLAR: 1 };

/** `billing.reportedCost` ({ value: int, unit }) in dollars; null when absent or in an unknown unit. */
export function reportedCostUsd(billing: { reportedCost?: { value: number; unit: string } } | undefined): number | null {
  const c = billing?.reportedCost;
  const factor = c ? UNIT_USD[c.unit] : undefined;
  return c && factor !== undefined ? Math.round(c.value * factor * 1e6) / 1e6 : null;
}

/**
 * Pricing v2 engine (NOTES 2026-11-08). Pure: no database, no clock unless passed in. Every number is reproducible,
 * which is what lets create_quote re-price an agent's options and refuse invented prices.
 *
 *   option price = data + analysis + risk buffer + margin           (constants: src/lib/config.ts PRICING)
 *     data      per item: free → 0; priced → unit × max(area, minimum order) × epochs; no public price → a range
 *     analysis  base + extra dates + extra data types + compute per km² above the included area (+ high stakes), capped
 *     risk      % of data cost: tasking 25%, unknown price 15% of the range's high end, cloudy-climate optical 10%
 *     margin    max(analysisMarginMultiple × analysis + dataMarkup × (data + risk), marginFloorUsd)
 *   then floored at PRICING.minReportUsd and rounded up to a friendly number ($1 < $100, $5 < $1,000, $50 above).
 *
 * No free answers: the cheapest option (usually free public data) still costs at least the floor.
 */
import { PRICING } from "../config";
import {
  type AcquisitionPlan, type Confidence, type DataSpec, type DataType, optionPriceLow, QUOTE_OPTION_IDS, type QuoteOption,
  type QuoteOptionData, type QuoteOptionId, type QuoteOptionKind, type Recipe,
} from "../domain";
import type { ProviderRow } from "./providers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Urgency = "normal" | "urgent";
export type DataMode = "free" | "archive" | "tasking";

/** A registry row (db/seeds/providers.ts) as the engine reads it; numeric columns may arrive as strings from Postgres. */
export type PricedProvider = Pick<
  ProviderRow,
  "id" | "name" | "data_type" | "resolution_m" | "is_free" | "pricing_model" | "currency" | "archive_usd_per_km2" |
  "tasking_usd_per_km2" | "min_order_km2" | "delivery_time" | "notes"
> & { active?: boolean };

export interface PriceItemInput {
  provider: PricedProvider;
  product: string;
  data_type: DataType;
  resolution_m: number;
  epochs: number;
  /** Area this item covers (km²); defaults to the option's area. */
  area_km2?: number;
  /** archive or tasking; inferred from the product ("tasking …") and the provider's prices when left out. */
  mode?: "archive" | "tasking";
  /** USD/km² band used when the provider publishes no price (buildQuoteOptions fills it from the registry). */
  price_band_usd_per_km2?: [number, number] | null;
  /** A real supplier quote for this item in USD (orders.supplier_quote_usd): replaces the list price or range. */
  supplier_quote_usd?: number | null;
}

export interface PriceOptionInput {
  area_km2: number;
  /** Dates / scenes the analysis needs (drives the analysis line). */
  epochs: number;
  data_items: PriceItemInput[];
  recipe: Recipe;
  high_stakes?: boolean;
  urgency?: Urgency;
  /** Optical data where clouds are likely: adds the cloud risk buffer. */
  cloudy_climate?: boolean;
}

/** priceOption's output: a QuoteOption without the words (id, label, what it answers, confidence). */
export type PricedOption = Pick<
  QuoteOption,
  "kind" | "data" | "analysis_cost_usd" | "risk_buffer_usd" | "margin_usd" | "price_usd" | "price_range_usd" | "delivery_time" | "notes"
>;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const toNum = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const r2 = (n: number) => Math.round(n * 100) / 100;
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];

export const fmtRes = (m: number) => (m < 1 ? `${Math.round(m * 100)} cm` : `${Number(m.toFixed(1))} m`);
const fmtUsd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 2 : 0 })}`;
export const fmtPrice = (o: Pick<QuoteOption, "price_usd" | "price_range_usd">) =>
  o.price_usd !== null ? fmtUsd(o.price_usd) : `${fmtUsd(o.price_range_usd![0])}–${fmtUsd(o.price_range_usd![1])}`;

/** Round UP to a friendly number: nearest $1 under $100, $5 under $1,000, $50 above. Never below the input. */
export function friendlyPrice(p: number): number {
  const step = p < 100 ? 1 : p < 1000 ? 5 : 50;
  return Math.ceil(r2(p) / step - 1e-9) * step;
}

/** free, archive or tasking for an item: the product name says "tasking" for a new capture. */
export function itemMode(p: PricedProvider, product: string, mode?: "archive" | "tasking"): DataMode {
  if (p.is_free) return "free";
  if (mode) return mode;
  if (/task/i.test(product)) return "tasking";
  const archive = toNum(p.archive_usd_per_km2);
  if (archive === null && (toNum(p.tasking_usd_per_km2) !== null || p.pricing_model === "per_km2_tasking")) return "tasking";
  return "archive";
}

/** USD per km² per epoch from the registry (EUR rows converted), or null when the provider publishes no price. */
export function unitPriceUsd(p: PricedProvider, mode: DataMode): number | null {
  if (mode === "free") return 0;
  const raw = toNum(mode === "tasking" ? p.tasking_usd_per_km2 : p.archive_usd_per_km2);
  if (raw === null) return null;
  return r2(String(p.currency).toUpperCase() === "EUR" ? raw * PRICING.eurToUsd : raw);
}

/** Minimum billable km². Tasking minimums are usually only in the notes ("Tasking minimum 25 km²"). */
export function minOrderKm2(p: PricedProvider, mode: DataMode): number {
  if (mode === "free") return 0;
  const min = toNum(p.min_order_km2) ?? 0;
  if (mode === "archive") return min;
  const stated = /tasking minimum\s+(\d+(?:\.\d+)?)\s*km/i.exec(p.notes ?? "");
  return Math.max(min, stated ? Number(stated[1]) : PRICING.taskingMinOrderKm2);
}

/**
 * The registry's typical USD/km² band for a data type and mode: min..max of the priced paid providers of that type.
 * Used for providers that publish no price; falls back to the conservative PRICING band.
 */
export function registryPriceBand(registry: readonly PricedProvider[], dataType: DataType, mode: DataMode): [number, number] {
  const prices = registry
    .filter((p) => !p.is_free && p.active !== false && p.data_type === dataType)
    .map((p) => unitPriceUsd(p, mode))
    .filter((x): x is number => x !== null && x > 0);
  if (!prices.length) return [...PRICING.unknownPriceBandUsdPerKm2];
  return [Math.min(...prices), Math.max(...prices)];
}

// ---------------------------------------------------------------------------
// priceOption
// ---------------------------------------------------------------------------

interface PricedItem { data: QuoteOptionData; mode: DataMode; low: number; high: number; risk: number; notes: string[] }

function priceItem(item: PriceItemInput, optionArea: number, cloudy: boolean): PricedItem {
  const p = item.provider;
  const area = item.area_km2 ?? optionArea;
  const epochs = Math.max(1, Math.round(item.epochs));
  const mode = itemMode(p, item.product, item.mode);
  const base = {
    provider_id: p.id, product: item.product, data_type: item.data_type, resolution_m: item.resolution_m, epochs, area_km2: r2(area),
  };
  if (mode === "free") {
    return {
      data: { ...base, billable_km2: r2(area), unit_price_usd: 0, data_cost_usd: 0, data_cost_range_usd: null, needs_supplier_quote: false },
      mode, low: 0, high: 0, risk: 0, notes: [],
    };
  }

  // Notes are customer-facing (quote email, accept page): name the source, not our registry id.
  const who = shortName(p);
  const notes: string[] = [];
  const minOrder = minOrderKm2(p, mode);
  const billable = Math.max(area, minOrder);
  if (minOrder > area) notes.push(`${who}: billed for the ${minOrder} km² minimum order (the area is ${r2(area)} km²).`);
  const quoted = toNum(item.supplier_quote_usd);
  if (String(p.currency).toUpperCase() === "EUR" && !(quoted !== null && quoted > 0)) {
    notes.push(`${who}: price converted from EUR at ${PRICING.eurToUsd} USD/EUR.`);
  }
  const unit = quoted !== null && quoted > 0 ? r2(quoted / (billable * epochs)) : unitPriceUsd(p, mode);

  let data: QuoteOptionData;
  let low: number;
  let high: number;
  let riskBase: number;
  let pct = mode === "tasking" ? PRICING.riskTaskingPct : 0;
  if (quoted !== null && quoted > 0) {
    low = high = riskBase = r2(quoted);
    notes.push(`${who}: priced from the supplier's quote.`);
    data = { ...base, billable_km2: r2(billable), unit_price_usd: unit, data_cost_usd: low, data_cost_range_usd: null, needs_supplier_quote: false };
  } else if (unit !== null) {
    low = high = riskBase = r2(unit * billable * epochs);
    data = { ...base, billable_km2: r2(billable), unit_price_usd: unit, data_cost_usd: low, data_cost_range_usd: null, needs_supplier_quote: false };
  } else {
    const band = item.price_band_usd_per_km2 ?? PRICING.unknownPriceBandUsdPerKm2;
    const highBillable = Math.max(area, minOrder > 0 ? minOrder : PRICING.unknownMinOrderKm2);
    low = r2(band[0] * billable * epochs);
    high = r2(band[1] * highBillable * epochs);
    riskBase = high;
    pct += PRICING.riskUnknownPricePct;
    notes.push(
      `${who} publishes no price: estimated at $${band[0]}–$${band[1]}/km²` +
        (highBillable > billable ? ` (high end assumes a ${highBillable} km² minimum order)` : "") +
        "; we confirm the real figure with the supplier before buying.",
    );
    data = { ...base, billable_km2: r2(billable), unit_price_usd: null, data_cost_usd: null, data_cost_range_usd: [low, high], needs_supplier_quote: true };
  }
  if (cloudy && item.data_type === "optical") pct += PRICING.riskCloudyOpticalPct;
  return { data, mode, low, high, risk: r2(riskBase * pct), notes };
}

/** Agents + compute for one option. */
export function analysisCost(a: { area_km2: number; epochs: number; data_types: number; high_stakes?: boolean }): number {
  const v =
    PRICING.analysisBaseUsd +
    Math.max(0, a.epochs - PRICING.analysisIncludedEpochs) * PRICING.analysisPerExtraEpochUsd +
    Math.max(0, a.data_types - 1) * PRICING.analysisPerExtraDataTypeUsd +
    Math.max(0, a.area_km2 - PRICING.analysisIncludedKm2) * PRICING.analysisComputePerKm2Usd +
    (a.high_stakes ? PRICING.analysisHighStakesUsd : 0);
  return r2(Math.min(v, PRICING.analysisCapUsd));
}

export function optionKind(modes: DataMode[]): QuoteOptionKind {
  if (!modes.some((m) => m !== "free")) return "free_data";
  if (modes.includes("tasking")) return "tasking";
  return modes.includes("free") ? "mixed" : "archive";
}

function defaultDeliveryTime(kind: QuoteOptionKind): string {
  if (kind === "tasking") return "about 1–3 weeks after you accept (a new image is captured for you, weather permitting)";
  if (kind === "archive" || kind === "mixed") return "about 2–5 business days after you accept (we order the imagery once you accept)";
  return "usually within a few hours of accepting";
}

/** Price one option bottom-up. Throws on an impossible input (no area). */
export function priceOption(input: PriceOptionInput): PricedOption {
  if (!(input.area_km2 > 0)) throw new Error("area_km2 must be positive.");
  const epochs = Math.max(1, Math.round(input.epochs));
  const items = input.data_items.map((i) => priceItem(i, input.area_km2, !!input.cloudy_climate));
  const lowData = r2(sum(items.map((i) => i.low)));
  const highData = r2(sum(items.map((i) => i.high)));
  const risk = r2(sum(items.map((i) => i.risk)));
  const dataTypes = new Set(items.map((i) => i.data.data_type)).size || 1;
  const analysis = analysisCost({ area_km2: input.area_km2, epochs, data_types: dataTypes, high_stakes: input.high_stakes });
  const unknown = items.some((i) => i.data.data_cost_range_usd !== null);

  // Value margin on OUR work (analysis), reseller markup on THEIR imagery (data + its risk buffer): one multiple on
  // everything turned $225 of archive imagery into a $910 option.
  const at = (data: number) => {
    const cost = r2(data + analysis + risk);
    const margin = Math.max(PRICING.analysisMarginMultiple * analysis + PRICING.dataMarkup * (data + risk), PRICING.marginFloorUsd);
    return { cost, price: friendlyPrice(Math.max(cost + margin, PRICING.minReportUsd)) };
  };
  const lo = at(lowData);
  const hi = at(highData);
  const kind = optionKind(items.map((i) => i.mode));

  const notes = items.flatMap((i) => i.notes);
  if (items.some((i) => i.mode === "tasking")) {
    notes.push(`Includes a ${PRICING.riskTaskingPct * 100}% buffer on new-capture data (weather, re-tasking).`);
    if (input.urgency === "urgent") notes.push("Priced at standard tasking priority; a rush capture may cost more.");
  }
  if (input.cloudy_climate && items.some((i) => i.mode !== "free" && i.data.data_type === "optical")) {
    notes.push(`Includes a ${PRICING.riskCloudyOpticalPct * 100}% buffer for cloud cover on optical data.`);
  }
  if (input.high_stakes) notes.push("High-stakes use: includes an extra verification pass; we still recommend an expert review of the result.");
  if (unknown) notes.push("Price is a range because a supplier price is not public; we confirm it before buying and never charge above the range without asking you.");

  return {
    kind,
    data: items.map((i) => i.data),
    analysis_cost_usd: analysis,
    risk_buffer_usd: risk,
    margin_usd: r2(hi.price - hi.cost),
    price_usd: unknown ? null : hi.price,
    price_range_usd: unknown ? [lo.price, hi.price] : null,
    delivery_time: defaultDeliveryTime(kind),
    notes: uniq(notes),
  };
}

// ---------------------------------------------------------------------------
// Job context: derived the same way by buildQuoteOptions and repriceOption, so re-pricing reproduces the numbers
// ---------------------------------------------------------------------------

export interface QuoteContext {
  /** "Today" for timeliness (default: now). */
  today?: Date;
  /** Override the number of dates (default: 2 with a before window, else 1). */
  epochs?: number;
  high_stakes?: boolean;
  urgency?: Urgency;
  /** provider_id → supplier's quoted USD total for this request (orders.supplier_quote_usd). */
  supplier_quotes?: Record<string, number>;
}

/** Words that mark a high-stakes use (insurance, legal, safety): one more verification pass. */
export const isHighStakesQuestion = (question: string) =>
  /\b(insur|claim|legal|court|lawsuit|litigat|evidence|safety|liabilit|complian|regulat|due diligence)/i.test(question);

/** Clouds likely: the plan's free scenes were cloudier than allowed or judged insufficient for clouds, or the tropics. */
export function isCloudyClimate(plan: AcquisitionPlan, spec: DataSpec): boolean {
  const scenes = [plan.free_option?.before_scene, plan.free_option?.after_scene].filter((s) => !!s);
  if (scenes.some((s) => s!.cloud_pct !== null && s!.cloud_pct > spec.max_cloud_pct)) return true;
  if (plan.free_option && !plan.free_option.sufficient && /cloud/i.test(plan.free_option.why)) return true;
  return Math.abs(spec.location.lat) <= 10;
}

const DAY_MS = 86_400_000;
/** Timeliness matters when the question is about now: the after window ends within the last 30 days (or later). */
export function isTimely(spec: DataSpec, ctx: QuoteContext): boolean {
  if (ctx.urgency === "urgent") return true;
  const end = Date.parse(`${spec.after.end.slice(0, 10)}T23:59:59Z`);
  const today = (ctx.today ?? new Date()).getTime();
  return Number.isFinite(end) && end >= today - 30 * DAY_MS;
}

/**
 * Dates the analysis handles for a set of items: per data type, the item epochs add up (archive history + a new
 * capture); across data types they overlap (optical and radar of the same dates). No items → the job's dates.
 */
export function optionEpochs(items: { data_type: DataType; epochs: number }[], fallback: number): number {
  if (!items.length) return Math.max(1, fallback);
  const byType = new Map<string, number>();
  for (const i of items) byType.set(i.data_type, (byType.get(i.data_type) ?? 0) + Math.max(1, i.epochs));
  return Math.max(...byType.values());
}

const resOf = (p: PricedProvider) => toNum(p.resolution_m);

/** The full engine input for a list of data items, with every derived field filled the same way each time. */
function engineInput(
  items: { provider: PricedProvider; product: string; resolution_m: number | null; epochs: number; area_km2: number }[],
  spec: DataSpec, plan: AcquisitionPlan, registry: readonly PricedProvider[], ctx: QuoteContext,
): PriceOptionInput {
  const dataItems: PriceItemInput[] = items.map((i) => {
    const mode = itemMode(i.provider, i.product);
    return {
      provider: i.provider, product: i.product, data_type: i.provider.data_type,
      resolution_m: resOf(i.provider) ?? i.resolution_m ?? spec.min_resolution_m, epochs: i.epochs, area_km2: i.area_km2,
      price_band_usd_per_km2: mode === "free" ? null : registryPriceBand(registry, i.provider.data_type, mode),
      supplier_quote_usd: ctx.supplier_quotes?.[i.provider.id] ?? null,
    };
  });
  const jobEpochs = ctx.epochs ?? (spec.before ? 2 : 1);
  return {
    area_km2: dataItems.length ? Math.max(...dataItems.map((i) => i.area_km2 ?? spec.area_km2)) : spec.area_km2,
    epochs: optionEpochs(dataItems, jobEpochs),
    data_items: dataItems,
    recipe: spec.recipe,
    high_stakes: !!ctx.high_stakes,
    urgency: ctx.urgency ?? "normal",
    cloudy_climate: isCloudyClimate(plan, spec),
  };
}

// ---------------------------------------------------------------------------
// Words: what an option can answer
// ---------------------------------------------------------------------------

const WHAT: Record<Recipe, string> = {
  true_color: "a current clear view of the site",
  vegetation_health: "vegetation health and change",
  flood_extent: "flood extent",
  burn_severity: "burn extent and severity",
  forest_loss: "forest loss",
  mining_indicators: "surface mining indicators (indicators only, never deposits)",
  change_detection: "visible change",
};

function detailAt(res: number): string {
  if (res <= 1) return "individual buildings and roofs are visible";
  if (res <= 5) return "building blocks, roads and field edges are visible";
  if (res <= 10) return "neighbourhood- and field-scale patterns; not individual buildings";
  return "area-wide patterns; not individual buildings or small fields";
}

/**
 * What a paid option delivers today: the pipeline measures on free public data (pipeline/terragent_pipeline), and the
 * purchased imagery (bought by a founder after acceptance, orders.ts markOrderDelivered) is reviewed by the interpreter
 * for the finer detail. Licences allow only derived results to reach the customer.
 */
export const PAID_DATA_DELIVERY =
  "Measurements come from our automated analysis of free public data, and the purchased imagery is reviewed for the finer detail; " +
  "you receive derived results, not the raw images.";

function answersText(spec: DataSpec, res: number, kind: QuoteOptionKind): string {
  const what = WHAT[spec.recipe];
  const dates = spec.before ? " Before and after dates are compared." : "";
  const fresh = kind === "tasking" ? " Includes a new image captured after you accept, so it shows the site as it is now." : "";
  const paid = kind === "free_data" ? "" : ` ${PAID_DATA_DELIVERY}`;
  return `${what.charAt(0).toUpperCase()}${what.slice(1)} at ${fmtRes(res)} resolution: ${detailAt(res)}.${dates}${fresh}${paid}`;
}

/** "Vantor 50 cm (via SkyWatch)" → "Vantor 50 cm": the customer-facing name of a source. */
function shortName(p: PricedProvider): string {
  return p.name.replace(/\s*\([^)]*\)\s*$/, "").trim() || p.name;
}

// ---------------------------------------------------------------------------
// buildQuoteOptions
// ---------------------------------------------------------------------------

export interface QuoteOptionsResult {
  options: QuoteOption[];
  recommended_option_id: QuoteOptionId | null;
  notes: string[];
}

interface Draft {
  kind: "free" | "archive" | "tasking";
  label: string;
  answers: string;
  answersQuestion: boolean;
  confidence: Confidence;
  notes: string[];
  priced: PricedOption;
}

type ItemSpec = Parameters<typeof engineInput>[0][number];

/**
 * Up to three options for a request, from the saved data spec, the acquisition plan and the provider registry:
 *   1. the cheapest option that answers the question (usually free public data; the Earth index when it already answers),
 *   2. a sharper archive option when a paid provider fits (≤ 1 m for property / asset-scale questions),
 *   3. a new-capture (tasking) option when timeliness matters or no archive option fits.
 * Recommends the cheapest option that answers; when free data can't (resolution or clouds), the paid one, saying why.
 * The acquisition plan's paid options are preferred over the registry's own candidates (acquisition compared them).
 */
export function buildQuoteOptions(
  plan: AcquisitionPlan, spec: DataSpec, registry: readonly PricedProvider[], ctx: QuoteContext = {},
): QuoteOptionsResult {
  const rows = registry.filter((p) => p.active !== false);
  const byId = new Map(rows.map((p) => [p.id, p]));
  const jobEpochs = ctx.epochs ?? (spec.before ? 2 : 1);
  const area = spec.area_km2;
  const notes: string[] = [];
  const drafts: Draft[] = [];
  const price = (items: ItemSpec[]) => priceOption(engineInput(items, spec, plan, rows, ctx));

  // 1. Free public data (or the Earth index) -------------------------------------------------------------
  const namedFree = plan.free_option ? byId.get(plan.free_option.provider_id) : undefined;
  const free = namedFree?.is_free
    ? namedFree
    : rows
        .filter((p) => p.is_free && p.data_type === spec.data_type && resOf(p) !== null)
        .sort((a, b) => resOf(a)! - resOf(b)!)[0];
  const freeRes = free ? (resOf(free) ?? spec.min_resolution_m) : Infinity;
  if (plan.choice === "existing_index") {
    drafts.push({
      kind: "free", label: "Standard: from our Earth index",
      answers: "Answered from results already in our Earth index for this area (derived from public satellite data); no new imagery is needed.",
      answersQuestion: true, confidence: "medium", notes: ["Uses results we already hold; the price covers the analysis and the verified report."],
      priced: price([]),
    });
  } else if (free) {
    const cantReason =
      freeRes > spec.min_resolution_m ? `it needs ${fmtRes(spec.min_resolution_m)} detail and free data is ${fmtRes(freeRes)}`
      : plan.free_option?.sufficient === false
        ? plan.free_option.why.trim().replace(/\.+$/, "").slice(0, 200) || "acquisition judged the free scenes insufficient"
      : null;
    const priced = price([{ provider: free, product: `public ${free.data_type} scenes`, resolution_m: freeRes, epochs: jobEpochs, area_km2: area }]);
    drafts.push({
      kind: "free", label: `Standard: ${fmtRes(freeRes)} public satellite data`,
      answers: answersText(spec, freeRes, priced.kind), answersQuestion: !cantReason, confidence: cantReason ? "low" : "medium",
      notes: [
        "Uses free public imagery; the price covers the analysis and the verified report.",
        ...(cantReason ? [`Can't fully answer this question: ${cantReason}.`] : []),
      ],
      priced,
    });
  } else {
    notes.push(`No free ${spec.data_type} source in the registry; only paid options are priced.`);
  }

  // Paid candidates: the plan's own comparison first, the registry's fitting providers otherwise ---------
  const assetScale = spec.min_resolution_m <= 5 || spec.area_km2 <= 10;
  const targetRes = Math.min(spec.min_resolution_m, assetScale ? 1 : 5);
  const planPaid = plan.paid_options
    .map((o) => ({ o, p: byId.get(o.provider_id) }))
    .filter((x): x is { o: (typeof plan.paid_options)[number]; p: PricedProvider } => {
      if (!x.p) notes.push(`Paid option ${x.o.provider_id} from the plan is not in the registry; skipped.`);
      return !!x.p && !x.p.is_free;
    });
  const fits = (p: PricedProvider) => !p.is_free && p.data_type === spec.data_type && resOf(p) !== null && resOf(p)! <= targetRes;
  const cheapest = (cands: { items: ItemSpec[]; p: PricedProvider }[]) =>
    cands
      .map((c) => ({ ...c, priced: price(c.items) }))
      .sort((a, b) =>
        (a.priced.price_usd === null ? 1 : 0) - (b.priced.price_usd === null ? 1 : 0) ||
        optionPriceLow(a.priced) - optionPriceLow(b.priced) ||
        (resOf(a.p) ?? 99) - (resOf(b.p) ?? 99))[0];

  // 2. Sharper archive imagery ---------------------------------------------------------------------------
  const archiveItem = (p: PricedProvider, res: number | null): ItemSpec => ({
    provider: p, product: `archive ${fmtRes(resOf(p) ?? res ?? targetRes)}`, resolution_m: res, epochs: jobEpochs, area_km2: area,
  });
  const planArchive = planPaid.filter(({ o, p }) => !/task/i.test(o.product) && itemMode(p, o.product) === "archive");
  const archiveCands = planArchive.length
    ? planArchive.map(({ o, p }) => ({ p, items: [archiveItem(p, o.resolution_m)] }))
    : rows.filter((p) => fits(p) && itemMode(p, "archive") === "archive" && unitPriceUsd(p, "archive") !== null)
        .map((p) => ({ p, items: [archiveItem(p, null)] }));
  const archive = archiveCands.length ? cheapest(archiveCands) : undefined;
  if (archive) {
    const res = archive.priced.data[0].resolution_m;
    drafts.push({
      kind: "archive", label: `Sharper: ${fmtRes(res)} archive imagery (${shortName(archive.p)})`,
      answers: answersText(spec, res, archive.priced.kind), answersQuestion: res <= spec.min_resolution_m,
      confidence: res > spec.min_resolution_m ? "low" : archive.priced.price_usd !== null ? "high" : "medium",
      notes: ["Paid imagery is bought only after you accept; you receive derived results, not the raw licensed images."],
      priced: archive.priced,
    });
  }

  // 3. New capture (tasking) when timeliness matters or there is no archive option -------------------------
  if (isTimely(spec, ctx) || !archive) {
    const history = Math.max(0, jobEpochs - 1);
    const taskingItems = (p: PricedProvider, res: number | null): ItemSpec[] => {
      const items: ItemSpec[] = [];
      if (history > 0) {
        if (unitPriceUsd(p, "archive") !== null) items.push({ ...archiveItem(p, res), epochs: history });
        else if (free) items.push({ provider: free, product: `public ${free.data_type} scenes`, resolution_m: freeRes, epochs: history, area_km2: area });
      }
      items.push({ provider: p, product: `tasking ${fmtRes(resOf(p) ?? res ?? targetRes)}`, resolution_m: res, epochs: 1, area_km2: area });
      return items;
    };
    const planTasking = planPaid.filter(({ o, p }) => /task/i.test(o.product) || itemMode(p, o.product) === "tasking");
    const taskCands = planTasking.length
      ? planTasking.map(({ o, p }) => ({ p, items: taskingItems(p, o.resolution_m) }))
      : rows.filter((p) => fits(p) && unitPriceUsd(p, "tasking") !== null).map((p) => ({ p, items: taskingItems(p, null) }));
    const tasking = taskCands.length ? cheapest(taskCands) : undefined;
    if (tasking) {
      const res = tasking.priced.data.at(-1)!.resolution_m;
      drafts.push({
        kind: "tasking", label: `New capture: ${fmtRes(res)} imagery taken for you (${shortName(tasking.p)})`,
        answers: answersText(spec, res, tasking.priced.kind), answersQuestion: res <= spec.min_resolution_m,
        confidence: res > spec.min_resolution_m ? "low" : "medium",
        notes: ["A satellite is scheduled only after you accept; clouds can delay an optical capture."],
        priced: tasking.priced,
      });
    }
  }

  if (!drafts.length) {
    notes.push(`No provider in the registry fits ${spec.data_type} data for this request; acquisition must add a source or a supplier quote.`);
    return { options: [], recommended_option_id: null, notes };
  }

  // Recommendation: the cheapest option that answers; else the cheapest, saying it can't fully answer -----
  const options: QuoteOption[] = drafts.slice(0, 3).map((d, i) => ({
    option_id: QUOTE_OPTION_IDS[i], label: d.label.slice(0, 120), answers: d.answers.slice(0, 600), ...d.priced,
    confidence: d.confidence, notes: uniq([...d.notes, ...d.priced.notes]).slice(0, 12),
  }));
  const answering = options.filter((_, i) => drafts[i].answersQuestion);
  const pool = answering.length ? answering : options;
  const rec = [...pool].sort((a, b) => optionPriceLow(a) - optionPriceLow(b) || (a.price_usd === null ? 1 : 0) - (b.price_usd === null ? 1 : 0))[0];
  const freeDraft = drafts[0].kind === "free" ? drafts[0] : null;
  if (freeDraft && !freeDraft.answersQuestion && rec.option_id !== options[0].option_id) {
    const why = (freeDraft.notes.find((n) => n.startsWith("Can't fully answer"))?.replace(/^Can't fully answer this question: /, "") ?? "")
      .replace(/\.+$/, "");
    rec.notes = uniq([`Recommended because the free-data option can't fully answer this: ${why}.`, ...rec.notes]).slice(0, 12);
    notes.push(`Free data can't fully answer (${why}); recommending option ${rec.option_id}.`);
  }
  if (!answering.length) notes.push(`No option fully answers at the needed ${fmtRes(spec.min_resolution_m)}; option ${rec.option_id} is the closest.`);
  return { options, recommended_option_id: rec.option_id, notes };
}

// ---------------------------------------------------------------------------
// Re-pricing an agent's option (create_quote): server numbers always win
// ---------------------------------------------------------------------------

export class UnknownProviderError extends Error {}

/** Re-price an option from its data items (provider ids, products, epochs, areas); keeps the agent's words. */
export function repriceOption(
  option: QuoteOption, plan: AcquisitionPlan, spec: DataSpec, registry: readonly PricedProvider[], ctx: QuoteContext = {},
): QuoteOption {
  const rows = registry.filter((p) => p.active !== false);
  const items: ItemSpec[] = option.data.map((d) => {
    const p = rows.find((r) => r.id === d.provider_id);
    if (!p) throw new UnknownProviderError(`Option ${option.option_id}: unknown provider ${d.provider_id}; use ids from list_providers.`);
    return { provider: p, product: d.product, resolution_m: d.resolution_m, epochs: d.epochs, area_km2: d.area_km2 };
  });
  const priced = priceOption(engineInput(items, spec, plan, rows, ctx));
  const area = Math.max(0, ...option.data.map((d) => d.area_km2));
  const coverage = option.data.length && area < spec.area_km2 * 0.95
    ? [`Covers ${r2(area)} km² of the ${r2(spec.area_km2)} km² area of interest.`] : [];
  return {
    option_id: option.option_id, label: option.label, answers: option.answers, ...priced,
    delivery_time: option.delivery_time?.trim() || priced.delivery_time, confidence: option.confidence,
    notes: uniq([...option.notes, ...priced.notes, ...coverage]).slice(0, 12),
  };
}

/** Why an agent's price differs from the server's by more than the tolerance, or null when it doesn't. */
export function priceMismatch(agent: Pick<QuoteOption, "price_usd" | "price_range_usd">, server: Pick<QuoteOption, "price_usd" | "price_range_usd">): string | null {
  const tol = PRICING.repriceTolerancePct;
  const close = (a: number, b: number) => Math.abs(a - b) <= tol * Math.max(b, 1);
  if (server.price_usd !== null) {
    if (agent.price_usd !== null && close(agent.price_usd, server.price_usd)) return null;
    return `server price ${fmtPrice(server)}, you gave ${agent.price_usd !== null || agent.price_range_usd ? fmtPrice(agent) : "none"}`;
  }
  const [lo, hi] = server.price_range_usd!;
  if (agent.price_range_usd && close(agent.price_range_usd[0], lo) && close(agent.price_range_usd[1], hi)) return null;
  return `server price ${fmtPrice(server)}, you gave ${agent.price_usd !== null || agent.price_range_usd ? fmtPrice(agent) : "none"}`;
}

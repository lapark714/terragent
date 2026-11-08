/**
 * Tunables in one place: models, budgets, windows, caps, pricing. Env overrides where useful.
 * Money in USD here; convert with usd() → integer micro-USD for Naïve.
 */
import type { AgentName, Playbook } from "./domain";
import { env, envNumber } from "./env";

export const usd = (dollars: number) => Math.round(dollars * 1_000_000); // → micro-USD integer

// ---------------------------------------------------------------------------
// Models (verified live 2026-11-07, NOTES). Only GLM-5.2-FP8 / Kimi-K2.6 / gemma-4-31B-it accept loose.
// ---------------------------------------------------------------------------
export const MODELS = {
  strong: env("NAIVE_MODEL_STRONG") ?? "anthropic/claude-sonnet-5.5", // Brain 1, Brain 2, Verifier
  routine: env("NAIVE_MODEL_ROUTINE") ?? "anthropic/claude-haiku-5.5", // comms, acquisition, pricing, analytics
  loose: env("NAIVE_MODEL_LOOSE") ?? "zai-org/GLM-5.2-FP8", // overnight cron work on the cheap window
} as const;

export type Window = "immediate" | "priority" | "loose";

export interface AgentBudget {
  model: string;
  window: Window;
  /** Daily cap for the agent (Naïve budget.cap_micro_usd, period "day"). */
  capUsdPerDay: number;
  /** Ceiling per session/task (budget.max_task_micro_usd). */
  maxTaskUsd: number;
}

/**
 * Split of the $250 Naïve budget (spec §1.1): ~$40 build/test, ~$120 overnight, ~$50 inbound+demo, ~$40 buffer.
 * Caps sum to ~$119/day; the org balance is the hard ceiling. Session pre-flight floors measured live
 * (docs/platform/naive-live.md): Sonnet 5.5 ~$0.40, GLM-5.2 ~$0.30, Haiku 5.5 ~$0.05 — maxTaskUsd must stay ≥ 2× floor.
 */
export const AGENT_BUDGETS: Record<AgentName, AgentBudget> = {
  coordinator: { model: MODELS.loose, window: "loose", capUsdPerDay: 8, maxTaskUsd: 0.8 },
  "comms-customer": { model: MODELS.routine, window: "immediate", capUsdPerDay: 8, maxTaskUsd: 0.5 },
  "comms-suppliers": { model: MODELS.routine, window: "immediate", capUsdPerDay: 3, maxTaskUsd: 0.4 },
  "comms-outreach": { model: MODELS.routine, window: "immediate", capUsdPerDay: 8, maxTaskUsd: 0.4 },
  planner: { model: MODELS.strong, window: "immediate", capUsdPerDay: 10, maxTaskUsd: 1.0 },
  acquisition: { model: MODELS.routine, window: "immediate", capUsdPerDay: 10, maxTaskUsd: 0.6 },
  pricing: { model: MODELS.routine, window: "immediate", capUsdPerDay: 3, maxTaskUsd: 0.25 },
  interpreter: { model: MODELS.strong, window: "immediate", capUsdPerDay: 15, maxTaskUsd: 1.0 },
  analytics: { model: MODELS.routine, window: "immediate", capUsdPerDay: 10, maxTaskUsd: 0.75 },
  verifier: { model: MODELS.strong, window: "immediate", capUsdPerDay: 8, maxTaskUsd: 1.0 },
  sourcing: { model: MODELS.loose, window: "loose", capUsdPerDay: 30, maxTaskUsd: 2.0 },
  "market-researcher": { model: MODELS.loose, window: "loose", capUsdPerDay: 6, maxTaskUsd: 3.0 },
};

// ---------------------------------------------------------------------------
// Pricing v2 (spec §6, NOTES 2026-11-08). Per job, bottom-up, 1–3 options (src/lib/pipeline/pricing-engine.ts):
//   option price = data + analysis + risk buffer + margin, floored and rounded to a friendly number.
// No free answers: only the investigation (planning + source comparison) is free, and nothing else runs until the
// customer accepts an option. Quotes go out without founder review; buying paid data stays a founder's job.
// ---------------------------------------------------------------------------
export const PRICING = {
  /**
   * DISPLAY / BACK-COMPAT ONLY (landing and terms copy). Since pricing v2 nothing starts work from it: every quote
   * waits for the customer to accept an option, whatever its price.
   */
  autoApproveCapUsd: envNumber("PRICE_AUTO_APPROVE_CAP_USD", 50),
  /** Price floor of any option (in practice the cheapest one, usually free data). Never $0. */
  minReportUsd: envNumber("PRICE_MIN_REPORT_USD", 29),
  /**
   * Margin = max(analysisMarginMultiple × analysis + dataMarkup × (data + risk), marginFloorUsd).
   * Value margin on our own analysis; a reseller markup on purchased imagery (industry norm ~20–40%).
   */
  analysisMarginMultiple: envNumber("PRICE_ANALYSIS_MARGIN_MULTIPLE", 8),
  dataMarkup: envNumber("PRICE_DATA_MARKUP", 0.35),
  /** @deprecated kept for the quote mirror columns / older callers; the engine uses the two values above. */
  marginMultiple: envNumber("PRICE_MARGIN_MULTIPLE", 3),
  marginFloorUsd: envNumber("PRICE_MARGIN_FLOOR_USD", 20),
  /** Estimated agent + compute cost for one free-data report (estimate_costs, outbound metrics). Same as analysisBaseUsd. */
  defaultAnalysisCostUsd: 1.5,

  // --- analysis cost (agents + compute), per option ---------------------------------------------------------
  /** Measured agent cost of one report: planner + analytics + interpreter + verifier + comms sessions (~$1.5). */
  analysisBaseUsd: envNumber("PRICE_ANALYSIS_BASE_USD", 1.5),
  /** Dates/scenes included in the base (a before/after pair). */
  analysisIncludedEpochs: 2,
  /**
   * Most dates a quote may price for one request. The pipeline (pipeline/terragent_pipeline) compares one before/after
   * pair, so a quote never sells more dates than are analysed; price_options / create_quote cap `epochs` here and say so.
   * Raise it when the pipeline does time series (the engine already prices extra dates).
   */
  maxAnalysisEpochs: 2,
  /** Each extra date beyond the included two: one more pipeline run plus interpreter tokens. */
  analysisPerExtraEpochUsd: 0.25,
  /** Each data type beyond the first (e.g. optical + radar): another recipe and a longer report. */
  analysisPerExtraDataTypeUsd: 1.0,
  /** Area included in the base; beyond it, compute scales with km². */
  analysisIncludedKm2: 25,
  analysisComputePerKm2Usd: 0.02,
  /** High-stakes uses (insurance, legal, safety): one more verifier pass. */
  analysisHighStakesUsd: 1.0,
  /** Cap on the analysis line, so a huge area doesn't price compute absurdly (data costs are not capped). */
  analysisCapUsd: 250,

  // --- risk buffer: % of data cost by uncertainty (summed per data item) --------------------------------------
  /** New capture: weather, re-tasking, minimum-order surprises. */
  riskTaskingPct: 0.25,
  /** No public price: applied to the high end of the estimated range. */
  riskUnknownPricePct: 0.15,
  /** Optical data where clouds are likely (tropics, or the plan found the free scenes cloudy). */
  riskCloudyOpticalPct: 0.1,

  // --- data prices the registry doesn't give -----------------------------------------------------------------
  /** USD/km² band for a provider with no public price when the registry has no priced provider of that type/mode. */
  unknownPriceBandUsdPerKm2: [5, 40] as [number, number],
  /** Assumed minimum order (km²) at the high end of an unknown price. */
  unknownMinOrderKm2: 25,
  /** Tasking minimum when the provider's notes don't state one (most tasking minimums are 25–100 km²). */
  taskingMinOrderKm2: 25,
  /** EUR → USD for UP42 rows (prices in EUR). Approximate; the founder sees the real figure at purchase. */
  eurToUsd: envNumber("PRICE_EUR_TO_USD", 1.1),

  // --- quote lifecycle ---------------------------------------------------------------------------------------
  /** How long a quote's options can be accepted. */
  quoteValidDays: 7,
  /** create_quote rejects an agent's option price that differs from the server's by more than this. */
  repriceTolerancePct: 0.05,

  /** Monitoring subscription; create_monitor records the customer's acceptance of this price first (NOTES 2026-11-08). */
  monitoringPerSiteMonthlyUsd: 49,
};

// ---------------------------------------------------------------------------
// Safety caps
// ---------------------------------------------------------------------------
export const CAPS = {
  /**
   * AgentMail Developer plan: 1,000/day, 100 per 5 min, 10 inboxes (verified 2026-11-07). The binding limit is
   * the new-org ramp — ~5 distinct new recipients in the first hour, 10 the first day, 25 the first week —
   * enforced by AgentMail (429/403). Treat those rejections as "blocked by provider", not errors (NOTES H2g).
   */
  emailsPerDayTotal: envNumber("CAP_EMAILS_PER_DAY", 900),
  outreachTouchesPerDay: envNumber("CAP_OUTREACH_PER_DAY", 40),
  /** Monid: $20 wallet for the weekend (H3b done); hard per-call and per-day ceilings in our wrapper. */
  monidMaxUsdPerCall: envNumber("CAP_MONID_PER_CALL_USD", 0.05),
  monidMaxUsdPerDay: envNumber("CAP_MONID_PER_DAY_USD", 6),
  maxReportRevisions: 2,
  /** Free sample reports the signal engine may start per run, before allocation weights. */
  freeSamplesPerRun: envNumber("CAP_FREE_SAMPLES_PER_RUN", 6),
  /** Free samples per day across playbooks — sized so planner/interpreter/verifier caps keep ~$4/day each for inbound + demo. */
  freeSamplesPerDay: envNumber("CAP_FREE_SAMPLES_PER_DAY", 12),
  apiRequestsPerHourDefault: 30,
  /** Largest AOI we analyze from free data without asking (km²). */
  maxFreeAoiKm2: 100,
};

/** Default effort split before the coordinator has measured anything. */
export const DEFAULT_ALLOCATION: Record<Exclude<Playbook, "inbound">, number> = {
  disasters: 0.5,
  deforestation: 0.3,
  mining: 0.2,
};

export const H3_DEFAULT_RES = 8; // ~0.74 km² cells, ~531 m edge
export const H3_GLOBE_RES = 4; // aggregate for the world view

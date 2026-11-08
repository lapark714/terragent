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
// Pricing (spec §6): quote = data cost + analysis cost + margin.
// ---------------------------------------------------------------------------
export const PRICING = {
  /** Quotes at or below this are auto-approved (no human, no waiting on the customer). */
  autoApproveCapUsd: envNumber("PRICE_AUTO_APPROVE_CAP_USD", 50),
  /** Floor price for a free-data report. */
  minReportUsd: envNumber("PRICE_MIN_REPORT_USD", 29),
  /** Margin as a multiple of real cost (data + compute), with a dollar floor. */
  marginMultiple: 3,
  marginFloorUsd: 20,
  /** Estimated agent + compute cost for one free-data report, until measured. */
  defaultAnalysisCostUsd: 1.5,
  monitoringPerSiteMonthlyUsd: 49,
  apiPerRequestUsd: 9,
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

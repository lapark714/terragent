/**
 * Terragent domain contract.
 *
 * One set of zod schemas drives three things:
 *   1. runtime validation in API routes and webhooks,
 *   2. input schemas for the Terragent MCP tools the agents call,
 *   3. Naïve `output_schema`s (via `z.toJSONSchema`) so agents return typed results.
 *
 * Change a shape here and every layer follows. Keep it boring and explicit.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

export const PLAYBOOKS = ["disasters", "deforestation", "mining", "inbound"] as const;
export const Playbook = z.enum(PLAYBOOKS);
export type Playbook = z.infer<typeof Playbook>;

/** Globe layers. `forest` is the deforestation playbook's layer name. */
export const LAYERS = ["disasters", "forest", "mining", "inbound"] as const;
export const Layer = z.enum(LAYERS);
export type Layer = z.infer<typeof Layer>;

export const playbookLayer: Record<Playbook, Layer> = {
  disasters: "disasters",
  deforestation: "forest",
  mining: "mining",
  inbound: "inbound",
};

export const REQUEST_SOURCES = ["portal", "email", "api", "signal", "monitor"] as const;
export const RequestSource = z.enum(REQUEST_SOURCES);
export type RequestSource = z.infer<typeof RequestSource>;

/**
 * Request lifecycle. Order matters: it is the left-to-right column order of the board.
 * Terminal states: delivered, refused, failed, cancelled.
 */
export const REQUEST_STATUSES = [
  "received", // just arrived (portal / email / api / signal)
  "screening", // Comms 2 checks for misuse
  "clarifying", // waiting on the customer for missing info
  "planning", // Brain 1 builds the data spec
  "acquiring", // Orchestrator: free first, compare paid
  "pricing", // Pricing agent builds the quote
  "quoted", // quote sent, waiting on customer
  "awaiting_approval", // paid order or large quote held for a founder
  "fetching", // Orchestrator fetching free data
  "analyzing", // Analytics / Brain 2
  "verifying", // Verifier grading
  "revising", // Verifier sent it back to Brain 2
  "delivering", // Comms sending the answer
  "delivered",
  "refused",
  "failed",
  "cancelled",
] as const;
export const RequestStatus = z.enum(REQUEST_STATUSES);
export type RequestStatus = z.infer<typeof RequestStatus>;

export const TERMINAL_STATUSES: ReadonlySet<RequestStatus> = new Set([
  "delivered",
  "refused",
  "failed",
  "cancelled",
]);

/** Agent roster names. These are the `actor` / `owner_agent` values everywhere. */
export const AGENT_NAMES = [
  "coordinator",
  "comms-customer", // Comms 2, hello@
  "comms-suppliers", // Comms 1, data@
  "comms-outreach", // Comms 3, outreach@
  "planner", // Brain 1
  "acquisition", // Orchestrator
  "pricing",
  "interpreter", // Brain 2
  "analytics",
  "verifier",
  "sourcing", // signal engine
  "market-researcher",
] as const;
export const AgentName = z.enum(AGENT_NAMES);
export type AgentName = z.infer<typeof AgentName>;

export const INBOXES = ["hello", "data", "outreach"] as const;
export const Inbox = z.enum(INBOXES);
export type Inbox = z.infer<typeof Inbox>;

export const Confidence = z.enum(["high", "medium", "low"]);
export type Confidence = z.infer<typeof Confidence>;

export const DATA_TYPES = [
  "optical",
  "radar",
  "thermal",
  "hyperspectral",
  "elevation",
  "alerts",
] as const;
export const DataType = z.enum(DATA_TYPES);
export type DataType = z.infer<typeof DataType>;

/** Analysis recipes implemented by the Python pipeline (pipeline/terragent_pipeline/recipes.py). */
export const RECIPES = [
  "true_color", // latest clear image only
  "vegetation_health", // NDVI
  "flood_extent", // NDWI / MNDWI before vs after
  "burn_severity", // NBR / dNBR
  "forest_loss", // NDVI drop (+ GFW alerts when available)
  "mining_indicators", // iron-oxide + clay band ratios — indicators, never "deposits"
  "change_detection", // generic before/after true color + NDVI delta
] as const;
export const Recipe = z.enum(RECIPES);
export type Recipe = z.infer<typeof Recipe>;

export const DECISION_KINDS = [
  "screening",
  "source_selection",
  "free_vs_paid",
  "pricing",
  "verification",
  "outreach",
  "playbook_allocation",
  "monitoring",
] as const;
export const DecisionKind = z.enum(DECISION_KINDS);
export type DecisionKind = z.infer<typeof DecisionKind>;

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export const LatLon = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});
export type LatLon = z.infer<typeof LatLon>;

/** GeoJSON Polygon, [lon, lat] order. Kept minimal on purpose. */
export const Polygon = z.object({
  type: z.literal("Polygon"),
  coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))),
});
export type Polygon = z.infer<typeof Polygon>;

/** [minLon, minLat, maxLon, maxLat] */
export const BBox = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export type BBox = z.infer<typeof BBox>;

export const DateRange = z.object({
  start: z.string().describe("ISO date, inclusive"),
  end: z.string().describe("ISO date, inclusive"),
});
export type DateRange = z.infer<typeof DateRange>;

// ---------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------

/** What the portal form, the public API and the email parser all produce. */
export const NewRequestInput = z.object({
  question: z.string().min(5).max(2000),
  location_text: z.string().min(2).max(500).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  email: z.email().optional(),
  name: z.string().max(200).optional(),
  company: z.string().max(200).optional(),
});
export type NewRequestInput = z.infer<typeof NewRequestInput>;

/** Comms 2 misuse screen. Refusals are logged as `screening` decisions. */
export const ScreeningResult = z.object({
  allowed: z.boolean(),
  category: z.enum([
    "ok",
    "individual_surveillance",
    "stalking",
    "targeting",
    "military_or_weapons",
    "illegal_activity",
    "unclear_needs_clarification",
    "out_of_scope",
  ]),
  reason: z.string(),
  clarifying_question: z.string().optional(),
});
export type ScreeningResult = z.infer<typeof ScreeningResult>;

// ---------------------------------------------------------------------------
// Brain 1 — Planner: abstract request → concrete data spec
// ---------------------------------------------------------------------------

export const EarthIndexHit = z.object({
  h3_cell: z.string(),
  metric: z.string(),
  value: z.number(),
  observed_at: z.string(),
  source: z.string(),
  report_id: z.string().nullable().optional(),
});
export type EarthIndexHit = z.infer<typeof EarthIndexHit>;

export const DataSpec = z.object({
  request_id: z.string(),
  playbook: Playbook,
  location: z.object({
    text: z.string(),
    lat: z.number(),
    lon: z.number(),
    geocoder: z.string().describe("which geocoder resolved it, e.g. monid-maps | nominatim | census | user"),
  }),
  aoi: Polygon.describe("area of interest, GeoJSON [lon, lat]"),
  area_km2: z.number().positive(),
  h3_res: z.number().int().min(5).max(10),
  recipe: Recipe,
  data_type: DataType.describe("names the data type; the Orchestrator picks a provider from the registry"),
  min_resolution_m: z.number().positive().describe("coarsest resolution that can still answer the question"),
  max_cloud_pct: z.number().min(0).max(100),
  before: DateRange.nullable().describe("comparison window, null if no comparison is needed"),
  after: DateRange.describe("most recent / post-event window"),
  earth_index_hits: z.array(EarthIndexHit).describe("existing results found in the Earth index before fetching"),
  reuse_existing: z.boolean().describe("true if the Earth index already answers the question"),
  assumptions: z.array(z.string()),
});
export type DataSpec = z.infer<typeof DataSpec>;

// ---------------------------------------------------------------------------
// Orchestrator — Acquisition: free first, compare paid, justify in writing
// ---------------------------------------------------------------------------

export const SceneRef = z.object({
  collection: z.string(),
  item_id: z.string(),
  datetime: z.string(),
  cloud_pct: z.number().nullable(),
});
export type SceneRef = z.infer<typeof SceneRef>;

export const PaidOption = z.object({
  provider_id: z.string(),
  product: z.string(),
  resolution_m: z.number(),
  est_cost_usd: z.number().nonnegative(),
  min_order_km2: z.number().nullable(),
  delivery_time: z.string().nullable(),
  license_terms: z.string().nullable(),
  preview_available: z.boolean(),
  why: z.string(),
});
export type PaidOption = z.infer<typeof PaidOption>;

export const AcquisitionPlan = z.object({
  request_id: z.string(),
  choice: z.enum(["existing_index", "free", "paid"]),
  free_option: z
    .object({
      provider_id: z.string(),
      before_scene: SceneRef.nullable(),
      after_scene: SceneRef.nullable(),
      sufficient: z.boolean(),
      why: z.string(),
    })
    .nullable(),
  paid_options: z.array(PaidOption),
  justification: z
    .string()
    .describe("why this choice; REQUIRED to explain why free data is not enough whenever choice = paid"),
  data_cost_usd: z.number().nonnegative(),
  quote_requests_sent: z.array(z.object({ provider_id: z.string(), thread_id: z.string().nullable() })),
});
export type AcquisitionPlan = z.infer<typeof AcquisitionPlan>;

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

export const QuoteLine = z.object({
  label: z.string(),
  amount_usd: z.number(),
});

export const Quote = z.object({
  request_id: z.string(),
  data_cost_usd: z.number().nonnegative(),
  analysis_cost_usd: z.number().nonnegative(),
  margin_usd: z.number().nonnegative(),
  price_usd: z.number().nonnegative(),
  auto_approved: z.boolean(),
  needs_approval_reason: z.string().nullable(),
  line_items: z.array(QuoteLine),
});
export type Quote = z.infer<typeof Quote>;

// ---------------------------------------------------------------------------
// Analytics — output of the Python pipeline (pipeline/run.py prints this JSON)
// ---------------------------------------------------------------------------

export const SceneSummary = z.object({
  collection: z.string(),
  item_id: z.string(),
  datetime: z.string(),
  cloud_pct: z.number().nullable(),
  clear_fraction: z.number().min(0).max(1).describe("share of AOI pixels not masked by SCL"),
});

export const IndexMeasurement = z.object({
  name: z.string().describe("ndvi | ndwi | mndwi | nbr | dnbr | iron_oxide | clay"),
  before_mean: z.number().nullable(),
  after_mean: z.number().nullable(),
  delta: z.number().nullable(),
  unit: z.string().nullable(),
  affected_area_km2: z.number().nullable().describe("area crossing the recipe threshold, if any"),
  threshold: z.string().nullable(),
});
export type IndexMeasurement = z.infer<typeof IndexMeasurement>;

export const AnalysisImage = z.object({
  role: z.enum(["before", "after", "index", "change"]),
  path: z.string().describe("local path inside the computer, or URL once uploaded"),
  caption: z.string(),
});

export const AnalysisResult = z.object({
  recipe: Recipe,
  bbox: BBox,
  before: SceneSummary.nullable(),
  after: SceneSummary.nullable(),
  indices: z.array(IndexMeasurement),
  images: z.array(AnalysisImage),
  h3_metrics: z.array(
    z.object({ h3_cell: z.string(), h3_res: z.number().int(), metric: z.string(), value: z.number() }),
  ),
  timings_s: z.record(z.string(), z.number()),
  warnings: z.array(z.string()),
});
export type AnalysisResult = z.infer<typeof AnalysisResult>;

// ---------------------------------------------------------------------------
// Brain 2 — Interpreter: the report
// ---------------------------------------------------------------------------

export const ReportMeasurement = z.object({
  metric: z.string(),
  value: z.number().nullable(),
  unit: z.string().nullable(),
  before: z.number().nullable(),
  after: z.number().nullable(),
  note: z.string().nullable(),
});

export const ReportImage = z.object({
  role: z.enum(["before", "after", "index", "change"]),
  url: z.string(),
  caption: z.string(),
  date: z.string().nullable(),
  source: z.string(),
});

export const ReportSource = z.object({
  name: z.string(),
  collection: z.string().nullable(),
  item_id: z.string().nullable(),
  datetime: z.string().nullable(),
  url: z.string().nullable(),
  license: z.string().nullable(),
});

export const ReportDraft = z.object({
  request_id: z.string(),
  title: z.string(),
  answer: z.string().describe("plain-language answer to the customer's question, 2-6 sentences"),
  confidence: Confidence,
  measurements: z.array(ReportMeasurement),
  images: z.array(ReportImage),
  sources: z.array(ReportSource).min(1),
  limitations: z.string().describe("resolution, clouds, dates, what this cannot tell you"),
  human_review_recommended: z.boolean().describe("true for high-stakes uses (insurance, legal, safety)"),
  paid_data_estimate: z
    .object({ would_show: z.string(), est_cost_usd: z.number(), provider_id: z.string() })
    .nullable(),
});
export type ReportDraft = z.infer<typeof ReportDraft>;

// ---------------------------------------------------------------------------
// Verifier
// ---------------------------------------------------------------------------

/** Checklist ids the Verifier must evaluate. Kept in code so the rule-based pre-check can run too. */
export const VERIFIER_CHECKS = [
  "answers_the_question",
  "has_before_and_after_images",
  "has_measurements",
  "has_confidence",
  "has_dated_sources",
  "has_limitations",
  "claims_supported_by_measurements",
  "mining_language_is_indicator_only",
  "no_raw_licensed_imagery",
  "high_stakes_flagged",
] as const;
export const VerifierCheckId = z.enum(VERIFIER_CHECKS);

export const Verdict = z.object({
  report_id: z.string(),
  pass: z.boolean(),
  score: z.number().min(0).max(100),
  checks: z.array(z.object({ id: VerifierCheckId, pass: z.boolean(), note: z.string() })),
  required_fixes: z.array(z.string()),
});
export type Verdict = z.infer<typeof Verdict>;

// ---------------------------------------------------------------------------
// Signal engine
// ---------------------------------------------------------------------------

export const SIGNAL_FEEDS = [
  "nws",
  "usgs_quake",
  "nwps_flood",
  "firms",
  "openfema",
  "gfw",
  "mrds",
  "news",
  "blm_claims",
] as const;
export const SignalFeed = z.enum(SIGNAL_FEEDS);
export type SignalFeed = z.infer<typeof SignalFeed>;

export const SignalInput = z.object({
  playbook: Playbook,
  feed: SignalFeed,
  external_id: z.string(),
  title: z.string(),
  severity: z.string().nullable(),
  event_time: z.string().nullable(),
  geometry: Polygon.nullable(),
  lat: z.number().nullable(),
  lon: z.number().nullable(),
  raw: z.record(z.string(), z.unknown()),
});
export type SignalInput = z.infer<typeof SignalInput>;

export const ProspectInput = z.object({
  signal_id: z.string(),
  playbook: Playbook,
  company: z.string(),
  domain: z.string().nullable(),
  contact_name: z.string().nullable(),
  contact_email: z.email().nullable().describe("WORK contacts only. Never individual homeowners."),
  contact_role: z.string().nullable(),
  asset_description: z.string(),
  asset_lat: z.number(),
  asset_lon: z.number(),
  score_fit: z.number().min(0).max(1),
  score_urgency: z.number().min(0).max(1),
  score_ability: z.number().min(0).max(1),
  score_reach: z.number().min(0).max(1),
  rationale: z.string(),
});
export type ProspectInput = z.infer<typeof ProspectInput>;

/** fit × urgency × ability to pay × reachability (spec §3.3). */
export function prospectScore(p: Pick<ProspectInput, "score_fit" | "score_urgency" | "score_ability" | "score_reach">) {
  return p.score_fit * p.score_urgency * p.score_ability * p.score_reach;
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

export const PlaybookAllocation = z.object({
  allocations: z
    .array(z.object({ playbook: Playbook, weight: z.number().min(0).max(1) }))
    .describe("weights must sum to 1"),
  reason: z.string(),
  metrics: z.record(z.string(), z.unknown()),
});
export type PlaybookAllocation = z.infer<typeof PlaybookAllocation>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** JSON Schema for a Naïve `output_schema`. Verify the supported subset in docs/platform/naive-compute.md. */
export function outputSchema<T extends z.ZodType>(schema: T) {
  return z.toJSONSchema(schema, { target: "draft-7" });
}

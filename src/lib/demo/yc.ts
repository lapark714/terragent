/**
 * The live-demo scenario: the area around YC's Dogpatch office (580 20th Street, San Francisco), 2016 vs 2026.
 *
 * Built from a REAL run of our system's parts (scripts/demo-build-yc.ts → yc-run.json + public/demo/yc-sf/):
 * the Sentinel-2 scenes, every map and measurement come from the real pipeline (change_detection recipe), the scene
 * counts from a real Planetary Computer search, and the quote from the real pricing engine and provider registry.
 * The only pretend part: /demo replays it instead of running the agents live, so it is fast and the same every time.
 * The report's wording stands in for the interpreter agent's, written strictly from those measurements.
 */
import type { PublicQuote, PublicQuoteOption, PublicReport } from "@/lib/dashboard/public";
import type { QuoteOptionId, RequestStatus } from "@/lib/domain";
import run from "./yc-run.json";

export const SITE = {
  name: "Y Combinator",
  short: "Dogpatch, SF",
  detail: "580 20th Street, San Francisco",
  lat: run.spec.location.lat,
  lng: run.spec.location.lon,
};

export const DEMO_QUESTION = "How has the area around the YC office changed over the past ten years?";
export const DEMO_PERIOD = "Time period: since 2016-01-01.";

const before = run.result.before;
const after = run.result.after;
const ndvi = run.result.indices[0];
const options = run.public_quote_options as PublicQuoteOption[];
const optionA = options.find((o) => o.option_id === "A")!;
const paidData = run.quote.options.find((o) => o.option_id === "B")?.data[0];
const t = run.result.timings_s;

const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

// ---------------------------------------------------------------------------
// The script the tracking page plays back
// ---------------------------------------------------------------------------

export interface DemoEvent {
  type: string;
  actor: string;
}

export interface DemoLogLine {
  actor: string;
  text: string;
}

export interface DemoStep {
  /** Seconds after the phase starts (request created, or quote accepted). */
  at: number;
  status?: RequestStatus;
  owner?: string | null;
  events?: DemoEvent[];
  log?: DemoLogLine[];
}

/** Before the quote: the free investigation. Ends waiting on the customer's choice. */
export const PRE_QUOTE: DemoStep[] = [
  { at: 0, status: "received", owner: "coordinator", events: [{ type: "request.created", actor: "customer (web)" }],
    log: [{ actor: "coordinator", text: "New request from the website. Routing to customer comms for screening." }] },
  { at: 2.5, status: "screening", owner: "comms-customer", events: [{ type: "handoff", actor: "coordinator" }],
    log: [{ actor: "comms-customer", text: "Screening: a question about buildings and land around an office. Not about tracking people. OK to proceed." }] },
  { at: 6, status: "planning", owner: "planner", events: [{ type: "decision.logged", actor: "comms-customer" }, { type: "handoff", actor: "comms-customer" }],
    log: [{ actor: "planner", text: "Reading 'changed' as visible change on the ground: buildings, cleared lots, vegetation. Recipe: change_detection." }] },
  { at: 9.5, log: [{ actor: "planner", text: `Area: a 1.6 km box around 580 20th St (${run.spec.area_km2} km²), Dogpatch plus the Pier 70 waterfront. Late summer 2016 vs late summer 2026.` }] },
  { at: 12, events: [{ type: "data_spec.saved", actor: "planner" }],
    log: [{ actor: "planner", text: "Data spec saved: optical, 10 m is enough for block-scale change, under 10% cloud." }] },
  { at: 13.5, status: "acquiring", owner: "acquisition", events: [{ type: "handoff", actor: "planner" }],
    log: [{ actor: "acquisition", text: "Searching Sentinel-2 L2A on Planetary Computer for both windows…" }] },
  { at: 17, log: [{ actor: "acquisition", text: "Jun–Oct 2016: 16 scenes, 3 under 10% cloud. Jun–Oct 2026: 38 scenes, 6 under 10% (summer fog)." }] },
  { at: 20, log: [{ actor: "acquisition", text: `Best pair: ${day(before.datetime)} (${Math.round(before.clear_fraction * 100)}% clear) and ${day(after.datetime)} (${Math.round(after.clear_fraction * 100)}% clear). Free data is sufficient.` }] },
  { at: 22, events: [{ type: "decision.logged", actor: "acquisition" }, { type: "acquisition_plan.saved", actor: "acquisition" }] },
  { at: 23.5, status: "pricing", owner: "pricing", events: [{ type: "handoff", actor: "acquisition" }],
    log: [{ actor: "pricing", text: "Pricing against the provider registry: free Sentinel-2, a 1 m archive option, a new 1 m capture." }] },
  { at: 27.5, status: "quoted", owner: null, events: [{ type: "quote.created", actor: "pricing" }, { type: "quote.sent", actor: "comms-customer" }],
    log: [{ actor: "pricing", text: `Quote ready: ${options.map((o) => `${o.option_id} $${o.price_usd ?? o.price_range_usd?.join("–")}`).join(", ")}. Recommending A: it answers the question at block scale.` }] },
];

/** After the customer accepts the free-data option: the real pipeline run, a verifier round-trip, delivery. */
const POST_FREE: DemoStep[] = [
  { at: 0, status: "fetching", owner: "analytics", events: [{ type: "quote.accepted", actor: "customer (link)" }],
    log: [{ actor: "analytics", text: "Option A accepted. Starting the imagery pipeline: change_detection on the 2 chosen scenes." }] },
  { at: 2.5, log: [{ actor: "analytics", text: `Signed the scene URLs and read red + near-infrared bands: 162 × 158 px at 10 m (${t.read.toFixed(1)} s).` }] },
  { at: 5, status: "analyzing", log: [{ actor: "analytics", text: "Cloud and shadow masks applied. Water masked out. Computing NDVI for both dates." }] },
  { at: 8, log: [{ actor: "analytics", text: `Mean NDVI ${ndvi.before_mean.toFixed(3)} → ${ndvi.after_mean.toFixed(3)}. Changed by more than 0.2: ${ndvi.affected_area_km2.toFixed(2)} km².` }] },
  { at: 10.5, log: [{ actor: "analytics", text: `Rendered 4 maps (before, after, NDVI, NDVI change) and wrote ${run.result.h3_cells} H3 cells to the Earth index. Pipeline total ${t.total.toFixed(1)} s.` }] },
  { at: 12, events: [{ type: "analysis.saved", actor: "analytics" }] },
  { at: 13, owner: "interpreter", events: [{ type: "handoff", actor: "analytics" }],
    log: [{ actor: "interpreter", text: "Writing the answer from the measurements and the before/after pair." }] },
  { at: 17, status: "verifying", owner: "verifier", events: [{ type: "report.drafted", actor: "interpreter" }, { type: "handoff", actor: "interpreter" }],
    log: [{ actor: "verifier", text: "Grading against the 10-point checklist…" }] },
  { at: 20, status: "revising", owner: "interpreter", events: [{ type: "decision.logged", actor: "verifier" }],
    log: [{ actor: "verifier", text: "Sent back (claims_supported_by_measurements): \"new buildings\" can't be confirmed at 10 m. Say large new roofs, and note the limit." }] },
  { at: 23, log: [{ actor: "interpreter", text: "Revised: describes changed roofs and cleared yards, adds the 10 m caveat and the 1 m option." }] },
  { at: 25, status: "verifying", owner: "verifier", events: [{ type: "report.saved", actor: "interpreter" }, { type: "handoff", actor: "interpreter" }],
    log: [{ actor: "verifier", text: "Re-checked: 10 of 10 checks pass." }] },
  { at: 28, status: "delivering", owner: "comms-customer", events: [{ type: "report.verified", actor: "verifier" }],
    log: [{ actor: "comms-customer", text: "Publishing the report and emailing the link." }] },
  { at: 30.5, status: "delivered", owner: null, events: [{ type: "email.sent", actor: "comms-customer" }],
    log: [{ actor: "comms-customer", text: "Delivered." }] },
];

/** Seconds the paid path spends on the imagery order before the analysis (really 2–5 business days; the demo skips ahead). */
const PAID_ORDER_S = 6;

/**
 * After accepting a paid option: the imagery order, then the same analysis and report. As the quote says, the
 * measurements come from the free Sentinel-2 pair and the purchased 1 m imagery is for reviewing finer detail.
 */
function postPaid(optionId: QuoteOptionId): DemoStep[] {
  return [
    { at: 0, status: "awaiting_approval", owner: null, events: [{ type: "quote.accepted", actor: "customer (link)" }],
      log: [{ actor: "acquisition", text: `Option ${optionId} accepted. Ordering the 1 m archive imagery from the supplier.` }] },
    { at: 2.5, log: [{ actor: "acquisition", text: "Imagery on order with the supplier." }] },
    { at: PAID_ORDER_S, status: "fetching", owner: "analytics", events: [{ type: "handoff", actor: "acquisition" }],
      log: [{ actor: "analytics", text: "Imagery delivered. Measurements run on the free Sentinel-2 pair; the 1 m frames are kept for reviewing detail." }] },
    ...POST_FREE.slice(1).map((s) => ({ ...s, at: s.at + PAID_ORDER_S })),
  ];
}

export const postQuoteSteps = (optionId: QuoteOptionId | null): DemoStep[] => (!optionId || optionId === "A" ? POST_FREE : postPaid(optionId));

export function demoQuote(id: string, acceptedOptionId: QuoteOptionId | null, acceptedAt: string | null, createdAt: string): PublicQuote {
  return {
    id: `quo_${id.slice(4)}`,
    status: acceptedOptionId ? "accepted" : "sent",
    recommended_option_id: run.quote.recommended_option_id as QuoteOptionId,
    accepted_option_id: acceptedOptionId,
    accepted_at: acceptedAt,
    valid_until: new Date(Date.parse(createdAt) + 7 * 86_400_000).toISOString(),
    closed_reason: acceptedOptionId ? "accepted" : null,
    // Only its last path segment is read (as the accept token); the demo never posts it anywhere.
    accept_url: acceptedOptionId ? null : `/quote/demo_${id.slice(4)}_token`,
    options,
  };
}

// ---------------------------------------------------------------------------
// The report (what /r/<token> would show)
// ---------------------------------------------------------------------------

export const REPORT_TITLE = "The waterfront next to YC's Dogpatch office has been cleared and rebuilt since 2016";
export const REPORT_ANSWER =
  `Yes, visibly. Comparing cloud-free Sentinel-2 images from ${day(before.datetime)} and ${day(after.datetime)}, ` +
  `${ndvi.affected_area_km2.toFixed(2)} km² of the ${run.spec.area_km2} km² area changed past our threshold. The clearest change is on the ` +
  "waterfront southeast of the office, where the round storage tanks and open yards of 2016 are gone and large new roofs appear. " +
  `Overall greenness barely moved (mean NDVI ${ndvi.before_mean.toFixed(2)} → ${ndvi.after_mean.toFixed(2)}): this is rebuilding, not new parkland.`;
export const REPORT_LIMITATIONS =
  "Sentinel-2 pixels are 10 m, so this shows block-scale change, not individual buildings or what they are used for. NDVI change also " +
  "responds to new roof materials and shadows. Two dates only: it shows the net change since 2016, not when each change happened. " +
  "It says nothing about people or how busy the office is.";
export const REPORT_CONFIDENCE = optionA.confidence;

const PC_ITEM = (collection: string, id: string) => `https://planetarycomputer.microsoft.com/api/stac/v1/collections/${collection}/items/${id}`;
const S2_SOURCE = "Sentinel-2 L2A via Microsoft Planetary Computer";

/** `paid`: the customer chose the 1 m option, so the report says what that imagery is for instead of offering it. */
export function demoReport(token: string, { paid = false }: { paid?: boolean } = {}): PublicReport {
  const imgDate = (role: string) => (role === "before" ? before.datetime : after.datetime);
  return {
    token,
    title: REPORT_TITLE,
    question: DEMO_QUESTION,
    location: `${SITE.name}, ${SITE.detail}`,
    playbook: "inbound",
    answer: REPORT_ANSWER,
    confidence: REPORT_CONFIDENCE,
    measurements: [
      { metric: "changed_area_km2", value: ndvi.affected_area_km2, unit: "km2", before: null, after: null, note: ndvi.threshold ?? null },
      { metric: "ndvi_mean", value: null, unit: "index", before: ndvi.before_mean, after: ndvi.after_mean, note: "Land pixels clear in both scenes; water masked." },
      { metric: "area_analysed_km2", value: run.spec.area_km2, unit: "km2", before: null, after: null, note: "1.6 km box centred on 580 20th Street." },
    ],
    images: run.result.images.map((i) => ({
      role: i.role,
      src: `/demo/yc-sf/${i.path}`,
      caption: i.caption,
      date: i.role === "before" || i.role === "after" ? imgDate(i.role) : after.datetime,
      source: S2_SOURCE,
    })),
    sources: [before, after].map((s) => ({
      name: `Sentinel-2 L2A scene (${Math.round(s.clear_fraction * 100)}% of the area clear)`,
      collection: s.collection,
      itemId: s.item_id,
      datetime: s.datetime,
      url: PC_ITEM(s.collection, s.item_id),
      license: "Copernicus Sentinel data, free and open",
    })),
    limitations: paid
      ? `${REPORT_LIMITATIONS} The 1 m imagery you chose is for reviewing finer detail; the measurements above come from the free 10 m Sentinel-2 pair.`
      : REPORT_LIMITATIONS,
    humanReview: false,
    paidDataEstimate: !paid && paidData
      ? { wouldShow: "1 m archive imagery would show individual buildings and roofs, and confirm what replaced the tanks and yards.", estCostUsd: paidData.data_cost_usd, providerId: paidData.provider_id }
      : null,
    verifierScore: 92,
    verifiedAt: new Date().toISOString(),
  };
}

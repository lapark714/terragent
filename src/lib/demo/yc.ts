/**
 * The live-demo scenario: "how has activity at the YC office changed over the past ten years?"
 *
 * EVERYTHING here is synthetic except two things: the two office locations (OpenStreetMap: 335 Pioneer Way,
 * Mountain View and 580 20th Street, Dogpatch SF) and the yearly Sentinel-2 cloudless mosaics the report shows
 * (EOX, CC BY 4.0). Prices, scene counts, measurements and every time series are made up for the stage.
 * Nothing under /demo touches the database, the agents, email or payments.
 */
import type { PublicQuote, PublicReport } from "@/lib/dashboard/public";
import type { RequestStatus } from "@/lib/domain";

export interface DemoSite {
  key: "sf" | "mv";
  name: string;
  short: string;
  detail: string;
  lat: number;
  lng: number;
}

export const SITES: Record<DemoSite["key"], DemoSite> = {
  sf: { key: "sf", name: "Y Combinator", short: "Dogpatch, SF", detail: "580 20th Street, San Francisco", lat: 37.76078, lng: -122.38664 },
  mv: { key: "mv", name: "Y Combinator", short: "Mountain View", detail: "335 Pioneer Way, Mountain View", lat: 37.38626, lng: -122.06688 },
};

export const DEMO_QUESTION = "How has activity around the YC office changed over the past ten years?";
export const DEMO_PERIOD = "Time period: compare 2016-01-01 with today.";

/** Years with a Sentinel-2 cloudless mosaic from EOX (2017 was never published). */
export const MOSAIC_YEARS = [2016, 2018, 2019, 2020, 2021, 2022, 2023, 2024] as const;
export const mosaicLayer = (year: number) => (year === 2016 ? "s2cloudless_3857" : `s2cloudless-${year}_3857`);

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
    log: [{ actor: "comms-customer", text: "Screening: a commercial building and its parking. Not tracking individuals. OK to proceed." }] },
  { at: 6, events: [{ type: "decision.logged", actor: "comms-customer" }],
    log: [{ actor: "comms-customer", text: "Geocoded 2 YC sites: 580 20th St (Dogpatch) and 335 Pioneer Way (Mountain View). Comparing both." }] },
  { at: 8, status: "planning", owner: "planner", events: [{ type: "handoff", actor: "comms-customer" }],
    log: [{ actor: "planner", text: "Proxy for 'activity': parking occupancy, night-time light, rooftop heat, radar change over the lots." }] },
  { at: 11, log: [{ actor: "planner", text: "AOI: two 600 m boxes. Window: Jan 2016 → Nov 2026, monthly. Control: 3 nearby office parks." }] },
  { at: 13.5, events: [{ type: "data_spec.saved", actor: "planner" }],
    log: [{ actor: "planner", text: "Data spec written: 5 modalities, 130 monthly epochs per site." }] },
  { at: 15, status: "acquiring", owner: "acquisition", events: [{ type: "handoff", actor: "planner" }],
    log: [{ actor: "acquisition", text: "Searching STAC catalogs: sentinel-2-l2a, sentinel-1-grd, landsat-c2-l2, viirs-dnb-monthly…" }] },
  { at: 18, log: [{ actor: "acquisition", text: "Sentinel-2: 1,184 scenes, 412 under 10% cloud over both boxes." }] },
  { at: 20, log: [{ actor: "acquisition", text: "Sentinel-1: 731 radar passes (cloud-proof). Landsat 8/9 thermal: 298 night & day scenes." }] },
  { at: 22, log: [{ actor: "acquisition", text: "Archive check: 64 sub-meter frames (30–50 cm) available. Enough to count cars directly." }] },
  { at: 23.5, events: [{ type: "acquisition_plan.saved", actor: "acquisition" }] },
  { at: 25, status: "pricing", owner: "pricing", events: [{ type: "handoff", actor: "acquisition" }],
    log: [{ actor: "pricing", text: "Pricing 3 options. Free data alone answers the trend; archive imagery makes the car counts exact." }] },
  { at: 29, status: "quoted", owner: null, events: [{ type: "quote.created", actor: "pricing" }, { type: "quote.sent", actor: "comms-customer" }],
    log: [{ actor: "pricing", text: "Quote ready. Waiting for the customer to choose." }] },
];

/** After the customer accepts: fetch, analyze, a verifier round-trip, deliver. */
export const POST_QUOTE: DemoStep[] = [
  { at: 0, status: "fetching", owner: "acquisition", events: [{ type: "quote.accepted", actor: "customer (link)" }],
    log: [{ actor: "acquisition", text: "Option accepted. Pulling 1,557 scenes into the sandbox (412 optical, 731 radar, 298 thermal, 116 night-light)." }] },
  { at: 3.5, log: [{ actor: "acquisition", text: "Archive frames ordered from the demo supplier sandbox. Co-registering to a common 0.5 m grid…" }] },
  { at: 6.5, status: "analyzing", owner: "analytics", events: [{ type: "handoff", actor: "acquisition" }],
    log: [{ actor: "analytics", text: "Cloud masks applied. Building monthly composites, 2016-01 → 2026-10." }] },
  { at: 9, log: [{ actor: "analytics", text: "Car detector on sub-meter frames: 9,318 vehicles counted across 64 frames (F1 0.94 on held-out lots)." }] },
  { at: 11.5, log: [{ actor: "analytics", text: "Calibrated a Sentinel-2 parking-surface index against the counts (r² = 0.87). Filling the monthly gaps." }] },
  { at: 14, log: [{ actor: "analytics", text: "VIIRS night radiance, Dogpatch box: 17.5 → 43.1 nW/cm²/sr. Mountain View box: 33.8 → 27.2." }] },
  { at: 16.5, log: [{ actor: "analytics", text: "Sentinel-1 coherence drop flags construction at 20th St, Q3 2021 – Q1 2023. Landsat rooftop heat +3.1 °C after 9 pm." }] },
  { at: 19, log: [{ actor: "analytics", text: "Periodicity test: occupancy peaks every ~3 months since 2025, every ~6 before. Matches the batch calendar." }] },
  { at: 21, events: [{ type: "analysis.saved", actor: "analytics" }] },
  { at: 22, owner: "interpreter", events: [{ type: "handoff", actor: "analytics" }],
    log: [{ actor: "interpreter", text: "Writing it up: the activity moved north, and it now pulses with the batches." }] },
  { at: 26, status: "verifying", owner: "verifier", events: [{ type: "report.drafted", actor: "interpreter" }, { type: "handoff", actor: "interpreter" }],
    log: [{ actor: "verifier", text: "Checking 14 claims against the measurements…" }] },
  { at: 29, status: "revising", owner: "interpreter", events: [{ type: "decision.logged", actor: "verifier" }],
    log: [{ actor: "verifier", text: "Sent back: 'busiest night of the decade' is unsupported. Night radiance is monthly, not nightly. Soften it." }] },
  { at: 32, log: [{ actor: "interpreter", text: "Revised: claim now says 'brightest month on record (Mar 2026)'. Added the cloud-gap caveat." }] },
  { at: 34, status: "verifying", owner: "verifier", events: [{ type: "report.saved", actor: "interpreter" }, { type: "handoff", actor: "interpreter" }],
    log: [{ actor: "verifier", text: "Re-checking… 14 of 14 claims supported. Score 93/100." }] },
  { at: 37, status: "delivering", owner: "comms-customer", events: [{ type: "report.verified", actor: "verifier" }],
    log: [{ actor: "comms-customer", text: "Publishing the report and emailing the link." }] },
  { at: 39.5, status: "delivered", owner: null, events: [{ type: "email.sent", actor: "comms-customer" }],
    log: [{ actor: "comms-customer", text: "Delivered." }] },
];

export function demoQuote(id: string, acceptedOptionId: "A" | "B" | "C" | null, acceptedAt: string | null, createdAt: string): PublicQuote {
  const validUntil = new Date(Date.parse(createdAt) + 7 * 86_400_000).toISOString();
  return {
    id: `quo_${id.slice(4)}`,
    status: acceptedOptionId ? "accepted" : "sent",
    recommended_option_id: "B",
    accepted_option_id: acceptedOptionId,
    accepted_at: acceptedAt,
    valid_until: validUntil,
    closed_reason: acceptedOptionId ? "accepted" : null,
    // Only its last path segment is read (as the accept token); the demo never posts it anywhere.
    accept_url: acceptedOptionId ? null : `/quote/demo_${id.slice(4)}_token`,
    options: [
      {
        option_id: "A", label: "Free data trend", kind: "free_data", recommended: false,
        answers: "The ten-year trend from free Sentinel-2, Sentinel-1, Landsat thermal and VIIRS night lights.",
        resolution_m: 10, data_types: ["optical", "radar", "thermal"], epochs: 130,
        price_usd: 49, price_range_usd: null, needs_supplier_quote: false, delivery_time: "about 10 minutes", confidence: "medium",
      },
      {
        option_id: "B", label: "Multimodal + archive car counts", kind: "mixed", recommended: true,
        answers: "Everything in A, plus 64 sub-meter archive frames to count cars directly and calibrate the trend.",
        resolution_m: 0.3, data_types: ["optical", "radar", "thermal"], epochs: 130,
        price_usd: 390, price_range_usd: null, needs_supplier_quote: false, delivery_time: "about 15 minutes", confidence: "high",
      },
      {
        option_id: "C", label: "Add fresh tasking", kind: "tasking", recommended: false,
        answers: "Everything in B, plus a new 30 cm capture of both sites this week.",
        resolution_m: 0.3, data_types: ["optical", "radar", "thermal"], epochs: 131,
        price_usd: null, price_range_usd: [1100, 1400], needs_supplier_quote: true, delivery_time: "3–5 days", confidence: "high",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export const REPORT_TITLE = "YC's activity moved north, and now pulses with the batches";
export const REPORT_ANSWER =
  "Activity at the Mountain View office fell by about two thirds from its 2018 peak, while the Dogpatch building went from a construction site to the busiest of the two by early 2024. Parking at 20th Street now peaks every three months, in step with the batch calendar, and night-time light there more than doubled.";
export const REPORT_LIMITATIONS =
  "Parking, light and rooftop heat are proxies for how busy a building is, not head counts, and say nothing about who is inside. Monthly composites smooth out single days. Clouds left gaps in 9 of 130 months, filled from radar.";

export const REPORT_MEASUREMENTS: PublicReport["measurements"] = [
  { metric: "peak_parking_occupancy_dogpatch", value: null, unit: "pct", before: 0, after: 93, note: "Share of marked stalls filled, busiest month (Mar 2026). Calibrated on 9,318 counted cars." },
  { metric: "parking_occupancy_mountain_view", value: null, unit: "pct", before: 78, after: 26, note: "2018 average vs. the last 12 months." },
  { metric: "night_radiance_dogpatch", value: null, unit: "nW/cm²/sr", before: 17.5, after: 43.1, note: "VIIRS day/night band, monthly median, 2016 vs. 2026." },
  { metric: "rooftop_heat_after_9pm", value: 3.1, unit: "°C", before: null, after: null, note: "Landsat 8/9 thermal, Dogpatch roof vs. 3 neighbouring roofs, 2024–26." },
  { metric: "peak_cycle_length", value: 3, unit: "months", before: 6, after: 3, note: "Dominant period in occupancy, 2016–23 vs. 2025–26." },
  { metric: "radar_change_flag", value: 18, unit: "months", before: null, after: null, note: "Sentinel-1 coherence loss at 20th St (construction), Q3 2021 – Q1 2023." },
];

const S2_URL = "https://s2maps.eu";
export const REPORT_SOURCES: PublicReport["sources"] = [
  { name: "Sentinel-2 cloudless mosaic 2016", collection: "eox-s2cloudless", itemId: "s2cloudless_3857", datetime: "2016-07-01T00:00:00Z", url: S2_URL, license: "CC BY 4.0, EOX" },
  { name: "Sentinel-2 cloudless mosaic 2024", collection: "eox-s2cloudless", itemId: "s2cloudless-2024_3857", datetime: "2024-07-01T00:00:00Z", url: S2_URL, license: "CC BY 4.0, EOX" },
  { name: "Sentinel-2 L2A, 412 scenes (demo)", collection: "sentinel-2-l2a", itemId: "S2B_MSIL2A_20261031T185519_N0511_R070_T10SEG", datetime: "2026-10-31T18:55:19Z", url: null, license: "Copernicus" },
  { name: "Sentinel-1 GRD, 731 passes (demo)", collection: "sentinel-1-grd", itemId: "S1A_IW_GRDH_1SDV_20261102T020412", datetime: "2026-11-02T02:04:12Z", url: null, license: "Copernicus" },
  { name: "Landsat 9 C2 L2 thermal, 298 scenes (demo)", collection: "landsat-c2-l2", itemId: "LC09_L2SP_044034_20261027_02_T1", datetime: "2026-10-27T18:41:03Z", url: null, license: "USGS public domain" },
  { name: "VIIRS DNB monthly composites, 2016–2026 (demo)", collection: "viirs-dnb-monthly", itemId: "VNL_v2_npp_202610_vcmslcfg", datetime: "2026-10-01T00:00:00Z", url: null, license: "EOG, CC BY 4.0" },
  { name: "Sub-meter archive frames, 64 (demo supplier sandbox)", collection: "archive-30cm", itemId: "demo-archive-2016-2026-x64", datetime: "2026-09-14T19:02:00Z", url: null, license: "Demo" },
];

// ---------------------------------------------------------------------------
// Synthetic monthly series, Jan 2016 → Oct 2026
// ---------------------------------------------------------------------------

export interface MonthPoint {
  /** "2016-01" */
  month: string;
  /** Fractional year for plotting. */
  t: number;
  mv: number;
  sf: number;
  /** Night radiance, nW/cm²/sr. */
  lightSf: number;
  lightMv: number;
  /** Rooftop heat anomaly after 9 pm, °C. */
  heatSf: number;
  /** Sentinel-1 coherence over the 20th St lot (0–1; drops during construction). */
  coherenceSf: number;
}

/** Deterministic jitter so the series look measured without changing between renders. */
function jitter(i: number, salt: number): number {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x) - 0.5;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const ramp = (t: number, from: number, to: number) => clamp01((t - from) / (to - from));

/** Demo Day bumps: twice a year (Mar, Aug) until 2024, then four times (Mar, Jun, Sep, Dec). */
function batchBump(year: number, m: number): number {
  const months = year < 2025 ? [2, 7] : [2, 5, 8, 11];
  let b = 0;
  for (const p of months) {
    const d = Math.min(Math.abs(m - p), 12 - Math.abs(m - p));
    b = Math.max(b, d === 0 ? 1 : d === 1 ? 0.35 : 0);
  }
  return b;
}

export function demoSeries(): MonthPoint[] {
  const out: MonthPoint[] = [];
  for (let i = 0; i < 130; i++) {
    const year = 2016 + Math.floor(i / 12);
    const m = i % 12;
    const t = year + m / 12;
    const covid = t >= 2020.2 && t < 2022.0 ? 1 - ramp(t, 2021.4, 2022.0) : 0;
    const bump = batchBump(year, m);

    const mvBase = 0.62 + 0.14 * ramp(t, 2016, 2018.5) - 0.48 * covid - 0.5 * ramp(t, 2023.3, 2024.4) * (1 - covid);
    const mv = clamp01(mvBase + bump * 0.14 * (1 - ramp(t, 2023.5, 2024.5)) + jitter(i, 1) * 0.06);

    const open = ramp(t, 2023.1, 2024.1);
    const sf = clamp01(open * (0.52 + 0.18 * ramp(t, 2024.1, 2026)) + open * bump * 0.22 + (open > 0 ? jitter(i, 2) * 0.05 : 0) + (1 - open) * 0.03 * (0.5 + jitter(i, 7)));

    const lightSf = 17.9 + 6 * ramp(t, 2021.5, 2023) + 17.7 * open + bump * open * 3 + jitter(i, 3) * 1.6;
    const lightMv = 34.2 + 2.5 * ramp(t, 2016, 2018.5) - 5 * covid - 10 * ramp(t, 2023.3, 2024.4) + jitter(i, 4) * 1.4;
    const heatSf = open * (2.2 + bump * 1.6) + jitter(i, 5) * 0.4;
    const construction = t >= 2021.5 && t < 2023.25 ? 1 : 0;
    const coherenceSf = clamp01(0.78 - construction * 0.5 + jitter(i, 6) * 0.08);

    out.push({ month: `${year}-${String(m + 1).padStart(2, "0")}`, t, mv, sf, lightSf, lightMv, heatSf, coherenceSf });
  }
  return out;
}

/** Sensors shown as cards on the report: what each one is, how much of it, and the one-line finding. */
export const SENSORS: { name: string; what: string; res: string; scenes: string; finding: string; key: keyof Pick<MonthPoint, "sf" | "lightSf" | "heatSf" | "coherenceSf" | "mv"> }[] = [
  { name: "Sub-meter optical", what: "Cars, counted one by one", res: "30–50 cm", scenes: "64 frames", finding: "9,318 vehicles counted; anchors every other signal.", key: "sf" },
  { name: "Sentinel-2", what: "Parking-surface index", res: "10 m", scenes: "412 scenes", finding: "Dogpatch lot fills from 2024; Mountain View empties.", key: "mv" },
  { name: "VIIRS night lights", what: "After-dark radiance", res: "500 m", scenes: "130 months", finding: "Dogpatch more than doubled: 17.5 → 43.1.", key: "lightSf" },
  { name: "Landsat thermal", what: "Rooftop heat after 9 pm", res: "100 m", scenes: "298 scenes", finding: "+3.1 °C over neighbours, peaking near Demo Days.", key: "heatSf" },
  { name: "Sentinel-1 radar", what: "Ground-change coherence", res: "10 m", scenes: "731 passes", finding: "Construction at 20th St, Q3 2021 – Q1 2023.", key: "coherenceSf" },
];

/**
 * Builds the /demo YC scenario from a REAL pipeline run, so the demo shows what the system actually produces.
 *
 *   1. Run the real analysis (once, needs network; Planetary Computer is keyless):
 *        bash pipeline/bootstrap.sh
 *        pipeline/.venv/bin/python -m terragent_pipeline.run --job <job.json> --out <dir> --deadline-s 300
 *      with job.json = the JOB constant below.
 *   2. npx tsx scripts/demo-build-yc.ts <dir>
 *      Copies the PNGs to public/demo/yc-sf/ and writes src/lib/demo/yc-run.json: the AnalysisResult (minus the
 *      H3 rows), the data spec and acquisition plan, and the quote options priced by the real pricing engine against
 *      the real provider registry.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROVIDERS } from "../db/seeds/providers";
import { AcquisitionPlan, DataSpec } from "../src/lib/domain";
import { buildQuoteOptions, type PricedProvider } from "../src/lib/pipeline/pricing-engine";
import { publicQuote } from "../src/lib/dashboard/public";

export const JOB = {
  request_id: "req_demoycsf",
  recipe: "change_detection",
  bbox: [-122.3956, 37.7538, -122.3776, 37.7678],
  after_window: { start: "2026-06-01", end: "2026-10-31" },
  before_window: { start: "2016-06-01", end: "2016-10-31" },
  max_cloud_pct: 10,
  h3_res: 10,
  collection: "sentinel-2-l2a",
} as const;

const dir = process.argv[2];
if (!dir) {
  console.error("usage: npx tsx scripts/demo-build-yc.ts <pipeline output dir>");
  process.exit(2);
}

const result = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
const [lo0, la0, lo1, la1] = JOB.bbox;
const midLat = ((la0 + la1) / 2) * (Math.PI / 180);
const areaKm2 = Number(((lo1 - lo0) * 111.32 * Math.cos(midLat) * (la1 - la0) * 110.57).toFixed(2));
const scene = (s: { collection: string; item_id: string; datetime: string; cloud_pct: number | null }) => ({
  collection: s.collection, item_id: s.item_id, datetime: s.datetime, cloud_pct: s.cloud_pct,
});

const spec = DataSpec.parse({
  request_id: JOB.request_id,
  playbook: "inbound",
  location: { text: "Y Combinator, 580 20th Street, San Francisco", lat: 37.76078, lon: -122.38664, geocoder: "user" },
  aoi: { type: "Polygon", coordinates: [[[lo0, la0], [lo1, la0], [lo1, la1], [lo0, la1], [lo0, la0]]] },
  area_km2: areaKm2,
  h3_res: JOB.h3_res,
  recipe: JOB.recipe,
  data_type: "optical",
  min_resolution_m: 10,
  max_cloud_pct: JOB.max_cloud_pct,
  before: JOB.before_window,
  after: JOB.after_window,
  earth_index_hits: [],
  reuse_existing: false,
  assumptions: [
    "\"Changed\" means visible change on the ground: buildings, cleared lots, vegetation. Not people or foot traffic.",
    "Late-summer windows in both years, for the same sun angle and fewer fog days.",
    "A 1.6 km box around the office, taking in the Dogpatch blocks and the Pier 70 waterfront.",
  ],
});

const plan = AcquisitionPlan.parse({
  request_id: JOB.request_id,
  choice: "free",
  free_option: {
    provider_id: "pc-sentinel-2-l2a",
    before_scene: scene(result.before),
    after_scene: scene(result.after),
    sufficient: true,
    why: "Two near-cloudless Sentinel-2 scenes ten years apart. 10 m shows block-scale change; individual buildings need sharper imagery.",
  },
  paid_options: [],
  justification: "Free Sentinel-2 answers block-scale change; a sharper archive option is offered for building-level detail.",
  data_cost_usd: 0,
  quote_requests_sent: [],
});

// The provider registry as seedProviders writes it to the database (seed field names → column names).
const registry: PricedProvider[] = PROVIDERS.map((p) => ({
  id: p.id, name: p.name, data_type: p.data_type, resolution_m: p.resolution_m, is_free: p.is_free, pricing_model: p.pricing_model,
  currency: p.currency, archive_usd_per_km2: p.archive_per_km2, tasking_usd_per_km2: p.tasking_per_km2, min_order_km2: p.min_order_km2,
  delivery_time: p.delivery_time, notes: p.notes, active: true,
}));
const quote = buildQuoteOptions(plan, spec, registry, { today: new Date("2026-11-08T12:00:00Z") });

// What the status page would show for it: the real public mapping (labels, resolution, price, delivery time).
const shown = publicQuote(
  { id: "quo_demo", status: "sent", options: quote.options, recommended_option_id: quote.recommended_option_id, accept_token: "demo_token_not_real" },
  { currentQuoteId: "quo_demo", requestStatus: "quoted" },
);

const pub = join("public", "demo", "yc-sf");
mkdirSync(pub, { recursive: true });
for (const img of result.images as { path: string }[]) copyFileSync(join(dir, img.path), join(pub, img.path));

const { h3_metrics, ...rest } = result;
writeFileSync(
  join("src", "lib", "demo", "yc-run.json"),
  JSON.stringify({ generated_from: "real pipeline run (scripts/demo-build-yc.ts)", job: JOB, result: { ...rest, h3_cells: h3_metrics.length }, spec, plan, quote, public_quote_options: shown?.options ?? [] }, null, 2) + "\n",
);
console.log(`area ${areaKm2} km², ${result.images.length} images, ${h3_metrics.length} H3 cells`);
for (const o of quote.options) console.log(o.option_id, o.label, o.price_usd ?? o.price_range_usd, o.confidence, o.option_id === quote.recommended_option_id ? "(recommended)" : "");
console.log(quote.notes);

/**
 * Local UI mode: fills the PGlite demo database (.pglite-demo/) with realistic demo data so every dashboard
 * panel and public page looks alive without Naïve, AgentMail, Monid or Neon.
 *
 *   npm run seed:demo                 # seed (adds a fresh demo set; run with --reset for a clean one)
 *   npm run seed:demo -- --reset      # wipe .pglite-demo/ first, then seed
 *   npm run dev:local                 # seeds with --if-empty, then starts next dev on the demo database
 *
 * Refuses to run unless TERRAGENT_DB=local, and checks the database it opened is PGlite: it can never write to
 * Neon. Loads no .env file and makes no network calls. Every demo row is marked (meta.demo = true, or the
 * table's own jsonb column). Image URLs are Planetary Computer data-API renders of real Sentinel-2 scenes
 * (Copernicus open data), looked up once by hand: they load in the browser, the seed never fetches them.
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gridDisk, latLngToCell } from "h3-js";
import { seedProviders } from "../db/seeds/providers";
import { createDb, type Db } from "../src/lib/db/client";
import { migrate } from "../src/lib/db/migrate";
import {
  type AgentName, type BBox, type DecisionKind, optionPriceLow, type Playbook, type QuoteOption, type QuoteOptionId, type RequestSource,
  type RequestStatus,
} from "../src/lib/domain";
import { seedTemplates } from "../src/lib/email/template-library";
import { bboxAround } from "../src/lib/geo/h3";
import { newId, newToken } from "../src/lib/ids";
import { SETTING } from "../src/lib/settings";

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export class NotLocalError extends Error {}

/** The demo seed only ever writes to the local demo PGlite database. */
type Env = Record<string, string | undefined>;

export function assertDemoTarget(env: Env = process.env, db?: Pick<Db, "kind">) {
  if (env.TERRAGENT_DB !== "local") {
    throw new NotLocalError("seed-demo writes demo data and only runs with TERRAGENT_DB=local (the .pglite-demo database). Use npm run seed:demo.");
  }
  if (db && db.kind !== "pglite") throw new NotLocalError(`seed-demo opened a ${db.kind} database; it only writes to local PGlite.`);
}

/** The demo data dir, and only if it is safe to wipe: inside this repo and named .pglite-demo*. */
export function demoDataDir(env: Env = process.env, cwd = process.cwd()): string {
  const dir = path.resolve(cwd, env.PGLITE_DATA_DIR ?? ".pglite-demo");
  const rel = path.relative(cwd, dir);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || !path.basename(dir).startsWith(".pglite-demo")) {
    throw new NotLocalError(`Refusing to touch ${dir}: the demo database must be a .pglite-demo* folder inside the repo.`);
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Imagery: real Sentinel-2 L2A scenes on Planetary Computer (STAC search 2026-11-07, < 2 % cloud over each box)
// ---------------------------------------------------------------------------

const PC_DATA = "https://planetarycomputer.microsoft.com/api/data/v1";
const PC_STAC = "https://planetarycomputer.microsoft.com/api/stac/v1/collections/sentinel-2-l2a/items";
const LICENSE = "Copernicus Sentinel data, free and open (contains modified Copernicus Sentinel data 2026)";

interface Scene { item: string; date: string }
interface Site { lat: number; lon: number; before: Scene; after: Scene }

const scene = (item: string): Scene => ({ item, date: `${item.slice(11, 15)}-${item.slice(15, 17)}-${item.slice(17, 19)}` });

export const SITES = {
  houston: { lat: 29.745, lon: -95.3, before: scene("S2B_MSIL2A_20260721T164839_R026_T15RTP_20260721T220803"), after: scene("S2C_MSIL2A_20261017T170311_R069_T15RTN_20261017T202312") },
  butte: { lat: 39.76, lon: -121.62, before: scene("S2C_MSIL2A_20260622T184921_R113_T10TFK_20260622T235211"), after: scene("S2C_MSIL2A_20260930T185201_R113_T10TFK_20260930T221307") },
  rondonia: { lat: -9.9, lon: -63.0, before: scene("S2C_MSIL2A_20260708T142711_R053_T20LMQ_20260708T193409"), after: scene("S2C_MSIL2A_20260827T142711_R053_T20LMQ_20260827T192955") },
  novoprogresso: { lat: -7.13, lon: -55.38, before: scene("S2B_MSIL2A_20260704T135659_R067_T21MXN_20260704T173427"), after: scene("S2C_MSIL2A_20261007T135701_R067_T21MXN_20261007T171603") },
  silverpeak: { lat: 37.75, lon: -117.63, before: scene("S2C_MSIL2A_20260629T183921_R070_T11SMB_20260629T233012"), after: scene("S2C_MSIL2A_20261106T184551_R070_T11SMB_20261106T215858") },
  bingham: { lat: 40.52, lon: -112.15, before: scene("S2C_MSIL2A_20260710T180911_R084_T12TUK_20260710T231209"), after: scene("S2C_MSIL2A_20261001T182151_R127_T12TVK_20261001T213510") },
  sonoma: { lat: 38.255, lon: -122.4, before: scene("S2B_MSIL2A_20260518T184919_R113_T10SEH_20260518T224058"), after: scene("S2C_MSIL2A_20260930T185201_R113_T10SEH_20260930T221307") },
  lakemead: { lat: 36.14, lon: -114.62, before: scene("S2C_MSIL2A_20260524T181921_R127_T11SQA_20260524T231208"), after: scene("S2C_MSIL2A_20261001T182151_R127_T11SQA_20261001T213510") },
  kelowna: { lat: 49.88, lon: -119.49, before: scene("S2C_MSIL2A_20260503T184921_R113_T11ULR_20260503T223413"), after: scene("S2C_MSIL2A_20261020T185421_R113_T11ULR_20261020T215208") },
  atacama: { lat: -23.5, lon: -68.25, before: scene("S2C_MSIL2A_20260611T143741_R096_T19KEQ_20260611T194338"), after: scene("S2C_MSIL2A_20260919T143741_R096_T19KEQ_20260919T174907") },
  chaco: { lat: -21.5, lon: -60.5, before: scene("S2A_MSIL2A_20260505T141101_R110_T20KQB_20260505T230317"), after: scene("S2C_MSIL2A_20260920T140711_R110_T20KQB_20260920T190758") },
} satisfies Record<string, Site>;
type SiteKey = keyof typeof SITES;

/** A 2.4 km square around the site, the same size the planner uses for a point question. */
export const siteBox = (s: Site): BBox => bboxAround(s.lat, s.lon, 2.4);

/** Server-rendered PNG of one scene over the box: true colour, or an NDVI map (PB ≥ 04.00 offset, docs/platform/imagery.md §3.8). */
export function pcImageUrl(item: string, bbox: BBox, kind: "visual" | "ndvi" = "visual"): string {
  const q = new URLSearchParams({ collection: "sentinel-2-l2a", item });
  if (kind === "visual") {
    q.set("assets", "visual");
    q.set("asset_bidx", "visual|1,2,3");
    q.set("nodata", "0");
  } else {
    q.set("expression", "(B08-B04)/(B08+B04-2000)");
    q.set("asset_as_band", "true");
    q.set("rescale", "-0.2,0.8");
    q.set("colormap_name", "rdylgn");
  }
  return `${PC_DATA}/item/bbox/${bbox.map((v) => v.toFixed(4)).join(",")}/512x512.png?${q}`;
}

// ---------------------------------------------------------------------------
// Demo content
// ---------------------------------------------------------------------------

const DEMO = { demo: true } as const;
type At = (minutesAgo: number) => string;

/**
 * "What it costs today" rows for the market panel. Not real quotes: the figures are placeholders and every row
 * says so in its source title, so a demo screenshot can never pass them off as cited prices. In production the
 * market researcher writes real, linked rows (save_market_prices).
 */
type MarketSeed = [Playbook, string, number | null, number | null, string, string | null];
const MARKET: MarketSeed[] = [
  ["disasters", "Drone roof inspection after a storm", 250, 600, "per site", "2–5 days"],
  ["disasters", "Insurance adjuster site visit", 300, 900, "per site", "1–2 weeks"],
  ["deforestation", "On-site EUDR due-diligence audit", 2000, 8000, "per supplier", "4–8 weeks"],
  ["deforestation", "Commercial forest-monitoring subscription", 500, 1500, "per month", null],
  ["mining", "Environmental site survey", 3000, 10000, "per site", "2–6 weeks"],
  ["mining", "Drone stockpile survey", 800, 2500, "per survey", "about 1 week"],
];

/** [key, playbook, feed, title, severity, lat, lon, minutes ago, status, status reason] */
type SignalSeed = [string, Playbook, string, string, string | null, number, number, number, "new" | "matched" | "ignored", string?];
const SIGNALS: SignalSeed[] = [
  ["hou", "disasters", "nws", "Flash Flood Warning for Harris County, TX", "Severe", 29.76, -95.37, 1330, "matched"],
  ["guad", "disasters", "nwps_flood", "Guadalupe River at Victoria, TX: moderate flood stage forecast", "Moderate", 28.8, -97.0, 1185, "matched"],
  ["vent", "disasters", "nws", "Red Flag Warning for the Ventura County mountains", "Severe", 34.5, -119.1, 1090, "ignored", "Fire weather only; nothing burning yet"],
  ["chas", "disasters", "nws", "Coastal Flood Advisory for Charleston County, SC", "Minor", 32.78, -79.93, 980, "new"],
  ["ridge", "disasters", "usgs_quake", "M5.4, 18 km SW of Ridgecrest, CA", "M5.4", 35.53, -117.82, 905, "matched"],
  ["ponce", "disasters", "usgs_quake", "M4.7, 9 km NE of Ponce, Puerto Rico", "M4.7", 18.07, -66.55, 760, "ignored", "Below M5 and no damage reports"],
  ["hual", "disasters", "usgs_quake", "M6.1, 42 km S of Hualien City, Taiwan", "M6.1", 23.6, 121.55, 645, "matched"],
  ["norcia", "disasters", "usgs_quake", "M5.0, 7 km N of Norcia, Italy", "M5.0", 42.85, 13.09, 520, "new"],
  ["baton", "disasters", "nwps_flood", "Mississippi River at Baton Rouge above flood stage", "Minor", 30.45, -91.19, 470, "matched"],
  ["colusa", "disasters", "nwps_flood", "Sacramento River at Colusa: minor flooding", "Minor", 39.21, -122.01, 400, "new"],
  ["butte", "disasters", "firms", "VIIRS fire cluster, 48 detections, Butte County, CA", "high", 39.76, -121.62, 355, "matched"],
  ["kel", "disasters", "firms", "VIIRS fire cluster, 31 detections, hills north-east of Kelowna, BC", "high", 49.96, -119.33, 300, "matched"],
  ["nsw", "disasters", "firms", "VIIRS fire cluster in the Blue Mountains hinterland, NSW", "nominal", -33.6, 150.3, 222, "new"],
  ["fema", "disasters", "openfema", "Major disaster declaration DR-4874-FL (hurricane): Hillsborough and Pinellas", "Major", 27.95, -82.46, 162, "matched"],
  ["tulsa", "disasters", "nws", "Severe Thunderstorm Warning for Tulsa County, OK", "Severe", 36.15, -95.99, 75, "new"],
  ["valencia", "disasters", "news", "Flash floods close roads south of Valencia, Spain", null, 39.3, -0.42, 26, "new"],
  ["rond", "deforestation", "gfw", "Integrated alerts: 1,146 pixels (13.9 ha) since Oct 1, Rondônia, Brazil", "high", -9.9, -63.0, 1255, "matched"],
  ["novo", "deforestation", "gfw", "GLAD-S2 alert cluster near Novo Progresso, Pará", "high", -7.13, -55.38, 1120, "matched"],
  ["riau", "deforestation", "gfw", "RADD alert cluster, Riau, Sumatra", "nominal", 0.5, 101.45, 1002, "new"],
  ["ucay", "deforestation", "gfw", "Integrated alerts, Ucayali, Peru (42 ha)", "high", -8.38, -74.55, 870, "matched"],
  ["sinop", "deforestation", "gfw", "GLAD-L alerts near Sinop, Mato Grosso", "nominal", -11.86, -55.5, 752, "ignored", "Inside a licensed clearing permit"],
  ["sangha", "deforestation", "gfw", "RADD alerts, Sangha, Republic of the Congo", "nominal", 1.6, 16.05, 690, "new"],
  ["kalim", "deforestation", "gfw", "Integrated alerts on a peatland edge, Central Kalimantan", "high", -2.2, 113.9, 612, "matched"],
  ["peten", "deforestation", "gfw", "GLAD alerts in the Maya Biosphere buffer, Petén, Guatemala", "high", 17.2, -90.1, 480, "new"],
  ["chaco", "deforestation", "gfw", "Integrated alerts, Boquerón, Paraguayan Chaco (95 ha)", "high", -21.5, -60.5, 382, "matched"],
  ["sabah", "deforestation", "gfw", "RADD alerts, Sabah, Malaysia", "nominal", 5.4, 117.2, 262, "new"],
  ["soubre", "deforestation", "gfw", "Integrated alerts near Soubré, Côte d'Ivoire cocoa belt", "nominal", 5.79, -6.59, 191, "matched"],
  ["ghana", "deforestation", "gfw", "Integrated alerts, Western North Region, Ghana", "nominal", 6.2, -2.5, 112, "new"],
  ["mdd", "deforestation", "news", "New logging roads reported in the Madre de Dios buffer zone, Peru", null, -12.5, -69.8, 41, "new"],
  ["silver", "mining", "blm_claims", "12 new lode claims filed, Esmeralda County, NV (lithium clays)", null, 37.75, -117.63, 1205, "matched"],
  ["elko", "mining", "blm_claims", "8 new placer claims, Elko County, NV", null, 40.83, -115.76, 1050, "new"],
  ["thacker", "mining", "blm_claims", "Lode claims filed near Thacker Pass, Humboldt County, NV", null, 41.7, -118.05, 930, "matched"],
  ["pima", "mining", "blm_claims", "New lode claims in the Pima County copper belt, AZ", null, 31.9, -111.0, 822, "new"],
  ["sanjuan", "mining", "blm_claims", "Uranium claims filed, San Juan County, UT", null, 37.6, -109.5, 700, "ignored", "Claims only; no ground disturbance yet"],
  ["bingham", "mining", "mrds", "MRDS site Bingham Canyon (Cu-Mo): tailings footprint review", null, 40.52, -112.15, 582, "matched"],
  ["ray", "mining", "mrds", "MRDS site Ray (Cu), Pinal County, AZ", null, 33.16, -110.98, 452, "new"],
  ["minas", "mining", "news", "Tailings dam inspections ordered in Minas Gerais, Brazil", null, -20.12, -44.2, 330, "matched"],
  ["kamoa", "mining", "news", "Concentrator expansion announced in Lualaba, DR Congo", null, -10.77, 25.33, 242, "new"],
  ["atac", "mining", "news", "Lithium brine ponds expand on the Salar de Atacama, Chile", null, -23.5, -68.25, 131, "matched"],
  ["pilbara", "mining", "news", "New haul road reported east of Newman, Pilbara, Australia", null, -23.36, 119.9, 56, "new"],
];

interface ProspectSeed {
  key: string; signal: string; playbook: Exclude<Playbook, "inbound">; company: string; domain: string; contact?: string; role?: string;
  asset: string; status: string; channel: "contact_form" | "email_warm" | "email_direct"; score: number; created: number;
  touch?: { at: number; status: "sent" | "blocked"; reason?: string; version?: string };
  reply?: { at: number; text: string };
}
const PROSPECTS: ProspectSeed[] = [
  { key: "foothill", signal: "butte", playbook: "disasters", company: "Foothill Orchard Co-op", domain: "foothillorchard.example", asset: "Packing shed and 120 ha of orchards", status: "quoted", channel: "contact_form", score: 0.82, created: 340, touch: { at: 300, status: "sent", version: "disasters/v1" }, reply: { at: 180, text: "Thanks, this is useful. What would monthly checks of all three blocks cost?" } },
  { key: "bayou", signal: "hou", playbook: "disasters", company: "Bayou City Self Storage", domain: "bayoucitystorage.example", asset: "Storage yard on the ship channel", status: "emailed", channel: "contact_form", score: 0.71, created: 1300, touch: { at: 900, status: "sent", version: "disasters/v1" } },
  { key: "victoria", signal: "guad", playbook: "disasters", company: "Victoria Grain Terminal", domain: "victoriagrain.example", asset: "Grain elevators by the river", status: "sample_requested", channel: "contact_form", score: 0.66, created: 1150 },
  { key: "okanagan", signal: "kel", playbook: "disasters", company: "Okanagan Lakeshore Hotel", domain: "okanaganlakeshore.example", contact: "Hannah Brooks", role: "Operations manager", asset: "Lakeshore hotel grounds", status: "replied", channel: "email_warm", score: 0.77, created: 290, touch: { at: 240, status: "sent", version: "disasters/v1" }, reply: { at: 95, text: "Could you check our second property up the hill too? Happy to pay for that." } },
  { key: "mojave", signal: "ridge", playbook: "disasters", company: "Mojave Solar Partners", domain: "mojavesolar.example", contact: "Ray Ortiz", role: "Asset manager", asset: "Solar array access roads", status: "sample_ready", channel: "email_warm", score: 0.69, created: 880, touch: { at: 420, status: "blocked", reason: "provider_limit:rate_limit_exceeded" } },
  { key: "tampa", signal: "fema", playbook: "disasters", company: "Tampa Bay Marine Storage", domain: "tampabaymarine.example", asset: "Dry-stack boat storage", status: "sample_requested", channel: "contact_form", score: 0.74, created: 150 },
  { key: "riverroad", signal: "baton", playbook: "disasters", company: "River Road Terminals", domain: "riverroadterminals.example", asset: "Barge terminal and tank farm", status: "sample_requested", channel: "contact_form", score: 0.63, created: 12 },
  { key: "jamari", signal: "rond", playbook: "deforestation", company: "Rio Jamari Cattle Co.", domain: "riojamari.example", asset: "Pasture boundary next to the alert cluster", status: "replied", channel: "contact_form", score: 0.72, created: 1240, touch: { at: 960, status: "sent", version: "deforestation/v1" }, reply: { at: 720, text: "We need this for our buyer's EUDR file. We would pay around $150 for a full parcel report." } },
  { key: "tapajos", signal: "novo", playbook: "deforestation", company: "Tapajós Soy Traders", domain: "tapajossoy.example", asset: "Supplier farm on the BR-163", status: "emailed", channel: "contact_form", score: 0.68, created: 1100, touch: { at: 600, status: "sent", version: "deforestation/v1" } },
  { key: "pucallpa", signal: "ucay", playbook: "deforestation", company: "Pucallpa Timber Exports", domain: "pucallpatimber.example", asset: "Concession boundary", status: "sample_requested", channel: "contact_form", score: 0.64, created: 850 },
  { key: "kahayan", signal: "kalim", playbook: "deforestation", company: "Kahayan Palm Holdings", domain: "kahayanpalm.example", contact: "Dewi Santoso", role: "Sustainability lead", asset: "Plantation edge on peat", status: "sample_ready", channel: "email_warm", score: 0.7, created: 600, touch: { at: 230, status: "blocked", reason: "provider_rejected:recipient_limit_exceeded" } },
  { key: "soubre", signal: "soubre", playbook: "deforestation", company: "Nawa Cocoa Cooperative", domain: "nawacocoa.example", asset: "Member farms west of Soubré", status: "matched", channel: "email_direct", score: 0.61, created: 185, touch: { at: 150, status: "blocked", reason: "direct_email_not_approved" } },
  { key: "esmeralda", signal: "silver", playbook: "mining", company: "Esmeralda Lithium Exploration", domain: "esmeraldalithium.example", contact: "Grace Kim", role: "Exploration manager", asset: "Claim block east of Silver Peak", status: "paid", channel: "contact_form", score: 0.79, created: 1190, touch: { at: 840, status: "sent", version: "mining/v1" }, reply: { at: 660, text: "Interesting. Send the full report for the whole claim block, we'll pay the $45." } },
  { key: "humboldt", signal: "thacker", playbook: "mining", company: "Humboldt Basin Minerals", domain: "humboldtbasin.example", asset: "Access road and drill pads", status: "sample_requested", channel: "contact_form", score: 0.67, created: 910 },
  { key: "copperline", signal: "bingham", playbook: "mining", company: "Copperline Haulage", domain: "copperline.example", contact: "Ops desk", role: "Operations", asset: "Haul yard below the pit", status: "opted_out", channel: "contact_form", score: 0.52, created: 800, touch: { at: 760, status: "sent", version: "mining/v1" }, reply: { at: 700, text: "Please don't contact us again." } },
  { key: "salar", signal: "atac", playbook: "mining", company: "Altiplano Brine Services", domain: "altiplanobrine.example", asset: "Pond service yard", status: "matched", channel: "contact_form", score: 0.58, created: 120 },
  { key: "minas", signal: "minas", playbook: "mining", company: "Serra Verde Tailings Services", domain: "serraverdetailings.example", asset: "Tailings facility", status: "disqualified", channel: "contact_form", score: 0.31, created: 320 },
];

interface ReportSeed {
  site: SiteKey; title: string; answer: string; confidence: "high" | "medium" | "low"; recipe: string; layer: "disasters" | "forest" | "mining" | "inbound";
  measurements: { metric: string; value: number; unit: string; before: number | null; after: number | null; note?: string }[];
  limitations: string; verifier: "pass" | "pending" | "fail"; score: number | null; humanReview?: boolean; index?: boolean;
  paidEstimate?: { would_show: string; est_cost_usd: number; provider_id: string };
}

/**
 * A pricing v2 quote (migration 080): 1–3 options, nothing runs until the customer accepts one. The legacy money
 * columns mirror the accepted option, else the recommended one (the low end of a range), as create_quote does.
 */
interface QuoteV2Seed { options: QuoteOption[]; recommended: QuoteOptionId; accepted?: QuoteOptionId }

interface RequestSeed {
  key: string; source: RequestSource; playbook: Playbook; status: RequestStatus; owner: AgentName | null; question: string;
  location: string | null; lat: number | null; lon: number | null; created: number; updated: number;
  customer?: { name: string | null; email: string; company?: string }; prospect?: string; price?: number; refusal?: string;
  path: RequestStatus[]; report?: ReportSeed; quote?: { price: number; status: string; data?: number; analysis?: number; v2?: QuoteV2Seed };
}

type QuoteData = QuoteOption["data"][number];
const freeData = (provider_id: string, product: string, data_type: QuoteData["data_type"], epochs: number, area_km2: number): QuoteData => ({
  provider_id, product, data_type, resolution_m: 10, epochs, area_km2, billable_km2: area_km2, unit_price_usd: 0, data_cost_usd: 0,
  data_cost_range_usd: null, needs_supplier_quote: false,
});

/** Ivory Cocoa's three plots: free 10 m check, a 50 cm archive image, or a new capture whose supplier price isn't confirmed. */
export const COCOA_OPTIONS: QuoteOption[] = [
  {
    option_id: "A", label: "Free satellite check", kind: "free_data",
    answers: "Shows any clearing larger than about half a hectare on the three plots since January 2024, from free 10 m Sentinel-2 imagery and Global Forest Watch alerts.",
    data: [freeData("pc-sentinel-2-l2a", "Sentinel-2 L2A scenes", "optical", 2, 6), freeData("gfw-integrated-alerts", "GFW integrated alerts", "alerts", 1, 6)],
    analysis_cost_usd: 1.5, risk_buffer_usd: 1.5, margin_usd: 26, price_usd: 29, price_range_usd: null,
    delivery_time: "About an hour after you accept", confidence: "medium", notes: [],
  },
  {
    option_id: "B", label: "Sharp archive image", kind: "archive",
    answers: "Shows individual felled trees, new paths and burn patches on each plot from a 50 cm image taken in October, compared with free Sentinel-2 from 2024.",
    data: [
      freeData("pc-sentinel-2-l2a", "Sentinel-2 L2A scenes", "optical", 2, 6),
      { provider_id: "sw-skysat-50cm", product: "archive 0.5 m, 2026-10-24 pass", data_type: "optical", resolution_m: 0.5, epochs: 1, area_km2: 6, billable_km2: 8,
        unit_price_usd: 6, data_cost_usd: 48, data_cost_range_usd: null, needs_supplier_quote: false },
    ],
    analysis_cost_usd: 4, risk_buffer_usd: 8, margin_usd: 25, price_usd: 85, price_range_usd: null,
    delivery_time: "1–2 days after you accept", confidence: "high", notes: ["demo: placeholder unit price"],
  },
  {
    option_id: "C", label: "New capture of all three plots", kind: "tasking",
    answers: "Orders a fresh 30 cm capture of the plots for an up-to-date, plot-by-plot record for your EUDR due-diligence file.",
    data: [{ provider_id: "sw-pneo-30cm", product: "tasking 0.3 m", data_type: "optical", resolution_m: 0.3, epochs: 1, area_km2: 6, billable_km2: 25,
      unit_price_usd: null, data_cost_usd: null, data_cost_range_usd: [380, 600], needs_supplier_quote: true }],
    analysis_cost_usd: 6, risk_buffer_usd: 14, margin_usd: 50, price_usd: null, price_range_usd: [450, 700],
    delivery_time: "5–10 days after you accept, weather permitting", confidence: "high", notes: ["demo: supplier price not confirmed"],
  },
];

/** Pacific Re's quake zone: they accepted the 30 cm archive pass, which a founder now buys by hand (the held order below). */
export const HUALIEN_OPTIONS: QuoteOption[] = [
  {
    option_id: "A", label: "Free radar and optical overview", kind: "free_data",
    answers: "Shows which parts of the industrial zone changed after the quake, from free 10 m Sentinel-1 radar and Sentinel-2. It can't count individual roofs.",
    data: [freeData("pc-sentinel-2-l2a", "Sentinel-2 L2A scenes", "optical", 2, 5), freeData("pc-sentinel-1-rtc", "Sentinel-1 RTC radar", "radar", 2, 5)],
    analysis_cost_usd: 2, risk_buffer_usd: 1.5, margin_usd: 25.5, price_usd: 29, price_range_usd: null,
    delivery_time: "About an hour after you accept", confidence: "low", notes: [],
  },
  {
    option_id: "B", label: "Sharp archive image", kind: "archive",
    answers: "Counts damaged roofs across the 5 km² zone from a 30 cm Pléiades Neo image taken two days after the quake.",
    data: [{ provider_id: "sw-pneo-30cm", product: "archive 0.3 m, 2026-11-05 pass", data_type: "optical", resolution_m: 0.3, epochs: 1, area_km2: 5, billable_km2: 5,
      unit_price_usd: 42, data_cost_usd: 210, data_cost_range_usd: null, needs_supplier_quote: false }],
    analysis_cost_usd: 9, risk_buffer_usd: 21, margin_usd: 55, price_usd: 295, price_range_usd: null,
    delivery_time: "1–2 days after you accept", confidence: "high", notes: ["demo: placeholder unit price"],
  },
];

/** The option whose price the legacy columns mirror: the accepted one, else the recommended one. */
const mirroredOption = (v2: QuoteV2Seed) => v2.options.find((o) => o.option_id === (v2.accepted ?? v2.recommended))!;
const optionDataCost = (o: QuoteOption) => o.data.reduce((sum, d) => sum + (d.data_cost_usd ?? d.data_cost_range_usd?.[0] ?? 0), 0);
const v2Quote = (status: string, v2: QuoteV2Seed): NonNullable<RequestSeed["quote"]> => {
  const o = mirroredOption(v2);
  return { price: optionPriceLow(o), status, data: optionDataCost(o), analysis: o.analysis_cost_usd, v2 };
};
const fmtOptionPrice = (o: QuoteOption) => (o.price_usd !== null ? `$${o.price_usd}` : `$${o.price_range_usd![0]}–$${o.price_range_usd![1]}`);

const OWNER: Record<RequestStatus, AgentName | null> = {
  received: "comms-customer", screening: "comms-customer", clarifying: "comms-customer", planning: "planner", acquiring: "acquisition",
  pricing: "pricing", quoted: "comms-customer", awaiting_approval: "acquisition", fetching: "acquisition", analyzing: "analytics",
  verifying: "verifier", revising: "interpreter", delivering: "comms-customer", delivered: "comms-customer", refused: "comms-customer",
  failed: "analytics", cancelled: "comms-customer",
};
const STAGE: Partial<Record<RequestStatus, string>> = {
  screening: "screening", clarifying: "screening", planning: "planning", acquiring: "acquisition", pricing: "pricing", quoted: "quote",
  awaiting_approval: "acquisition", fetching: "acquisition", analyzing: "analysis", verifying: "verify", revising: "report", delivering: "deliver",
};

const INBOUND_DONE: RequestStatus[] = ["received", "screening", "planning", "acquiring", "pricing", "quoted", "analyzing", "verifying", "delivering", "delivered"];
const SAMPLE_DONE: RequestStatus[] = ["received", "planning", "acquiring", "analyzing", "verifying", "delivering", "delivered"];
const upTo = (path: RequestStatus[], last: RequestStatus) => path.slice(0, path.indexOf(last) + 1);

const REQUESTS: RequestSeed[] = [
  {
    key: "r_houston", source: "portal", playbook: "inbound", status: "delivered", owner: "comms-customer",
    question: "Did floodwater reach our loading docks during last week's storm?", location: "Clinton Drive warehouse district, Houston, TX",
    lat: 29.745, lon: -95.3, created: 1322, updated: 1315, customer: { name: "Maria Okafor", email: "maria.okafor@gulfcoastcold.example", company: "Gulf Coast Cold Storage" },
    path: INBOUND_DONE, quote: { price: 29, status: "accepted" },
    report: {
      site: "houston", title: "No standing water at the Clinton Drive docks on Oct 17", recipe: "flood_extent", layer: "inbound", confidence: "medium",
      answer: "The clear Sentinel-2 pass on Oct 17 shows no standing water on the loading apron or the access road. The water index over the docks is the same as in July, so any flooding had drained before the satellite passed.",
      measurements: [
        { metric: "flooded_area_km2", value: 0, unit: "km2", before: 0, after: 0, note: "Pixels above the MNDWI water threshold, excluding the ship channel" },
        { metric: "mndwi_delta", value: 0.01, unit: "index", before: -0.31, after: -0.3 },
      ],
      limitations: "10 m pixels; a pass three days after the storm can miss water that drained within hours.", verifier: "pass", score: 88,
      paidEstimate: { would_show: "Sub-metre imagery from the day after the storm would show the docks themselves", est_cost_usd: 180, provider_id: "sw-skysat-50cm" },
    },
  },
  {
    key: "r_sonoma", source: "email", playbook: "inbound", status: "delivered", owner: "comms-customer",
    question: "How much vegetation did our vineyard blocks lose between May and September?", location: "Carneros, Sonoma County, CA",
    lat: 38.255, lon: -122.4, created: 1180, updated: 1174, customer: { name: "Tom Reyes", email: "tom@valleyoakwines.example", company: "Valley Oak Wines" },
    path: INBOUND_DONE, quote: { price: 29, status: "accepted" },
    report: {
      site: "sonoma", title: "Vineyard greenness down 0.21 NDVI since May, as expected after harvest", recipe: "vegetation_health", layer: "inbound", confidence: "high", index: true,
      answer: "Mean NDVI over the vineyard blocks fell from 0.62 on May 18 to 0.41 on September 30. The drop is even across the blocks, the usual post-harvest pattern, with no block standing out as stressed.",
      measurements: [{ metric: "ndvi_mean", value: 0.41, unit: "index", before: 0.62, after: 0.41 }, { metric: "ndvi_delta", value: -0.21, unit: "index", before: null, after: null }],
      limitations: "Seasonal change dominates; a same-month comparison with last year would isolate stress.", verifier: "pass", score: 93,
    },
  },
  {
    key: "r_mead", source: "api", playbook: "inbound", status: "delivered", owner: "comms-customer",
    question: "Has the shoreline in the coves east of Callville Bay moved since May?", location: "Callville Bay, Lake Mead, NV",
    lat: 36.14, lon: -114.62, created: 1030, updated: 1026, customer: { name: null, email: "agent@hydrowatch.example" },
    path: INBOUND_DONE, quote: { price: 29, status: "accepted" },
    report: {
      site: "lakemead", title: "Water area in the coves down 4.6 % since May", recipe: "change_detection", layer: "inbound", confidence: "high",
      answer: "Open water inside the 2.4 km box shrank from 2.18 to 2.08 km² between May 24 and October 1. The new bare shoreline is a 20–60 m band, widest at the heads of the coves.",
      measurements: [{ metric: "water_area_km2", value: 2.08, unit: "km2", before: 2.18, after: 2.08 }, { metric: "water_area_change_pct", value: -4.6, unit: "%", before: null, after: null }],
      limitations: "Shoreline position is accurate to about one 10 m pixel.", verifier: "pass", score: 95,
    },
  },
  {
    key: "r_kelowna", source: "portal", playbook: "inbound", status: "delivered", owner: "comms-customer",
    question: "Has tree cover around our downtown office changed since the spring?", location: "Downtown Kelowna, BC, Canada",
    lat: 49.88, lon: -119.49, created: 860, updated: 852, customer: { name: "Priya Nand", email: "priya.nand@example.com" },
    path: INBOUND_DONE, quote: { price: 29, status: "accepted" },
    report: {
      site: "kelowna", title: "Tree canopy unchanged; greenness down with autumn leaf colour", recipe: "vegetation_health", layer: "inbound", confidence: "medium", index: true,
      answer: "Tree canopy on the blocks around the office covers the same 0.52 km² as on May 3. Mean NDVI is lower on October 20 (0.31 against 0.38) because the street trees are turning, not because any were removed.",
      measurements: [{ metric: "ndvi_mean", value: 0.31, unit: "index", before: 0.38, after: 0.31 }, { metric: "canopy_area_km2", value: 0.52, unit: "km2", before: 0.53, after: 0.52 }],
      limitations: "Single street trees are smaller than a 10 m pixel; a June re-check compares like with like.", verifier: "pass", score: 86,
    },
  },
  {
    key: "r_atacama", source: "email", playbook: "inbound", status: "delivered", owner: "comms-customer",
    question: "Have the evaporation ponds next to our concession expanded this year?", location: "Salar de Atacama, Chile",
    lat: -23.5, lon: -68.25, created: 640, updated: 633, customer: { name: "Diego Fuentes", email: "dfuentes@andesbrine.example", company: "Andes Brine Consulting" },
    path: INBOUND_DONE, quote: { price: 39, status: "accepted", data: 0, analysis: 1.9 },
    report: {
      site: "atacama", title: "Pond area up 0.18 km² since June", recipe: "change_detection", layer: "inbound", confidence: "high",
      answer: "Bright brine surface inside the box grew from 1.42 to 1.60 km² between June 11 and September 19, all of it in two new cells on the north-east edge.",
      measurements: [{ metric: "pond_area_km2", value: 1.6, unit: "km2", before: 1.42, after: 1.6 }],
      limitations: "Pond boundaries are mapped from reflectance; lined but empty cells may be missed.", verifier: "pass", score: 91,
    },
  },
  {
    key: "r_bingham", source: "portal", playbook: "inbound", status: "delivering", owner: "comms-customer",
    question: "Did the tailings footprint grow at the Bingham Canyon site since July?", location: "Bingham Canyon, UT",
    lat: 40.52, lon: -112.15, created: 34, updated: 4, customer: { name: "Sam Whitfield", email: "sam@saltlakeesg.example", company: "Salt Lake ESG Research" },
    path: upTo(INBOUND_DONE, "delivering"), quote: { price: 35, status: "accepted" },
    report: {
      site: "bingham", title: "Disturbed ground up 0.07 km² on the south-east bench", recipe: "mining_indicators", layer: "inbound", confidence: "medium",
      answer: "Bare, iron-stained ground inside the box grew by about 0.07 km² between July 10 and October 1, along the south-east bench. These are surface indicators of disturbance, not evidence of what is being mined.",
      measurements: [{ metric: "iron_oxide_ratio", value: 1.46, unit: "ratio", before: 1.38, after: 1.46 }, { metric: "disturbed_area_km2", value: 0.07, unit: "km2", before: null, after: null }],
      limitations: "Indicators only; band ratios cannot identify ore or deposits.", verifier: "pass", score: 84,
    },
  },
  {
    key: "r_chaco", source: "api", playbook: "inbound", status: "verifying", owner: "verifier",
    question: "Any new clearing on the ranch parcel since May? It's for an EUDR due-diligence file.", location: "Boquerón, Paraguay",
    lat: -21.5, lon: -60.5, created: 22, updated: 2, customer: { name: null, email: "compliance@granchaco-beef.example" },
    path: upTo(INBOUND_DONE, "verifying"), quote: { price: 29, status: "accepted" },
    report: {
      site: "chaco", title: "New clearing of about 0.4 km² on the parcel's east side", recipe: "forest_loss", layer: "inbound", confidence: "medium", index: true,
      answer: "NDVI dropped by more than 0.3 over about 0.4 km² on the east side of the parcel between May 5 and September 20, consistent with fresh clearing; GFW alerts overlap the same area.",
      measurements: [{ metric: "ndvi_delta", value: -0.34, unit: "index", before: 0.58, after: 0.24 }, { metric: "cleared_area_km2", value: 0.41, unit: "km2", before: null, after: null }],
      limitations: "Dry-season browning can mimic clearing; the GFW overlap raises confidence.", verifier: "pending", score: null, humanReview: true,
    },
  },
  {
    key: "r_westland", source: "portal", playbook: "inbound", status: "analyzing", owner: "analytics",
    question: "Did the hail storm damage the greenhouse roofs on our site?", location: "Westland, Netherlands", lat: 52.0, lon: 4.2,
    created: 18, updated: 9, customer: { name: "Joost de Vries", email: "joost@westlandkas.example", company: "Westland Kas" },
    path: upTo(INBOUND_DONE, "analyzing"), quote: { price: 29, status: "accepted" },
  },
  {
    key: "r_hualien", source: "email", playbook: "inbound", status: "awaiting_approval", owner: "acquisition",
    question: "We need to count damaged roofs in the Hualien industrial zone after the M6.1 quake.", location: "Hualien County, Taiwan", lat: 23.6, lon: 121.55,
    created: 210, updated: 186, customer: { name: "Lin Chen", email: "l.chen@pacificre.example", company: "Pacific Re Analytics" },
    path: ["received", "screening", "planning", "acquiring", "pricing", "quoted", "awaiting_approval"],
    quote: v2Quote("accepted", { options: HUALIEN_OPTIONS, recommended: "B", accepted: "B" }),
  },
  {
    // KNOWN DEMO INCONSISTENCY: a pre-v2 founder price check (needs_approval), which pricing v2 removed. Its status page
    // says the imagery is being bought, which isn't true for this row. Kept because the dashboard approvals card
    // (seed-demo.test.ts: getApprovals().quotes) and Aarush's demo use it. To fix, with Aarush: give it an accepted paid
    // option with a held order, or move it to another status, and update that test.
    key: "r_quarries", source: "portal", playbook: "inbound", status: "awaiting_approval", owner: "pricing",
    question: "Monthly checks of six quarry sites for unpermitted expansion.", location: "Pima County, AZ", lat: 31.9, lon: -111.0,
    created: 120, updated: 104, customer: { name: "Ana Morales", email: "amorales@desertwatch.example", company: "Desert Watch" },
    path: ["received", "screening", "planning", "acquiring", "pricing", "awaiting_approval"],
    quote: { price: 174, status: "needs_approval", data: 0, analysis: 9 },
  },
  {
    key: "r_cocoa", source: "email", playbook: "inbound", status: "quoted", owner: "comms-customer",
    question: "What would a deforestation check of our three cocoa supplier plots cost?", location: "Soubré, Côte d'Ivoire", lat: 5.79, lon: -6.59,
    created: 95, updated: 70, customer: { name: "Awa Koné", email: "awa.kone@ivorycocoa.example", company: "Ivory Cocoa Sourcing" },
    path: ["received", "screening", "planning", "acquiring", "pricing", "quoted"],
    quote: v2Quote("sent", { options: COCOA_OPTIONS, recommended: "B" }),
  },
  {
    key: "r_colusa", source: "portal", playbook: "inbound", status: "pricing", owner: "pricing",
    question: "Is there standing water on our rice fields after the levee breach?", location: "Colusa County, CA", lat: 39.21, lon: -122.01,
    created: 16, updated: 6, customer: { name: "Ben Harlan", email: "ben@harlanfarms.example", company: "Harlan Farms" },
    path: ["received", "screening", "planning", "acquiring", "pricing"],
  },
  {
    key: "r_elko", source: "api", playbook: "inbound", status: "acquiring", owner: "acquisition",
    question: "Count new structures inside the quarry buffer since 2025.", location: "Elko, NV", lat: 40.83, lon: -115.76,
    created: 14, updated: 7, customer: { name: null, email: "ops@basinpermits.example" }, path: ["received", "screening", "planning", "acquiring"],
  },
  {
    key: "r_victoria", source: "portal", playbook: "inbound", status: "planning", owner: "planner",
    question: "Did the river flood reach our hay fields this week?", location: "Victoria County, TX", lat: 28.8, lon: -97.0,
    created: 11, updated: 5, customer: { name: "Carla Mendez", email: "carla.mendez@example.com" }, path: ["received", "screening", "planning"],
  },
  {
    key: "r_vague", source: "email", playbook: "inbound", status: "clarifying", owner: "comms-customer",
    question: "Can you check our site please?", location: null, lat: null, lon: null,
    created: 48, updated: 44, customer: { name: "Leo Grant", email: "leo.grant@example.com" }, path: ["received", "screening", "clarifying"],
  },
  {
    key: "r_norcia", source: "portal", playbook: "inbound", status: "screening", owner: "comms-customer",
    question: "Was there a landslide on the slope above our road after the quake?", location: "Norcia, Italy", lat: 42.85, lon: 13.09,
    created: 8, updated: 7, customer: { name: "Giulia Rossi", email: "giulia@agriturismo-sibillini.example" }, path: ["received", "screening"],
  },
  {
    key: "r_charleston", source: "portal", playbook: "inbound", status: "received", owner: "comms-customer",
    question: "Is the beach in front of our hotel eroding?", location: "Folly Beach, Charleston, SC", lat: 32.66, lon: -79.94,
    created: 3, updated: 3, customer: { name: "Dana Pike", email: "dana@follyinn.example", company: "Folly Inn" }, path: ["received"],
  },
  {
    key: "r_refused", source: "portal", playbook: "inbound", status: "refused", owner: "comms-customer",
    question: "Tell me every time my neighbour leaves the house", location: "Leeds, UK", lat: null, lon: null,
    created: 410, updated: 408, customer: { name: null, email: "anon@example.com" }, refusal: "Surveillance of a private individual (acceptable use policy)",
    path: ["received", "screening", "refused"],
  },
  {
    key: "r_failed", source: "api", playbook: "inbound", status: "failed", owner: "analytics",
    question: "Daily cloud-free image of a barley field", location: "Aberdeenshire, UK", lat: 57.2, lon: -2.6,
    created: 560, updated: 520, customer: { name: null, email: "agri-bot@example.com" }, path: ["received", "screening", "planning", "acquiring", "pricing", "quoted", "analyzing", "failed"],
    quote: { price: 29, status: "accepted" },
  },
  {
    key: "r_cancelled", source: "email", playbook: "inbound", status: "cancelled", owner: "comms-customer",
    question: "Burn scar check near Paradise, CA", location: "Paradise, CA", lat: 39.76, lon: -121.62,
    created: 1100, updated: 1020, customer: { name: "Erin Walsh", email: "erin.walsh@example.com" }, path: ["received", "screening", "planning", "acquiring", "pricing", "quoted", "cancelled"],
    quote: { price: 29, status: "declined" },
  },
  // Free samples from the signal engine (enter at planning, delivered by comms-outreach).
  {
    key: "s_butte", source: "signal", playbook: "disasters", status: "delivered", owner: "comms-outreach", prospect: "foothill",
    question: "Free sample: fire and burn-scar check of Foothill Orchard Co-op's packing shed and orchards", location: "Butte County, CA",
    lat: 39.76, lon: -121.62, created: 338, updated: 305, path: SAMPLE_DONE, quote: { price: 49, status: "sent" },
    report: {
      site: "butte", title: "No new burn scar on the orchards; fire activity stayed 6 km north", recipe: "burn_severity", layer: "disasters", confidence: "high",
      answer: "Burn-severity index (dNBR) over the orchards and packing shed is 0.03, well under the 0.1 burn threshold. The VIIRS detections that triggered the alert sit about 6 km north, outside your blocks.",
      measurements: [{ metric: "dnbr_mean", value: 0.03, unit: "index", before: null, after: null }, { metric: "burned_area_km2", value: 0, unit: "km2", before: 0, after: 0 }],
      limitations: "Smoke can hide small spot fires; the next clear pass will confirm.", verifier: "pass", score: 90,
    },
  },
  {
    key: "s_rondonia", source: "signal", playbook: "deforestation", status: "delivered", owner: "comms-outreach", prospect: "jamari",
    question: "Free sample: forest change along Rio Jamari Cattle Co.'s pasture boundary", location: "Rondônia, Brazil",
    lat: -9.9, lon: -63.0, created: 1238, updated: 1200, path: SAMPLE_DONE,
    report: {
      site: "rondonia", title: "0.6 km² of forest cleared next to the pasture boundary since July", recipe: "forest_loss", layer: "forest", confidence: "high", index: true,
      answer: "Between July 8 and August 27, NDVI fell by more than 0.3 over 0.6 km² of forest just west of the pasture boundary, matching the GFW integrated alerts. The pasture itself is unchanged.",
      measurements: [{ metric: "ndvi_delta", value: -0.38, unit: "index", before: 0.81, after: 0.43 }, { metric: "cleared_area_km2", value: 0.6, unit: "km2", before: null, after: null }],
      limitations: "Selective logging under an intact canopy is not visible at 10 m.", verifier: "pass", score: 92,
    },
  },
  {
    key: "s_novo", source: "signal", playbook: "deforestation", status: "delivered", owner: "comms-outreach", prospect: "tapajos",
    question: "Free sample: forest change on a Tapajós Soy Traders supplier farm", location: "Novo Progresso, Pará, Brazil",
    lat: -7.13, lon: -55.38, created: 1098, updated: 1060, path: SAMPLE_DONE,
    report: {
      site: "novoprogresso", title: "Burned clearing of 0.3 km² on the farm's north edge", recipe: "forest_loss", layer: "forest", confidence: "medium", index: true,
      answer: "A 0.3 km² patch on the north edge lost its canopy between July 4 and October 7; the dark, low-NDVI surface suggests it was burned after clearing.",
      measurements: [{ metric: "ndvi_delta", value: -0.29, unit: "index", before: 0.77, after: 0.48 }],
      limitations: "Burn and clearing dates cannot be separated with two scenes.", verifier: "pass", score: 85,
    },
  },
  {
    key: "s_silver", source: "signal", playbook: "mining", status: "delivered", owner: "comms-outreach", prospect: "esmeralda",
    question: "Free sample: surface change on Esmeralda Lithium Exploration's claim block", location: "Esmeralda County, NV",
    lat: 37.75, lon: -117.63, created: 1188, updated: 1150, path: SAMPLE_DONE, quote: { price: 45, status: "accepted" },
    report: {
      site: "silverpeak", title: "Two new drill-pad scars on the claim block since June", recipe: "mining_indicators", layer: "mining", confidence: "medium",
      answer: "Two new bright clearings of about 0.01 km² each appear on the east side of the claim block between June 29 and November 6, with a fresh access track between them. Clay-ratio indicators rose slightly there.",
      measurements: [{ metric: "clay_ratio", value: 1.22, unit: "ratio", before: 1.15, after: 1.22 }, { metric: "new_disturbance_km2", value: 0.02, unit: "km2", before: null, after: null }],
      limitations: "Indicators only; band ratios never confirm a deposit.", verifier: "pass", score: 87,
    },
  },
  {
    key: "s_bayou", source: "signal", playbook: "disasters", status: "delivered", owner: "comms-outreach", prospect: "bayou",
    question: "Free sample: flood check of Bayou City Self Storage's yard on the ship channel", location: "Houston, TX",
    lat: 29.745, lon: -95.3, created: 1296, updated: 1262, path: SAMPLE_DONE,
    report: {
      site: "houston", title: "Yard dry on Oct 17; water confined to the bayou channel", recipe: "flood_extent", layer: "disasters", confidence: "medium",
      answer: "On the first clear pass after the warning (Oct 17) the water index over the storage yard matches July: no standing water outside the bayou channel itself.",
      measurements: [{ metric: "flooded_area_km2", value: 0, unit: "km2", before: 0, after: 0 }],
      limitations: "10 m pixels; water that drained within a day may be missed.", verifier: "pass", score: 85,
    },
  },
  {
    key: "s_kelowna", source: "signal", playbook: "disasters", status: "delivered", owner: "comms-outreach", prospect: "okanagan",
    question: "Free sample: wildfire check around Okanagan Lakeshore Hotel's grounds", location: "Kelowna, BC, Canada",
    lat: 49.88, lon: -119.49, created: 286, updated: 248, path: SAMPLE_DONE,
    report: {
      site: "kelowna", title: "No burn scar within 2 km of the hotel; the fire cluster is 12 km north-east", recipe: "burn_severity", layer: "disasters", confidence: "high",
      answer: "Burn-severity index around the hotel grounds is flat (dNBR 0.01). The VIIRS cluster that triggered the alert is in the hills about 12 km north-east, outside this view.",
      measurements: [{ metric: "dnbr_mean", value: 0.01, unit: "index", before: null, after: null }],
      limitations: "Smoke and lake glare can lower confidence on a single pass.", verifier: "pass", score: 89,
    },
  },
  {
    key: "s_copper", source: "signal", playbook: "mining", status: "delivered", owner: "comms-outreach", prospect: "copperline",
    question: "Free sample: ground change around Copperline Haulage's yard below the Bingham Canyon pit", location: "Salt Lake County, UT",
    lat: 40.52, lon: -112.15, created: 795, updated: 765, path: SAMPLE_DONE,
    report: {
      site: "bingham", title: "Haul roads widened on the south-east bench since July", recipe: "mining_indicators", layer: "mining", confidence: "medium",
      answer: "Bare, iron-stained ground along the south-east haul roads grew by about 0.05 km² between July 10 and October 1. These are surface indicators of activity, not evidence of what is mined.",
      measurements: [{ metric: "iron_oxide_ratio", value: 1.44, unit: "ratio", before: 1.38, after: 1.44 }],
      limitations: "Indicators only; band ratios cannot identify ore.", verifier: "pass", score: 83,
    },
  },
  {
    key: "s_ridge", source: "signal", playbook: "disasters", status: "revising", owner: "interpreter", prospect: "mojave",
    question: "Free sample: access-road damage check for Mojave Solar Partners after the M5.4 quake", location: "Ridgecrest, CA",
    lat: 35.53, lon: -117.82, created: 60, updated: 10, path: ["received", "planning", "acquiring", "analyzing", "verifying", "revising"],
    report: {
      site: "bingham", title: "Possible road damage south of the array", recipe: "change_detection", layer: "disasters", confidence: "low",
      answer: "Draft: a change in brightness along the southern access road may be damage.",
      measurements: [], limitations: "10 m pixels.", verifier: "fail", score: 41,
    },
  },
  {
    key: "s_ucay", source: "signal", playbook: "deforestation", status: "fetching", owner: "acquisition", prospect: "pucallpa",
    question: "Free sample: canopy change on Pucallpa Timber Exports' concession boundary", location: "Ucayali, Peru",
    lat: -8.38, lon: -74.55, created: 80, updated: 15, path: ["received", "planning", "acquiring", "fetching"],
  },
  {
    key: "s_thacker", source: "signal", playbook: "mining", status: "analyzing", owner: "analytics", prospect: "humboldt",
    question: "Free sample: new ground disturbance near Humboldt Basin Minerals' drill pads", location: "Humboldt County, NV",
    lat: 41.7, lon: -118.05, created: 40, updated: 13, path: ["received", "planning", "acquiring", "analyzing"],
  },
  {
    key: "s_tampa", source: "signal", playbook: "disasters", status: "planning", owner: "planner", prospect: "tampa",
    question: "Free sample: storm-surge check of Tampa Bay Marine Storage's dry-stack yard", location: "Tampa Bay, FL",
    lat: 27.95, lon: -82.46, created: 20, updated: 8, path: ["received", "planning"],
  },
  {
    key: "s_baton", source: "signal", playbook: "disasters", status: "received", owner: "planner", prospect: "riverroad",
    question: "Free sample: river flood check of River Road Terminals' barge terminal", location: "Baton Rouge, LA",
    lat: 30.45, lon: -91.19, created: 6, updated: 6, path: ["received"],
  },
];

/** Per-stage agent cost of one request on the Naïve ledger (USD), roughly what the live floors measured. */
const STAGE_COST: Partial<Record<AgentName, number>> = {
  "comms-customer": 0.06, planner: 0.34, acquisition: 0.07, pricing: 0.03, analytics: 0.21, interpreter: 0.42, verifier: 0.31, "comms-outreach": 0.05,
};

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

export interface DemoCounts { signals: number; prospects: number; requests: number; reports: number; earthIndex: number; interventions: number }

export async function seedDemo(db: Db, opts: { now?: Date } = {}): Promise<DemoCounts> {
  const now = (opts.now ?? new Date()).getTime();
  const at: At = (m) => new Date(now - m * 60_000).toISOString();
  const q = (sql: string, params: unknown[] = []) => db.query(sql, params);
  const json = (v: unknown) => JSON.stringify(v);
  const event = (type: string, actor: string, payload: Record<string, unknown>, requestId: string | null, minutesAgo: number) =>
    q("INSERT INTO events (request_id, type, actor, payload, created_at) VALUES ($1,$2,$3,$4,$5)", [requestId, type, actor, json({ ...payload, ...DEMO }), at(minutesAgo)]);
  const decision = async (d: { requestId: string | null; kind: DecisionKind; choice: string; reasoning: string; agent: string; minutesAgo: number; alternatives?: unknown[] }) => {
    const id = newId("decision");
    await q("INSERT INTO decisions (id, request_id, kind, choice, reasoning, alternatives, agent, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [
      id, d.requestId, d.kind, d.choice, d.reasoning, json(d.alternatives ?? []), d.agent, at(d.minutesAgo),
    ]);
    await event("decision.logged", d.agent, { decision_id: id, kind: d.kind, choice: d.choice }, d.requestId, d.minutesAgo);
  };
  const spend = (service: string, agent: string | null, requestId: string | null, usd: number, minutesAgo: number, component = "model") =>
    q("INSERT INTO spend (service, agent, request_id, component, amount_usd, is_estimate, recorded_at, meta) VALUES ($1,$2,$3,$4,$5,true,$6,$7)", [
      service, agent, requestId, component, usd, at(minutesAgo), json(DEMO),
    ]);

  // Signals ----------------------------------------------------------------
  const signalId = new Map<string, string>();
  for (const [key, playbook, feed, title, severity, lat, lon, ago, status, reason] of SIGNALS) {
    const id = newId("signal");
    signalId.set(key, id);
    await q(
      `INSERT INTO signals (id, playbook, feed, external_id, title, severity, event_time, lat, lon, h3_cells, status, status_reason, raw, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)`,
      [id, playbook, feed, `demo-${key}-${now}`, title, severity, at(ago + 20), lat, lon, [latLngToCell(lat, lon, 4)], status, reason ?? null, json(DEMO), at(ago)],
    );
  }
  await event("signals.polled", "sourcing", { feeds: ["nws", "usgs_quake", "nwps_flood", "firms", "openfema", "gfw", "blm_claims", "news"], new_signals: 6 }, null, 30);

  // Prospects and their touches ----------------------------------------------
  const prospectId = new Map<string, string>();
  for (const p of PROSPECTS) {
    const id = newId("prospect");
    prospectId.set(p.key, id);
    const sig = SIGNALS.find((s) => s[0] === p.signal)!;
    const email = p.channel === "contact_form" ? null : `${(p.contact ?? "ops").split(" ")[0].toLowerCase()}@${p.domain}`;
    const lat = sig[5] + 0.004;
    const lon = sig[6] - 0.003;
    await q(
      `INSERT INTO prospects (id, signal_id, playbook, company, domain, contact_name, contact_email, contact_role, asset_description, asset_lat, asset_lon,
         score_fit, score_urgency, score_ability, score_reach, score_total, status, message_version, channel, contact_form_url, warm, meta, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
      [
        id, signalId.get(p.signal), p.playbook, p.company, p.domain, p.contact ?? null, email, p.role ?? null, p.asset, lat, lon,
        Math.min(1, p.score + 0.05), Math.min(1, p.score + 0.08), Math.max(0, p.score - 0.06), Math.max(0, p.score - 0.1), p.score, p.status,
        p.touch?.version ?? null, p.channel, p.channel === "contact_form" ? `https://${p.domain}/contact` : null, p.channel === "email_warm",
        json(DEMO), at(p.created), at(Math.min(p.created, p.reply?.at ?? p.touch?.at ?? p.created)),
      ],
    );
    await event("prospect.created", "sourcing", { prospect_id: id, signal_id: signalId.get(p.signal) }, null, p.created);
    if (p.touch) {
      const mid = newId("message");
      await q(
        `INSERT INTO messages (id, direction, inbox, prospect_id, counterpart_email, counterpart_url, subject, body_text, kind, channel, status, blocked_reason, sent_at, meta, created_at)
         VALUES ($1,'outbound','outreach',$2,$3,$4,$5,$6,'outreach',$7,$8,$9,$10,$11,$12)`,
        [
          mid, id, email, p.channel === "contact_form" ? `https://${p.domain}/contact` : null, `Satellite check of your ${p.asset.toLowerCase()}`,
          "Demo outreach text (AI-written, with the asset image, one finding, a price and an opt-out link).", p.channel, p.touch.status,
          p.touch.reason ?? null, p.touch.status === "sent" ? at(p.touch.at) : null, json(DEMO), at(p.touch.at),
        ],
      );
      const type = p.touch.status === "sent" ? "email.sent" : p.touch.reason?.startsWith("provider_") ? "email.blocked_by_provider" : "email.blocked";
      await event(type, "comms-outreach", { message_id: mid, inbox: "outreach", kind: "outreach", channel: p.channel, reason: p.touch.reason ?? null }, null, p.touch.at);
      await decision({
        requestId: null, kind: "outreach", agent: "comms-outreach", minutesAgo: p.touch.at + 1,
        choice: `${p.channel.replace("_", " ")} for ${p.company}`,
        reasoning: p.channel === "contact_form"
          ? "Cold business prospect: first touch goes through their own website contact form, reply-to hello@. One touch per business."
          : p.channel === "email_warm" ? "They wrote to us first, so email from outreach@ is a warm reply." : "Direct cold email is built but switched off until the provider agrees (NOTES H2f).",
      });
    }
    if (p.reply) {
      await q(
        `INSERT INTO messages (id, direction, inbox, prospect_id, counterpart_email, subject, body_text, kind, channel, status, security_verdict, meta, created_at)
         VALUES ($1,'inbound','hello',$2,$3,$4,$5,'customer','email','received','clear',$6,$7)`,
        [newId("message"), id, email ?? `info@${p.domain}`, `Re: Satellite check of your ${p.asset.toLowerCase()}`, p.reply.text, json(DEMO), at(p.reply.at)],
      );
      await event("email.received", "system", { inbox: "hello", kind: "customer" }, null, p.reply.at);
      await event(p.status === "opted_out" ? "email.opted_out" : "prospect.replied", "comms-customer", { prospect_id: id }, null, p.reply.at - 1);
    }
    if (p.status === "opted_out") await q("INSERT INTO suppression (email, reason) VALUES ($1, 'opt_out') ON CONFLICT DO NOTHING", [`info@${p.domain}`]);
  }

  // Requests, their timelines, quotes and reports -----------------------------
  const requestId = new Map<string, string>();
  let reports = 0;
  for (const r of REQUESTS) {
    const id = newId("request");
    requestId.set(r.key, id);
    const sample = r.source === "signal";
    const site = r.report ? SITES[r.report.site] : null;
    await q(
      `INSERT INTO requests (id, source, playbook, priority, status, owner_agent, customer_email, customer_name, company, question, location_text, lat, lon,
         h3_cells, is_free_sample, prospect_id, inbox, refusal_reason, stage, meta, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [
        id, r.source, r.playbook, sample ? "background" : "inbound", r.status, r.owner, r.customer?.email ?? null, r.customer?.name ?? null,
        r.customer?.company ?? null, r.question, r.location, r.lat, r.lon, r.lat !== null && r.lon !== null ? [latLngToCell(r.lat, r.lon, 8)] : [],
        sample, r.prospect ? prospectId.get(r.prospect) : null, r.source === "email" ? "hello" : null, r.refusal ?? null, STAGE[r.status] ?? null,
        json({ ...DEMO, ...(sample ? {} : { screening: { allowed: r.status !== "refused" } }) }), at(r.created), at(r.updated),
      ],
    );
    if (r.prospect) await q("UPDATE prospects SET sample_request_id = $2 WHERE id = $1", [prospectId.get(r.prospect), id]);

    // Timeline: one hand-off and status change per step, evenly spaced between created and updated.
    const steps = r.path.length - 1;
    const tick = (i: number) => r.created - ((r.created - r.updated) * i) / Math.max(1, steps);
    await event("request.created", sample ? "sourcing" : "system", { source: r.source, priority: sample ? "background" : "inbound", is_free_sample: sample }, id, r.created);
    if (sample) await event("prospect.sample_requested", "sourcing", { prospect_id: prospectId.get(r.prospect!) }, id, r.created);
    let prevOwner: string = sample ? "sourcing" : "system";
    for (let i = 1; i <= steps; i++) {
      const status = r.path[i];
      const t = tick(i);
      const owner = status === "delivering" || status === "delivered" ? (sample ? "comms-outreach" : "comms-customer") : OWNER[status];
      if (STAGE[status] && owner && !["refused", "failed", "cancelled", "delivered"].includes(status)) {
        await event("handoff", prevOwner, { to: owner, stage: STAGE[status], lane: sample ? "background" : "inbound" }, id, t + 0.05);
      }
      await event("status.changed", prevOwner, { from: r.path[i - 1], to: status, note: null }, id, t);
      if (owner) prevOwner = owner;
      if (status === "planning") await event("data_spec.saved", "planner", { recipe: r.report?.recipe ?? "change_detection" }, id, t - 0.4);
      if (status === "acquiring" && site) {
        await event("acquisition_plan.saved", "acquisition", { choice: "free" }, id, t - 0.3);
        await decision({
          requestId: id, kind: "source_selection", agent: "acquisition", minutesAgo: t - 0.2,
          choice: `Sentinel-2 L2A, ${site.after.date} (clear) vs ${site.before.date}`,
          reasoning: `Both passes are under 2 % cloud over the 2.4 km box and on the same orbit family, so the change is comparable. Earth index had no fresher measurement here.`,
          alternatives: [
            { option: "Landsat 9 C2 L2", cost_usd: 0, why_not: "30 m pixels are too coarse for a 2 km site" },
            { option: "Sentinel-1 RTC radar", cost_usd: 0, why_not: "Not needed: clear optical scenes exist" },
          ],
        });
        await decision({
          requestId: id, kind: "free_vs_paid", agent: "acquisition", minutesAgo: t - 0.25, choice: "free",
          reasoning: "10 m Sentinel-2 answers the question at this size; paid sub-metre imagery would not change the answer.",
          alternatives: [{ option: "Planet SkySat 50 cm via SkyWatch", cost_usd: 160, why_not: "Not needed to answer this question" }],
        });
      }
      if (status === "pricing" && r.quote?.v2) {
        const { options, recommended } = r.quote.v2;
        const rec = options.find((o) => o.option_id === recommended)!;
        await decision({
          requestId: id, kind: "pricing", agent: "pricing", minutesAgo: t - 0.3,
          choice: `${options.length} options; recommended ${rec.option_id} at ${fmtOptionPrice(rec)}`,
          reasoning: options.map((o) => `${o.option_id} ${o.kind}: data $${optionDataCost(o)} + analysis $${o.analysis_cost_usd} + risk $${o.risk_buffer_usd} + margin $${o.margin_usd} = ${fmtOptionPrice(o)}`).join("; ") +
            ". Server-priced (pricing v2); the customer chooses.",
          alternatives: options.filter((o) => o.option_id !== rec.option_id).map((o) => ({
            option: `${o.option_id}: ${o.label}`, cost_usd: optionPriceLow(o), why_not: `offered as an alternative at ${fmtOptionPrice(o)}; the customer chooses`,
          })),
        });
      } else if (status === "pricing" && r.quote) {
        await decision({
          requestId: id, kind: "pricing", agent: "pricing", minutesAgo: t - 0.3,
          choice: r.quote.status === "needs_approval" ? `$${r.quote.price} (pre-v2 quote held for a founder)` : `$${r.quote.price} quoted; waits for the customer to accept`,
          reasoning: r.quote.status === "needs_approval"
            ? `Six sites at the $29 free-data floor = $174. Made before pricing v2, when quotes above $50 waited for a founder; a re-quote replaces it.`
            : `data $${r.quote.data ?? 0} + analysis $${r.quote.analysis ?? 1.5} + margin; free-data floor $29. Nothing beyond the investigation runs until the customer accepts.`,
        });
      }
      if (status === "analyzing" && r.report) {
        await event("analysis.saved", "analytics", { recipe: r.report.recipe, images: r.report.index ? 3 : 2 }, id, Math.max(r.updated, tick(i + 1) + 0.6));
      }
      if (status === "verifying" && r.report) await event("report.drafted", "interpreter", { revision: 1, confidence: r.report.confidence }, id, t + 0.3);
    }
    if (r.status === "refused") {
      await decision({ requestId: id, kind: "screening", agent: "comms-customer", minutesAgo: r.updated + 0.5, choice: "refused: surveillance of a private individual", reasoning: "Asks to watch a named private person's movements." });
    } else if (!sample && r.path.includes("screening") && r.status !== "screening") {
      await decision({ requestId: id, kind: "screening", agent: "comms-customer", minutesAgo: tick(1) - 0.2, choice: r.status === "clarifying" ? "allowed: needs a location" : "allowed", reasoning: "A business or personal question about a place, not about a person." });
    }
    if (r.status === "clarifying") await event("customer_message.sent", "comms-customer", { kind: "clarifying_question" }, id, r.updated);

    // Quote ---------------------------------------------------------------------
    let quoteId: string | null = null;
    if (r.quote) {
      quoteId = newId("quote");
      const analysis = r.quote.analysis ?? 1.5;
      const data = r.quote.data ?? 0;
      const lineItems = r.key === "r_quarries"
        ? [{ label: "Six site reports from free Sentinel-2 data", amount_usd: 174 }]
        : [...(data ? [{ label: "Satellite data", amount_usd: data }] : []), { label: "Analysis and verified report", amount_usd: r.quote.price - data }];
      const quoted = r.path.includes("pricing") ? tick(r.path.indexOf("pricing")) - 0.5 : r.created - 1;
      const v2 = r.quote.v2;
      if (v2) {
        // Pricing v2: options, an accept token for the link, valid 7 days; accepted only after the quote went out.
        const accepted = v2.accepted ? v2.options.find((o) => o.option_id === v2.accepted)! : null;
        const acceptedAt = accepted ? (r.path.includes("quoted") ? tick(r.path.indexOf("quoted")) - 0.5 : quoted - 0.6) : null;
        const items = [...(data ? [{ label: "Satellite data", amount_usd: data }] : []), { label: "Analysis and verified report", amount_usd: r.quote.price - data }];
        await q(
          `INSERT INTO quotes (id, request_id, data_cost_usd, analysis_cost_usd, margin_usd, price_usd, auto_approved, status, line_items, created_at, updated_at,
             options, recommended_option_id, accepted_option_id, accepted_at, accept_token, valid_until)
           VALUES ($1,$2,$3,$4,$5,$6,false,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [quoteId, id, data, analysis, Math.max(0, r.quote.price - data - analysis), r.quote.price, r.quote.status, json(items), at(quoted),
            at(acceptedAt ?? quoted), json(v2.options), v2.recommended, accepted?.option_id ?? null, acceptedAt === null ? null : at(acceptedAt),
            newToken(), at(quoted - 7 * 24 * 60)],
        );
        const rec = v2.options.find((o) => o.option_id === v2.recommended)!;
        await event("quote.created", "pricing", {
          quote_id: quoteId, options: v2.options.length, recommended_option_id: rec.option_id, price_usd: rec.price_usd, price_range_usd: rec.price_range_usd, auto_approved: false,
        }, id, quoted);
        await event("quote.sent", "comms-customer", { quote_id: quoteId }, id, quoted - 0.3);
        if (accepted && acceptedAt !== null) {
          await decision({
            requestId: id, kind: "pricing", agent: "comms-customer", minutesAgo: acceptedAt + 0.05,
            choice: `customer accepted option ${accepted.option_id} (${accepted.label}) at ${fmtOptionPrice(accepted)}`,
            reasoning: `Customer replied in the quote thread choosing option ${accepted.option_id}. Option kind ${accepted.kind}; ${accepted.answers}`,
            alternatives: v2.options.filter((o) => o !== accepted).map((o) => ({ option: `${o.option_id}: ${o.label}`, cost_usd: optionPriceLow(o), why_not: `not chosen (${fmtOptionPrice(o)})` })),
          });
          await event("quote.accepted", "comms-customer", {
            quote_id: quoteId, option_id: accepted.option_id, kind: accepted.kind, price_usd: accepted.price_usd, price_range_usd: accepted.price_range_usd,
          }, id, acceptedAt);
        }
      } else {
        await q(
          `INSERT INTO quotes (id, request_id, data_cost_usd, analysis_cost_usd, margin_usd, price_usd, auto_approved, status, line_items, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
          [quoteId, id, data, analysis, r.quote.price - data - analysis, r.quote.price, false, r.quote.status, json(lineItems), at(quoted)],
        );
        await event("quote.created", "pricing", { quote_id: quoteId, price_usd: r.quote.price, auto_approved: false }, id, quoted);
        if (["sent", "accepted", "declined"].includes(r.quote.status)) await event("quote.sent", "comms-customer", { quote_id: quoteId }, id, quoted - 0.3);
        if (r.quote.status === "accepted") {
          // Work started only once the customer said yes in the thread (no quote clears itself).
          const acceptedAt = r.path.includes("quoted") ? tick(r.path.indexOf("quoted")) - 0.5 : quoted - 0.6;
          await decision({
            requestId: id, kind: "pricing", agent: "comms-customer", minutesAgo: acceptedAt + 0.05,
            choice: `customer accepted the $${r.quote.price} quote`, reasoning: "Customer replied in the quote thread: go ahead.",
          });
          await event("quote.accepted", "comms-customer", { quote_id: quoteId }, id, acceptedAt);
        }
      }
    }

    // Report ----------------------------------------------------------------------
    let reportId: string | null = null;
    if (r.report && site) {
      reportId = newId("report");
      reports++;
      const box = siteBox(site);
      const images = r.report.verifier === "fail" ? [] : [
        { role: "before", url: pcImageUrl(site.before.item, box), caption: "True colour, before", date: site.before.date, source: "Sentinel-2 L2A (Copernicus)" },
        { role: "after", url: pcImageUrl(site.after.item, box), caption: "True colour, after", date: site.after.date, source: "Sentinel-2 L2A (Copernicus)" },
        ...(r.report.index ? [{ role: "index", url: pcImageUrl(site.after.item, box, "ndvi"), caption: "NDVI, after (red = bare, green = vegetation)", date: site.after.date, source: "Sentinel-2 L2A (Copernicus)" }] : []),
      ];
      const failed = r.report.verifier === "fail";
      const sources = (failed ? [] : [site.before, site.after]).map((s) => ({
        name: "Sentinel-2 L2A", collection: "sentinel-2-l2a", item_id: s.item, datetime: `${s.date}T00:00:00Z`, url: `${PC_STAC}/${s.item}`, license: LICENSE,
      }));
      await q(
        `INSERT INTO reports (id, request_id, title, answer, confidence, measurements, images, sources, limitations, human_review_recommended,
           paid_data_estimate, verifier_status, verifier_notes, verifier_score, public_token, meta, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          reportId, id, r.report.title, r.report.answer, r.report.confidence, json(r.report.measurements), json(images), json(sources), r.report.limitations,
          r.report.humanReview ?? false, r.report.paidEstimate ? json(r.report.paidEstimate) : null, r.report.verifier,
          r.report.verifier === "fail" ? "The change claim is not supported at 10 m; say what the imagery can and cannot show." : null,
          r.report.score, newToken(), json(DEMO), at(r.updated + 3), at(r.report.verifier === "pending" ? r.updated : r.updated + 1),
        ],
      );
      if (r.report.verifier !== "pending") {
        await decision({
          requestId: id, kind: "verification", agent: "verifier", minutesAgo: r.updated + 1,
          choice: r.report.verifier === "pass" ? `pass (score ${r.report.score})` : `fail (score ${r.report.score}): back to the interpreter`,
          reasoning: r.report.verifier === "pass"
            ? "Images match the claim, measurements are stated with units, limitations and confidence are present, sources cite real scenes."
            : "The draft claims damage that 10 m pixels cannot resolve and gives no measurement.",
        });
      }
      if (!failed) {
        await q("INSERT INTO analyses (id, request_id, recipe, result, created_by, created_at) VALUES ($1,$2,$3,$4,'analytics',$5)", [
          `ana_${reportId.slice(4)}`, id, r.report.recipe, json({ ...DEMO, recipe: r.report.recipe, before_scene: site.before.item, after_scene: site.after.item }), at(r.updated + 4),
        ]);
      }
    }
    if (r.status === "delivered" && !sample) {
      const inbox = "hello";
      await q(
        `INSERT INTO messages (id, direction, inbox, request_id, counterpart_email, subject, kind, channel, status, sent_at, meta, created_at)
         VALUES ($1,'outbound',$2,$3,$4,$5,$6,'email','sent',$7,$8,$7)`,
        [newId("message"), inbox, id, r.customer?.email ?? null, r.report?.title ?? "Your Terragent report", "customer", at(r.updated + 0.2), json(DEMO)],
      );
      await event("email.sent", "comms-customer", { inbox, kind: "customer", channel: "email" }, id, r.updated + 0.2);
    }

    // Spend: each agent that worked on it, at the floors measured live (estimates; the live ledger is never called).
    let cost = 0;
    const worked = new Set(r.path.map((s, i) => (i === 0 ? (sample ? null : "comms-customer") : s === "delivered" || s === "delivering" ? (sample ? "comms-outreach" : "comms-customer") : OWNER[s])));
    for (const agent of worked) {
      const usd = agent ? STAGE_COST[agent] : undefined;
      if (!agent || usd === undefined) continue;
      cost += usd;
      await spend("naive", agent, id, usd, r.updated);
    }
    await q("UPDATE requests SET cost_usd = $2, price_usd = $3, quote_id = $4, report_id = $5 WHERE id = $1", [
      id, Math.round(cost * 10_000) / 10_000, r.quote && !sample ? r.quote.price : null, quoteId, reportId,
    ]);
  }

  // Paid-data decision held for a founder (spec §10.2), and a past one a founder turned down -------------------
  const hualien = requestId.get("r_hualien")!;
  await decision({
    requestId: hualien, kind: "source_selection", agent: "acquisition", minutesAgo: 197,
    choice: "Sentinel-2 L2A searched first: clear pass on Nov 5, but 10 m",
    reasoning: "A free scene exists two days after the quake, but roofs in the zone are 15–40 m across: 10 m pixels can't tell a damaged roof from an intact one.",
  });
  await decision({
    requestId: hualien, kind: "free_vs_paid", agent: "acquisition", minutesAgo: 196, choice: "paid",
    reasoning: "Counting damaged roofs needs sub-metre imagery. Compared three archive offers for the 5 km² zone; Pléiades Neo is the cheapest pass after the quake, so pricing offers it as option B. Nothing is bought until the customer accepts; then a founder places the order by hand.",
    alternatives: [
      { option: "Sentinel-2 L2A (free, 10 m)", cost_usd: 0, why_not: "Pixels larger than most roofs; can't count damage" },
      { option: "Planet SkySat 50 cm via SkyWatch", cost_usd: 245, why_not: "Pricier for the same area, and the pass is a day later" },
      { option: "Vantor 30 cm via SkyWatch", cost_usd: 290, why_not: "No archive pass after the quake yet" },
    ],
  });
  const heldOrder = newId("order");
  await q(
    `INSERT INTO orders (id, request_id, provider_id, product, area_km2, est_cost_usd, status, justification, supplier_quote_usd, meta, created_at, updated_at)
     VALUES ($1,$2,'sw-pneo-30cm','Pléiades Neo 30 cm archive, 2026-11-05 pass',5,210,'awaiting_approval',$3,null,$4,$5,$5)`,
    [heldOrder, hualien, `Customer accepted option B (${HUALIEN_OPTIONS[1].label}): ${HUALIEN_OPTIONS[1].answers}`, json(DEMO), at(188)],
  );
  await event("supplier_quote.requested", "comms-suppliers", { order_id: heldOrder, provider_id: "sw-pneo-30cm" }, hualien, 189);
  await event("order.prepared", "acquisition", { order_id: heldOrder, provider_id: "sw-pneo-30cm", est_cost_usd: 210 }, hualien, 188);
  await event("approval.pending", "acquisition", { order_id: heldOrder }, hualien, 186);

  const ucay = requestId.get("s_ucay")!;
  const rejectedOrder = newId("order");
  await q(
    `INSERT INTO orders (id, request_id, provider_id, product, area_km2, est_cost_usd, status, justification, approved_by, decided_at, meta, created_at, updated_at)
     VALUES ($1,$2,'sw-skysat-50cm','SkySat 50 cm archive',4,180,'rejected',$3,'Aiden',$4,$5,$6,$4)`,
    [rejectedOrder, ucay, "Clouds over the concession in every recent Sentinel-2 pass.", at(66), json(DEMO), at(74)],
  );
  await decision({
    requestId: ucay, kind: "free_vs_paid", agent: "acquisition", minutesAgo: 62, choice: "free",
    reasoning: "After the founder declined SkySat, switched to Sentinel-1 radar: it sees through cloud and shows canopy loss at 10 m, which is enough for a free sample.",
    alternatives: [{ option: "Planet SkySat 50 cm via SkyWatch", cost_usd: 180, why_not: "Declined by a founder: too much to spend on a free sample" }],
  });

  // Earth index: ~19 res-8 cells around each measured site, on six continents -----------------------
  let earthIndex = 0;
  const INDEX_SITES: { lat: number; lon: number; layer: string; metric: string; base: number; spread: number; date: string; requestKey?: string; flagOver?: number }[] = [
    ...REQUESTS.filter((r, i, all) => r.report && r.report.verifier !== "fail" && all.findIndex((o) => o.report?.site === r.report!.site) === i).map((r) => {
      const s = SITES[r.report!.site];
      const m = r.report!.measurements[0];
      return { lat: s.lat, lon: s.lon, layer: r.report!.layer, metric: m?.metric ?? "ndvi_mean", base: m?.value ?? 0.4, spread: Math.max(0.05, Math.abs(m?.value ?? 0.2) * 0.3), date: s.after.date, requestKey: r.key };
    }),
    { lat: 23.6, lon: 121.55, layer: "disasters", metric: "brightness_change", base: 0.12, spread: 0.08, date: "2026-11-05", flagOver: 0.15 },
    { lat: 39.3, lon: -0.42, layer: "disasters", metric: "mndwi_delta", base: 0.22, spread: 0.12, date: "2026-11-04", flagOver: 0.25 },
    { lat: -8.38, lon: -74.55, layer: "forest", metric: "ndvi_delta", base: -0.18, spread: 0.12, date: "2026-10-29" },
    { lat: -2.2, lon: 113.9, layer: "forest", metric: "ndvi_delta", base: -0.22, spread: 0.1, date: "2026-10-30" },
    { lat: 5.79, lon: -6.59, layer: "forest", metric: "ndvi_delta", base: -0.09, spread: 0.07, date: "2026-10-21" },
    { lat: 41.7, lon: -118.05, layer: "mining", metric: "iron_oxide_ratio", base: 1.31, spread: 0.12, date: "2026-11-02", flagOver: 1.4 },
    { lat: -23.36, lon: 119.9, layer: "mining", metric: "iron_oxide_ratio", base: 1.62, spread: 0.15, date: "2026-11-03", flagOver: 1.7 },
  ];
  for (const [si, s] of INDEX_SITES.entries()) {
    const center = latLngToCell(s.lat, s.lon, 8);
    const rid = s.requestKey ? requestId.get(s.requestKey) ?? null : null;
    for (const [ci, cell] of gridDisk(center, 2).entries()) {
      // Deterministic wobble so neighbouring cells differ but reruns look the same.
      const wobble = Math.sin(si * 13.7 + ci * 2.3) * s.spread;
      const value = Math.round((s.base + wobble) * 1000) / 1000;
      const changed = s.flagOver !== undefined ? value > s.flagOver : s.metric.endsWith("_delta") ? Math.abs(value) > 0.2 : ci % 5 === 0;
      await q(
        `INSERT INTO earth_index (h3_cell, h3_res, layer, metric, value, unit, observed_at, source, change_flag, request_id, meta, created_at)
         VALUES ($1,8,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [cell, s.layer, s.metric, value, s.metric.endsWith("km2") ? "km2" : "index", s.date, `sentinel-2-l2a:demo-${s.date}`, changed, rid, json(DEMO), at(30 + si * 70)],
      );
      earthIndex++;
    }
  }

  // Money: agent spend outside requests, Monid runs, revenue ---------------------------------------------
  for (let h = 0; h < 22; h += 2) await spend("naive", "sourcing", null, 0.31, h * 60 + 15);
  for (const m of [1200, 700, 140]) await spend("naive", "coordinator", null, 0.22, m);
  await spend("naive", "market-researcher", null, 1.18, 1260);
  for (let i = 0; i < 9; i++) await spend("monid", "sourcing", null, 0.04, 60 + i * 130, "data");
  const rev = (key: string | null, usd: number, kind: string, note: string, minutesAgo: number) =>
    q("INSERT INTO revenue (request_id, quote_id, amount_usd, kind, note, recorded_at) VALUES ($1,(SELECT quote_id FROM requests WHERE id = $1),$2,$3,$4,$5)", [
      key ? requestId.get(key) : null, usd, kind, `demo: ${note}`, at(minutesAgo),
    ]);
  await rev("r_houston", 29, "paid", "paid via payment link", 1300);
  await rev("r_sonoma", 29, "paid", "paid via payment link", 1160);
  await rev("r_kelowna", 29, "paid", "paid via payment link", 840);
  await rev("r_atacama", 39, "paid", "paid via payment link", 620);
  await rev("s_silver", 45, "paid", "full claim-block report after the free sample", 650);
  await rev("r_mead", 29, "committed", "API customer, invoiced monthly", 1020);
  await rev("s_butte", 49, "committed", "monthly checks of three orchard blocks", 170);
  await rev("s_rondonia", 150, "stated_willingness", "said they would pay about $150 for a full parcel report", 715);

  // What buyers pay today (placeholders, marked as such) -------------------------------------------------
  for (const [i, [playbook, alternative, low, high, unit, turnaround]] of MARKET.entries()) {
    await q(
      `INSERT INTO market_prices (id, playbook, alternative, price_low, price_high, unit, turnaround, source_title, source_url, retrieved_at, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (playbook, alternative, source_url) DO NOTHING`,
      [newId("marketPrice"), playbook, alternative, low, high, unit, turnaround, "Local demo row, not a real price",
        `https://example.com/terragent-demo/market-${i + 1}`, at(1260).slice(0, 10), "demo: placeholder figures for local UI work"],
    );
  }

  // Coordinator's effort shifts over the day ------------------------------------------------------------
  const shifts = [
    { at: 1080, w: { disasters: 0.45, deforestation: 0.35, mining: 0.2 }, reason: "Fresh GFW alerts and EUDR deadlines: deforestation buyers have a reason to answer now; disaster feeds were quiet overnight." },
    { at: 540, w: { disasters: 0.55, deforestation: 0.3, mining: 0.15 }, reason: "Disasters: 2 replies from 3 first touches; deforestation 1 from 3; mining samples cost $1.90 each, the highest." },
    { at: 120, w: { disasters: 0.62, deforestation: 0.23, mining: 0.15 }, reason: "Two disaster prospects replied within 3 h of their free sample; moving effort to disasters and keeping a 15 % floor elsewhere." },
  ];
  for (const s of shifts) {
    for (const [playbook, weight] of Object.entries(s.w)) {
      await q("INSERT INTO playbook_allocations (playbook, weight, reason, metrics, decided_by, created_at) VALUES ($1,$2,$3,$4,'coordinator',$5)", [
        playbook, weight, s.reason, json({ ...DEMO, method: "smoothed reply rate × value / cost per report" }), at(s.at),
      ]);
    }
    await decision({ requestId: null, kind: "playbook_allocation", agent: "coordinator", minutesAgo: s.at - 0.1, choice: Object.entries(s.w).map(([p, w]) => `${p} ${Math.round(w * 100)}%`).join(", "), reasoning: s.reason });
  }
  await q(
    `INSERT INTO settings (key, value, updated_by) VALUES ($1, $2, 'coordinator') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [SETTING.allocation, json(shifts.at(-1)!.w)],
  );

  // A monitoring subscription from a delivered report.
  await q(
    "INSERT INTO monitors (id, request_id, lat, lon, recipe, metric, threshold, cadence, last_checked_at, last_value, status) VALUES ($1,$2,$3,$4,'vegetation_health','ndvi_mean',0.05,'0 6 1 * *',$5,0.39,'active')",
    [newId("monitor"), requestId.get("r_kelowna"), SITES.kelowna.lat, SITES.kelowna.lon, at(850)],
  );
  await decision({ requestId: requestId.get("r_kelowna")!, kind: "monitoring", agent: "comms-customer", minutesAgo: 849, choice: "monthly re-check offered", reasoning: "Leaf colour hides canopy changes until spring; a monthly NDVI check through June will show any real loss." });

  // Templates: drafts from the library; disasters v1 approved by a founder. Outreach inbox armed. --------------
  await seedTemplates(db);
  const [tpl] = await db.query<{ id: string }>(
    "UPDATE templates SET status = 'approved', approved_by = 'Laurence', approved_at = $1 WHERE playbook = 'disasters' AND version = 'v1' RETURNING id",
    [at(1290)],
  );
  await q(
    `INSERT INTO settings (key, value, updated_by) VALUES ($1, $2, 'human:Laurence') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [SETTING.inboxArmed, json({ outreach: true })],
  );

  // Interventions: the only human steps of the day -----------------------------------------------------
  const interventions = [
    { actor: "Laurence", action: "approve_template", reason: "Disasters v1 checked against spec §8: AI disclosure, opt-out, one finding, a price.", ref: tpl?.id ?? null, request: null, at: 1290 },
    { actor: "Laurence", action: "arm_inbox", reason: "First outreach send reviewed; arming outreach@.", ref: "outreach", request: null, at: 1285 },
    { actor: "Aarush", action: "naive_deny", reason: "Agent asked to log in to a supplier portal; humans create accounts.", ref: "tc_demo_login", request: null, at: 610 },
    { actor: "Aiden", action: "reject_order", reason: "Free Sentinel-1 radar sees through the cloud; $180 is too much for a free sample.", ref: rejectedOrder, request: ucay, at: 66 },
  ];
  for (const i of interventions) {
    await q("INSERT INTO interventions (actor, action, reason, request_id, ref_id, created_at) VALUES ($1,$2,$3,$4,$5,$6)", [i.actor, i.action, i.reason, i.request, i.ref, at(i.at)]);
    await event("human.intervention", `human:${i.actor}`, { action: i.action, reason: i.reason, ref_id: i.ref }, i.request, i.at);
  }
  await event("order.rejected", "human:Aiden", { order_id: rejectedOrder, approved_by: "Aiden", purchased: false, via: "dashboard" }, ucay, 66);

  return { signals: SIGNALS.length, prospects: PROSPECTS.length, requests: REQUESTS.length, reports, earthIndex, interventions: interventions.length };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(argv: string[]) {
  assertDemoTarget();
  const dir = demoDataDir();
  if (argv.includes("--reset")) {
    await rm(dir, { recursive: true, force: true });
    console.log(`[seed-demo] wiped ${path.relative(process.cwd(), dir)}/`);
  }
  const db = await createDb({ dataDir: dir });
  try {
    assertDemoTarget(process.env, db);
    await migrate(db);
    if (argv.includes("--if-empty")) {
      const [{ n }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM requests");
      if (Number(n) > 0) {
        console.log(`[seed-demo] ${path.relative(process.cwd(), dir)}/ already has ${n} requests; leaving it as is (--reset to start over).`);
        return;
      }
    }
    await seedProviders(db);
    const counts = await seedDemo(db);
    console.log(
      `[seed-demo] ${path.relative(process.cwd(), dir)}/: ${counts.requests} requests, ${counts.reports} reports, ${counts.signals} signals, ` +
        `${counts.prospects} prospects, ${counts.earthIndex} Earth index cells, ${counts.interventions} interventions (all marked demo).`,
    );
  } finally {
    await db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`[seed-demo] ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}

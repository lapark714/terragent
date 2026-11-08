/**
 * Provider & data-type registry seed (spec §3.5). Adding a data type is a row, not new code.
 * Every price and limit is cited; sources are docs/platform/web-and-providers.md §3.7 (paid),
 * docs/platform/imagery.md (Planetary Computer) and docs/platform/signals.md §3.6 (GFW), all retrieved 2026-11-07.
 * UP42 prices are EUR (100 credits = €1); the *_usd_per_km2 columns then hold EUR and `currency` says so.
 */
import type { Db } from "../../src/lib/db/client";
import type { DataType } from "../../src/lib/domain";

export interface ProviderSeed {
  id: string; name: string; vendor: string; data_type: DataType; resolution_m: number | null; revisit_days: number | null;
  coverage: string | null; is_free: boolean; pricing_model: string; currency: "USD" | "EUR";
  archive_per_km2: number | null; tasking_per_km2: number | null; min_order_km2: number | null; delivery_time: string | null;
  license_terms: string | null; access_method: "stac" | "api" | "email_quote" | "web_form"; access_url: string | null;
  quote_contact: string | null; notes: string | null; citations: { url: string; retrieved_at: string; note: string }[];
}

const AT = "2026-11-07";
const cite = (url: string, note: string) => ({ url, retrieved_at: AT, note });

const SW_PRICES = cite("https://skywatch.com/data", "SkyWatch public starting rates, USD");
const SW_MCP = cite("https://mcp.skywatch.com/mcp", "SkyWatch public MCP get_offerings, no login, USD per km² + minimum order");
const SW_LICENCE = "Restrictions apply to all SkyWatch imagery; ask SkyWatch before publishing. Archive orders are non-refundable. Deliver derived results only.";
const SW_FAQ = cite("https://intercom.help/skywatch-ab92e82e1a0a/en/articles/9952716-explore-faq", "licence restrictions; archive orders non-refundable");
// As in the §3.7 seed table: the sales form, not support@skywatch.com, so request_supplier_quote never emails SkyWatch support.
const SW_CONTACT = "https://skywatch.com/contact-sales/";
const SW_NOTES = "Self-serve prices, so most jobs need no quote; live per-AOI totals from the public SkyWatch MCP calculate_pricing (no account).";

const UP42_PRICING = cite("https://up42.com/pricing", "UP42 headline prices, EUR (100 credits = €1)");
const UP42_EULA = cite("https://docs.up42.com/getting-started/eulas.md", "licensed not sold; no resale; derivatives usually distributable");
const UP42_MIN = cite("https://docs.up42.com/data/catalog-min-charges.md", "catalog minimum charges");
const UP42_TASK_MIN = cite("https://docs.up42.com/data/tasking-min-charges.md", "tasking minimum charges");
const UP42_LICENCE = "Licensed, not sold: no resale, the customer may not access the data; derivative products (no original pixels) are usually distributable.";
const UP42_SALES = "https://up42.com/contact-us/sales";
const UP42_API = "https://api.up42.com";

const COPERNICUS_LICENCE = "Copernicus Sentinel data licence: free, full and open, commercial use allowed; credit \"Contains modified Copernicus Sentinel data [year]\".";
const PC_STAC = "https://planetarycomputer.microsoft.com/api/stac/v1/collections";

const paid = { is_free: false, revisit_days: null, coverage: "Global archive and tasking" } as const;

export const PROVIDERS: ProviderSeed[] = [
  // --- Free -----------------------------------------------------------------
  {
    id: "pc-sentinel-2-l2a", name: "Sentinel-2 Level-2A (Planetary Computer)", vendor: "ESA Copernicus via Microsoft Planetary Computer",
    data_type: "optical", resolution_m: 10, revisit_days: 5, coverage: "Global land and coastal waters, 2015-06-27 to present", is_free: true,
    pricing_model: "free", currency: "USD", archive_per_km2: 0, tasking_per_km2: null, min_order_km2: null,
    delivery_time: "minutes (anonymous STAC search + COG reads)", license_terms: COPERNICUS_LICENCE, access_method: "stac",
    access_url: `${PC_STAC}/sentinel-2-l2a`, quote_contact: null,
    notes: "Default source. 10 m B02/B03/B04/B08, 20 m SCL cloud mask; apply the -1000 BOA offset for baseline >= 04.00.",
    citations: [
      cite("https://planetarycomputer.microsoft.com/api/stac/v1/collections/sentinel-2-l2a", "live collection: 10 m gsd, extent 2015-06-27 to open (imagery.md §3.2)"),
      cite("https://ads.atmosphere.copernicus.eu/licences/ec-sentinel", "Copernicus Sentinel licence (imagery.md §4)"),
      cite("https://sentinels.copernicus.eu/web/sentinel/missions/sentinel-2", "5-day constellation revisit: mission spec, not re-verified live"),
    ],
  },
  {
    id: "pc-landsat-c2-l2", name: "Landsat Collection 2 Level-2 (Planetary Computer)", vendor: "USGS / NASA via Microsoft Planetary Computer",
    data_type: "optical", resolution_m: 30, revisit_days: 8, coverage: "Global land, 1982-08-22 to present (use Landsat 8/9)", is_free: true,
    pricing_model: "free", currency: "USD", archive_per_km2: 0, tasking_per_km2: null, min_order_km2: null,
    delivery_time: "minutes (anonymous STAC search + COG reads)", license_terms: "USGS public domain; credit the U.S. Geological Survey.",
    access_method: "stac", access_url: `${PC_STAC}/landsat-c2-l2`, quote_contact: null,
    notes: "Fallback when Sentinel-2 has no clear scene, or for pre-2017 history. A 2x2 km AOI is only ~67x67 pixels.",
    citations: [
      cite("https://planetarycomputer.microsoft.com/api/stac/v1/collections/landsat-c2-l2", "live collection: 30 m, extent 1982-08-22 to open (imagery.md §3.3, §3.11)"),
      cite("https://www.usgs.gov/core-science-systems/hdds/data-policy", "USGS data policy (collection licence link)"),
      cite("https://www.usgs.gov/landsat-missions/landsat-9", "8-day combined Landsat 8+9 revisit: mission spec, not re-verified live"),
    ],
  },
  {
    id: "pc-sentinel-1-rtc", name: "Sentinel-1 RTC radar (Planetary Computer)", vendor: "ESA Copernicus via Microsoft Planetary Computer",
    data_type: "radar", resolution_m: 10, revisit_days: 12, coverage: "Global land", is_free: true,
    pricing_model: "free", currency: "USD", archive_per_km2: 0, tasking_per_km2: null, min_order_km2: null, delivery_time: null,
    license_terms: COPERNICUS_LICENCE, access_method: "stac", access_url: `${PC_STAC}/sentinel-1-rtc`, quote_contact: null,
    notes: "Sees through cloud and at night. Not verified live in docs/platform and no pipeline recipe reads radar yet: suggest it, don't plan on it.",
    citations: [cite("https://planetarycomputer.microsoft.com/dataset/sentinel-1-rtc", "collection page; id, 10 m and 12-day revisit not re-verified live")],
  },
  {
    id: "gfw-integrated-alerts", name: "GFW integrated deforestation alerts (GLAD-L + GLAD-S2 + RADD)", vendor: "Global Forest Watch (WRI)",
    data_type: "alerts", resolution_m: 10, revisit_days: 1, coverage: "Tropics, 30°N to 30°S", is_free: true,
    pricing_model: "free", currency: "USD", archive_per_km2: 0, tasking_per_km2: null, min_order_km2: null, delivery_time: "daily updates",
    license_terms: "CC BY 4.0", access_method: "api", access_url: "https://data-api.globalforestwatch.org/dataset/gfw_integrated_alerts",
    quote_contact: null, notes: "POST .../download/json with a geometry works without a key; /query needs GFW_API_KEY plus an Origin header.",
    citations: [cite("https://data-api.globalforestwatch.org/openapi.json", "live: 10 m, daily, 30°N–30°S, CC BY 4.0 (signals.md §3.6)")],
  },

  // --- SkyWatch (USD, self-serve) ------------------------------------------
  {
    ...paid, id: "sw-vantor-30cm", name: "Vantor 30 cm (via SkyWatch)", vendor: "SkyWatch (Vantor)", data_type: "optical", resolution_m: 0.3,
    pricing_model: "per_km2_archive", currency: "USD", archive_per_km2: 19, tasking_per_km2: 29, min_order_km2: 1, delivery_time: null,
    license_terms: SW_LICENCE, access_method: "api", access_url: "https://mcp.skywatch.com/mcp", quote_contact: SW_CONTACT,
    notes: `Tasking minimum 25 km². ${SW_NOTES}`, citations: [SW_PRICES, SW_MCP, SW_FAQ],
  },
  {
    ...paid, id: "sw-vantor-50cm", name: "Vantor 50 cm (via SkyWatch)", vendor: "SkyWatch (Vantor)", data_type: "optical", resolution_m: 0.5,
    pricing_model: "per_km2_archive", currency: "USD", archive_per_km2: 14, tasking_per_km2: 25, min_order_km2: 1, delivery_time: null,
    license_terms: SW_LICENCE, access_method: "api", access_url: "https://mcp.skywatch.com/mcp", quote_contact: SW_CONTACT,
    notes: `Tasking minimum 25 km². ${SW_NOTES}`, citations: [SW_MCP, SW_FAQ],
  },
  {
    ...paid, id: "sw-pneo-30cm", name: "Pléiades Neo 30 cm (via SkyWatch)", vendor: "SkyWatch (Airbus)", data_type: "optical", resolution_m: 0.3,
    pricing_model: "per_km2_archive", currency: "USD", archive_per_km2: 22.5, tasking_per_km2: 32.5, min_order_km2: 5, delivery_time: null,
    license_terms: SW_LICENCE, access_method: "api", access_url: "https://mcp.skywatch.com/mcp", quote_contact: SW_CONTACT,
    notes: `1 km² minimum AOI but 5 km² billable (a 1 km² job costs $112.50). Airbus tasking needs a >=2 km corridor. ${SW_NOTES}`,
    citations: [SW_MCP, cite("https://intercom.help/skywatch-ab92e82e1a0a/en/articles/9917241-aoi-size-and-cost-requirements-hub", "minimum billable AOI rules"), SW_FAQ],
  },
  {
    ...paid, id: "sw-skysat-50cm", name: "Planet SkySat 50 cm (via SkyWatch)", vendor: "SkyWatch (Planet)", data_type: "optical", resolution_m: 0.5,
    pricing_model: "per_km2_archive", currency: "USD", archive_per_km2: 10, tasking_per_km2: 12, min_order_km2: 25, delivery_time: null,
    license_terms: SW_LICENCE, access_method: "api", access_url: "https://mcp.skywatch.com/mcp", quote_contact: SW_CONTACT,
    notes: SW_NOTES, citations: [SW_MCP, SW_FAQ],
  },
  {
    ...paid, id: "sw-medium-optical", name: "Medium-resolution optical 1–8 m (via SkyWatch)", vendor: "SkyWatch", data_type: "optical", resolution_m: 1,
    pricing_model: "per_km2_archive", currency: "USD", archive_per_km2: 2.5, tasking_per_km2: 3.5, min_order_km2: 1, delivery_time: null,
    license_terms: SW_LICENCE, access_method: "api", access_url: "https://mcp.skywatch.com/mcp", quote_contact: SW_CONTACT,
    notes: `Resolution 1–8 m by product; tasking minimum 25 km². ${SW_NOTES}`, citations: [SW_PRICES, SW_FAQ],
  },
  {
    ...paid, id: "sw-umbra-25cm", name: "Umbra Spotlight SAR 25 cm (via SkyWatch)", vendor: "SkyWatch (Umbra)", data_type: "radar", resolution_m: 0.25,
    pricing_model: "per_km2_tasking", currency: "USD", archive_per_km2: null, tasking_per_km2: 190, min_order_km2: 25, delivery_time: null,
    license_terms: SW_LICENCE, access_method: "api", access_url: "https://mcp.skywatch.com/mcp", quote_contact: SW_CONTACT,
    notes: `Tasking only. ${SW_NOTES}`, citations: [SW_MCP, SW_FAQ],
  },

  // --- UP42 (EUR; exact estimates need an authenticated call) -------------
  {
    ...paid, id: "up42-pleiades-neo", name: "Pléiades Neo 30 cm (UP42)", vendor: "UP42 (Airbus)", data_type: "optical", resolution_m: 0.3,
    pricing_model: "per_km2_archive", currency: "EUR", archive_per_km2: 18, tasking_per_km2: 26, min_order_km2: 0.1,
    delivery_time: "10 minutes (subset scenes) to a few days", license_terms: UP42_LICENCE, access_method: "api", access_url: UP42_API,
    quote_contact: UP42_SALES, notes: "Minimum 0.1 km² (10-minute subset), 5 km² standard, 25 km² HD15; tasking minimum 100 km². Credits: €100 minimum purchase.",
    citations: [cite("https://docs.up42.com/data/pleiades-neo.md", "1,800 / 2,600 credits per km²; delivery times"), UP42_MIN, UP42_TASK_MIN, UP42_EULA],
  },
  {
    ...paid, id: "up42-spot", name: "SPOT 1.5 m (UP42)", vendor: "UP42 (Airbus)", data_type: "optical", resolution_m: 1.5,
    pricing_model: "per_km2_archive", currency: "EUR", archive_per_km2: 2, tasking_per_km2: 2.8, min_order_km2: 0.1, delivery_time: null,
    license_terms: UP42_LICENCE, access_method: "api", access_url: UP42_API, quote_contact: UP42_SALES,
    notes: "Minimum 0.1 / 1 / 25 km² by delivery option; tasking minimum 100 km².",
    citations: [cite("https://docs.up42.com/data/spot.md", "200 / 280 credits per km² (Collection type row)"), UP42_MIN, UP42_TASK_MIN, UP42_EULA],
  },
  {
    ...paid, id: "up42-vantor", name: "Vantor 30–50 cm (UP42)", vendor: "UP42 (Vantor)", data_type: "optical", resolution_m: 0.3,
    pricing_model: "per_km2_archive", currency: "EUR", archive_per_km2: 13.5, tasking_per_km2: 22.5, min_order_km2: 1, delivery_time: null,
    license_terms: UP42_LICENCE, access_method: "api", access_url: UP42_API, quote_contact: UP42_SALES,
    notes: "VNIR minimum 1 km² archive, 25 km² tasking.",
    citations: [cite("https://docs.up42.com/data/vantor.md", "1,350 / 2,250 credits per km² (Collection type row)"), UP42_MIN, UP42_TASK_MIN, UP42_EULA],
  },
  {
    ...paid, id: "up42-hydrosat", name: "Hydrosat thermal (UP42)", vendor: "UP42 (Hydrosat)", data_type: "thermal", resolution_m: 70,
    pricing_model: "per_km2_archive", currency: "EUR", archive_per_km2: 1.6, tasking_per_km2: 6.4, min_order_km2: 500, delivery_time: null,
    license_terms: UP42_LICENCE, access_method: "api", access_url: UP42_API, quote_contact: UP42_SALES,
    notes: "70 m thermal, 30 m multispectral; 500 km² minimum.", citations: [UP42_PRICING, UP42_MIN, UP42_EULA],
  },
  {
    ...paid, id: "up42-dragonette-1", name: "Dragonette-1 hyperspectral (UP42)", vendor: "UP42 (Dragonette-1)", data_type: "hyperspectral", resolution_m: 5.3,
    pricing_model: "per_km2_tasking", currency: "EUR", archive_per_km2: null, tasking_per_km2: 8, min_order_km2: 100, delivery_time: null,
    license_terms: UP42_LICENCE, access_method: "api", access_url: UP42_API, quote_contact: UP42_SALES,
    notes: "Archive is per scene (€490/scene, 400 km² minimum); tasking €8/km², 100 km² minimum.", citations: [UP42_PRICING, UP42_MIN, UP42_TASK_MIN, UP42_EULA],
  },

  // --- Direct vendors -------------------------------------------------------
  {
    ...paid, id: "planet-skysat", name: "Planet SkySat (direct)", vendor: "Planet", data_type: "optical", resolution_m: 0.5,
    pricing_model: "per_km2_archive", currency: "USD", archive_per_km2: 6, tasking_per_km2: 12, min_order_km2: 25, delivery_time: null,
    license_terms: "Planet licence via contract; no small orders without one.", access_method: "web_form", access_url: "https://www.planet.com/pricing/",
    quote_contact: "https://www.planet.com/contact-sales",
    notes: "Archive (30+ days old) $6/km², flexible tasking $12/km², assured tasking $40/km²; 25 km² minimum with Planet Select. Needs a contract.",
    citations: [cite("https://www.planet.com/pricing/", "SkySat archive/tasking prices and 25 km² minimum")],
  },
  {
    ...paid, id: "arlula-archive", name: "Arlula archive (quote only)", vendor: "Arlula", data_type: "optical", resolution_m: null,
    pricing_model: "quote", currency: "USD", archive_per_km2: null, tasking_per_km2: null, min_order_km2: null, delivery_time: null,
    license_terms: "Licence options per scene add a loading on top of the price (archive API).", access_method: "email_quote",
    access_url: "https://docs.arlula.com/apis/archive", quote_contact: "hello@arlula.com",
    notes: "Pivoted to Geostack; no public price list. Per-scene prices only through the authenticated archive API, so ask by email.",
    citations: [cite("https://arlula.com/pricing", "redirects to /geostack/overview; no public prices"), cite("https://docs.arlula.com/apis/archive", "STAC archive search/quote/order")],
  },
  {
    ...paid, id: "vantor-direct", name: "Vantor (formerly Maxar) direct", vendor: "Vantor", data_type: "optical", resolution_m: null,
    pricing_model: "quote", currency: "USD", archive_per_km2: null, tasking_per_km2: null, min_order_km2: null, delivery_time: null,
    license_terms: null, access_method: "web_form", access_url: null, quote_contact: null,
    notes: "No public direct price list found; compare with sw-vantor-30cm / sw-vantor-50cm / up42-vantor instead.",
    citations: [cite("https://mcp.skywatch.com/mcp", "reseller rates used instead (web-and-providers.md §3.7)")],
  },
  {
    ...paid, id: "airbus-oneatlas", name: "Airbus OneAtlas direct", vendor: "Airbus", data_type: "optical", resolution_m: null,
    pricing_model: "quote", currency: "EUR", archive_per_km2: null, tasking_per_km2: null, min_order_km2: null, delivery_time: null,
    license_terms: "Airbus licences: https://space-solutions.airbus.com/legal/licences/", access_method: "web_form", access_url: null, quote_contact: null,
    notes: "No public direct price list found; compare with sw-pneo-30cm / up42-pleiades-neo / up42-spot instead.",
    citations: [cite("https://space-solutions.airbus.com/legal/licences/", "licence terms (linked from UP42 EULA page, not fetched)")],
  },
];

/** Upsert every row by id (safe to re-run). Returns the number of rows written. */
export async function seedProviders(db: Db): Promise<number> {
  for (const p of PROVIDERS) {
    await db.query(
      `INSERT INTO providers (id, name, vendor, data_type, resolution_m, revisit_days, coverage, is_free, pricing_model, currency,
         archive_usd_per_km2, tasking_usd_per_km2, min_order_km2, delivery_time, license_terms, access_method, access_url,
         quote_contact, notes, citations, active, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,true,now())
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, vendor = EXCLUDED.vendor, data_type = EXCLUDED.data_type,
         resolution_m = EXCLUDED.resolution_m, revisit_days = EXCLUDED.revisit_days, coverage = EXCLUDED.coverage, is_free = EXCLUDED.is_free,
         pricing_model = EXCLUDED.pricing_model, currency = EXCLUDED.currency, archive_usd_per_km2 = EXCLUDED.archive_usd_per_km2,
         tasking_usd_per_km2 = EXCLUDED.tasking_usd_per_km2, min_order_km2 = EXCLUDED.min_order_km2, delivery_time = EXCLUDED.delivery_time,
         license_terms = EXCLUDED.license_terms, access_method = EXCLUDED.access_method, access_url = EXCLUDED.access_url,
         quote_contact = EXCLUDED.quote_contact, notes = EXCLUDED.notes, citations = EXCLUDED.citations, active = true, updated_at = now()`,
      [
        p.id, p.name, p.vendor, p.data_type, p.resolution_m, p.revisit_days, p.coverage, p.is_free, p.pricing_model, p.currency,
        p.archive_per_km2, p.tasking_per_km2, p.min_order_km2, p.delivery_time, p.license_terms, p.access_method, p.access_url,
        p.quote_contact, p.notes, JSON.stringify(p.citations),
      ],
    );
  }
  return PROVIDERS.length;
}

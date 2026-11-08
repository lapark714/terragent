/**
 * OWNER: imagery builder. Free scene search on Microsoft Planetary Computer (TypeScript, no Python).
 *
 * STAC search (anonymous POST) → one item per date and tile, footprints that cover the AOI first → AOI clear
 * fraction and haze check for the newest few from the data API (TiTiler) statistics on SCL + B02 (and, when none
 * of them is clear enough, the least cloudy few of the older ones, inside a time budget) → best before/after. Verified endpoints and traps: docs/platform/imagery.md §3.1, §3.8, §3.14. The Python
 * pipeline (pipeline/terragent_pipeline/scenes.py) applies the same rules at full resolution.
 */
import type { BBox, DateRange, SceneRef } from "../domain";

const STAC_URL = "https://planetarycomputer.microsoft.com/api/stac/v1";
const DATA_URL = "https://planetarycomputer.microsoft.com/api/data/v1";

const SCREEN_PER_WINDOW = 4; // newest candidates whose AOI we measure (stats calls run in parallel)
const EXTRA_SCREEN = 4; // if none of those is clear enough: the least cloudy (by tile) of the older ones, like scenes.py
const MEASURE_BUDGET_MS = 5_000; // per window (both windows run at once): the extra round only gets what is left …
const MIN_EXTRA_MS = 1_000; // … and is skipped when less than this remains
const LIST_PER_WINDOW = 8; // candidates returned to the agent (keeps the MCP reply small)
const TILE_CLOUD_CAP = 80; // eo:cloud_cover is per 110 km tile: only drop hopeless tiles before measuring
const HAZE_ABS = 0.025; // median blue reflectance this far above the window's clearest scene = haze …
const HAZE_REL = 1.2; // … and this many times it (SCL calls haze "clear"; seen live in downtown LA)
const SEARCH_TIMEOUT_MS = 8_000;
const STATS_TIMEOUT_MS = 4_000;
/** ESA processing baseline 04.00 (DN + 1000 offset) went live on 2022-01-25. */
const BASELINE_04_DATE = "2022-01-25";
/** SCL classes that are not usable ground: nodata, saturated, cloud shadow, cloud medium/high, cirrus. */
const SCL_CLEAR_EXPR = "where((SCL<=1)|(SCL==3)|((SCL>=8)&(SCL<=10)),0,1)";

export interface FreeSceneQuery {
  bbox: BBox;
  before: DateRange | null;
  after: DateRange;
  maxCloudPct: number;
  collection?: "sentinel-2-l2a" | "landsat-c2-l2";
  /** "earliest" = first clear scene of the after window (floods recede within days). Default "latest". */
  afterPreference?: "latest" | "earliest";
}

/** A SceneRef (cloud_pct = tile eo:cloud_cover) plus what we measured over the AOI. */
export interface SceneCandidate extends SceneRef {
  aoi_clear_fraction?: number | null; // share of the AOI clear by SCL; null = not measured
  aoi_blue?: number | null; // median blue reflectance of the AOI (haze check)
  mgrs_tile?: string | null;
  processing_baseline?: string | null;
  covers_aoi?: boolean;
  preview_url?: string; // true-colour crop of the AOI (PNG), for the chosen scenes
}

export interface FreeSceneResult {
  provider_id: string; // registry id, e.g. "pc-sentinel-2-l2a"
  collection: string;
  before: SceneCandidate | null;
  after: SceneCandidate | null;
  candidates: { before: SceneCandidate[]; after: SceneCandidate[] };
  notes: string[];
}

interface StacItem {
  id: string;
  geometry: { type: string; coordinates: unknown } | null;
  properties: Record<string, unknown>;
}

type Ring = [number, number][];

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

export function stacInterval(w: DateRange): string {
  const stamp = (s: string, time: string) => (s.includes("T") ? s : `${s}${time}`);
  return `${stamp(w.start, "T00:00:00Z")}/${stamp(w.end, "T23:59:59Z")}`;
}

/** Share of the AOI that must be clear; capped below 1 because SCL flags a few stray pixels in most scenes. */
export function minClear(maxCloudPct: number): number {
  return Math.min(Math.max(1 - maxCloudPct / 100, 0), 0.95);
}

function inRing([x, y]: [number, number], ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** True if the footprint contains all four AOI corners (footprints are convex; AOIs are small). */
export function covers(geometry: StacItem["geometry"], [x0, y0, x1, y1]: BBox): boolean {
  if (!geometry) return false;
  const polygons = (geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates) as Ring[][];
  const corners: [number, number][] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  return polygons.some((poly) => corners.every((c) => inRing(c, poly[0])));
}

function tileOf(p: Record<string, unknown>): string | null {
  if (p["s2:mgrs_tile"]) return String(p["s2:mgrs_tile"]);
  if (p["landsat:wrs_path"] && p["landsat:wrs_row"]) return `${p["landsat:wrs_path"]}/${p["landsat:wrs_row"]}`;
  return null;
}

/**
 * Newest first, one item per acquisition (tiles overlap, so an AOI can sit in two): prefer a footprint that covers
 * the whole AOI (swath edges have nodata wedges), then the latest processing. Partial ones stay only if nothing covers.
 */
export function toCandidates(items: StacItem[], collection: string, bbox: BBox): SceneCandidate[] {
  const rank = (i: StacItem) =>
    [covers(i.geometry, bbox) ? "1" : "0", String(i.properties["s2:generation_time"] ?? ""), tileOf(i.properties) ?? ""].join("|");
  const best = new Map<string, StacItem>();
  for (const it of items) {
    const key = String(it.properties.datetime);
    const prev = best.get(key);
    if (!prev || rank(it) > rank(prev)) best.set(key, it);
  }
  const all = [...best.values()]
    .map((it): SceneCandidate => {
      const p = it.properties;
      const cloud = typeof p["eo:cloud_cover"] === "number" ? (p["eo:cloud_cover"] as number) : null;
      return {
        collection,
        item_id: it.id,
        datetime: String(p.datetime),
        cloud_pct: cloud === null ? null : Math.round(cloud * 100) / 100,
        aoi_clear_fraction: null,
        aoi_blue: null,
        mgrs_tile: tileOf(p),
        processing_baseline: p["s2:processing_baseline"] ? String(p["s2:processing_baseline"]) : null,
        covers_aoi: covers(it.geometry, bbox),
      };
    })
    .sort((a, b) => b.datetime.localeCompare(a.datetime));
  const full = all.filter((c) => c.covers_aoi);
  return full.length ? full : all;
}

export function isHazy(blue: number | null | undefined, clearest: number | null): boolean {
  if (blue == null || clearest == null) return false;
  return blue > clearest + HAZE_ABS && blue > clearest * HAZE_REL;
}

/**
 * Candidates are in preference order (newest first, or oldest first for floods). Measured ones: the first that is
 * clear enough and not hazy, else the first clear enough, else the clearest. Nothing measured: the first whose tile
 * cloud cover is within the limit, else the first.
 */
export function pickBest(cands: SceneCandidate[], need: number, maxCloudPct: number): SceneCandidate | null {
  const measured = cands.filter((c) => c.aoi_clear_fraction != null);
  const ok = measured.filter((c) => c.aoi_clear_fraction! >= need);
  if (ok.length) {
    const blues = ok.map((c) => c.aoi_blue).filter((b): b is number => b != null);
    const clearest = blues.length ? Math.min(...blues) : null;
    return ok.find((c) => !isHazy(c.aoi_blue, clearest)) ?? ok[0];
  }
  if (measured.length) return measured.reduce((a, b) => (b.aoi_clear_fraction! > a.aoi_clear_fraction! ? b : a));
  return cands.find((c) => c.cloud_pct != null && c.cloud_pct <= maxCloudPct) ?? cands[0] ?? null;
}

function usesBoaOffset(scene: SceneRef & { processing_baseline?: string | null }): boolean {
  if (scene.processing_baseline) return parseFloat(scene.processing_baseline) >= 4;
  return scene.datetime.slice(0, 10) >= BASELINE_04_DATE;
}

function sizeFor([x0, y0, x1, y1]: BBox, px: number): [number, number] {
  const midLat = (((y0 + y1) / 2) * Math.PI) / 180;
  const wKm = (x1 - x0) * 111.32 * Math.cos(midLat);
  const hKm = (y1 - y0) * 110.574;
  const s = px / Math.max(wKm, hKm);
  return [Math.max(1, Math.round(wKm * s)), Math.max(1, Math.round(hKm * s))];
}

/** Planetary Computer data API (TiTiler) PNG preview URL for a scene cropped to bbox. */
export function previewUrl(
  scene: SceneRef & { processing_baseline?: string | null },
  bbox: BBox,
  kind: "true_color" | "ndvi",
  px = 512,
): string {
  const q = new URLSearchParams({ collection: scene.collection, item: scene.item_id });
  const landsat = scene.collection === "landsat-c2-l2";
  if (kind === "true_color" && landsat) {
    for (const band of ["red", "green", "blue"]) q.append("assets", band);
    q.set("rescale", "7300,20000");
    q.set("color_formula", "Gamma RGB 1.4");
  } else if (kind === "true_color") {
    q.set("assets", "visual");
    q.set("asset_bidx", "visual|1,2,3");
  } else {
    // The server applies no scale/offset: fold them into the denominator (the numerator offsets cancel).
    const [nir, red] = landsat ? ["nir08", "red"] : ["B08", "B04"];
    const offset = landsat ? 14545 : usesBoaOffset(scene) ? 2000 : 0;
    q.set("expression", offset ? `(${nir}-${red})/(${nir}+${red}-${offset})` : `(${nir}-${red})/(${nir}+${red})`);
    q.set("asset_as_band", "true");
    q.set("rescale", "-0.2,0.8");
    q.set("colormap_name", "rdylgn");
  }
  const [w, h] = sizeFor(bbox, px);
  return `${DATA_URL}/item/bbox/${bbox.join(",")}/${w}x${h}.png?${q}`;
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

async function stacSearch(
  collection: string,
  bbox: BBox,
  window: DateRange,
  maxCloudPct: number,
  tile: string | null,
): Promise<StacItem[]> {
  const query: Record<string, unknown> = { "eo:cloud_cover": { lte: Math.max(TILE_CLOUD_CAP, maxCloudPct) } };
  if (collection === "landsat-c2-l2") query.platform = { in: ["landsat-8", "landsat-9"] };
  if (tile && collection === "sentinel-2-l2a") query["s2:mgrs_tile"] = { eq: tile };
  const [x0, y0, x1, y1] = bbox;
  const res = await fetch(`${STAC_URL}/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      collections: [collection],
      intersects: { type: "Polygon", coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] },
      datetime: stacInterval(window),
      query,
      sortby: [{ field: "datetime", direction: "desc" }],
      limit: 50,
    }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Planetary Computer STAC search failed: HTTP ${res.status}`);
  return ((await res.json()) as { features?: StacItem[] }).features ?? [];
}

/** AOI clear fraction (SCL) and median blue reflectance (B02) in one statistics call. Null on any failure. */
async function measure(c: SceneCandidate, bbox: BBox, timeoutMs = STATS_TIMEOUT_MS): Promise<SceneCandidate> {
  const [x0, y0, x1, y1] = bbox;
  const q = new URLSearchParams({
    collection: c.collection,
    item: c.item_id,
    expression: `${SCL_CLEAR_EXPR};B02`,
    asset_as_band: "true",
  });
  try {
    const res = await fetch(`${DATA_URL}/item/statistics?${q}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "Feature",
        properties: {},
        geometry: { type: "Polygon", coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return c;
    const body = (await res.json()) as { properties?: { statistics?: Record<string, { mean?: number; median?: number }> } };
    const [clear, blue] = Object.values(body.properties?.statistics ?? {});
    const offset = usesBoaOffset(c) ? 1000 : 0;
    return {
      ...c,
      aoi_clear_fraction: typeof clear?.mean === "number" ? Math.round(clear.mean * 1000) / 1000 : null,
      aoi_blue: typeof blue?.median === "number" ? Math.round(((blue.median - offset) / 10000) * 10000) / 10000 : null,
    };
  } catch {
    return c;
  }
}

const tileCloud = (c: SceneCandidate) => c.cloud_pct ?? 100;

/**
 * Measures the first few candidates (in preference order). If none is clear enough, also measures the least cloudy
 * (by tile) of the rest, at most EXTRA_SCREEN more and only while the window's budget lasts, so a cloudy spell at
 * the newest end of the window doesn't hide a clear scene a few passes earlier. Order is kept; unmeasured ones
 * stay as they are.
 */
async function measureCandidates(cands: SceneCandidate[], bbox: BBox, need: number): Promise<SceneCandidate[]> {
  const started = Date.now();
  const out = [...cands];
  const measureAt = async (idx: number[], timeoutMs: number) => {
    const done = await Promise.all(idx.map((i) => measure(out[i], bbox, timeoutMs)));
    idx.forEach((i, k) => (out[i] = done[k]));
  };
  await measureAt(out.slice(0, SCREEN_PER_WINDOW).map((_, i) => i), STATS_TIMEOUT_MS);
  if (out.slice(0, SCREEN_PER_WINDOW).some((c) => (c.aoi_clear_fraction ?? 0) >= need)) return out;
  const left = MEASURE_BUDGET_MS - (Date.now() - started);
  if (left < MIN_EXTRA_MS || out.length <= SCREEN_PER_WINDOW) return out;
  const extra = out
    .map((c, i) => ({ c, i }))
    .slice(SCREEN_PER_WINDOW)
    .sort((a, b) => tileCloud(a.c) - tileCloud(b.c) || a.i - b.i)
    .slice(0, EXTRA_SCREEN)
    .map(({ i }) => i);
  await measureAt(extra, Math.min(STATS_TIMEOUT_MS, left));
  return out;
}

function describe(label: string, pick: SceneCandidate | null, cands: SceneCandidate[], need: number, window: DateRange): string[] {
  if (!pick) return [`${label}: no scene covers the area between ${window.start} and ${window.end}.`];
  const day = pick.datetime.slice(0, 10);
  const notes: string[] = [];
  if (pick.aoi_clear_fraction == null) {
    notes.push(`${label}: ${pick.item_id} (${day}); AOI cloud not measured, tile cloud cover ${pick.cloud_pct ?? "?"}%.`);
  } else {
    notes.push(`${label}: ${pick.item_id} (${day}), ${Math.round(pick.aoi_clear_fraction * 100)}% of the AOI clear (SCL).`);
    if (pick.aoi_clear_fraction < need) {
      const checked = cands.filter((c) => c.aoi_clear_fraction != null).length;
      notes.push(`${label}: no scene in the window is clear enough; this is the clearest of ${checked} measured.`);
    }
  }
  const skipped = cands.slice(0, cands.indexOf(pick)).filter((c) => (c.aoi_clear_fraction ?? 0) >= need);
  if (skipped.length) notes.push(`${label}: skipped ${skipped.length} scene(s) ahead of it that SCL calls clear but look hazy.`);
  return notes;
}

/** Best clear before/after scenes for an AOI. Never throws for "no scenes" — returns nulls + notes. */
export async function searchFreeScenes(q: FreeSceneQuery): Promise<FreeSceneResult> {
  const collection = q.collection ?? "sentinel-2-l2a";
  const need = minClear(q.maxCloudPct);
  const [afterItems, beforeItems] = await Promise.all([
    stacSearch(collection, q.bbox, q.after, q.maxCloudPct, null),
    q.before ? stacSearch(collection, q.bbox, q.before, q.maxCloudPct, null) : Promise.resolve([]),
  ]);
  const afterCands = toCandidates(afterItems, collection, q.bbox);
  if (q.afterPreference === "earliest") afterCands.reverse();
  let beforeCands = toCandidates(beforeItems, collection, q.bbox);
  // Same MGRS tile before and after = same pixel grid, so change maps line up without resampling.
  const tile = afterCands[0]?.mgrs_tile;
  const sameTile = beforeCands.filter((c) => c.mgrs_tile === tile);
  if (sameTile.length) beforeCands = sameTile;

  const screenable = collection === "sentinel-2-l2a";
  const [after, before] = screenable
    ? await Promise.all([measureCandidates(afterCands, q.bbox, need), measureCandidates(beforeCands, q.bbox, need)])
    : [afterCands, beforeCands];
  const afterPick = pickBest(after, need, q.maxCloudPct);
  const beforePick = q.before ? pickBest(before, need, q.maxCloudPct) : null;

  const notes = [
    ...describe("after", afterPick, after, need, q.after),
    ...(q.before ? describe("before", beforePick, before, need, q.before) : []),
  ];
  if (!screenable) notes.push("Landsat scenes are chosen by tile cloud cover; the pipeline measures the AOI itself.");
  const withPreview = (s: SceneCandidate | null) => (s ? { ...s, preview_url: previewUrl(s, q.bbox, "true_color") } : null);
  return {
    provider_id: `pc-${collection}`,
    collection,
    before: withPreview(beforePick),
    after: withPreview(afterPick),
    candidates: { before: before.slice(0, LIST_PER_WINDOW), after: after.slice(0, LIST_PER_WINDOW) },
    notes,
  };
}

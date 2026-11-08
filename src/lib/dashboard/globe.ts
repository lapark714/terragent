/** Globe layers: Earth index cells aggregated to display resolutions, recent signals, request markers. */
import { getDb } from "../db/client";
import { LAYERS, playbookLayer, TERMINAL_STATUSES, type Layer, type Playbook, type RequestStatus } from "../domain";
import { cellCenter, toResolution } from "../geo/h3";
import { coarsen, scrubText, shortId } from "./mask";
import { iso, num } from "./rows";
import type { GlobeCell, GlobeData } from "./types";

/**
 * Display resolutions. config.H3_GLOBE_RES (4) cells are ~45 km across: one or two pixels on a
 * ~500 px globe. The world view uses res 3 (~120 km) so clusters read on a projector; zooming in uses res 5.
 */
const WORLD_RES = 3;
const REGION_RES = 5;

interface IndexRow { h3_cell: string; layer: string; n: number; changed: boolean }

const layerOf = (playbook: string): Layer => playbookLayer[playbook as Playbook] ?? "inbound";
const asLayer = (layer: string): Layer => ((LAYERS as readonly string[]).includes(layer) ? (layer as Layer) : "inbound");

/** Rolls stored cells (res 7–9) up to `res`; each display cell takes the layer with the most measurements. */
export function aggregateCells(rows: IndexRow[], res: number): GlobeCell[] {
  const bins = new Map<string, { counts: Map<Layer, number>; n: number; changed: boolean }>();
  for (const r of rows) {
    let parent: string;
    try {
      parent = toResolution(r.h3_cell, res);
    } catch {
      continue; // malformed cell id: skip rather than break the globe
    }
    const bin = bins.get(parent) ?? { counts: new Map(), n: 0, changed: false };
    const layer = asLayer(r.layer);
    bin.counts.set(layer, (bin.counts.get(layer) ?? 0) + num(r.n));
    bin.n += num(r.n);
    bin.changed ||= r.changed;
    bins.set(parent, bin);
  }
  return [...bins].map(([h3, bin]) => {
    const { lat, lon } = cellCenter(h3);
    const layer = [...bin.counts].sort((a, b) => b[1] - a[1] || LAYERS.indexOf(a[0]) - LAYERS.indexOf(b[0]))[0][0];
    return { h3, lat, lng: lon, layer, n: bin.n, changed: bin.changed };
  });
}

export async function getGlobeData(): Promise<GlobeData> {
  const db = await getDb();
  const [cells, signals, requests] = await Promise.all([
    db.query<IndexRow>(
      `SELECT h3_cell, layer, count(*)::int AS n, bool_or(change_flag) AS changed
       FROM earth_index GROUP BY h3_cell, layer LIMIT 50000`,
    ),
    db.query<{ id: string; playbook: string; feed: string; title: string; severity: string | null; lat: number; lon: number; created_at: unknown }>(
      `SELECT id, playbook, feed, title, severity, lat, lon, created_at FROM signals
       WHERE lat IS NOT NULL AND lon IS NOT NULL ORDER BY created_at DESC LIMIT 400`,
    ),
    db.query<{ id: string; playbook: string; status: RequestStatus; is_free_sample: boolean; lat: number; lon: number; updated_at: unknown }>(
      `SELECT id, playbook, status, is_free_sample, lat, lon, updated_at FROM requests
       WHERE lat IS NOT NULL AND lon IS NOT NULL ORDER BY updated_at DESC LIMIT 300`,
    ),
  ]);
  return {
    cells: { world: aggregateCells(cells, WORLD_RES), region: aggregateCells(cells, REGION_RES) },
    resolutions: { world: WORLD_RES, region: REGION_RES },
    signals: signals.map((s) => ({
      id: s.id,
      lat: num(s.lat),
      lng: num(s.lon),
      layer: layerOf(s.playbook),
      title: scrubText(s.title).slice(0, 140),
      feed: s.feed,
      severity: s.severity,
      at: iso(s.created_at),
    })),
    requests: requests.map((r) => ({
      id: shortId(r.id),
      lat: coarsen(num(r.lat)),
      lng: coarsen(num(r.lon)),
      layer: layerOf(r.playbook),
      status: r.status,
      active: !TERMINAL_STATUSES.has(r.status),
      sample: r.is_free_sample,
      at: iso(r.updated_at),
    })),
  };
}

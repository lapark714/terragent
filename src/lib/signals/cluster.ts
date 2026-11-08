/**
 * Point clustering for pixel feeds (FIRMS hotspots, GFW alert pixels, BLM claim centres): points whose H3
 * cells touch form one cluster, so one fire or one clearing front becomes one signal instead of hundreds.
 */
import { greatCircleDistance, gridDisk, latLngToCell, UNITS } from "h3-js";
import { isoWeek } from "./types";

export interface GeoPoint {
  lat: number;
  lon: number;
}

/** Res 7 cells are ~1.2 km across, so detections within roughly 2-3 km chain into one cluster. */
export function clusterPoints<T extends GeoPoint>(points: readonly T[], res = 7): T[][] {
  const byCell = new Map<string, T[]>();
  for (const p of points) {
    const cell = latLngToCell(p.lat, p.lon, res);
    const list = byCell.get(cell);
    if (list) list.push(p);
    else byCell.set(cell, [p]);
  }
  const parent = new Map([...byCell.keys()].map((c) => [c, c]));
  const find = (c: string): string => {
    let root = c;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(c, root);
    return root;
  };
  for (const cell of byCell.keys()) {
    for (const n of gridDisk(cell, 1)) {
      if (!byCell.has(n)) continue;
      const a = find(cell);
      const b = find(n);
      if (a !== b) parent.set(a, b);
    }
  }
  const groups = new Map<string, T[]>();
  for (const [cell, pts] of byCell) {
    const root = find(cell);
    groups.set(root, [...(groups.get(root) ?? []), ...pts]);
  }
  return [...groups.values()];
}

export function meanPoint(points: readonly GeoPoint[]): GeoPoint {
  const n = points.length || 1;
  return {
    lat: Number((points.reduce((s, p) => s + p.lat, 0) / n).toFixed(5)),
    lon: Number((points.reduce((s, p) => s + p.lon, 0) / n).toFixed(5)),
  };
}

/** Farthest point from the centre, in km: the cluster's footprint radius (continuity.ts matches on it). */
export function radiusKm(centre: GeoPoint, points: readonly GeoPoint[]): number {
  const far = Math.max(0, ...points.map((p) => greatCircleDistance([centre.lat, centre.lon], [p.lat, p.lon], UNITS.km)));
  return Number(far.toFixed(2));
}

/**
 * Dedupe keys for one poll's clusters: the res-6 cell (~36 km²) of the centre plus the ISO week first seen.
 * Clusters that share a key get their res-8 cell (~0.7 km²) appended, so a key never depends on result order.
 * Events that outlive a key (a growing fire, a clearing seen across weeks) are linked by continuity.ts.
 */
export function clusterKeys(prefix: string, clusters: readonly { centre: GeoPoint; first: Date }[]): string[] {
  const cell = (c: GeoPoint, res: number) => latLngToCell(c.lat, c.lon, res);
  const base = clusters.map((c) => `${prefix}:${cell(c.centre, 6)}:${isoWeek(c.first)}`);
  const count = new Map<string, number>();
  for (const k of base) count.set(k, (count.get(k) ?? 0) + 1);
  return base.map((k, i) => (count.get(k)! > 1 ? `${k}:${cell(clusters[i].centre, 8)}` : k));
}

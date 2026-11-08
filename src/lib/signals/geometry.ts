/**
 * Small geometry helpers for signals. SignalInput.geometry is a single GeoJSON Polygon, so multi-part
 * shapes (NWS zones, fire clusters) are reduced to their convex hull: an approximate, compact footprint.
 */
import type { Polygon } from "../domain";

export type LonLat = [number, number];

const round = (v: number, digits = 5) => Number(v.toFixed(digits));

/** Andrew's monotone chain. Returns the hull counter-clockwise, without repeating the first point. */
export function convexHull(points: LonLat[]): LonLat[] {
  const pts = [...new Map(points.map((p) => [`${p[0]},${p[1]}`, p])).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: LonLat, a: LonLat, b: LonLat) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list: LonLat[]) => {
    const out: LonLat[] = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(pts), ...half([...pts].reverse())];
}

/**
 * Convex hull as a closed Polygon. `padDeg` grows every point into a square first (e.g. half a sensor
 * pixel), so one or two points still give a real footprint. Null when there is no area.
 */
export function hullPolygon(points: LonLat[], padDeg = 0): Polygon | null {
  const grown = padDeg > 0
    ? points.flatMap(([x, y]): LonLat[] => [[x - padDeg, y - padDeg], [x + padDeg, y - padDeg], [x + padDeg, y + padDeg], [x - padDeg, y + padDeg]])
    : points;
  const hull = convexHull(grown.map(([x, y]): LonLat => [round(x), round(y)]));
  if (hull.length < 3) return null;
  return { type: "Polygon", coordinates: [[...hull, hull[0]]] };
}

/** Every exterior-ring vertex of a Polygon, MultiPolygon or GeometryCollection (others are ignored). */
export function geometryPoints(geometry: unknown): LonLat[] {
  const g = geometry as { type?: string; coordinates?: unknown; geometries?: unknown[] } | null;
  if (!g) return [];
  if (g.type === "Polygon") return ((g.coordinates as LonLat[][])[0] ?? []).map(([x, y]) => [x, y]);
  if (g.type === "MultiPolygon") return (g.coordinates as LonLat[][][]).flatMap((poly) => (poly[0] ?? []).map(([x, y]): LonLat => [x, y]));
  if (g.type === "GeometryCollection") return (g.geometries ?? []).flatMap(geometryPoints);
  return [];
}

/** Polygon with coordinates rounded to ~1 m (keeps rows small). */
export function roundPolygon(p: Polygon): Polygon {
  return { type: "Polygon", coordinates: p.coordinates.map((ring) => ring.map(([x, y]): LonLat => [round(x), round(y)])) };
}

/** Area-weighted centroid of the exterior ring; vertex mean for degenerate rings. */
export function polygonCentroid(p: Polygon): { lat: number; lon: number } {
  const ring = p.coordinates[0];
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[i + 1];
    const f = x0 * y1 - x1 * y0;
    a += f;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
  }
  if (Math.abs(a) < 1e-12) {
    const n = ring.length || 1;
    return { lon: round(ring.reduce((s, c) => s + c[0], 0) / n), lat: round(ring.reduce((s, c) => s + c[1], 0) / n) };
  }
  return { lon: round(cx / (3 * a)), lat: round(cy / (3 * a)) };
}

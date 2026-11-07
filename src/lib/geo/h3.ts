/**
 * H3 + AOI helpers shared by planner tools, the Earth index and the globe.
 * GeoJSON is [lon, lat]; h3-js latLngToCell takes (lat, lng). Pass isGeoJson=true to polygonToCells.
 */
import { cellToBoundary, cellToLatLng, cellToParent, getResolution, isValidCell, latLngToCell, polygonToCells } from "h3-js";
import type { BBox, Polygon } from "../domain";
import { H3_DEFAULT_RES } from "../config";

const KM_PER_DEG_LAT = 110.574;
const kmPerDegLon = (lat: number) => 111.32 * Math.cos((lat * Math.PI) / 180);

/** Square AOI of `sideKm` centred on a point. */
export function bboxAround(lat: number, lon: number, sideKm = 2): BBox {
  const dLat = sideKm / 2 / KM_PER_DEG_LAT;
  const dLon = sideKm / 2 / Math.max(kmPerDegLon(lat), 1e-6);
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}

export function bboxToPolygon([minLon, minLat, maxLon, maxLat]: BBox): Polygon {
  return {
    type: "Polygon",
    coordinates: [[[minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat]]],
  };
}

export function polygonBbox(p: Polygon): BBox {
  const pts = p.coordinates.flat();
  const lons = pts.map((c) => c[0]);
  const lats = pts.map((c) => c[1]);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}

/** Approximate area of a bbox in km² (fine for AOIs of a few km). */
export function bboxAreaKm2([minLon, minLat, maxLon, maxLat]: BBox): number {
  const midLat = (minLat + maxLat) / 2;
  return (maxLat - minLat) * KM_PER_DEG_LAT * (maxLon - minLon) * kmPerDegLon(midLat);
}

export function pointCell(lat: number, lon: number, res = H3_DEFAULT_RES): string {
  return latLngToCell(lat, lon, res);
}

/** Cells covering a polygon; falls back to the centroid cell for tiny AOIs. */
export function polygonCells(p: Polygon, res = H3_DEFAULT_RES): string[] {
  const cells = polygonToCells(p.coordinates, res, true);
  if (cells.length) return cells;
  const [minLon, minLat, maxLon, maxLat] = polygonBbox(p);
  return [latLngToCell((minLat + maxLat) / 2, (minLon + maxLon) / 2, res)];
}

export function cellCenter(cell: string): { lat: number; lon: number } {
  const [lat, lon] = cellToLatLng(cell);
  return { lat, lon };
}

/** GeoJSON ring [lon, lat] for drawing a cell. */
export function cellPolygon(cell: string): Polygon {
  const ring = cellToBoundary(cell, true) as [number, number][];
  return { type: "Polygon", coordinates: [[...ring, ring[0]]] };
}

export function toResolution(cell: string, res: number): string {
  return getResolution(cell) <= res ? cell : cellToParent(cell, res);
}

export { isValidCell };

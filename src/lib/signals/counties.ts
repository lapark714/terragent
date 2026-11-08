/**
 * US county internal points (Census 2025 Gazetteer, 3,222 counties incl. DC and PR), keyed by 5-digit FIPS:
 * the join key shared by FEMA, NWS SAME codes and the Census geocoder (docs/platform/signals.md §3.10).
 */
import countyCentroids from "./data/county-centroids.json";

const CENTROIDS: Record<string, number[] | undefined> = countyCentroids;
const ENTRIES = Object.entries(CENTROIDS) as [string, [number, number]][];

export function countyCentroid(fips: string): { lat: number; lon: number } | null {
  const c = CENTROIDS[fips];
  return c ? { lat: c[0], lon: c[1] } : null;
}

const toRad = (d: number) => (d * Math.PI) / 180;

function km(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lon2 - lon1) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

/**
 * Nearest county internal point. A hint, not a containment test: large western counties span 100+ km,
 * so a big distance suggests (but doesn't prove) the point is outside the US.
 */
export function nearestCounty(lat: number, lon: number): { fips: string; km: number } {
  let best = { fips: "", km: Infinity };
  for (const [fips, [clat, clon]] of ENTRIES) {
    const d = km(lat, lon, clat, clon);
    if (d < best.km) best = { fips, km: d };
  }
  return { fips: best.fips, km: Math.round(best.km) };
}

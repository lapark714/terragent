/** Formatting for report measurements. Shared by the table and the card views. */

const INDEX_NAMES = new Set(["ndvi", "ndwi", "mndwi", "nbr", "dnbr"]);

/** Precision that reads well for both areas (1,240 km²) and spectral indices (0.412). */
export function fmtMetric(v: number | null): string {
  if (v === null) return "–";
  const a = Math.abs(v);
  if (a >= 1000) return Math.round(v).toLocaleString("en-US");
  if (a >= 100) return v.toFixed(0);
  if (a >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

/** "mndwi_mean" → "MNDWI mean", "flooded_area_km2" → "Flooded area" (the unit is shown separately). */
export function metricLabel(metric: string, unit: string | null): string {
  const shown = unitLabel(unit);
  const words = metric
    .split("_")
    .filter((w) => !(unit && w === unit.toLowerCase()) && !(w === "km2" && unit) && !(shown === "%" && (w === "pct" || w === "percent")));
  const text = words.map((w) => (INDEX_NAMES.has(w) ? w.toUpperCase() : w === "km2" ? "km²" : w === "pct" ? "%" : w)).join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Pretty units: km2 → km², pct/percent → %. */
export function unitLabel(unit: string | null): string {
  if (!unit) return "";
  const u = unit.trim();
  // Spectral indices (NDVI etc.) are unitless; the label already names the index.
  if (/^(index|unitless|ratio)$/i.test(u)) return "";
  if (/^km2$/i.test(u)) return "km²";
  if (/^m2$/i.test(u)) return "m²";
  if (/^(pct|percent)$/i.test(u)) return "%";
  return u;
}

/** Signed change between before and after, when both are known. */
export function delta(before: number | null, after: number | null): number | null {
  return before === null || after === null ? null : after - before;
}

import type { PublicReport } from "@/lib/dashboard/public";

const fmt = (v: number | null) => (v === null ? "–" : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3));
const INDEX_NAMES = new Set(["ndvi", "ndwi", "mndwi", "nbr", "dnbr"]);
/** "mndwi_mean" → "MNDWI mean", "flooded_area_km2" → "Flooded area km²" */
const metricLabel = (m: string) => {
  const words = m.split("_").map((w) => (INDEX_NAMES.has(w) ? w.toUpperCase() : w === "km2" ? "km²" : w));
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
};

export function Measurements({ rows }: { rows: PublicReport["measurements"] }) {
  if (!rows.length) return null;
  return (
    <div className="scroll-quiet overflow-x-auto rounded-lg border border-line">
      <table className="w-full min-w-[34rem] text-left text-sm">
        <thead className="bg-panel text-fg-2">
          <tr>
            <th scope="col" className="px-4 py-3 font-medium">Measurement</th>
            <th scope="col" className="px-4 py-3 text-right font-medium">Before</th>
            <th scope="col" className="px-4 py-3 text-right font-medium">After</th>
            <th scope="col" className="px-4 py-3 text-right font-medium">Value</th>
            <th scope="col" className="px-4 py-3 font-medium">Unit</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((m) => (
            <tr key={m.metric} className="align-top">
              <th scope="row" className="px-4 py-3 font-normal">
                {metricLabel(m.metric)}
                {m.note && <p className="mt-1 text-fg-3">{m.note}</p>}
              </th>
              <td className="px-4 py-3 text-right tabular-nums text-fg-2">{fmt(m.before)}</td>
              <td className="px-4 py-3 text-right tabular-nums text-fg-2">{fmt(m.after)}</td>
              <td className="px-4 py-3 text-right font-medium tabular-nums">{fmt(m.value)}</td>
              <td className="px-4 py-3 text-fg-3">{m.unit ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

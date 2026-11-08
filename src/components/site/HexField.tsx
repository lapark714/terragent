/** A faint field of H3-style hexagons (the Earth index grid), fading out from one corner. */
export function HexField({ className = "" }: { className?: string }) {
  const s = 22;
  const w = Math.sqrt(3) * s;
  const d = `M${w / 2} 0L${w} ${s / 2}V${1.5 * s}L${w / 2} ${2 * s}L0 ${1.5 * s}V${s / 2}ZM${w / 2} ${2 * s}V${3 * s}`;
  return (
    <svg aria-hidden className={`pointer-events-none absolute ${className}`} style={{ maskImage: "radial-gradient(closest-side, black, transparent)" }}>
      <defs>
        <pattern id="hexfield" width={w} height={3 * s} patternUnits="userSpaceOnUse">
          <path d={d} fill="none" className="stroke-line-strong" strokeWidth="1" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#hexfield)" />
    </svg>
  );
}

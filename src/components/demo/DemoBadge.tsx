/** Always on screen under /demo, so nobody mistakes the scripted run for a real request. */
export function DemoBadge() {
  return (
    <div className="pointer-events-none fixed right-3 bottom-3 z-50 flex items-center gap-2 rounded-full border border-human/60 bg-space/85 px-3 py-1.5 font-mono text-[11px] tracking-[0.08em] text-human uppercase shadow-lg backdrop-blur-md">
      <span className="size-1.5 rounded-full bg-human" aria-hidden />
      Demo · simulated data
    </div>
  );
}

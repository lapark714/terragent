/** Placeholder bars for loading states. Pulses gently; holds still for reduced motion. */
export function Bar({ className = "" }: { className?: string }) {
  return <span aria-hidden className={`block animate-pulse rounded bg-raised motion-reduce:animate-none ${className}`} />;
}

/** Screen-reader announcement plus a visible caption, so a slow phone connection reads as "working", not "broken". */
export function LoadingCaption({ children }: { children: React.ReactNode }) {
  return (
    <p role="status" className="flex items-center gap-2.5 text-sm text-fg-3">
      <span className="beacon inline-block size-2 rounded-full bg-inbound text-inbound" aria-hidden />
      {children}
    </p>
  );
}

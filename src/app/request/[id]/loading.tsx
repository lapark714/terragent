import { Bar, LoadingCaption } from "@/components/site/Skeleton";
import { LogoLockup } from "@/components/site/Logo";

/** Mirrors the request page's layout so nothing jumps when it streams in. */
export default function Loading() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-4 sm:px-6 sm:py-5">
      <header className="mb-10 sm:mb-14 flex items-center justify-between">
        <LogoLockup className="h-7 sm:h-8" label="Terragent" />
        <Bar className="h-4 w-28" />
      </header>
      <div className="mb-10 flex flex-col gap-3">
        <Bar className="h-8 w-full" />
        <Bar className="h-8 w-2/3" />
        <Bar className="mt-2 h-4 w-40" />
      </div>
      <div className="mb-10 grid grid-cols-7 gap-1.5" aria-hidden>
        {Array.from({ length: 7 }, (_, i) => (
          <Bar key={i} className="h-1.5 rounded-full" />
        ))}
      </div>
      <LoadingCaption>Finding your request…</LoadingCaption>
      <p className="mt-16 border-t border-line pt-6 text-sm text-fg-3">AI agents run every step of this request.</p>
    </div>
  );
}

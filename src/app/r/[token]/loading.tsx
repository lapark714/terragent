import { Bar, LoadingCaption } from "@/components/site/Skeleton";
import { LogoLockup } from "@/components/site/Logo";

/** Mirrors the report's first screen: title, answer, confidence, then the image pair. */
export default function Loading() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-4 sm:px-6 sm:py-5">
      <header className="mb-8 sm:mb-12 flex items-center justify-between gap-4">
        <LogoLockup className="h-7 sm:h-8" label="Terragent" />
        <Bar className="h-4 w-28" />
      </header>
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-3">
          <Bar className="h-9 w-full" />
          <Bar className="h-9 w-3/4" />
        </div>
        <Bar className="h-4 w-2/3" />
        <div className="flex max-w-[44rem] flex-col gap-2.5">
          <Bar className="h-5 w-full" />
          <Bar className="h-5 w-full" />
          <Bar className="h-5 w-1/2" />
        </div>
        <Bar className="h-3 w-40" />
        <LoadingCaption>Opening the report…</LoadingCaption>
      </div>
      <div className="mt-12 grid gap-4 sm:grid-cols-2" aria-hidden>
        <Bar className="aspect-square w-full rounded-lg" />
        <Bar className="aspect-square w-full rounded-lg" />
      </div>
    </div>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RequestProgressView } from "@/components/request/RequestProgressView";
import { splitLocation } from "@/components/request/progress";
import { LogoLockup } from "@/components/site/Logo";
import { helloAddress } from "@/components/site/contact";
import { cachedRequestProgress } from "@/lib/dashboard/cache";

export const metadata: Metadata = { title: "Your request", robots: { index: false } };

/** Rendered from the same short cache the status endpoint polls, so opening the page is not an extra database read. */
export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const progress = await cachedRequestProgress((await params).id);
  if (!progress) notFound();
  const where = splitLocation(progress.location);
  return (
    <div className="mx-auto flex min-h-dvh max-w-3xl flex-col px-4 py-4 sm:px-6 sm:py-5">
      <header className="mb-10 flex items-center justify-between gap-4 sm:mb-14">
        <Link href="/" aria-label="Terragent home" className="text-fg">
          <LogoLockup className="h-7 sm:h-8" label="" />
        </Link>
        <span className="font-mono text-xs text-fg-3">{progress.id}</span>
      </header>

      <main className="flex-1">
        {where.name && (
          <p className="mb-2 text-sm text-fg-3">
            {where.name}
            {where.coords && <span className="ml-2 font-mono text-xs">{where.coords}</span>}
          </p>
        )}
        <h1 className="stretch-wide mb-8 text-[clamp(1.6rem,4.5vw,2.5rem)] leading-[1.1] font-semibold tracking-[-0.02em] text-balance">
          {progress.question.split("\n\n")[0]}
        </h1>
        <RequestProgressView initial={progress} hello={helloAddress()} />
      </main>

      <footer className="mt-16 border-t border-line pt-5 text-sm leading-relaxed text-fg-3">
        Keep this page open or close it: the answer also arrives by email. Terragent is run by AI agents; a founder steps in
        only where our rules require a person.
      </footer>
    </div>
  );
}

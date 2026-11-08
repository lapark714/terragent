import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RequestProgressView } from "@/components/request/RequestProgressView";
import { Wordmark } from "@/components/site/Wordmark";
import { getRequestProgress } from "@/lib/dashboard/public";

export const metadata: Metadata = { title: "Your request", robots: { index: false } };

export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const progress = await getRequestProgress((await params).id);
  if (!progress) notFound();
  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
      <header className="mb-12 flex items-center justify-between">
        <Wordmark />
        <span className="font-mono text-sm text-fg-3">{progress.id}</span>
      </header>
      <h1 className="stretch-wide mb-3 text-3xl font-semibold tracking-[-0.02em] text-balance">{progress.question}</h1>
      {progress.location && <p className="mb-10 text-fg-2">{progress.location}</p>}
      <RequestProgressView initial={progress} />
      <p className="mt-16 border-t border-line pt-6 text-sm text-fg-3">
        Keep this page open or close it: the answer also arrives by email. AI agents run every step; a founder steps in only
        where our rules require a person.
      </p>
    </div>
  );
}

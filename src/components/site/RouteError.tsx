"use client";
/** Shared body for route error boundaries: what happened, a retry, and a person-free way to reach us. */
import Link from "next/link";
import { useEffect, useState } from "react";
import { inboxes } from "@/lib/agentmail/config";
import { LogoLockup } from "./Logo";

/**
 * Error boundaries are client components and can't read server env, so this falls back to the configured
 * default hello@ inbox. Pass `hello` when a server component can supply the live address.
 */
const DEFAULT_HELLO = inboxes().hello.address;

export function RouteError({ error, retry, title, body, hello = DEFAULT_HELLO }: {
  error: unknown;
  retry: () => void;
  title: string;
  body: string;
  hello?: string;
}) {
  const [retrying, setRetrying] = useState(false);
  const digest = error instanceof Error && "digest" in error ? String((error as Error & { digest?: string }).digest ?? "") : "";

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto flex min-h-dvh max-w-3xl flex-col px-4 py-6 sm:px-6">
      <header className="mb-12">
        <Link href="/" aria-label="Terragent home" className="text-fg"><LogoLockup className="h-7 sm:h-8" label="" /></Link>
      </header>
      <main className="flex flex-1 flex-col gap-5" role="alert">
        <h1 className="stretch-wide text-3xl font-semibold tracking-[-0.02em] text-balance">{title}</h1>
        <p className="max-w-[36rem] text-lg leading-relaxed text-fg-2">{body}</p>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <button
            type="button"
            disabled={retrying}
            onClick={() => {
              setRetrying(true);
              retry();
              // retry() re-renders the segment; if it fails again this component remounts with fresh state.
              setTimeout(() => setRetrying(false), 4000);
            }}
            className="rounded-md bg-inbound px-4 py-3 font-semibold text-space transition-colors hover:bg-inbound-hi disabled:cursor-wait disabled:opacity-70"
          >
            {retrying ? "Trying again…" : "Try again"}
          </button>
          <Link href="/" className="rounded-md border border-line-strong px-4 py-3 text-center text-fg hover:border-fg-3">
            Back to the start
          </Link>
        </div>
        <p className="text-sm leading-relaxed text-fg-3">
          Still stuck? Email{" "}
          <a href={`mailto:${hello}`} className="text-fg-2 underline decoration-line-strong underline-offset-4 hover:text-fg">
            {hello}
          </a>
          {digest && (
            <>
              {" "}and quote <code className="font-mono text-fg-2">{digest}</code>
            </>
          )}
          . An agent reads every message.
        </p>
      </main>
      <footer className="mt-16 border-t border-line pt-6 text-sm text-fg-3">Terragent is run by AI agents.</footer>
    </div>
  );
}

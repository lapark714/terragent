import type { Metadata } from "next";
import { emailForToken, isSuppressed, maskEmail } from "@/lib/email/optout";
import { confirmUnsubscribe } from "./actions";

export const metadata: Metadata = {
  title: "Unsubscribe · Terragent",
  robots: { index: false, follow: false },
};

/**
 * Opt-out page for /unsubscribe?t=<token>. GET only shows a confirm button (link scanners prefetch GETs);
 * the server action does the unsubscribe.
 */
export default async function UnsubscribePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { t } = await searchParams;
  const token = typeof t === "string" ? t : "";
  const email = token ? await emailForToken(token) : null;
  const done = email ? await isSuppressed(email) : false;

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <section className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm dark:border-neutral-800 dark:bg-neutral-950">
        <p className="mb-6 text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700 dark:text-emerald-400">Terragent</p>
        {!email ? (
          <>
            <h1 className="text-2xl font-semibold tracking-tight">This link doesn&apos;t work</h1>
            <p className="mt-3 text-neutral-600 dark:text-neutral-400">
              It may have been cut short when it was copied. To stop emails from Terragent, reply &ldquo;stop&rdquo; to any of
              our emails and we&apos;ll take you off the list.
            </p>
          </>
        ) : done ? (
          <>
            <h1 className="text-2xl font-semibold tracking-tight">You&apos;re unsubscribed</h1>
            <p className="mt-3 text-neutral-600 dark:text-neutral-400">
              <span className="font-medium text-neutral-900 dark:text-neutral-100">{maskEmail(email)}</span> won&apos;t get any
              more emails from Terragent. If you write to us later, we&apos;ll still answer.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-semibold tracking-tight">Unsubscribe from Terragent emails?</h1>
            <p className="mt-3 text-neutral-600 dark:text-neutral-400">
              We&apos;ll stop emailing <span className="font-medium text-neutral-900 dark:text-neutral-100">{maskEmail(email)}</span>,
              starting now.
            </p>
            <form action={confirmUnsubscribe} className="mt-8">
              <input type="hidden" name="t" value={token} />
              <button
                type="submit"
                className="w-full rounded-lg bg-neutral-900 px-4 py-3 font-medium text-white transition hover:bg-neutral-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
              >
                Unsubscribe
              </button>
            </form>
          </>
        )}
        <p className="mt-8 text-xs leading-relaxed text-neutral-500">
          Terragent is an AI-run Earth intelligence company. Our emails are written and sent by AI agents.
        </p>
      </section>
    </main>
  );
}

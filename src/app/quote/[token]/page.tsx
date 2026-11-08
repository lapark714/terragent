import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getQuoteByToken, QUOTE_ACCEPT_ERRORS, type PublicQuoteOption, type QuoteByToken } from "@/lib/dashboard/public";
import { DbPausedError, dbRead } from "@/lib/dashboard/rows";
import { dayText, resolutionText } from "@/lib/email/templates";

export const metadata: Metadata = { title: "Your quote", robots: { index: false, follow: false } };

type Props = { params: Promise<{ token: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * /quote/<accept_token>: the customer's quote (pricing v2) with one Accept button per option. The token is the only
 * credential. GET only reads (link scanners prefetch GETs); each button is a plain form POST to /api/quotes/accept,
 * which records the choice and redirects back here.
 *
 * Deliberately plain and server-rendered (no client JS). Aiden owns the public pages and may restyle this one;
 * keep the form fields (token, option_id) and the POST target.
 */
export default async function QuotePage({ params, searchParams }: Props) {
  const { token } = await params;
  const { error } = await searchParams;
  let found: QuoteByToken | null;
  try {
    found = await dbRead(() => getQuoteByToken(token));
  } catch (e) {
    if (!(e instanceof DbPausedError)) console.error("[quote page] lookup failed:", e);
    return (
      <Shell>
        <h1 className="text-2xl font-semibold tracking-tight">We can&apos;t show your quote just now</h1>
        <p className="mt-3 text-fg-2">{QUOTE_ACCEPT_ERRORS.unavailable}</p>
      </Shell>
    );
  }
  if (!found) notFound();

  const { quote, requestId } = found;
  const errorText = typeof error === "string" ? QUOTE_ACCEPT_ERRORS[error] : undefined;
  const open = !quote.closed_reason;
  const closedText = quote.closed_reason ? QUOTE_ACCEPT_ERRORS[quote.closed_reason] : undefined;
  const until = dayText(quote.valid_until);
  const acceptedOn = dayText(quote.accepted_at);
  const ids = quote.options.map((o) => o.option_id);
  const recommended = quote.recommended_option_id ?? ids[0];
  const paid = quote.options.some((o) => o.kind !== "free_data");

  return (
    <Shell requestId={requestId}>
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Your quote</h1>
      <p className="mt-3 text-fg-2">&ldquo;{found.question.split("\n\n")[0].trim()}&rdquo;</p>

      {quote.accepted_option_id ? (
        <Notice tone="done">
          You accepted option {quote.accepted_option_id}
          {acceptedOn ? ` on ${acceptedOn}` : ""}. Follow the progress on{" "}
          <Link href={`/request/${requestId}`} className="underline underline-offset-4">
            your request page
          </Link>
          ; the answer also arrives by email.
        </Notice>
      ) : quote.closed_reason ? (
        <Notice tone="stop">{closedText}</Notice>
      ) : (
        <p className="mt-6 text-fg-2">
          Checking which satellite data can answer your question was free. Nothing else happens, and nothing is bought or
          charged, until you choose an option.
        </p>
      )}
      {errorText && errorText !== closedText && <Notice tone="stop">{errorText}</Notice>}

      <ol className="mt-8 flex flex-col gap-4">
        {quote.options.map((o) => (
          <li
            key={o.option_id}
            className={`rounded-lg border bg-panel p-5 ${o.option_id === quote.accepted_option_id ? "border-inbound" : "border-line"}`}
          >
            <p className="font-mono text-xs tracking-[0.08em] text-fg-3 uppercase">
              Option {o.option_id}
              {ids.length > 1 && o.option_id === recommended && " · Recommended"}
              {o.option_id === quote.accepted_option_id && " · Accepted"}
            </p>
            <h2 className="mt-1 text-lg font-semibold">{o.label}</h2>
            {o.answers && <p className="mt-2 text-fg-2">{o.answers}</p>}
            <dl className="mt-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-fg-3">Data</dt>
              <dd>{dataText(o)}</dd>
              {o.delivery_time && (
                <>
                  <dt className="text-fg-3">Delivery</dt>
                  <dd>{o.delivery_time}</dd>
                </>
              )}
              <dt className="text-fg-3">Price</dt>
              <dd className="font-semibold">
                {priceText(o)}
                {o.price_range_usd && (
                  <span className="font-normal text-fg-3"> (estimate: the supplier&apos;s exact price isn&apos;t confirmed yet)</span>
                )}
              </dd>
            </dl>
            {open && (
              <form method="post" action="/api/quotes/accept" className="mt-5">
                <input type="hidden" name="token" value={token} />
                <input type="hidden" name="option_id" value={o.option_id} />
                <button
                  type="submit"
                  className="rounded-md bg-inbound px-4 py-3 font-semibold text-space transition-colors hover:bg-inbound-hi"
                >
                  Accept option {o.option_id} · {priceText(o)}
                </button>
              </form>
            )}
          </li>
        ))}
      </ol>

      <div className="mt-8 flex flex-col gap-2 text-sm leading-relaxed text-fg-3">
        {open && (
          <p>
            Prefer email? Reply &ldquo;yes&rdquo; to the quote email for option {recommended}
            {ids.length > 1 ? ", or reply with the letter of the option you want" : ""}.
          </p>
        )}
        {paid && <p>We buy paid imagery only after you accept an option that needs it.</p>}
        {open && until && <p>This quote is valid until {until}.</p>}
      </div>
    </Shell>
  );
}

function Shell({ children, requestId }: { children: React.ReactNode; requestId?: string }) {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6">
      <p className="mb-8 flex items-center justify-between gap-4 text-xs">
        <Link href="/" className="font-semibold tracking-[0.2em] text-fg uppercase">
          Terragent
        </Link>
        {requestId && (
          <Link href={`/request/${requestId}`} className="font-mono text-fg-3 underline-offset-4 hover:underline">
            {requestId}
          </Link>
        )}
      </p>
      {children}
      <p className="mt-12 border-t border-line pt-5 text-xs leading-relaxed text-fg-3">
        Terragent is an AI-run Earth intelligence company. This quote was prepared by AI agents; reply to the quote email
        with any question.
      </p>
    </main>
  );
}

function Notice({ tone, children }: { tone: "done" | "stop"; children: React.ReactNode }) {
  return (
    <p
      role="status"
      className={`mt-6 rounded-md border px-4 py-3 ${tone === "done" ? "border-inbound/60 bg-inbound/10" : "border-alert/50 bg-alert/10"}`}
    >
      {children}
    </p>
  );
}

const usd = (n: number) => `$${n.toFixed(n % 1 === 0 ? 0 : 2)}`;

const priceText = (o: PublicQuoteOption) =>
  o.price_usd !== null ? usd(o.price_usd) : o.price_range_usd ? `${usd(o.price_range_usd[0])}–${usd(o.price_range_usd[1])}` : "on request";

const KIND: Record<PublicQuoteOption["kind"], string> = {
  free_data: "Free public satellite data",
  archive: "Archive imagery, bought after you accept",
  tasking: "A new satellite capture, ordered after you accept",
  mixed: "Free and paid data combined",
};

function dataText(o: PublicQuoteOption): string {
  return [
    KIND[o.kind],
    o.resolution_m ? `${resolutionText(o.resolution_m)} detail` : "",
    o.epochs ? `${o.epochs} date${o.epochs === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

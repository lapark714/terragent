"use client";
/**
 * "Your choice" (pricing v2): the free investigation ends in a quote of 1–3 options, and nothing else runs until the
 * customer accepts one. One card per option, the recommended one first; one Accept button each, which POSTs
 * { token, option_id } to /api/quotes/accept (the service behind the quote page and the email reply). The choice
 * shows at once and polling catches up. Rendered inside Outcome's waiting frame; the pure parts live in quote.ts.
 */
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import type { PublicQuote, PublicQuoteOption } from "@/lib/dashboard/public";
import type { QuoteOptionId } from "@/lib/domain";
import {
  acceptLabel, afterChoiceText, chosenText, CLOSED_TEXT, CONFIDENCE_TEXT, dataText, emailHint, ESTIMATE_NOTE, introText, isEstimate,
  NETWORK_ERROR, orderOptions, priceText, quotePath, quoteState, readAcceptResponse, recommendedId, resolutionText,
  SOURCE_TEXT, validUntilText, type AcceptResult,
} from "./quote";

const linkClass = "text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg";

type Post =
  | { state: "idle" }
  | { state: "posting"; optionId: QuoteOptionId }
  | { state: "done"; optionId: QuoteOptionId }
  | { state: "error"; message: string };

export function QuoteChoice({ quote, requestId, contact, onAccepted, onDemoAccept }: {
  quote: PublicQuote;
  requestId: string;
  /** The hello@ mail link, as Outcome renders it. */
  contact: React.ReactNode;
  /** Ask the page to poll now, so the server's view of the choice replaces the optimistic one sooner. */
  onAccepted?: () => void;
  /** /demo only: record the choice locally instead of posting it. */
  onDemoAccept?: (optionId: QuoteOptionId) => void;
}) {
  const [post, setPost] = useState<Post>({ state: "idle" });
  // A ref, not state: two fast clicks land before React re-renders, and only the first may post.
  const inFlight = useRef(false);
  const result = useRef<HTMLParagraphElement>(null);
  const headingId = useId();
  const state = quoteState(quote);
  const chosen = state.kind === "accepted" ? state.optionId : post.state === "done" ? post.optionId : null;

  // The buttons are gone once a choice is made: move focus to the confirmation so keyboard and screen-reader users land on it.
  useEffect(() => {
    if (post.state === "done") result.current?.focus();
  }, [post.state]);

  if (chosen) {
    const option = quote.options.find((o) => o.option_id === chosen);
    return (
      <div className="flex flex-col gap-2">
        <p ref={result} tabIndex={-1} role="status" className="text-lg leading-relaxed">
          {chosenText(quote, chosen, state.kind === "accepted" ? state.at : null)}.
        </p>
        <p className="text-fg-2">{afterChoiceText(option?.kind)}</p>
      </div>
    );
  }

  if (state.kind === "closed") {
    return (
      <>
        <p className="text-lg leading-relaxed">{CLOSED_TEXT[state.reason]}</p>
        <p className="text-sm text-fg-3">
          Reply in the quote email thread, or write to {contact} and mention <code className="font-mono text-fg">{requestId}</code>.
        </p>
      </>
    );
  }

  const token = state.kind === "open" ? state.token : null;
  const recommended = recommendedId(quote);
  const options = orderOptions(quote.options, recommended);
  const markRecommended = options.length > 1;
  const busy = post.state === "posting";

  async function accept(optionId: QuoteOptionId) {
    if (inFlight.current || !token) return;
    inFlight.current = true;
    setPost({ state: "posting", optionId });
    if (onDemoAccept) {
      await new Promise((done) => setTimeout(done, 700));
      setPost({ state: "done", optionId });
      onDemoAccept(optionId);
      return;
    }
    let r: AcceptResult;
    try {
      const res = await fetch("/api/quotes/accept", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ token, option_id: optionId }),
        cache: "no-store",
      });
      r = readAcceptResponse(res.status, await res.json().catch(() => null), optionId);
    } catch {
      r = { ok: false, message: NETWORK_ERROR, acceptedOptionId: null };
    }
    // After a success the buttons are gone; keep the guard closed so nothing can post a second option.
    inFlight.current = r.ok;
    setPost(r.ok ? { state: "done", optionId: r.optionId } : { state: "error", message: r.message });
    // Success, or a refusal like "already accepted with another option": either way the server now knows more than we do.
    onAccepted?.();
  }

  return (
    <>
      {/* The page outline: h1 (the question) → h2 (this list; the eyebrow above is only a label) → h3 per option. */}
      <h2 id={headingId} className="sr-only">Your options</h2>
      <p className="text-lg leading-relaxed">{introText(!!token)}</p>

      <ol className="flex flex-col gap-3" aria-labelledby={headingId}>
        {options.map((o, i) => (
          <OptionCard
            key={o.option_id}
            option={o}
            recommended={markRecommended && o.option_id === recommended}
            primary={i === 0}
            canAccept={!!token}
            busy={busy}
            posting={post.state === "posting" && post.optionId === o.option_id}
            onAccept={() => accept(o.option_id)}
          />
        ))}
      </ol>

      <div aria-live="polite" aria-atomic="true">
        {post.state === "error" && (
          <p className="rounded-md border border-alert/50 bg-alert/[0.06] px-3 py-2 text-sm text-fg">{post.message}</p>
        )}
      </div>

      <div className="flex flex-col gap-1.5 text-sm leading-relaxed text-fg-3">
        <p>{emailHint(options.map((o) => o.option_id).sort(), recommended, !!token)}</p>
        <p>We only buy paid imagery after you accept.</p>
        {validUntilText(quote.valid_until) && <p>{validUntilText(quote.valid_until)}</p>}
        {token && (
          <p>
            <Link href={quotePath(token)} className={linkClass}>Open the quote page</Link>
          </p>
        )}
      </div>
    </>
  );
}

function OptionCard({ option: o, recommended, primary, canAccept, busy, posting, onAccept }: {
  option: PublicQuoteOption;
  recommended: boolean;
  /** The first card (the recommended one, or the only one) gets the filled button; the others an outlined one. */
  primary: boolean;
  canAccept: boolean;
  busy: boolean;
  posting: boolean;
  onAccept: () => void;
}) {
  const resolution = resolutionText(o.resolution_m);
  const data = dataText(o);
  const conf = CONFIDENCE_TEXT[o.confidence];
  return (
    <li className={`flex flex-col gap-4 rounded-lg border bg-panel p-4 sm:p-5 ${recommended ? "border-inbound" : "border-line"}`}>
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className={`font-mono text-xs tracking-[0.08em] uppercase ${recommended ? "text-inbound-hi" : "text-fg-3"}`}>
            Option {o.option_id}
            {recommended && " · Recommended"}
          </p>
          <p className="stretch-semi text-xl font-semibold tabular-nums">{priceText(o)}</p>
        </div>
        <h3 className="text-lg leading-snug font-semibold text-balance">{o.label}</h3>
        {isEstimate(o) && <p className="text-sm text-fg-3">{ESTIMATE_NOTE}</p>}
      </div>

      {o.answers && <p className="leading-relaxed text-fg-2">{o.answers}</p>}

      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
        {resolution && (
          <>
            <dt className="text-fg-3">Resolution</dt>
            <dd>{resolution}</dd>
          </>
        )}
        <dt className="text-fg-3">Source</dt>
        <dd>{SOURCE_TEXT[o.kind]}</dd>
        {data && (
          <>
            <dt className="text-fg-3">Data</dt>
            <dd>{data}</dd>
          </>
        )}
        {o.delivery_time && (
          <>
            <dt className="text-fg-3">Delivery</dt>
            <dd>{o.delivery_time}</dd>
          </>
        )}
        <dt className="text-fg-3">Confidence</dt>
        <dd className="flex items-center gap-2">
          <span className="flex gap-0.5" aria-hidden>
            {[0, 1, 2].map((i) => (
              <span key={i} className={`h-1.5 w-4 rounded-full ${i < conf.filled ? "bg-fg" : "bg-line-strong"}`} />
            ))}
          </span>
          {conf.label}
        </dd>
      </dl>

      {canAccept && (
        <button
          type="button"
          onClick={onAccept}
          aria-disabled={busy || undefined}
          aria-busy={posting || undefined}
          className={`w-full rounded-md px-4 py-3 font-semibold transition-colors aria-disabled:cursor-wait aria-disabled:opacity-70 sm:w-auto sm:self-start ${
            primary
              ? "bg-inbound text-space hover:bg-inbound-hi aria-disabled:hover:bg-inbound"
              : "border border-line-strong text-fg hover:border-fg-3 aria-disabled:hover:border-line-strong"
          }`}
        >
          {posting ? `Accepting option ${o.option_id}…` : acceptLabel(o)}
        </button>
      )}
    </li>
  );
}

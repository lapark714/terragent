"use client";
/**
 * The one block that says what this request needs or has become: the answer when delivered,
 * a clear stop for refused / failed, the quote to choose from (pricing v2: nothing runs until the customer accepts
 * an option), or "your move" when we're waiting on the customer or a founder.
 * Returns null while agents are simply working.
 */
import Link from "next/link";
import { ConfidenceMeter } from "@/components/report/ConfidenceMeter";
import { CopyLink } from "@/components/report/CopyLink";
import type { RequestProgress } from "@/lib/dashboard/public";
import type { QuoteOptionId } from "@/lib/domain";
import { Elapsed } from "./Elapsed";
import { showsQuoteChoice } from "./progress";
import { QuoteChoice } from "./QuoteChoice";

const linkClass = "text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg";

/**
 * `live` (default on) announces the frame's content when it changes. Off for the quote: QuoteChoice announces its own
 * confirmation (role=status) and errors (aria-live), and a live frame would read them twice, plus every card and button label.
 */
function Frame({ tone, eyebrow, live = true, children }: {
  tone: "answer" | "stop" | "wait" | "human";
  eyebrow: string;
  live?: boolean;
  children: React.ReactNode;
}) {
  const TONE = {
    answer: "border-inbound/60 bg-panel",
    stop: "border-alert/50 bg-alert/[0.06]",
    wait: "border-inbound/50 bg-inbound/[0.07]",
    human: "border-human/50 bg-human/[0.07]",
  } as const;
  const EYEBROW = { answer: "text-inbound-hi", stop: "text-alert", wait: "text-inbound-hi", human: "text-human" } as const;
  return (
    <section aria-live={live ? "polite" : undefined} className={`flex flex-col gap-4 rounded-lg border p-5 sm:p-6 ${TONE[tone]}`}>
      <p className={`font-mono text-xs tracking-[0.08em] uppercase ${EYEBROW[tone]}`}>{eyebrow}</p>
      {children}
    </section>
  );
}

export function Outcome({ progress: p, hello, onQuoteAccepted, onDemoAccept, demo = false }: {
  progress: RequestProgress;
  hello: string;
  /** Called after an Accept button posts, so the page can poll at once. */
  onQuoteAccepted?: () => void;
  /** /demo only: QuoteChoice records the choice locally instead of posting it. */
  onDemoAccept?: (optionId: QuoteOptionId) => void;
  /** /demo: the paid-imagery wait reads as an order in progress, without narrating who places it. */
  demo?: boolean;
}) {
  const mail = (
    <a href={`mailto:${hello}?subject=${encodeURIComponent(`About ${p.id}`)}`} className={linkClass}>
      {hello}
    </a>
  );

  if (p.status === "delivered" && p.report) {
    const r = p.report;
    return (
      <Frame tone="answer" eyebrow="Your answer is ready">
        <h2 className="stretch-semi text-xl leading-snug font-semibold text-balance">{r.title}</h2>
        <p className="text-lg leading-relaxed">{r.answer}</p>
        <ConfidenceMeter level={r.confidence} />
        {r.humanReview && (
          <p className="rounded-md border border-human/50 bg-human/10 px-3 py-2 text-sm text-fg">
            Human review recommended before you rely on this for insurance, legal, lending or safety decisions.
          </p>
        )}
        <div className="flex flex-col gap-3 pt-1 sm:flex-row sm:items-center">
          <Link href={r.path} className="rounded-md bg-inbound px-4 py-3 text-center font-semibold text-space transition-colors hover:bg-inbound-hi">
            Open the full report
          </Link>
          <CopyLink url={r.url} className="py-3" />
          <span className="text-sm text-fg-3 sm:ml-auto">
            Answered in <Elapsed since={p.createdAt} until={p.updatedAt} />
          </span>
        </div>
      </Frame>
    );
  }

  if (p.status === "delivered") {
    return (
      <Frame tone="answer" eyebrow="Delivered">
        <p className="text-lg leading-relaxed">Your answer was sent by email. Check the thread you used to ask.</p>
      </Frame>
    );
  }

  if (p.status === "refused") {
    return (
      <Frame tone="stop" eyebrow="We can't take this request">
        <p className="text-lg leading-relaxed">{p.refusalReason ?? "It falls outside what we answer."}</p>
        <p className="text-fg-2">
          We refuse anything that targets or tracks people. See our{" "}
          <Link href="/acceptable-use" className={linkClass}>acceptable use policy</Link>. If you think we got this wrong, write to {mail}.
        </p>
      </Frame>
    );
  }

  if (p.status === "failed" || p.status === "cancelled") {
    return (
      <Frame tone="stop" eyebrow={p.status === "failed" ? "This request stopped" : "Cancelled"}>
        <p className="text-lg leading-relaxed">
          {p.status === "failed"
            ? "Something went wrong before an answer was ready. The agents have logged it, and we'll email you about what happens next."
            : "This request was cancelled before an answer was ready."}
        </p>
        <p className="text-fg-2">Questions? Write to {mail} and mention <code className="font-mono text-fg">{p.id}</code>.</p>
      </Frame>
    );
  }

  if (p.quote && showsQuoteChoice(p)) {
    return (
      <Frame tone="wait" eyebrow="Your quote" live={false}>
        <QuoteChoice quote={p.quote} requestId={p.id} contact={mail} onAccepted={onQuoteAccepted} onDemoAccept={onDemoAccept} />
      </Frame>
    );
  }

  if (p.status === "clarifying" || p.status === "quoted") {
    return (
      <Frame tone="wait" eyebrow="Your move">
        <p className="text-lg leading-relaxed">
          {p.status === "clarifying"
            ? "We emailed you a question. Reply in the same thread and the agents carry on from there."
            : "We emailed you a quote. Reply to accept it and the agents start on the data."}
        </p>
        <p className="text-sm text-fg-3">Can&apos;t find it? Check spam, or write to {mail}.</p>
      </Frame>
    );
  }

  if (p.status === "awaiting_approval" && demo) {
    return (
      <Frame tone="wait" eyebrow="Ordering your imagery">
        <p className="leading-relaxed text-fg">
          The imagery for the option you chose is on order. The analysis starts as soon as it arrives, and the answer also comes by email.
        </p>
      </Frame>
    );
  }

  if (p.status === "awaiting_approval") {
    return (
      <Frame tone="human" eyebrow="A founder is buying your data">
        <p className="leading-relaxed text-fg">
          {p.quote?.accepted_option_id ? "Buying the imagery for the option you chose." : "Buying the imagery for your request."} We place
          paid data orders by hand; the analysis starts as soon as the data arrives.
        </p>
      </Frame>
    );
  }

  return null;
}

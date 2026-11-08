/**
 * The report's first screen: what was asked, the answer, how sure we are, what it can't tell you,
 * and the human-review callout. Sized so answer + confidence land above the fold on a 375×812 phone.
 */
import { dateUtc } from "@/components/format";
import type { PublicReport } from "@/lib/dashboard/public";
import { ConfidenceMeter } from "./ConfidenceMeter";
import { CopyLink } from "./CopyLink";

export function HumanReview({ className = "" }: { className?: string }) {
  return (
    <aside className={`flex gap-3 rounded-lg border border-human/50 bg-human/[0.08] px-4 py-3.5 ${className}`}>
      <svg viewBox="0 0 16 16" className="mt-0.5 size-4 shrink-0 text-human" aria-hidden>
        <circle cx="8" cy="5" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <path d="M2.8 14c.6-2.8 2.7-4.3 5.2-4.3s4.6 1.5 5.2 4.3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
      <p className="text-sm leading-relaxed text-fg">
        <strong className="font-semibold">Human review recommended.</strong>{" "}
        <span className="text-fg-2">
          If you&apos;ll use this for an insurance claim, a legal matter, lending or safety, have a qualified person check it first.
        </span>
      </p>
    </aside>
  );
}

export function Limitations({ text, className = "" }: { text: string; className?: string }) {
  return (
    <aside aria-labelledby="limitations-h" className={`flex flex-col gap-1.5 border-l-2 border-line-strong pl-4 ${className}`}>
      <h2 id="limitations-h" className="text-sm font-medium text-fg">What this can&apos;t tell you</h2>
      <p className="text-sm leading-relaxed text-fg-2">{text}</p>
    </aside>
  );
}

export function ReportHero({ report: r, url }: { report: PublicReport; url?: string }) {
  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-fg-2">
        <span className="text-fg-3">You asked </span>
        <span className="text-fg">{r.question}</span>
        {r.location && <span className="text-fg-3"> · {r.location}</span>}
      </p>
      <h1 className="stretch-wide text-[clamp(1.6rem,4.5vw,3rem)] leading-[1.08] font-semibold tracking-[-0.02em] text-balance">{r.title}</h1>
      <p className="max-w-[44rem] text-lg leading-relaxed sm:text-xl">{r.answer}</p>
      <ConfidenceMeter level={r.confidence} />
      {r.humanReview && <HumanReview className="max-w-[44rem]" />}
      <Limitations text={r.limitations} className="max-w-[44rem]" />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <CopyLink url={url} />
        <span className="text-sm text-fg-3">
          Verified <time dateTime={r.verifiedAt}>{dateUtc(r.verifiedAt)}</time> · AI-generated
        </span>
      </div>
    </div>
  );
}

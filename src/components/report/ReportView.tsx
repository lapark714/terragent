/** The public report: answer first, then evidence (images, measurements), caveats and sources. */
import { dateUtc, usd } from "@/components/format";
import { Wordmark } from "@/components/site/Wordmark";
import type { PublicReport } from "@/lib/dashboard/public";
import { ConfidenceMeter } from "./ConfidenceMeter";
import { Measurements } from "./Measurements";
import { ReportImages } from "./ReportImages";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="stretch-semi text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function ReportView({ report: r }: { report: PublicReport }) {
  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6">
      <header className="mb-12 flex items-center justify-between gap-4">
        <Wordmark suffix="Report" />
        <span className="text-sm text-fg-3">Verified {dateUtc(r.verifiedAt)}</span>
      </header>

      <article className="flex flex-col gap-12">
        <div className="flex flex-col gap-5">
          <h1 className="stretch-wide text-[clamp(2rem,4.5vw,3.2rem)] leading-[1.05] font-semibold tracking-[-0.02em] text-balance">{r.title}</h1>
          <p className="text-fg-2">
            You asked: <span className="text-fg">{r.question}</span>
            {r.location && <span className="text-fg-3"> ({r.location})</span>}
          </p>
          <p className="max-w-[44rem] text-xl leading-relaxed">{r.answer}</p>
          <ConfidenceMeter level={r.confidence} />
          {r.humanReview && (
            <p className="max-w-[44rem] rounded-md border border-human/50 bg-human/10 px-4 py-3 text-fg">
              Human review recommended. If you&apos;ll use this for an insurance claim, a legal matter, lending or safety, have a
              qualified person check it first.
            </p>
          )}
        </div>

        {r.images.length > 0 && (
          <Section title="Images">
            <ReportImages images={r.images} />
          </Section>
        )}

        {r.measurements.length > 0 && (
          <Section title="Measurements">
            <Measurements rows={r.measurements} />
          </Section>
        )}

        <Section title="Limitations">
          <p className="max-w-[44rem] leading-relaxed text-fg-2">{r.limitations}</p>
        </Section>

        {r.paidDataEstimate && (
          <Section title="What paid imagery would add">
            <p className="max-w-[44rem] leading-relaxed text-fg-2">
              {r.paidDataEstimate.wouldShow} Estimated data cost: {usd(r.paidDataEstimate.estCostUsd)} ({r.paidDataEstimate.providerId}).
              We only buy imagery when you ask us to and a founder approves the purchase.
            </p>
          </Section>
        )}

        <Section title="Sources">
          <ul className="flex flex-col divide-y divide-line border-y border-line text-sm">
            {r.sources.map((s, i) => (
              <li key={i} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
                <span className="min-w-0">
                  {s.url ? <a href={s.url} className="underline decoration-line-strong underline-offset-4 hover:decoration-fg" rel="noreferrer">{s.name}</a> : s.name}
                  {s.itemId && <span className="ml-2 font-mono text-xs break-all text-fg-3">{s.itemId}</span>}
                </span>
                <span className="shrink-0 text-fg-2">
                  {dateUtc(s.datetime)}
                  {s.license && <span className="text-fg-3">, {s.license}</span>}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      </article>

      <footer className="mt-16 border-t border-line pt-6 text-sm leading-relaxed text-fg-3">
        <p>
          Written by Terragent&apos;s AI agents from satellite data and checked by a separate verifier agent
          {r.verifierScore !== null && <> (score {Math.round(r.verifierScore)} of 100)</>}. This is not a site inspection.{" "}
          <a href="/terms" className="underline underline-offset-4 hover:text-fg">Terms</a> and{" "}
          <a href="/acceptable-use" className="underline underline-offset-4 hover:text-fg">acceptable use</a>.
        </p>
      </footer>
    </div>
  );
}

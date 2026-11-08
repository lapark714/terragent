/**
 * The public report. First screen: question, answer, confidence, limitations, human-review callout, share link.
 * Then the evidence: a before/after comparison, other derived maps, measurement cards, and dated sources.
 */
import Link from "next/link";
import { LogoLockup } from "@/components/site/Logo";
import type { PublicReport } from "@/lib/dashboard/public";
import { dateUtc, usd } from "@/components/format";
import { BeforeAfter } from "./BeforeAfter";
import { MeasurementCards } from "./MeasurementCards";
import { ReportHero } from "./ReportHero";
import { SatImage } from "./SatImage";
import { SourceList } from "./SourceList";

const ROLE_LABEL: Record<string, string> = { before: "Before", after: "After", index: "Index map", change: "Change map" };

function Section({ title, children, note }: { title: string; note?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="stretch-semi text-xl font-semibold">{title}</h2>
        {note && <p className="text-sm text-fg-3">{note}</p>}
      </div>
      {children}
    </section>
  );
}

function ImageCard({ img }: { img: PublicReport["images"][number] }) {
  const label = ROLE_LABEL[img.role] ?? img.role;
  return (
    <figure className="overflow-hidden rounded-xl border border-line bg-panel">
      <SatImage src={img.src} alt={img.caption || label} label={label} />
      <figcaption className="flex flex-col gap-1 p-4 text-sm">
        <span className="font-medium">
          {label}
          {img.date && <span className="font-normal text-fg-2">, {dateUtc(img.date)}</span>}
        </span>
        {img.caption && <span className="text-fg-2">{img.caption}</span>}
        {img.source && <span className="text-fg-3">{img.source}</span>}
      </figcaption>
    </figure>
  );
}

/** `home` is where the logo links and `demo` adjusts the purchase wording (both for the /demo report). */
export function ReportView({ report: r, url, home = "/", demo = false }: { report: PublicReport; url?: string; home?: string; demo?: boolean }) {
  const before = r.images.find((i) => i.role === "before");
  const after = r.images.find((i) => i.role === "after");
  const paired = before && after;
  const others = r.images.filter((i) => !paired || (i !== before && i !== after));

  return (
    <div className="mx-auto max-w-4xl px-4 py-4 sm:px-6 sm:py-5">
      <header className="mb-8 flex items-center justify-between gap-4 sm:mb-12">
        <Link href={home} aria-label="Terragent home" className="text-fg">
          <LogoLockup className="h-7 sm:h-8" label="" />
        </Link>
        <span className="font-mono text-xs tracking-[0.12em] text-fg-3 uppercase">Report</span>
      </header>

      <article className="flex flex-col gap-14">
        <ReportHero report={r} url={url} />

        {(paired || others.length > 0) && (
          <Section title="What the satellite saw">
            {paired && <BeforeAfter before={before} after={after} />}
            {others.length > 0 && (
              <div className="grid gap-4 sm:grid-cols-2">
                {others.map((img) => (
                  <ImageCard key={img.src} img={img} />
                ))}
              </div>
            )}
          </Section>
        )}

        {r.measurements.length > 0 && (
          <Section title="Measurements">
            <MeasurementCards rows={r.measurements} />
          </Section>
        )}

        {r.paidDataEstimate && (
          <Section title="What paid imagery would add">
            <p className="max-w-[44rem] leading-relaxed text-fg-2">
              {r.paidDataEstimate.wouldShow} Estimated data cost: {usd(r.paidDataEstimate.estCostUsd)} ({r.paidDataEstimate.providerId}).
              {demo ? "We only buy imagery when you choose a paid option." : "We only buy imagery when you ask us to and a founder approves the purchase."}
            </p>
          </Section>
        )}

        <Section title="Sources" note="Capture dates in UTC">
          <SourceList sources={r.sources} />
        </Section>
      </article>

      <footer className="mt-16 border-t border-line pt-6 text-sm leading-relaxed text-fg-3">
        <p>
          Written by Terragent&apos;s AI agents from satellite data and checked by a separate verifier agent
          {r.verifierScore !== null && <> (score {Math.round(r.verifierScore)} of 100)</>}. This is not a site inspection.{" "}
          <Link href="/terms" className="underline underline-offset-4 hover:text-fg">Terms</Link> and{" "}
          <Link href="/acceptable-use" className="underline underline-offset-4 hover:text-fg">acceptable use</Link>.
        </p>
      </footer>
    </div>
  );
}

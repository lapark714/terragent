import type { Metadata } from "next";
import Link from "next/link";
import { SensorCards, SignalChart } from "@/components/demo/SignalChart";
import { YearScrubber } from "@/components/demo/YearScrubber";
import { MeasurementCards } from "@/components/report/MeasurementCards";
import { ReportHero } from "@/components/report/ReportHero";
import { SourceList } from "@/components/report/SourceList";
import { LogoLockup } from "@/components/site/Logo";
import type { PublicReport } from "@/lib/dashboard/public";
import {
  DEMO_QUESTION, REPORT_ANSWER, REPORT_LIMITATIONS, REPORT_MEASUREMENTS, REPORT_SOURCES, REPORT_TITLE, SITES,
} from "@/lib/demo/yc";

export const metadata: Metadata = { title: REPORT_TITLE };

function Section({ title, note, children }: { title: string; note?: React.ReactNode; children: React.ReactNode }) {
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

/** The demo report: the real report components with the synthetic YC findings, plus the multimodal panels. */
export default async function DemoReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const report: PublicReport = {
    token: id,
    title: REPORT_TITLE,
    question: DEMO_QUESTION,
    location: `${SITES.sf.name}: ${SITES.sf.short} and ${SITES.mv.short}`,
    playbook: "inbound",
    answer: REPORT_ANSWER,
    confidence: "high",
    measurements: REPORT_MEASUREMENTS,
    images: [],
    sources: REPORT_SOURCES,
    limitations: REPORT_LIMITATIONS,
    humanReview: false,
    paidDataEstimate: null,
    verifierScore: 93,
    verifiedAt: new Date().toISOString(),
  };

  return (
    <div className="mx-auto max-w-4xl px-4 py-4 sm:px-6 sm:py-5">
      <header className="mb-8 flex items-center justify-between gap-4 sm:mb-12">
        <Link href="/demo" aria-label="Terragent home" className="text-fg">
          <LogoLockup className="h-7 sm:h-8" label="" />
        </Link>
        <span className="font-mono text-xs tracking-[0.12em] text-fg-3 uppercase">Report</span>
      </header>

      <article className="flex flex-col gap-14">
        <ReportHero report={report} />

        <Section title="What the satellite saw" note="Eight years of mosaics, both offices">
          <YearScrubber />
        </Section>

        <Section title="Ten years of signals" note="1,557 scenes across five sensors">
          <SignalChart />
        </Section>

        <Section title="Five sensors, one answer">
          <SensorCards />
        </Section>

        <Section title="Measurements">
          <MeasurementCards rows={report.measurements} />
        </Section>

        <Section title="Sources" note="Capture dates in UTC">
          <SourceList sources={report.sources} />
        </Section>
      </article>

      <footer className="mt-16 border-t border-line pt-6 text-sm leading-relaxed text-fg-3">
        <p>
          Written by Terragent&apos;s AI agents from satellite data and checked by a separate verifier agent (score 93 of 100). This
          is not a site inspection. <strong className="font-medium text-fg-2">Demo report:</strong> apart from the Sentinel-2
          mosaics, every number, series and source on this page is simulated.
        </p>
      </footer>
    </div>
  );
}

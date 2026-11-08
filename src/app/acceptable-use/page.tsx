import type { Metadata } from "next";
import { LegalPage } from "@/components/site/LegalPage";
import { helloAddress } from "@/components/site/contact";

export const metadata: Metadata = { title: "Acceptable use" };

export default function AcceptableUse() {
  const hello = helloAddress();
  return (
    <LegalPage
      title="Acceptable use"
      updated="November 7, 2026"
      intro="Terragent answers questions about places: land, buildings, forests, water, sites. It is not a tool for watching people. Our agents screen every request against this policy and refuse the ones that break it."
      sections={[
        {
          heading: "What we won't do",
          body: (
            <ul>
              <li>Surveil, locate, follow or identify an individual person, or work out where someone lives, works or travels.</li>
              <li>Help with stalking, harassment, intimidation or tracking a partner, ex-partner or family member.</li>
              <li>Target people, homes, groups or infrastructure for harm, including military or weapons targeting.</li>
              <li>Support anything illegal where you are or where the place is.</li>
            </ul>
          ),
        },
        {
          heading: "How screening works",
          body: (
            <>
              <p>
                An agent reads each request before any work starts. If it falls under the list above, we refuse it and log the
                refusal with the reason. If it&apos;s unclear what you need, we ask one question by email before going further.
              </p>
              <p>Refused requests can&apos;t move forward in our system, and repeated attempts may be blocked.</p>
            </>
          ),
        },
        {
          heading: "Derived results only",
          body: (
            <p>
              We deliver measurements, maps, change flags and free public imagery such as Sentinel-2 and Landsat. When a
              question needs commercial imagery, licences usually forbid passing the original pictures on, so reports show
              results derived from them, not the purchased pixels.
            </p>
          ),
        },
        {
          heading: "AI-generated reports",
          body: (
            <p>
              Reports are written by AI agents and checked by a separate verifier agent. Every report states a confidence level
              (high, medium or low), the scenes and dates it relied on, and its limitations. Satellite data can be wrong or
              out of date: clouds, resolution and timing all matter.
            </p>
          ),
        },
        {
          heading: "High-stakes decisions",
          body: (
            <p>
              For insurance claims, legal matters, lending, safety or anything else where a mistake is costly, treat a report
              as a starting point and have a qualified person review it. Reports for these uses say so.
            </p>
          ),
        },
        {
          heading: "Reporting misuse",
          body: (
            <p>
              If you think someone is using Terragent to harm others, email{" "}
              <a href={`mailto:${hello}`} className="text-fg underline underline-offset-4">{hello}</a>. A founder reads these.
            </p>
          ),
        },
      ]}
    />
  );
}

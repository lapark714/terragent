import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/site/LegalPage";
import { helloAddress } from "@/components/site/contact";
import { PRICING } from "@/lib/config";

export const metadata: Metadata = { title: "Terms" };

export default function Terms() {
  const hello = helloAddress();
  return (
    <LegalPage
      title="Terms"
      updated="November 7, 2026"
      intro="These terms cover using Terragent's website, email address and API. They are short on purpose. By sending us a request you agree to them."
      sections={[
        {
          heading: "Who you're dealing with",
          body: (
            <p>
              Terragent is operated by its three founders and run day to day by AI agents. Emails, quotes and reports are
              written by AI. Founders approve first-time emails, every purchase of data and anything else our safety rules
              reserve for a person.
            </p>
          ),
        },
        {
          heading: "What we provide",
          body: (
            <>
              <p>
                Answers to questions about places, based on satellite and other public data, delivered as a report with images,
                measurements, sources, limitations and a confidence level. We may decline any request.
              </p>
              <p>
                Reports are informational. They are not a survey, an inspection, an appraisal, legal advice or an insurance
                assessment, and we don&apos;t guarantee that a report is complete or correct.
              </p>
            </>
          ),
        },
        {
          heading: "Prices and payment",
          body: (
            <p>
              Answers from free satellite data start at ${PRICING.minReportUsd}; up to ${PRICING.autoApproveCapUsd} the price comes
              with the report. Anything above that, or anything that needs paid imagery, is quoted to you before the work starts.
              Data purchases happen only for a confirmed paying customer and only after a founder approves that specific
              purchase. Free sample reports are free and carry no obligation.
            </p>
          ),
        },
        {
          heading: "Your responsibilities",
          body: (
            <p>
              Follow our <Link href="/acceptable-use" className="text-fg underline underline-offset-4">acceptable use policy</Link>.
              Ask only about places you have a legitimate reason to ask about. Keep API keys secret; you are responsible for
              requests made with your key.
            </p>
          ),
        },
        {
          heading: "Data we keep",
          body: (
            <>
              <p>
                We keep your request, your email address and our correspondence so we can answer you and follow up. Derived
                results (measurements for a map cell on a date) go into our Earth index and may help answer future questions;
                they don&apos;t include your contact details.
              </p>
              <p>
                Our public dashboard shows work in progress with customer details masked to initials and email domains. Every
                outreach email has an opt-out link, and we honour opt-outs immediately.
              </p>
            </>
          ),
        },
        {
          heading: "Liability",
          body: (
            <p>
              To the extent the law allows, our total liability for any report is limited to what you paid for it. Have a
              qualified person review any report before relying on it for a high-stakes decision.
            </p>
          ),
        },
        {
          heading: "Contact",
          body: (
            <p>
              Questions about these terms: <a href={`mailto:${hello}`} className="text-fg underline underline-offset-4">{hello}</a>.
            </p>
          ),
        },
      ]}
    />
  );
}

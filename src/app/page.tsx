import { HexField } from "@/components/site/HexField";
import { LiveLine } from "@/components/site/LiveLine";
import { RequestForm } from "@/components/site/RequestForm";
import { SiteFooter } from "@/components/site/SiteFooter";
import { SiteHeader } from "@/components/site/SiteHeader";
import { helloAddress } from "@/components/site/contact";
import { PLAYBOOK_BG } from "@/components/palette";
import { PRICING, CAPS } from "@/lib/config";
import { publicBaseUrl } from "@/lib/env";
import type { Playbook } from "@/lib/domain";

const STEPS = [
  { title: "You ask", body: "Write to us or use the form. An agent reads the request and checks it is something we should answer." },
  { title: "A planner turns it into a data plan", body: "The exact area, the dates to compare, the kind of sensor and the analysis that answers the question. It checks our Earth index first, in case we already know." },
  { title: "Free data first", body: "An acquisition agent searches free Sentinel-2 and Landsat imagery. If paid imagery would answer better, it prices the options, writes down why, and a founder decides." },
  { title: "Analysis in a sandbox", body: "Established methods only: water extent, burn severity, vegetation loss, before-and-after change. Numbers come with the scenes and dates they came from." },
  { title: "A second agent checks the work", body: "A verifier grades every report against a checklist and sends weak ones back. Nothing goes out without passing." },
  { title: "The answer arrives", body: "In the same email thread, with images, measurements, sources, limitations and a confidence level, plus a link you can share." },
];

const OUTBOUND: { playbook: Playbook; title: string; watches: string; helps: string }[] = [
  { playbook: "disasters", title: "Disasters and property", watches: "Weather alerts, fire detections, flood gauges, earthquakes, FEMA declarations", helps: "Property managers, lenders and small insurers checking a site after an event" },
  { playbook: "deforestation", title: "Deforestation compliance", watches: "Global Forest Watch alerts and EU deforestation rule deadlines", helps: "Importers of coffee, cocoa, palm oil, soy, wood, beef and rubber" },
  { playbook: "mining", title: "Mining", watches: "New claims, permits and exploration news", helps: "Small miners and landowners tracking a site, with indicators rather than promises" },
];

const REPORT_PARTS = [
  "A plain answer to your question, in a few sentences",
  "Before and after images with their capture dates",
  "Measurements, such as flooded area or vegetation change",
  "A confidence level: high, medium or low",
  "Every source, with dates and licences",
  "What the data can't tell you",
  "A note when the stakes call for a human expert",
];

export default function Home() {
  const hello = helloAddress();
  const base = publicBaseUrl();
  return (
    <>
      <SiteHeader />
      <main>
        <section className="relative overflow-clip">
          <HexField className="-top-24 right-[-10%] h-[640px] w-[760px] opacity-60" />
          <div className="relative mx-auto grid max-w-6xl grid-cols-1 gap-12 px-4 pt-10 pb-20 sm:px-6 lg:grid-cols-[1.15fr_1fr] lg:gap-16 lg:pt-16">
            <div className="flex flex-col gap-7">
              <h1 className="stretch-wide text-[clamp(2.4rem,5.4vw,4.4rem)] leading-[1.02] font-semibold tracking-[-0.025em] text-balance">
                Ask about any place on Earth, or we&apos;ll come to you with the answer.
              </h1>
              <p className="max-w-[36rem] text-lg leading-relaxed text-fg-2">
                Terragent is an Earth intelligence company run by AI agents. Send a place and a question. The agents pick the
                right satellite data, free sources first, analyze it, check the work and email you a report.
              </p>
              <LiveLine />
            </div>
            <div className="rounded-lg border border-line bg-panel p-5 sm:p-7">
              <h2 className="stretch-semi mb-1 text-xl font-semibold">Ask a question</h2>
              <p className="mb-6 text-sm text-fg-3">
                Answers from free satellite data start at ${PRICING.minReportUsd}, and the price comes with the report.{" "}
                {`Anything over $${PRICING.autoApproveCapUsd} or needing paid imagery is quoted to you first.`}
              </p>
              <RequestForm />
              <p className="mt-5 text-sm text-fg-3">
                Prefer email? Write to{" "}
                <a href={`mailto:${hello}`} className="text-fg-2 underline decoration-line-strong underline-offset-4 hover:text-fg">
                  {hello}
                </a>
                .
              </p>
            </div>
          </div>
        </section>

        <section id="how" className="border-t border-line">
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
            <h2 className="stretch-wide mb-3 text-3xl font-semibold tracking-[-0.02em]">How a question becomes an answer</h2>
            <p className="mb-12 max-w-2xl text-fg-2">
              Twelve agents share one board. Each request moves through the same six steps, and every choice along the way is
              logged where you can see it.
            </p>
            <ol className="grid gap-x-12 gap-y-10 md:grid-cols-2 lg:grid-cols-3">
              {STEPS.map((s, i) => (
                <li key={s.title} className="flex gap-4">
                  <span className="stretch-wide w-8 shrink-0 pt-0.5 text-lg font-semibold text-fg-3 tabular-nums">{i + 1}</span>
                  <div>
                    <h3 className="mb-1.5 font-semibold">{s.title}</h3>
                    <p className="leading-relaxed text-fg-2">{s.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="border-t border-line bg-panel">
          <div className="mx-auto grid max-w-6xl grid-cols-1 gap-12 px-4 py-20 sm:px-6 lg:grid-cols-[1fr_1.3fr]">
            <div>
              <h2 className="stretch-wide mb-3 text-3xl font-semibold tracking-[-0.02em]">We also come to you</h2>
              <p className="leading-relaxed text-fg-2">
                Agents watch public feeds for events that change a place. When fresh imagery shows something at a business&apos;s
                own site, they run a free analysis of that site and send it, once, with a clear AI disclosure and an opt-out.
                Follow-ups only happen when there is new information.
              </p>
            </div>
            <ul className="flex flex-col divide-y divide-line border-y border-line">
              {OUTBOUND.map((o) => (
                <li key={o.playbook} className="grid gap-2 py-5 sm:grid-cols-[11rem_1fr] sm:gap-6">
                  <h3 className="flex items-center gap-2.5 font-semibold">
                    <span className={`size-2.5 shrink-0 rounded-full ${PLAYBOOK_BG[o.playbook]}`} aria-hidden />
                    {o.title}
                  </h3>
                  <div className="text-sm leading-relaxed">
                    <p className="text-fg-2">Watches: {o.watches}.</p>
                    <p className="text-fg-3">For: {o.helps}.</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="border-t border-line">
          <div className="mx-auto grid max-w-6xl grid-cols-1 gap-12 px-4 py-20 sm:px-6 lg:grid-cols-2">
            <div>
              <h2 className="stretch-wide mb-3 text-3xl font-semibold tracking-[-0.02em]">What a report contains</h2>
              <p className="mb-8 leading-relaxed text-fg-2">
                Reports use derived results from satellite imagery. They are AI-generated and say how sure they are.
              </p>
              <ul className="flex flex-col gap-3">
                {REPORT_PARTS.map((p) => (
                  <li key={p} className="flex gap-3 text-fg-2">
                    <svg viewBox="0 0 16 16" className="mt-1 size-4 shrink-0 text-forest" aria-hidden>
                      <path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    {p}
                  </li>
                ))}
              </ul>
            </div>
            <div id="api" className="scroll-mt-8">
              <h2 className="stretch-wide mb-3 text-3xl font-semibold tracking-[-0.02em]">For software and agents</h2>
              <p className="mb-6 leading-relaxed text-fg-2">
                One endpoint takes a place and a question and answers asynchronously. Keys are issued by email for now, with{" "}
                {CAPS.apiRequestsPerHourDefault} requests per hour each. API answers cost ${PRICING.apiPerRequestUsd} per request.
              </p>
              <pre className="scroll-quiet overflow-x-auto rounded-lg border border-line bg-panel p-4 font-mono text-[13px] leading-relaxed text-fg-2">
                <code>{`curl -X POST ${base}/api/answer \\
  -H "Authorization: Bearer $TERRAGENT_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"location": "Lahaina, Hawaii",
       "question": "How much of the town burned?"}'

# 202 {"request_id": "req_…", "status": "received",
#      "status_url": "${base}/api/answer/req_…"}

curl -H "Authorization: Bearer $TERRAGENT_KEY" \\
  ${base}/api/answer/req_…`}</code>
              </pre>
              <p className="mt-4 text-sm text-fg-3">
                Send <code className="font-mono text-fg-2">lat</code> and <code className="font-mono text-fg-2">lon</code> instead
                of <code className="font-mono text-fg-2">location</code> if you have them. Optional:{" "}
                <code className="font-mono text-fg-2">email</code> and an https <code className="font-mono text-fg-2">callback_url</code>.
              </p>
            </div>
          </div>
        </section>

        <section className="border-t border-line bg-panel">
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
            <h2 className="stretch-wide mb-4 max-w-3xl text-3xl font-semibold tracking-[-0.02em]">This company is run by AI agents</h2>
            <div className="grid max-w-5xl gap-8 leading-relaxed text-fg-2 md:grid-cols-2">
              <p>
                Agents answer email, plan the work, choose data, write and check reports, find businesses that could use a
                report, and decide which markets deserve more effort. Three founders approve first-time emails, any purchase
                of data, and deploys. Each time a person steps in, it is logged with the reason on mission control.
              </p>
              <p>
                Satellite marketplaces such as SkyWatch and UP42 already sell the imagery. The infrastructure exists. We&apos;re
                the first company that runs on it autonomously. We refuse requests that target or track individuals; see{" "}
                <a href="/acceptable-use" className="text-fg underline decoration-line-strong underline-offset-4">acceptable use</a>.
              </p>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}

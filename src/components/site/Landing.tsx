import { Pipeline } from "@/components/site/Pipeline";
import { SiteFooter } from "@/components/site/SiteFooter";
import { SiteHeader } from "@/components/site/SiteHeader";
import { GlobeAsk } from "@/components/site/ask/GlobeAsk";
import { helloAddress } from "@/components/site/contact";
import { CAPS, PRICING } from "@/lib/config";
import { publicBaseUrl } from "@/lib/env";

/** The landing page. `demo` (the /demo copy) keeps every link inside /demo and makes the ask form play a scripted run. */
export function Landing({ demo = false }: { demo?: boolean }) {
  const base = publicBaseUrl();
  return (
    <>
      <SiteHeader overlay home={demo ? "/demo" : "/"} />
      <main>
        <GlobeAsk hello={helloAddress()} demo={demo} />

        <section id="how" className="scroll-mt-4 border-t border-line">
          <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-24">
            <div className="mb-10 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-10">
              <h2 className="stretch-wide max-w-xl text-3xl font-semibold tracking-[-0.02em] text-balance sm:text-4xl">
                From a question to a verified answer
              </h2>
              <p className="max-w-sm text-fg-2">
                A team of AI agents runs every step, and a separate verifier agent checks the work before anything reaches you.
              </p>
            </div>
            <Pipeline />
          </div>
        </section>

        <section id="api" className="scroll-mt-4 border-t border-line bg-panel">
          <div className="mx-auto grid max-w-6xl grid-cols-1 gap-10 px-4 py-20 sm:px-6 sm:py-24 lg:grid-cols-[1fr_1.25fr] lg:gap-16">
            <div>
              <h2 className="stretch-wide mb-4 text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">For software and agents</h2>
              <p className="mb-4 leading-relaxed text-fg-2">
                One endpoint takes a place and a question and answers asynchronously. Keys are issued by email for now, with{" "}
                {CAPS.apiRequestsPerHourDefault} requests per hour each. Each answer is priced like any report, from $
                {PRICING.minReportUsd} when free imagery answers it. A quote up to ${PRICING.autoApproveCapUsd} goes ahead at
                once and shows in the status response; a higher one is emailed to you to accept.
              </p>
              <p className="text-sm leading-relaxed text-fg-3">
                Send <code className="font-mono text-fg-2">lat</code> and <code className="font-mono text-fg-2">lon</code> instead
                of <code className="font-mono text-fg-2">location</code> if you have them. Add an{" "}
                <code className="font-mono text-fg-2">email</code> to get the answer and any quote there too; without one, a quote
                above ${PRICING.autoApproveCapUsd} can&apos;t reach you. Answers take a few minutes, so poll the status URL every
                30 seconds or so.
              </p>
            </div>
            <pre className="scroll-quiet min-w-0 overflow-x-auto rounded-xl border border-line bg-space p-5 font-mono text-[13px] leading-relaxed text-fg-2">
              <code>{`curl -X POST ${base}/api/answer \\
  -H "Authorization: Bearer $TERRAGENT_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"location": "Lahaina, Hawaii",
       "question": "How much of the town burned?"}'

# 202 {"request_id": "req_…", "status": "received",
#      "status_url": "${base}/api/answer/req_…"}

curl -H "Authorization: Bearer $TERRAGENT_KEY" \\
  ${base}/api/answer/req_…

# 200 {"status": "delivered", "done": true,
#      "quote": {"price_usd": ${PRICING.minReportUsd}, "status": "approved", …},
#      "report": {"url": "…", "answer": "…", "confidence": "…"}}`}</code>
            </pre>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}

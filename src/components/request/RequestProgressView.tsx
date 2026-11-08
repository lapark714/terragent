"use client";
/** Live progress of one request: a step track, who's on it now, the timeline, and the answer when it lands. */
import Link from "next/link";
import { useState } from "react";
import { actorLabel, ago, clockUtc, eventLabel, STATUS_LABEL } from "@/components/format";
import { ConfidenceMeter } from "@/components/report/ConfidenceMeter";
import { useNow } from "@/components/useNow";
import { usePoll } from "@/components/usePoll";
import type { RequestStatus } from "@/lib/domain";
import type { RequestProgress } from "@/lib/dashboard/public";

const STEPS = ["Received", "Checked", "Planned", "Data", "Analysis", "Verified", "Delivered"];
const STEP_OF: Record<RequestStatus, number> = {
  received: 0, screening: 1, clarifying: 1, planning: 2, acquiring: 3, fetching: 3, pricing: 3, quoted: 3,
  awaiting_approval: 3, analyzing: 4, verifying: 5, revising: 5, delivering: 6, delivered: 7,
  refused: 1, failed: -1, cancelled: -1,
};

const NOTE: Partial<Record<RequestStatus, string>> = {
  clarifying: "We emailed you a question. Reply in the same thread and the agents pick it up from there.",
  quoted: "We sent you a quote by email. Reply to accept it.",
  awaiting_approval: "A founder is reviewing the price or a paid-data purchase before the agents continue.",
  revising: "The verifier sent the report back for another pass. This is normal.",
};

export function RequestProgressView({ initial }: { initial: RequestProgress }) {
  const [terminal, setTerminal] = useState(initial.terminal);
  const { data } = usePoll<RequestProgress>(`/api/requests/${initial.id}/status`, terminal ? 60_000 : 4_000, initial);
  const now = useNow();
  const p = data ?? initial;
  if (p.terminal !== terminal) setTerminal(p.terminal);
  const step = STEP_OF[p.status];

  return (
    <div className="flex flex-col gap-10">
      <ol className="grid grid-cols-7 gap-1.5" aria-label="Progress">
        {STEPS.map((label, i) => {
          const state = i < step ? "done" : i === step && !p.terminal ? "current" : "todo";
          return (
            <li key={label} aria-current={state === "current" ? "step" : undefined} className="flex flex-col gap-2">
              <span className={`h-1.5 rounded-full ${state === "done" ? "bg-inbound" : state === "current" ? "beacon bg-inbound-hi text-inbound" : "bg-line-strong"}`} />
              <span className={`text-xs sm:text-sm ${state === "todo" ? "text-fg-3" : "text-fg"}`}>{label}</span>
            </li>
          );
        })}
      </ol>

      <div className="flex flex-col gap-2">
        <p className="stretch-semi text-2xl font-semibold">{STATUS_LABEL[p.status]}</p>
        {!p.terminal && p.owner && <p className="text-fg-2">With the {actorLabel(p.owner)} agent right now.</p>}
        {NOTE[p.status] && <p className="text-fg-2">{NOTE[p.status]}</p>}
        {p.status === "refused" && (
          <p className="text-fg-2">
            We can&apos;t take this request{p.refusalReason ? `: ${p.refusalReason}` : "."} See our{" "}
            <Link href="/acceptable-use" className="text-fg underline underline-offset-4">acceptable use policy</Link>.
          </p>
        )}
        {(p.status === "failed" || p.status === "cancelled") && (
          <p className="text-fg-2">This request stopped before an answer was ready. We&apos;ll email you about what happens next.</p>
        )}
      </div>

      {p.report && (
        <section className="rounded-lg border border-line-strong bg-panel p-6">
          <h2 className="stretch-semi mb-3 text-xl font-semibold">{p.report.title}</h2>
          <p className="mb-5 text-lg leading-relaxed">{p.report.answer}</p>
          <ConfidenceMeter level={p.report.confidence} />
          <Link href={p.report.path} className="mt-6 inline-block rounded-md bg-inbound px-4 py-2.5 font-semibold text-space hover:bg-inbound-hi">
            Open the full report
          </Link>
        </section>
      )}

      <section>
        <h2 className="mb-4 text-sm font-medium text-fg-2">What the agents have done</h2>
        <ol className="flex flex-col border-l border-line-strong">
          {p.events.map((e, i) => (
            <li key={i} className="relative flex flex-wrap items-baseline gap-x-3 py-2 pl-5">
              <span className="absolute top-[0.95rem] -left-[4.5px] size-2 rounded-full bg-line-strong" aria-hidden />
              <span className="w-12 font-mono text-xs text-fg-3 tabular-nums">{now ? ago(e.at, now) : clockUtc(e.at)}</span>
              <span>{eventLabel(e.type)}</span>
              <span className="text-sm text-fg-3">{actorLabel(e.actor)}</span>
            </li>
          ))}
          {!p.events.length && <li className="py-2 pl-5 text-fg-3">Waiting for the first agent to pick this up.</li>}
        </ol>
      </section>
    </div>
  );
}

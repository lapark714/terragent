"use client";
/**
 * Live progress of one request: the step track, how long it's been, the outcome (answer / stop / the quote to
 * choose from / your move), who's on it now, and what the agents have done. Polls with backoff (poll.ts).
 */
import { useState } from "react";
import { useNow } from "@/components/useNow";
import { usePoll } from "@/components/usePoll";
import type { RequestProgress } from "@/lib/dashboard/public";
import { AgentNow } from "./AgentNow";
import { Elapsed } from "./Elapsed";
import { Outcome } from "./Outcome";
import { pollIntervalMs } from "./poll";
import { agentIsWorking, headingOf, ownerSince, showsChosenOption, trackOf } from "./progress";
import { chosenText } from "./quote";
import { StepTrack } from "./StepTrack";
import { Timeline } from "./Timeline";

export function RequestProgressView({ initial, hello }: { initial: RequestProgress; hello: string }) {
  const now = useNow();
  const [latest, setLatest] = useState(initial);
  const { data, error, refresh } = usePoll<RequestProgress>(`/api/requests/${initial.id}/status`, pollIntervalMs(latest, now), initial);
  const p = data ?? initial;
  if (p !== latest) setLatest(p);
  const track = trackOf(p);

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <StepTrack {...track} />
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="stretch-semi text-2xl font-semibold" aria-live="polite">{headingOf(p)}</p>
          <p className="text-sm text-fg-3">
            {p.terminal ? "Took " : "Asked "}
            <Elapsed since={p.createdAt} until={p.terminal ? p.updatedAt : null} className="text-fg-2" />
            {p.terminal ? "" : " ago"}
          </p>
        </div>
        {showsChosenOption(p) && p.quote?.accepted_option_id && (
          <p className="text-fg-2">{chosenText(p.quote, p.quote.accepted_option_id, p.quote.accepted_at)}.</p>
        )}
        {p.status === "revising" && (
          <p className="text-fg-2">The verifier sent the report back for another pass. This is normal, and it&apos;s how weak answers get caught.</p>
        )}
        {error && !p.terminal && (
          <p className="text-sm text-fg-3">Lost touch with the server for a moment; retrying. Your request keeps going either way.</p>
        )}
      </div>

      <Outcome progress={p} hello={hello} onQuoteAccepted={refresh} />
      {agentIsWorking(p) && <AgentNow owner={p.owner} since={ownerSince(p)} />}
      <Timeline events={p.events} />
    </div>
  );
}

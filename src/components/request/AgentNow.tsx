"use client";
/** "Who's on it": the agent holding the request, what that agent does, and how long it has had it. */
import { actorLabel } from "@/components/format";
import { Elapsed } from "./Elapsed";

/** One line per agent, in the same words the landing page uses for each step. */
const AGENT_DOES: Record<string, string> = {
  coordinator: "Routing your request to the right specialist.",
  "comms-customer": "Reading your request and checking it is something we should answer.",
  planner: "Turning your question into a data plan: the exact area, the dates to compare and the method.",
  acquisition: "Searching free Sentinel-2 and Landsat imagery for scenes that answer the question.",
  pricing: "Pricing up to three options for you to choose from. Nothing is bought or charged until you accept one.",
  "comms-suppliers": "Asking a data supplier for its exact price. A founder places every paid order by hand.",
  analytics: "Measuring the change in a sandbox, using established methods.",
  interpreter: "Turning the measurements into a plain answer.",
  verifier: "Grading the report against a checklist. Weak reports go back for another pass.",
};

export function AgentNow({ owner, since }: { owner: string | null; since: string }) {
  if (!owner) {
    return <p className="text-fg-2">Waiting for the first agent to pick this up.</p>;
  }
  const human = owner.startsWith("human:");
  return (
    <div className="flex items-start gap-3 rounded-lg border border-line bg-panel px-4 py-3.5">
      <span className={`beacon mt-1.5 inline-block size-2 shrink-0 rounded-full ${human ? "bg-human text-human" : "bg-inbound-hi text-inbound"}`} aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="flex flex-wrap items-baseline justify-between gap-x-3">
          <span className="font-medium">
            {human ? `${actorLabel(owner)} (founder)` : `${actorLabel(owner)} agent`}
            <span className="font-normal text-fg-3"> is on it</span>
          </span>
          <Elapsed since={since} className="text-[13px] text-fg-3" />
        </p>
        <p className="text-sm leading-relaxed text-fg-2">
          {human ? "A founder is handling a step our rules reserve for a person." : AGENT_DOES[owner] ?? "Working on the next step."}
        </p>
      </div>
    </div>
  );
}

/**
 * The request's step track (pricing v2: nothing past "Your choice" runs until the customer accepts an option).
 * Phones and small tablets get the segmented bar plus one line ("Step 6 of 8, Analysis"); from md up, eight labels
 * fit, so every segment gets its own. Outcome changes the colour of the stop.
 */
import { STEPS, type TrackOutcome } from "./progress";

export function StepTrack({ step, outcome }: {
  /** Index of the current step (0-based); STEPS.length when delivered. For refused/stopped, the step it stopped at. */
  step: number;
  outcome: TrackOutcome;
}) {
  const total = STEPS.length;
  /** A stop with no recorded step (failed / cancelled): mute the whole track rather than guess. */
  const unknownStop = outcome === "stopped" && step < 0;
  const at = Math.max(0, Math.min(step, total - 1));
  const caption =
    outcome === "delivered"
      ? "All steps done"
      : outcome === "active"
        ? `Step ${at + 1} of ${total}, ${STEPS[at]}`
        : unknownStop
          ? "Stopped before an answer was ready"
          : `Stopped at step ${at + 1} of ${total}, ${STEPS[at]}`;

  const segment = (i: number) => {
    if (unknownStop) return "todo";
    if (outcome === "delivered" || i < at) return "done";
    if (i === at) return outcome === "active" ? "current" : "halted";
    return "todo";
  };

  const SEG_CLASS = {
    done: "bg-inbound",
    current: "beacon bg-inbound-hi text-inbound",
    halted: "bg-alert",
    todo: "bg-line-strong",
  } as const;

  return (
    <div className="flex flex-col gap-2.5">
      <ol className="grid grid-cols-8 gap-1 sm:gap-1.5" aria-label={`Progress: ${caption}`}>
        {STEPS.map((label, i) => {
          const s = segment(i);
          return (
            <li key={label} aria-current={s === "current" ? "step" : undefined} className="flex min-w-0 flex-col gap-2">
              <span className={`h-1.5 rounded-full ${SEG_CLASS[s]}`} />
              <span className={`hidden truncate text-sm md:block ${s === "todo" ? "text-fg-3" : s === "halted" ? "text-alert" : "text-fg"}`}>
                {label}
              </span>
            </li>
          );
        })}
      </ol>
      <p className={`font-mono text-[13px] ${unknownStop ? "" : "md:hidden"} ${outcome === "refused" || outcome === "stopped" ? "text-alert" : "text-fg-2"}`} aria-hidden>
        {caption}
      </p>
    </div>
  );
}

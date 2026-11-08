/**
 * How a question becomes an answer, as one row of steps with the agent behind each.
 * Same seven-segment language as the request page's step track, so the site reads as one product.
 */
const STEPS = [
  { title: "Ask", agent: "You", body: "Pick a place and ask a question." },
  { title: "Plan", agent: "Planner", body: "Sets the exact area, the dates to compare and the method." },
  { title: "Data", agent: "Acquisition", body: "Finds free Sentinel-2 and Landsat scenes first." },
  { title: "Analyze", agent: "Analytics", body: "Measures change with established methods, in a sandbox." },
  { title: "Verify", agent: "Verifier", body: "Grades every report. Weak ones go back for another pass." },
  { title: "Deliver", agent: "Customer comms", body: "Answer, images, confidence, sources and limits, by email." },
];

export function Pipeline() {
  return (
    <ol className="grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-6">
      {STEPS.map((s, i) => (
        <li key={s.title} className="grid grid-cols-[2rem_1fr] gap-x-3 gap-y-1 bg-panel px-4 py-4 sm:flex sm:flex-col sm:gap-3 sm:p-5">
          {/* Phones: a numbered list. Wider: the segmented bar, echoing the request page's step track. */}
          <span className="row-span-3 pt-0.5 font-mono text-sm text-inbound-hi tabular-nums sm:hidden">{String(i + 1).padStart(2, "0")}</span>
          <span className="hidden items-center gap-2 sm:flex">
            <span className={`h-1.5 flex-1 rounded-full ${i === STEPS.length - 1 ? "bg-inbound-hi" : "bg-inbound"}`} aria-hidden />
            <span className="font-mono text-xs text-fg-3 tabular-nums">{String(i + 1).padStart(2, "0")}</span>
          </span>
          <h3 className="stretch-semi font-semibold sm:text-lg">{s.title}</h3>
          <p className="text-sm leading-relaxed text-fg-2">{s.body}</p>
          <p className="text-xs text-fg-3 sm:mt-auto">{s.agent === "You" ? "You" : `${s.agent} agent`}</p>
        </li>
      ))}
    </ol>
  );
}

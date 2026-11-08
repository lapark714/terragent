/** Where signals come from: each feed's count, coloured by the layer it feeds. */
import type { GlobeSignal } from "@/lib/dashboard/types";
import { count } from "../../format";
import { LAYER_LABEL } from "../../palette";
import { Quiet } from "../Panel";
import { feedCounts, feedLabel, LAYER_BG } from "./signals";

export function SignalSourcesPanel({ signals }: { signals: GlobeSignal[] }) {
  const feeds = feedCounts(signals);
  if (!feeds.length) return <Quiet>No signals yet.</Quiet>;
  const max = Math.max(1, ...feeds.map((f) => f.n));
  return (
    <ul className="scroll-quiet flex h-full min-h-0 flex-col gap-2 overflow-y-auto">
      {feeds.map((f) => (
        <li key={`${f.feed}|${f.layer}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 text-xs">
          <span className="truncate" title={`${feedLabel(f.feed)}, ${LAYER_LABEL[f.layer]}`}>
            {feedLabel(f.feed)}
            <span className="text-fg-3"> · {LAYER_LABEL[f.layer]}</span>
          </span>
          <span className="text-fg-2 tabular-nums">{count(f.n)}</span>
          <span className={`col-span-2 h-1.5 rounded-r-full ${LAYER_BG[f.layer]}`} style={{ width: `${((f.n / max) * 100).toFixed(2)}%` }} aria-hidden />
        </li>
      ))}
    </ul>
  );
}

"use client";
/** One honest sentence of live numbers under the hero. Hidden until real data arrives. */
import { usePoll } from "@/components/usePoll";
import type { Overview, Panel } from "@/lib/dashboard/types";
import { count, plural } from "../format";

export function LiveLine() {
  const { data } = usePoll<Panel<Overview>>("/api/dashboard/overview", 30_000);
  if (!data?.ok) return null;
  const o = data.data;
  return (
    <p className="flex items-center gap-2.5 text-sm text-fg-2">
      <span className="beacon inline-block size-2 rounded-full bg-forest text-forest" aria-hidden />
      <span>
        Live now: {count(o.active)} in progress, {count(o.delivered)} answered, {plural(o.verifiedReports, "verified report")}.{" "}
        {plural(o.interventions, "human intervention")} so far.{" "}
        <a href="/dashboard" className="text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg">
          Watch mission control
        </a>
      </span>
    </p>
  );
}

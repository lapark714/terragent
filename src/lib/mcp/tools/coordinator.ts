/** OWNER: outbound builder. Catalog group "coordinator": metrics, playbook allocation, spend, stuck requests. */
import { z } from "zod";
import { PlaybookAllocation } from "../../domain";
import { getAllocation, sampleCap, setPlaybookAllocation } from "../../outbound/allocation";
import { guarded } from "../../outbound/errors";
import { getMetrics } from "../../outbound/metrics";
import { getSpendOverview } from "../../outbound/spend-overview";
import { listStuckRequests } from "../../outbound/stuck";
import { OUTBOUND_PLAYBOOKS } from "../../outbound/util";
import type { ToolRegistrar } from "../types";

export function register(registrar: ToolRegistrar): void {
  const r = guarded(registrar);

  r.tool(
    "get_metrics",
    { since_hours: z.number().positive().optional().describe("cohort window; default all time") },
    (a) => getMetrics({ sinceHours: a.since_hours }),
  );

  r.tool("get_allocation", {}, async () => {
    const allocation = await getAllocation();
    const samples = await Promise.all(OUTBOUND_PLAYBOOKS.map((p) => sampleCap(p, allocation.weights)));
    return { ...allocation, free_samples: samples };
  });

  r.tool("set_playbook_allocation", PlaybookAllocation.shape, async (a, ctx) => {
    const m = await getMetrics();
    const measured = { by_playbook: m.by_playbook, overall: m.overall };
    return setPlaybookAllocation({ input: a, measured, actor: ctx.agent });
  });

  r.tool(
    "get_spend_summary",
    { top_requests: z.number().int().min(1).max(50).optional().describe("how many of the costliest requests to list (default 10)") },
    (a) => getSpendOverview({ topRequests: a.top_requests }),
  );

  r.tool(
    "list_stuck_requests",
    {
      stale_minutes: z.number().int().min(5).max(7 * 24 * 60).optional().describe("no update for this long counts as stuck (default 60)"),
      failed_within_hours: z.number().int().min(1).max(7 * 24).optional().describe("list failed requests that failed this recently (default 24)"),
      limit: z.number().int().min(1).max(100).optional(),
    },
    async (a) => ({
      requests: await listStuckRequests({ staleMinutes: a.stale_minutes, failedWithinHours: a.failed_within_hours, limit: a.limit }),
    }),
  );
}

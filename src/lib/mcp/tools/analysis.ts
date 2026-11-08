/** Catalog group "analysis": the Analytics agent's pipeline job and results. */
import { z } from "zod";
import { AnalysisResult } from "../../domain";
import { getAnalysisJob, getAnalysisView, saveAnalysis } from "../../pipeline/analyses";
import { runAnalysis } from "../../pipeline/run-analysis";
import type { ToolRegistrar } from "../types";

export function register(r: ToolRegistrar): void {
  r.tool(
    "get_analysis_job",
    {
      request_id: z.string(),
      monitor_id: z.string().optional().describe(
        "monitor re-check (from list_due_monitors): keeps the baseline, searches a new after scene since the monitor's last one; works on delivered requests",
      ),
    },
    async ({ request_id, monitor_id }) => getAnalysisJob(request_id, { monitorId: monitor_id }),
  );

  r.tool(
    "run_analysis",
    {
      request_id: z.string(),
      monitor_id: z.string().optional().describe("monitor re-check (from list_due_monitors): recorded on the monitor, nothing saved on the request"),
    },
    async ({ request_id, monitor_id }, ctx) => runAnalysis({ requestId: request_id, monitorId: monitor_id }, ctx.agent),
  );

  r.tool(
    "save_analysis",
    {
      request_id: z.string(),
      result: AnalysisResult.describe("the pipeline's stdout JSON, unchanged"),
      file_ids: z.record(z.string(), z.string()).describe('{ "<image path from result.images>": "fil_…" } from publish_file'),
    },
    async (a, ctx) => saveAnalysis({ requestId: a.request_id, result: a.result, fileIds: a.file_ids }, ctx.agent),
  );

  r.tool("get_analysis", { request_id: z.string() }, async ({ request_id }) => getAnalysisView(request_id));
}

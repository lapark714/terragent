/** Catalog group "reports": Brain 2 drafts and the Verifier's checklist and verdict. */
import { z } from "zod";
import { ReportDraft, Verdict } from "../../domain";
import { getReportView, saveReportDraft } from "../../pipeline/reports";
import { checkReportRules } from "../../pipeline/rules";
import { saveVerdict } from "../../pipeline/verdicts";
import type { ToolRegistrar } from "../types";

export function register(r: ToolRegistrar): void {
  r.tool(
    "save_report_draft",
    {
      ...ReportDraft.shape,
      images: ReportDraft.shape.images.describe("url = the image's file_id from get_analysis (fil_…) or an https URL; the server makes the public link"),
    },
    async (draft, ctx) => saveReportDraft(draft, ctx.agent),
  );

  r.tool(
    "get_report",
    { report_id: z.string().optional(), request_id: z.string().optional().describe("latest report of this request") },
    async (a) => getReportView({ reportId: a.report_id, requestId: a.request_id }),
  );

  r.tool("check_report_rules", { report_id: z.string() }, async ({ report_id }) => checkReportRules(report_id));

  r.tool("save_verdict", Verdict.shape, async (v, ctx) => saveVerdict(v, ctx.agent));
}

/** Brain 2 report drafts: stored per revision, served at an unguessable public URL. */
import { ReportDraft } from "../domain";
import { publicBaseUrl } from "../env";
import { logEvent } from "../events";
import { newId, newToken } from "../ids";
import { json, num, query, queryOne } from "./db";
import { latestAnalysis } from "./analyses";
import { assertPriceCleared } from "./gates";
import { isTerminal, requireRequest } from "./requests";

export interface ReportRow {
  id: string; request_id: string; title: string; answer: string; confidence: "high" | "medium" | "low";
  measurements: ReportDraft["measurements"]; images: ReportDraft["images"]; sources: ReportDraft["sources"]; limitations: string;
  human_review_recommended: boolean; paid_data_estimate: ReportDraft["paid_data_estimate"]; verifier_status: "pending" | "pass" | "fail";
  verifier_notes: string | null; verifier_score: string | number | null; revision: number; public_token: string;
  meta: Record<string, unknown>; created_at: string; updated_at: string;
}

/** Public report page (web module, src/lib/dashboard/public.ts uses the same path). */
export const reportUrl = (token: string) => `${publicBaseUrl()}/r/${token}`;
/** Report images are served by our files route, authorised by the report's token. */
export const reportFileUrl = (fileId: string, token: string) => `${publicBaseUrl()}/api/files/${fileId}?r=${token}`;

export async function getReport(id: string): Promise<ReportRow | null> {
  return queryOne<ReportRow>("SELECT * FROM reports WHERE id = $1", [id]);
}

export async function requireReport(id: string): Promise<ReportRow> {
  const r = await getReport(id);
  if (!r) throw new Error(`Unknown report ${id}.`);
  return r;
}

export async function latestReport(requestId: string): Promise<ReportRow | null> {
  return queryOne<ReportRow>("SELECT * FROM reports WHERE request_id = $1 ORDER BY revision DESC, created_at DESC LIMIT 1", [requestId]);
}

export function reportView(r: ReportRow) {
  return {
    id: r.id, request_id: r.request_id, revision: r.revision, url: reportUrl(r.public_token), title: r.title, answer: r.answer,
    confidence: r.confidence, measurements: r.measurements, images: r.images, sources: r.sources, limitations: r.limitations,
    human_review_recommended: r.human_review_recommended, paid_data_estimate: r.paid_data_estimate,
    verifier: { status: r.verifier_status, score: num(r.verifier_score), notes: r.verifier_notes },
  };
}

/** Image urls may be a published file id (fil_…), an analysis image path, or an https URL (e.g. a free preview). */
function resolveImageUrl(url: string, token: string, fileIds: Record<string, string>): string {
  if (/^fil_[\w-]+$/.test(url)) return reportFileUrl(url, token);
  if (fileIds[url]) return reportFileUrl(fileIds[url], token);
  if (/^https:\/\//.test(url)) return url;
  throw new Error(`Image url "${url}" must be a fil_ id from get_analysis, an analysis image path, or an https URL.`);
}

export async function saveReportDraft(input: ReportDraft, actor: string) {
  const draft = ReportDraft.parse(input);
  const req = await requireRequest(draft.request_id);
  if (isTerminal(req)) throw new Error(`Request ${req.id} is ${req.status}.`);
  await assertPriceCleared(req); // pricing v2: no report work before the customer accepted an option
  const analysis = await latestAnalysis(req.id);
  const token = newToken();
  const images = draft.images.map((img) => ({ ...img, url: resolveImageUrl(img.url, token, analysis?.file_ids ?? {}) }));

  const id = newId("report");
  const revision = req.revisions + 1;
  await query(
    `INSERT INTO reports (id, request_id, title, answer, confidence, measurements, images, sources, limitations,
       human_review_recommended, paid_data_estimate, revision, public_token, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      id, req.id, draft.title, draft.answer, draft.confidence, json(draft.measurements), json(images), json(draft.sources), draft.limitations,
      draft.human_review_recommended, draft.paid_data_estimate ? json(draft.paid_data_estimate) : null, revision, token,
      json({ analysis_id: analysis?.id ?? null, author: actor }),
    ],
  );
  await query("UPDATE requests SET report_id = $2, updated_at = now() WHERE id = $1", [req.id, id]);
  await logEvent("report.drafted", actor, { report_id: id, revision, confidence: draft.confidence }, req.id);
  return {
    report_id: id, revision, url: reportUrl(token),
    next: "Run check_report_rules, fix any failures with a new draft, then hand off to verifier (stage verification).",
  };
}

export async function getReportView(a: { reportId?: string; requestId?: string }) {
  const r = a.reportId ? await getReport(a.reportId) : a.requestId ? await latestReport(a.requestId) : null;
  if (!r) throw new Error(a.reportId ? `Unknown report ${a.reportId}.` : `No report for ${a.requestId ?? "(no id given)"} yet.`);
  return reportView(r);
}

/**
 * Public, capability-style views: a report by its unguessable token, a request's progress by its id.
 * Only verified reports are ever shown; files are served only if the report or its analysis uses them.
 */
import { getDb } from "../db/client";
import { publicBaseUrl } from "../env";
import { Confidence, TERMINAL_STATUSES, type RequestStatus } from "../domain";
import { asPlaybook } from "./board";
import { iso, numOrNull } from "./rows";

const TOKEN_RE = /^[A-Za-z0-9]{16,64}$/;
const FILE_ID_RE = /\bfil_[A-Za-z0-9]+\b/;
const isFileId = (id: string) => /^fil_[A-Za-z0-9]+$/.test(id);

export interface PublicReport {
  token: string;
  title: string;
  question: string;
  location: string | null;
  playbook: ReturnType<typeof asPlaybook>;
  answer: string;
  confidence: Confidence;
  measurements: { metric: string; value: number | null; unit: string | null; before: number | null; after: number | null; note: string | null }[];
  images: { role: string; src: string; caption: string; date: string | null; source: string }[];
  sources: { name: string; collection: string | null; itemId: string | null; datetime: string | null; url: string | null; license: string | null }[];
  limitations: string;
  humanReview: boolean;
  paidDataEstimate: { wouldShow: string; estCostUsd: number; providerId: string } | null;
  verifierScore: number | null;
  verifiedAt: string;
}

/** Naïve file ids go through our proxy (fresh link, access checked); other http(s) URLs pass through. */
export function reportImageSrc(url: string, token: string): string | null {
  const fileId = url.match(FILE_ID_RE)?.[0];
  if (fileId) return `/api/files/${fileId}?r=${encodeURIComponent(token)}`;
  return /^https?:\/\//.test(url) ? url : null;
}

export const reportUrl = (token: string) => `${publicBaseUrl()}/r/${token}`;

const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));

export async function getPublicReport(token: string): Promise<PublicReport | null> {
  if (!TOKEN_RE.test(token)) return null;
  const db = await getDb();
  const [r] = await db.query<Record<string, unknown>>(
    `SELECT rp.*, q.question, q.location_text, q.playbook
     FROM reports rp JOIN requests q ON q.id = rp.request_id
     WHERE rp.public_token = $1 AND rp.verifier_status = 'pass'`,
    [token],
  );
  if (!r) return null;
  const estimate = r.paid_data_estimate as Record<string, unknown> | null;
  return {
    token,
    title: String(r.title),
    question: String(r.question),
    location: str(r.location_text),
    playbook: asPlaybook(String(r.playbook)),
    answer: String(r.answer),
    confidence: Confidence.catch("low").parse(r.confidence),
    measurements: arr(r.measurements).map((m) => ({
      metric: String(m.metric ?? ""),
      value: numOrNull(m.value),
      unit: str(m.unit),
      before: numOrNull(m.before),
      after: numOrNull(m.after),
      note: str(m.note),
    })),
    images: arr(r.images).flatMap((i) => {
      const src = reportImageSrc(String(i.url ?? ""), token);
      return src ? [{ role: String(i.role ?? "after"), src, caption: String(i.caption ?? ""), date: str(i.date), source: String(i.source ?? "") }] : [];
    }),
    sources: arr(r.sources).map((s) => ({
      name: String(s.name ?? ""),
      collection: str(s.collection),
      itemId: str(s.item_id),
      datetime: str(s.datetime),
      url: str(s.url),
      license: str(s.license),
    })),
    limitations: String(r.limitations),
    humanReview: r.human_review_recommended === true,
    paidDataEstimate: estimate
      ? { wouldShow: String(estimate.would_show ?? ""), estCostUsd: Number(estimate.est_cost_usd ?? 0), providerId: String(estimate.provider_id ?? "") }
      : null,
    verifierScore: numOrNull(r.verifier_score),
    verifiedAt: iso(r.updated_at),
  };
}

/** True only if `fileId` appears in this verified report's images or in its request's analyses. */
export async function isFileReferenced(token: string, fileId: string): Promise<boolean> {
  if (!TOKEN_RE.test(token) || !isFileId(fileId)) return false;
  const db = await getDb();
  const [report] = await db.query<{ images: unknown; request_id: string }>(
    "SELECT images, request_id FROM reports WHERE public_token = $1 AND verifier_status = 'pass'",
    [token],
  );
  if (!report) return false;
  if (arr(report.images).some((i) => String(i.url ?? "").match(FILE_ID_RE)?.[0] === fileId)) return true;
  const analyses = await db.query<{ file_ids: Record<string, string> | null }>("SELECT file_ids FROM analyses WHERE request_id = $1", [
    report.request_id,
  ]);
  return analyses.some((a) => Object.values(a.file_ids ?? {}).includes(fileId));
}

export interface RequestProgress {
  id: string;
  status: RequestStatus;
  terminal: boolean;
  owner: string | null;
  question: string;
  location: string | null;
  refusalReason: string | null;
  createdAt: string;
  updatedAt: string;
  events: { type: string; actor: string; at: string }[];
  report: { url: string; path: string; title: string; answer: string; confidence: Confidence; limitations: string; humanReview: boolean } | null;
}

/** A request's progress. The id is the capability (it is only shown in full to whoever made the request). */
export async function getRequestProgress(id: string): Promise<RequestProgress | null> {
  if (!/^req_[a-z0-9]{6,32}$/.test(id)) return null;
  const db = await getDb();
  const [r] = await db.query<Record<string, unknown>>(
    "SELECT id, status, owner_agent, question, location_text, refusal_reason, created_at, updated_at FROM requests WHERE id = $1",
    [id],
  );
  if (!r) return null;
  const status = r.status as RequestStatus;
  const [events, [report]] = await Promise.all([
    db.query<{ type: string; actor: string; created_at: unknown }>(
      "SELECT type, actor, created_at FROM events WHERE request_id = $1 ORDER BY created_at DESC, id DESC LIMIT 80",
      [id],
    ),
    status === "delivered"
      ? db.query<{ public_token: string; title: string; answer: string; confidence: string; limitations: string; human_review_recommended: boolean }>(
          `SELECT public_token, title, answer, confidence, limitations, human_review_recommended FROM reports
           WHERE request_id = $1 AND verifier_status = 'pass' ORDER BY created_at DESC LIMIT 1`,
          [id],
        )
      : Promise.resolve([]),
  ]);
  return {
    id,
    status,
    terminal: TERMINAL_STATUSES.has(status),
    owner: str(r.owner_agent),
    question: String(r.question),
    location: str(r.location_text),
    refusalReason: str(r.refusal_reason),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    events: events.reverse().map((e) => ({ type: e.type, actor: e.actor, at: iso(e.created_at) })),
    report: report
      ? {
          url: reportUrl(report.public_token),
          path: `/r/${report.public_token}`,
          title: report.title,
          answer: report.answer,
          confidence: Confidence.catch("low").parse(report.confidence),
          limitations: report.limitations,
          humanReview: report.human_review_recommended,
        }
      : null,
  };
}

/** The API key that created a request through POST /api/answer, if any. */
export async function requestApiKeyId(id: string): Promise<string | null> {
  const db = await getDb();
  const [r] = await db.query<{ key_id: string | null }>("SELECT meta->>'api_key_id' AS key_id FROM requests WHERE id = $1", [id]);
  return r?.key_id ?? null;
}

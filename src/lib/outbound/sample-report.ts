/** The verified free-sample report behind a prospect, shaped for outreach emails and contact-form text. */
import { getDb } from "../db/client";
import type { ReportForEmail } from "../email/templates";
import { reportUrl } from "../pipeline/reports";
import { truncate } from "./util";

interface ReportRow {
  id: string;
  request_id: string;
  title: string;
  answer: string;
  confidence: "high" | "medium" | "low";
  limitations: string;
  human_review_recommended: boolean;
  images: { role: string; url: string; caption: string; date?: string | null }[];
  measurements: { metric: string; value: number | null; unit: string | null; note?: string | null }[];
  sources: { name: string; datetime: string | null }[];
  verifier_status: string;
  public_token: string;
}

/** Latest report for a request, preferring one that passed verification. */
export async function latestReport(requestId: string): Promise<ReportRow | null> {
  const db = await getDb();
  const [row] = await db.query<ReportRow>(
    `SELECT id, request_id, title, answer, confidence, limitations, human_review_recommended, images, measurements, sources,
            verifier_status, public_token
     FROM reports WHERE request_id = $1 ORDER BY (verifier_status = 'pass') DESC, revision DESC, created_at DESC LIMIT 1`,
    [requestId],
  );
  return row ?? null;
}

export function reportForEmail(r: ReportRow): ReportForEmail {
  return {
    id: r.id,
    title: r.title,
    answer: r.answer,
    confidence: r.confidence,
    limitations: r.limitations,
    human_review_recommended: r.human_review_recommended,
    url: reportUrl(r.public_token),
    images: r.images.map((i) => ({ role: i.role, url: i.url, caption: i.caption })),
    measurements: r.measurements.map((m) => ({ metric: m.metric, value: m.value, unit: m.unit, note: m.note ?? null })),
    sources: r.sources.map((s) => ({ name: s.name, datetime: s.datetime })),
  };
}

/** One finding for the first touch: the first measured value, else the answer's first sentence. */
export function headlineFinding(r: Pick<ReportForEmail, "answer" | "measurements">): string {
  const m = r.measurements.find((x) => x.value !== null);
  const firstSentence = truncate(r.answer.split(/(?<=[.!?])\s/)[0] ?? r.answer, 300);
  return m ? `${firstSentence} (${m.metric}: ${m.value}${m.unit ? ` ${m.unit}` : ""})` : firstSentence;
}

/** The image to lead with (same pick as the email renderer): the after view, else the change view. */
export function leadImage(r: Pick<ReportForEmail, "images">) {
  return r.images.find((i) => i.role === "after") ?? r.images.find((i) => i.role === "change") ?? r.images[0] ?? null;
}

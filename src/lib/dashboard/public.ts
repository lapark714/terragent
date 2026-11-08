/**
 * Public, capability-style views: a report by its unguessable token, a request's progress by its id.
 * Only verified reports are ever shown; files are served only if the report or its analysis uses them.
 */
import { getDb } from "../db/client";
import { publicBaseUrl } from "../env";
import { Confidence, QuoteOptionId, QuoteOptionKind, TERMINAL_STATUSES, type RequestStatus } from "../domain";
import { quoteAcceptUrl } from "../email/templates";
import { asPlaybook } from "./board";
import { iso, isoOrNull, numOrNull } from "./rows";

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
  /**
   * The request's quote once it has options (pricing v2), so the status page can offer one Accept button per option.
   * Always set by getRequestProgress (null when there is none); optional only so older fixtures still type-check.
   */
  quote?: PublicQuote | null;
}

/** The shape of a request id (newId("request")); anything else is answered "not found" without a read. */
export const REQUEST_ID_RE = /^req_[a-z0-9]{6,32}$/;

/** A request's progress. The id is the capability (it is only shown in full to whoever made the request). */
export async function getRequestProgress(id: string): Promise<RequestProgress | null> {
  if (!REQUEST_ID_RE.test(id)) return null;
  const db = await getDb();
  const [r] = await db.query<Record<string, unknown>>(
    "SELECT id, status, owner_agent, question, location_text, refusal_reason, quote_id, created_at, updated_at FROM requests WHERE id = $1",
    [id],
  );
  if (!r) return null;
  const status = r.status as RequestStatus;
  const quoteId = str(r.quote_id);
  const [events, [report], [quote]] = await Promise.all([
    db.query<{ type: string; actor: string; created_at: unknown }>(
      // A refused handoff is an expected recovery step between agents, not news for the customer.
      "SELECT type, actor, created_at FROM events WHERE request_id = $1 AND type <> 'handoff.refused' ORDER BY created_at DESC, id DESC LIMIT 80",
      [id],
    ),
    status === "delivered"
      ? db.query<{ public_token: string; title: string; answer: string; confidence: string; limitations: string; human_review_recommended: boolean }>(
          `SELECT public_token, title, answer, confidence, limitations, human_review_recommended FROM reports
           WHERE request_id = $1 AND verifier_status = 'pass' ORDER BY created_at DESC LIMIT 1`,
          [id],
        )
      : Promise.resolve([]),
    quoteId ? db.query<{ q: Record<string, unknown> }>(QUOTE_ROW_SQL, [quoteId]) : Promise.resolve([]),
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
    quote: quote ? publicQuote(quote.q, { currentQuoteId: quoteId, requestStatus: status }) : null,
  };
}

// ---------------------------------------------------------------------------
// Quotes (pricing v2): the options a customer can accept, by request id (status page) or by accept token (quote page)
// ---------------------------------------------------------------------------

/** quotes.accept_token as minted by create_quote (opaque, URL-safe); anything else is "not found" without a read. */
export const QUOTE_TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;
const isOptionId = (v: unknown): v is QuoteOptionId => QuoteOptionId.safeParse(v).success;

/** The whole row as JSON (numerics as numbers), so a database before migration 080 still answers, with no options. */
const QUOTE_ROW_SQL = "SELECT to_jsonb(q) AS q FROM quotes q WHERE q.id = $1";

/**
 * A quote option as the customer sees it: what it answers, how sharp, how many dates, how fast, what it costs.
 * Costs, margin, risk buffer, unit prices, suppliers and pricing notes stay internal.
 */
export interface PublicQuoteOption {
  option_id: QuoteOptionId;
  label: string;
  /** What this option can answer. */
  answers: string;
  kind: QuoteOptionKind;
  /** Finest resolution across the option's data, in metres. */
  resolution_m: number | null;
  data_types: string[];
  /** Most dates (scenes) any of its data covers. */
  epochs: number | null;
  /** Exactly one of price_usd / price_range_usd is set: a range while a supplier price is unconfirmed. */
  price_usd: number | null;
  price_range_usd: [number, number] | null;
  needs_supplier_quote: boolean;
  delivery_time: string | null;
  confidence: Confidence;
  recommended: boolean;
}

/** Why a quote can't be accepted (null while it can). */
export type QuoteClosedReason = "accepted" | "expired" | "superseded" | "closed";

export interface PublicQuote {
  id: string;
  status: string;
  options: PublicQuoteOption[];
  recommended_option_id: QuoteOptionId | null;
  accepted_option_id: QuoteOptionId | null;
  accepted_at: string | null;
  valid_until: string | null;
  closed_reason: QuoteClosedReason | null;
  /** The quote page (one Accept button per option); null once the quote can't be accepted or has no token. */
  accept_url: string | null;
}

/** Statuses a customer can still accept: ACCEPTABLE_QUOTE_STATUSES in src/lib/pipeline/quotes.ts (not imported, to keep this module light). */
const OPEN_QUOTE_STATUSES = new Set(["approved", "sent"]);

function range(v: unknown): [number, number] | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const [lo, hi] = v.map(numOrNull);
  return lo !== null && hi !== null && Number.isFinite(lo) && Number.isFinite(hi) ? [lo, hi] : null;
}

function publicOption(o: Record<string, unknown>, recommendedId: string | null): PublicQuoteOption | null {
  if (!isOptionId(o.option_id)) return null;
  const data = arr(o.data);
  const resolutions = data.map((d) => numOrNull(d.resolution_m)).filter((n): n is number => n !== null && Number.isFinite(n) && n > 0);
  const epochs = data.map((d) => numOrNull(d.epochs)).filter((n): n is number => n !== null && Number.isFinite(n));
  const priceRange = range(o.price_range_usd);
  const price = priceRange ? null : numOrNull(o.price_usd);
  return {
    option_id: o.option_id,
    label: String(o.label ?? `Option ${o.option_id}`).slice(0, 200),
    answers: String(o.answers ?? "").slice(0, 600),
    kind: QuoteOptionKind.catch("mixed").parse(o.kind),
    resolution_m: resolutions.length ? Math.min(...resolutions) : null,
    data_types: [...new Set(data.map((d) => str(d.data_type)).filter((t): t is string => !!t))],
    epochs: epochs.length ? Math.max(...epochs) : null,
    price_usd: price,
    price_range_usd: priceRange,
    needs_supplier_quote: !!priceRange || data.some((d) => d.needs_supplier_quote === true),
    delivery_time: str(o.delivery_time)?.slice(0, 120) ?? null,
    confidence: Confidence.catch("low").parse(o.confidence),
    recommended: o.option_id === recommendedId,
  };
}

function closedReason(a: {
  accepted: QuoteOptionId | null; superseded: boolean; requestStatus: RequestStatus; status: string; validUntil: string | null; now: number;
}): QuoteClosedReason | null {
  if (a.accepted) return "accepted";
  if (a.superseded) return "superseded";
  if (a.status === "superseded") return "superseded";
  if (a.status === "expired" || (a.validUntil && Date.parse(a.validUntil) < a.now)) return "expired";
  if (TERMINAL_STATUSES.has(a.requestStatus) || !OPEN_QUOTE_STATUSES.has(a.status)) return "closed";
  return null;
}

/**
 * The customer-facing view of a quote row (to_jsonb of quotes), or null for a quote without options (pricing v1).
 * `currentQuoteId` is the request's quote_id: an older quote of a re-priced request is superseded.
 */
export function publicQuote(
  q: Record<string, unknown>, ctx: { currentQuoteId: string | null; requestStatus: RequestStatus }, now = Date.now(),
): PublicQuote | null {
  const recommended = isOptionId(q.recommended_option_id) ? q.recommended_option_id : null;
  const options = arr(q.options).flatMap((o) => publicOption(o, recommended) ?? []).slice(0, 3);
  if (!options.length) return null;
  const accepted = isOptionId(q.accepted_option_id) ? q.accepted_option_id : null;
  const validUntil = isoOrNull(q.valid_until);
  const status = String(q.status ?? "");
  const closed = closedReason({ accepted, superseded: ctx.currentQuoteId !== String(q.id), requestStatus: ctx.requestStatus, status, validUntil, now });
  const token = str(q.accept_token);
  return {
    id: String(q.id),
    status,
    options,
    recommended_option_id: recommended && options.some((o) => o.option_id === recommended) ? recommended : null,
    accepted_option_id: accepted,
    accepted_at: isoOrNull(q.accepted_at),
    valid_until: validUntil,
    closed_reason: closed,
    accept_url: token && !closed ? quoteAcceptUrl(token) : null,
  };
}

export interface QuoteByToken {
  requestId: string;
  requestStatus: RequestStatus;
  question: string;
  quote: PublicQuote;
}

/** The quote behind an accept link, for the quote page and POST /api/quotes/accept. The token is the capability. */
export async function getQuoteByToken(token: string): Promise<QuoteByToken | null> {
  if (!QUOTE_TOKEN_RE.test(token)) return null;
  const db = await getDb();
  const [row] = await db.query<{ q: Record<string, unknown>; request_id: string; status: RequestStatus; question: string; quote_id: string | null }>(
    `SELECT to_jsonb(q) AS q, r.id AS request_id, r.status, r.question, r.quote_id
     FROM quotes q JOIN requests r ON r.id = q.request_id
     WHERE q.accept_token = $1 AND NOT r.is_free_sample`,
    [token],
  );
  const quote = row ? publicQuote(row.q, { currentQuoteId: row.quote_id, requestStatus: row.status }) : null;
  return row && quote ? { requestId: row.request_id, requestStatus: row.status, question: row.question, quote } : null;
}

/** What POST /api/quotes/accept's error codes mean, in the customer's words (the quote page shows the same text). */
export const QUOTE_ACCEPT_ERRORS: Partial<Record<string, string>> = {
  rate_limited: "Too many tries from your network. Wait a minute and try again, or reply to the quote email.",
  not_found: "This quote link doesn't work. Reply to the quote email with the option you want.",
  already_accepted: "This quote was already accepted with another option. To change it, reply to the quote email.",
  unknown_option: "That option isn't part of this quote.",
  expired: "This quote has expired. Reply to the quote email and we'll price it again.",
  superseded: "A newer quote replaced this one. Check your email for it.",
  closed: "This request is closed, so its quote can't be accepted.",
  not_acceptable: "This quote can't be accepted right now. Reply to the quote email and we'll sort it out.",
  db_suspended: "We can't record that just now. Try again in a few minutes, or reply to the quote email.",
  unavailable: "We couldn't record that just now. Try again in a minute, or reply to the quote email with the option you want.",
};

/**
 * The request's current quote, as GET /api/answer/{id} shows it to the key that created the request (the route adds
 * the PublicQuote fields: options, recommended_option_id, accept_url, …). Nothing runs until an option is accepted.
 */
export interface ApiQuote {
  id: string;
  /** The recommended option's price (the accepted one's once accepted; the low end of a range). */
  price_usd: number;
  /**
   * approved (priced, waiting for you to accept an option) | sent (emailed, waiting for you) | accepted (an option was
   * accepted; the work runs) | superseded (replaced by a newer quote) | expired | declined | needs_approval (pre-v2 only)
   */
  status: string;
  /** Always false since pricing v2: no price starts work by itself. Kept for older clients. */
  auto_approved: boolean;
  line_items: { label: string; amount_usd: number }[];
  payment_link: string | null;
}

/** The API key that created a request through POST /api/answer (null if none), and the request's quote. */
export async function getApiRequest(id: string): Promise<{ keyId: string | null; quote: ApiQuote | null } | null> {
  if (!REQUEST_ID_RE.test(id)) return null;
  const db = await getDb();
  const [r] = await db.query<{
    key_id: string | null; quote_id: string | null; price_usd: unknown; quote_status: string | null; auto_approved: boolean | null;
    line_items: unknown; payment_link: string | null;
  }>(
    `SELECT r.meta->>'api_key_id' AS key_id, q.id AS quote_id, q.price_usd, q.status AS quote_status, q.auto_approved, q.line_items, q.payment_link
     FROM requests r LEFT JOIN quotes q ON q.id = r.quote_id WHERE r.id = $1`,
    [id],
  );
  if (!r) return null;
  return {
    keyId: r.key_id ?? null,
    quote: r.quote_id
      ? {
          id: r.quote_id,
          price_usd: numOrNull(r.price_usd) ?? 0,
          status: String(r.quote_status),
          auto_approved: r.auto_approved === true,
          line_items: arr(r.line_items).slice(0, 8).map((i) => ({ label: String(i.label ?? "").slice(0, 80), amount_usd: numOrNull(i.amount_usd) ?? 0 })),
          payment_link: str(r.payment_link),
        }
      : null,
  };
}

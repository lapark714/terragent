/**
 * Every customer/supplier/outreach email body is rendered here so the compliance pieces (sender identity,
 * AI disclosure, opt-out for outreach, CAN-SPAM postal line) are never forgotten. sendEmail re-checks them.
 * Tone: plain, warm, specific, short. Bodies are plain text first; HTML is the same words, lightly styled.
 */
import { PRICING } from "../config";
import { env } from "../env";
import { DEFAULT_FOLLOWUP } from "./template-library";

export interface RenderedEmail { subject: string; text: string; html: string }

export interface ReportForEmail {
  id: string; title: string; answer: string; confidence: "high" | "medium" | "low"; limitations: string;
  human_review_recommended: boolean; url: string;
  images: { role: string; url: string; caption: string }[];
  measurements: { metric: string; value: number | null; unit: string | null; note?: string | null }[];
  sources: { name: string; datetime: string | null }[];
}

export const SENDER_IDENTITY = "Terragent, an AI-run Earth intelligence company";
/** Exact sentence sendEmail looks for; if it's missing, the standard footer is appended. */
export const AI_DISCLOSURE = "This email was written and sent by an AI agent at Terragent, an AI-run company.";
export const HUMAN_REVIEW_NOTE =
  "Human review recommended: this is a remote first look from satellite data. For insurance, legal or safety decisions, have a qualified person check it.";

export class TemplateError extends Error {
  name = "TemplateError";
}

/** CAN-SPAM needs a physical postal address in commercial email (outreach / follow-ups). */
export function postalAddress(): string | null {
  return env("COMPANY_POSTAL_ADDRESS") ?? null;
}

// ---------------------------------------------------------------------------
// Placeholders: {{name}} or {{name|fallback}}. Unknown or empty → TemplateError (fail closed).
// ---------------------------------------------------------------------------

const PLACEHOLDER = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\|([^}]*))?\}\}/g;

export function fillTemplate(template: string, vars: Record<string, string | undefined>): string {
  if (/\{\{|\}\}/.test(template.replace(PLACEHOLDER, ""))) throw new TemplateError("malformed placeholder in template");
  const missing = new Set<string>();
  const out = template.replace(PLACEHOLDER, (_m, key: string, fallback: string | undefined) => {
    const value = vars[key]?.trim() || fallback?.trim();
    if (!value) missing.add(key);
    return value ?? "";
  });
  if (missing.size) throw new TemplateError(`unknown or empty placeholder(s): ${[...missing].join(", ")}`);
  if (hasPlaceholder(out)) throw new TemplateError("a value is itself a placeholder");
  return out;
}

/** A real {{name}} / {{name|fallback}} left in text. Stray braces (a customer's pasted JSON) don't count. */
export function hasPlaceholder(s: string): boolean {
  return new RegExp(PLACEHOLDER.source).test(s);
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const URL_RE = /https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)]/g;

function linkify(escaped: string): string {
  return escaped.replace(URL_RE, (u) => `<a href="${u}" style="color:#0f5c4a">${u}</a>`);
}

/** Plain text → HTML paragraphs (blank line = new paragraph, "- " lines = list). */
export function textToHtml(text: string): string {
  return text
    .trim()
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split("\n");
      if (lines.every((l) => l.startsWith("- "))) {
        const items = lines.map((l) => `<li>${linkify(escapeHtml(l.slice(2)))}</li>`).join("");
        return `<ul style="margin:0 0 14px;padding-left:20px">${items}</ul>`;
      }
      return `<p style="margin:0 0 14px">${lines.map((l) => linkify(escapeHtml(l))).join("<br>")}</p>`;
    })
    .join("\n");
}

function imageHtml(img: { url: string; caption: string }): string {
  return `<figure style="margin:0 0 16px"><img src="${escapeHtml(img.url)}" alt="${escapeHtml(img.caption)}" width="560" style="display:block;max-width:100%;height:auto;border-radius:6px;border:1px solid #e3e3e3"><figcaption style="font-size:13px;color:#666;margin-top:6px">${escapeHtml(img.caption)}</figcaption></figure>`;
}

function layout(innerHtml: string): string {
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1d1d1f;max-width:600px">${innerHtml}</div>`;
}

// ---------------------------------------------------------------------------
// Footer (identity + AI disclosure + opt-out + postal line)
// ---------------------------------------------------------------------------

export function footerLines(o: { optOutUrl?: string | null; includeDisclosure?: boolean } = {}): string[] {
  const lines: string[] = [];
  if (o.includeDisclosure !== false) lines.push(`${SENDER_IDENTITY}. ${AI_DISCLOSURE} Reply to this email with any question.`);
  if (o.optOutUrl) {
    lines.push(`Don't want emails like this? Opt out here: ${o.optOutUrl} (or reply "stop").`);
    const postal = postalAddress();
    if (postal) lines.push(`Terragent, ${postal}`);
  }
  return lines;
}

function footerText(lines: string[]): string {
  return lines.length ? `\n\n--\n${lines.join("\n")}` : "";
}

function footerHtml(lines: string[]): string {
  if (!lines.length) return "";
  const body = lines.map((l) => linkify(escapeHtml(l))).join("<br>");
  return `<hr style="border:none;border-top:1px solid #e3e3e3;margin:22px 0 12px"><p style="margin:0;font-size:12px;line-height:1.5;color:#6b6b6b">${body}</p>`;
}

/**
 * Make an email compliant: adds the AI disclosure if missing and, for outreach, the opt-out link if missing.
 * Generates HTML from the text when no HTML was given.
 */
export function ensureCompliance(e: { text: string; html?: string }, o: { optOutUrl?: string | null } = {}): { text: string; html: string } {
  const textLines = footerLines({ includeDisclosure: !e.text.includes(AI_DISCLOSURE), optOutUrl: o.optOutUrl && !e.text.includes(o.optOutUrl) ? o.optOutUrl : null });
  const text = e.text.trimEnd() + footerText(textLines);
  if (!e.html) return { text, html: layout(textToHtml(e.text) + footerHtml(textLines)) };
  const htmlLines = footerLines({
    includeDisclosure: !e.html.includes(AI_DISCLOSURE),
    optOutUrl: o.optOutUrl && !e.html.includes(o.optOutUrl) ? o.optOutUrl : null,
  });
  return { text, html: htmlLines.length ? e.html + layout(footerHtml(htmlLines)) : e.html };
}

function compose(subject: string, paragraphs: string[], o: { images?: { url: string; caption: string }[]; optOutUrl?: string | null } = {}): RenderedEmail {
  const body = paragraphs.filter(Boolean).join("\n\n");
  const lines = footerLines({ optOutUrl: o.optOutUrl });
  const images = o.images ?? [];
  const imageText = images.length ? "\n\n" + images.map((i) => `${i.caption}: ${i.url}`).join("\n") : "";
  return {
    subject,
    text: body + imageText + footerText(lines),
    html: layout(textToHtml(body) + images.map(imageHtml).join("") + footerHtml(lines)),
  };
}

// ---------------------------------------------------------------------------
// Small formatting helpers
// ---------------------------------------------------------------------------

const greeting = (name?: string | null) => `Hi ${name?.trim() || "there"},`;
const usdFmt = (n: number) => `$${n.toFixed(n % 1 === 0 ? 0 : 2)}`;
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const dateOnly = (iso: string | null) => (iso ? iso.slice(0, 10) : "date unknown");

function measurementLine(m: ReportForEmail["measurements"][number]): string {
  const value = m.value === null ? "n/a" : `${Number(m.value.toPrecision(4))}${m.unit ? ` ${m.unit}` : ""}`;
  return `- ${m.metric}: ${value}${m.note ? ` (${m.note})` : ""}`;
}

/** Before/after first, then change/index maps. */
function reportImages(report: ReportForEmail, max = 3) {
  const order = ["before", "after", "change", "index"];
  return [...report.images].sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role)).slice(0, max);
}

/** The asset image for a first touch: after > change > anything. */
function assetImage(report: ReportForEmail) {
  const pick = report.images.find((i) => i.role === "after") ?? report.images.find((i) => i.role === "change") ?? report.images[0];
  if (!pick) throw new TemplateError("outreach needs an image of the prospect's asset");
  return pick;
}

// ---------------------------------------------------------------------------
// Customer (hello@)
// ---------------------------------------------------------------------------

/** Every delivery offers monitoring of the site (spec §6 pricing); a reply accepting it reaches Comms 2 as a follow-up. */
export const MONITORING_OFFER =
  `Want us to keep watching this site? Reply "monitor" and we'll re-check it on each new clear satellite pass and write ` +
  `when something changes (${usdFmt(PRICING.monitoringPerSiteMonthlyUsd)} per site per month).`;

export function renderReportDelivery(a: {
  customerName?: string | null; question: string; report: ReportForEmail; paymentLink?: string | null; priceUsd?: number | null;
  /** Default true; false when the site is already monitored (e.g. a monitoring follow-up's own report). */
  offerMonitoring?: boolean;
}): RenderedEmail {
  const r = a.report;
  const price = a.priceUsd
    ? a.paymentLink
      ? `The price for this report is ${usdFmt(a.priceUsd)}. You can pay here: ${a.paymentLink}`
      : `The price for this report is ${usdFmt(a.priceUsd)}. Reply to this email and we'll arrange payment.`
    : "";
  return compose(`Your Terragent report: ${r.title}`, [
    greeting(a.customerName),
    `You asked: "${a.question.trim()}"`,
    r.answer.trim(),
    `Confidence: ${capitalise(r.confidence)}.`,
    r.measurements.length ? `Key measurements:\n${r.measurements.slice(0, 6).map(measurementLine).join("\n")}` : "",
    r.sources.length ? `Sources:\n${r.sources.map((s) => `- ${s.name}, ${dateOnly(s.datetime)}`).join("\n")}` : "",
    `Limitations: ${r.limitations.trim()}`,
    r.human_review_recommended ? HUMAN_REVIEW_NOTE : "",
    `Full report with all images and sources: ${r.url}`,
    price,
    a.offerMonitoring === false ? "" : MONITORING_OFFER,
  ], { images: reportImages(r) });
}

export function renderQuote(a: { customerName?: string | null; question: string; quote: { price_usd: number; line_items: { label: string; amount_usd: number }[]; auto_approved: boolean }; paymentLink?: string | null; requestId: string }): RenderedEmail {
  const lines = a.quote.line_items.map((l) => `- ${l.label}: ${usdFmt(l.amount_usd)}`).join("\n");
  return compose(`Your Terragent quote (${a.requestId})`, [
    greeting(a.customerName),
    `Here's our quote for your question: "${a.question.trim()}"`,
    lines,
    `Total: ${usdFmt(a.quote.price_usd)}`,
    `To go ahead, reply "yes" to this email${a.paymentLink ? ` or pay here: ${a.paymentLink}` : ""}. We start as soon as you confirm and send the answer to this thread.`,
    `Reference: ${a.requestId}`,
  ]);
}

export function renderClarifyingQuestion(a: { customerName?: string | null; question: string; clarifyingQuestion: string }): RenderedEmail {
  return compose("A quick question about your Terragent request", [
    greeting(a.customerName),
    `Thanks for your request: "${a.question.trim()}"`,
    `Before we start, one question: ${a.clarifyingQuestion.trim()}`,
    "Just reply to this email and we'll take it from there.",
  ]);
}

export function renderRefusal(a: { customerName?: string | null; reason: string }): RenderedEmail {
  return compose("About your Terragent request", [
    greeting(a.customerName),
    `Thanks for writing to us. We can't take on this request: ${a.reason.trim()}`,
    "We don't monitor individual people or help target anyone, and we decline requests that could be used that way.",
    "If we've misunderstood what you need, reply and tell us a bit more.",
  ]);
}

/**
 * A status update or monitoring follow-up that carries no new report: what changed, in the agent's words, plus a
 * link to the earlier report when there is one. Monitoring updates say we keep watching.
 */
export function renderCustomerUpdate(a: { customerName?: string | null; question: string; update: string; reportUrl?: string | null; monitoring?: boolean }): RenderedEmail {
  return compose(a.monitoring ? "Monitoring update from Terragent" : "An update on your Terragent request", [
    greeting(a.customerName),
    a.monitoring ? `We re-checked the site you asked us to watch: "${a.question.trim()}"` : `An update on your request: "${a.question.trim()}"`,
    a.update.trim(),
    a.reportUrl ? `Your earlier report: ${a.reportUrl}` : "",
    a.monitoring ? "We'll keep watching and write again when something changes." : "",
  ]);
}

// ---------------------------------------------------------------------------
// Suppliers (data@)
// ---------------------------------------------------------------------------

export function renderSupplierQuoteRequest(a: { providerName: string; product: string; aoiDescription: string; areaKm2: number | null; dateWindow: string; orderId: string }): RenderedEmail {
  return compose(`Quote request: ${a.product} (${a.orderId})`, [
    `Hello ${a.providerName} team,`,
    "We'd like a quote for the following imagery:",
    [
      `- Product: ${a.product}`,
      `- Area: ${a.aoiDescription}`,
      a.areaKm2 !== null ? `- Size: ${Number(a.areaKm2.toFixed(2))} km²` : "",
      `- Dates: ${a.dateWindow}`,
    ].filter(Boolean).join("\n"),
    "Could you tell us the price (and any minimum order), delivery time, license terms, and whether a preview is available? We deliver derived results to one end customer and never resell raw imagery.",
    `Please keep this reference in the subject: ${a.orderId}`,
  ]);
}

// ---------------------------------------------------------------------------
// Outreach (outreach@) — approved templates only, see template-library.ts
// ---------------------------------------------------------------------------

export function renderOutreach(a: { template: { subject: string; body: string }; vars: Record<string, string>; report: ReportForEmail; optOutUrl: string }): RenderedEmail {
  const vars = { report_url: a.report.url, report_title: a.report.title, ...a.vars };
  const image = assetImage(a.report);
  return compose(fillTemplate(a.template.subject, vars), [fillTemplate(a.template.body, vars)], { images: [image], optOutUrl: a.optOutUrl });
}

export function renderFollowup(a: {
  contactName?: string | null; company: string; newInfo: string; report: ReportForEmail; optOutUrl: string;
  /** Approved follow-up template; defaults to the library follow-up text. */
  template?: { subject: string; body: string };
  vars?: Record<string, string>;
}): RenderedEmail {
  const vars = {
    contact_name: a.contactName ?? "",
    company: a.company,
    new_info: a.newInfo,
    price: `${usdFmt(PRICING.monitoringPerSiteMonthlyUsd)} per site per month`,
    ...a.vars,
  };
  return renderOutreach({ template: a.template ?? DEFAULT_FOLLOWUP, vars, report: a.report, optOutUrl: a.optOutUrl });
}

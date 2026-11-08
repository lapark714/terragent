/** Comms 2 (hello@) customer email: clarifying questions, refusals, quotes and report delivery, in the request's thread. */
import { createHash } from "node:crypto";
import { type RenderedEmail, type ReportForEmail, renderClarifyingQuestion, renderQuote, renderRefusal, renderReportDelivery } from "../email/templates";
import { replyInThread, type SendResult, sendEmail } from "../email/send";
import { getThread } from "../email/threads";
import { Inbox } from "../domain";
import { logEvent } from "../events";
import { num, query } from "./db";
import { priceBlockedReason } from "./gates";
import { getQuote } from "./quotes";
import { latestReport, reportView } from "./reports";
import { isTerminal, requireRequest, setStatus, type RequestRow } from "./requests";

const hash = (t: string) => createHash("sha256").update(t).digest("hex").slice(0, 16);

/** Reply in the customer's thread when there is one, else start a thread from hello@. */
async function sendToCustomer(req: RequestRow, email: RenderedEmail, idempotencyKey: string, actor: string): Promise<SendResult> {
  const inbox = Inbox.safeParse(req.inbox).data ?? "hello";
  const common = { inbox, text: email.text, html: email.html, kind: "customer" as const, requestId: req.id, idempotencyKey, actor };
  if (req.thread_id) {
    const thread = await getThread(req.thread_id);
    const last = thread?.messages.filter((m) => m.direction === "inbound").at(-1) ?? thread?.messages.at(-1);
    if (last) return replyInThread({ ...common, inReplyToMessageId: last.agentmail_message_id });
  }
  if (!req.customer_email) throw new Error("This request has no customer email or thread to reply to.");
  const sent = await sendEmail({ ...common, inbox: "hello", to: req.customer_email, subject: email.subject });
  if (sent.thread_id && !req.thread_id) {
    await query("UPDATE requests SET thread_id = $2, inbox = 'hello', updated_at = now() WHERE id = $1", [req.id, sent.thread_id]);
  }
  return sent;
}

const outcome = (s: SendResult) => ({ status: s.status, message_id: s.message_id, thread_id: s.thread_id ?? null, blocked_reason: s.blocked_reason ?? null });

/** Customer email only for requests still in progress (a refusal goes out on the refused request itself). */
function assertOpen(req: RequestRow) {
  if (isTerminal(req)) throw new Error(`Request ${req.id} is ${req.status}; nothing more is sent to the customer for it.`);
}

export async function sendCustomerMessage(a: { requestId: string; kind: "clarifying_question" | "refusal"; text: string }, actor: string) {
  const req = await requireRequest(a.requestId);
  let email: RenderedEmail;
  if (a.kind === "refusal") {
    if (req.status !== "refused") throw new Error("Record the refusal first: record_screening with allowed=false.");
    email = renderRefusal({ customerName: req.customer_name, reason: a.text });
  } else {
    assertOpen(req);
    email = renderClarifyingQuestion({ customerName: req.customer_name, question: req.question, clarifyingQuestion: a.text });
  }
  const sent = await sendToCustomer(req, email, `${req.id}:${a.kind}:${hash(a.text)}`, actor);
  if (a.kind === "clarifying_question" && sent.status === "sent") await setStatus(req.id, "clarifying", actor, "Asked the customer a clarifying question");
  await logEvent("customer_message.sent", actor, { kind: a.kind, status: sent.status, blocked_reason: sent.blocked_reason }, req.id);
  return outcome(sent);
}

export async function sendQuote(requestId: string, actor: string) {
  const req = await requireRequest(requestId);
  assertOpen(req);
  const quote = req.quote_id ? await getQuote(req.quote_id) : null;
  if (!quote) throw new Error("No quote yet; pricing must create_quote first.");
  if (quote.status === "needs_approval") throw new Error(`Quote ${quote.id} is above the cap; a founder must approve it first.`);
  if (!["approved", "sent"].includes(quote.status)) throw new Error(`Quote ${quote.id} is ${quote.status}; there is nothing to send.`);
  const email = renderQuote({
    customerName: req.customer_name, question: req.question, requestId: req.id, paymentLink: quote.payment_link,
    quote: { price_usd: num(quote.price_usd) ?? 0, line_items: quote.line_items, auto_approved: quote.auto_approved },
  });
  const sent = await sendToCustomer(req, email, `${req.id}:quote:${quote.id}`, actor);
  if (sent.status === "sent") {
    await query("UPDATE quotes SET status = 'sent', updated_at = now() WHERE id = $1", [quote.id]);
    if (["pricing", "awaiting_approval"].includes(req.status)) await setStatus(req.id, "quoted", actor, `Quote ${quote.id} sent`);
  }
  await logEvent("quote.sent", actor, { quote_id: quote.id, status: sent.status, blocked_reason: sent.blocked_reason }, req.id);
  return outcome(sent);
}

export function reportForEmail(view: ReturnType<typeof reportView>): ReportForEmail {
  return {
    id: view.id, title: view.title, answer: view.answer, confidence: view.confidence, limitations: view.limitations,
    human_review_recommended: view.human_review_recommended, url: view.url,
    images: view.images.map((i) => ({ role: i.role, url: i.url, caption: i.caption })),
    measurements: view.measurements.map((m) => ({ metric: m.metric, value: m.value, unit: m.unit, note: m.note })),
    sources: view.sources.map((s) => ({ name: s.name, datetime: s.datetime })),
  };
}

export async function deliverReport(requestId: string, actor: string) {
  const req = await requireRequest(requestId);
  if (req.is_free_sample) throw new Error("Free samples are sent by comms-outreach, not delivered here.");
  if (req.status === "delivered") return { status: "delivered", note: "Already delivered." };
  assertOpen(req);
  const report = await latestReport(req.id);
  if (!report || report.verifier_status !== "pass") throw new Error("No verified report yet; the verifier must pass it first.");
  // Founder-approval gate: no report (and so no price or payment link) goes out on an uncleared quote.
  const quote = req.quote_id ? await getQuote(req.quote_id) : null;
  const blocked = priceBlockedReason(req, quote);
  if (blocked) throw new Error(blocked);
  const view = reportView(report);

  if (!req.customer_email && !req.thread_id) {
    await setStatus(req.id, "delivered", actor, "Available through the API (no email on the request)");
    return { status: "delivered", channel: "api", url: view.url };
  }
  const email = renderReportDelivery({
    customerName: req.customer_name, question: req.question, report: reportForEmail(view),
    paymentLink: quote?.payment_link ?? null, priceUsd: quote ? num(quote.price_usd) : null,
  });
  const sent = await sendToCustomer(req, email, `${req.id}:deliver:${report.id}`, actor);
  await logEvent(sent.status === "sent" ? "report.delivered" : "report.delivery_blocked", actor, { report_id: report.id, ...outcome(sent) }, req.id);
  if (sent.status === "sent") await setStatus(req.id, "delivered", actor, `Report ${report.id} delivered`);
  return { ...outcome(sent), url: view.url };
}

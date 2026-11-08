/** Comms 2 (hello@) customer email: clarifying questions, refusals, updates, quotes and report delivery, in the request's thread. */
import { createHash } from "node:crypto";
import { isOwnAddress } from "../agentmail/config";
import { isValidEmail, normalizeEmail } from "../email/address";
import { suppress } from "../email/optout";
import {
  type RenderedEmail, type ReportForEmail, renderClarifyingQuestion, renderCustomerUpdate, renderQuote, renderRefusal, renderReportDelivery,
  requestStatusUrl,
} from "../email/templates";
import { replyInThread, type SendResult, sendEmail } from "../email/send";
import { getThread } from "../email/threads";
import { Inbox, TERMINAL_STATUSES } from "../domain";
import { logEvent } from "../events";
import { num, query } from "./db";
import { priceBlockedReason } from "./gates";
import { ACCEPTABLE_QUOTE_STATUSES, getQuote, isQuoteExpired, quoteForEmail } from "./quotes";
import { latestReport, reportView } from "./reports";
import { addNote, getRequest, isTerminal, requireRequest, setStatus, type RequestRow } from "./requests";

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

export type CustomerMessageKind = "clarifying_question" | "refusal" | "update";

/**
 * An update email. A monitoring follow-up (record_monitor_check → comms-customer, stage delivery) has no report of
 * its own, so the update IS its delivery and closes it; it quotes the watched request's question and links that
 * request's report. A follow-up that got a report of its own goes out with deliver_report instead.
 */
async function renderUpdate(req: RequestRow, text: string): Promise<{ email: RenderedEmail; closes: boolean }> {
  const monitoring = req.source === "monitor" && !(await latestReport(req.id));
  const parentId = req.meta?.parent_request_id;
  const parent = monitoring && typeof parentId === "string" ? await getRequest(parentId) : null;
  const about = parent ?? req;
  const report = await latestReport(about.id);
  const reportUrl = report?.verifier_status === "pass" ? reportView(report).url : null;
  return {
    email: renderCustomerUpdate({ customerName: req.customer_name, question: about.question, update: text, reportUrl, monitoring }),
    closes: monitoring,
  };
}

/**
 * clarifying_question parks the request (clarifying); refusal goes out on a request record_screening refused; update is
 * a status note on an open request, and on a monitoring follow-up it is the delivery, so sending it closes that
 * request as delivered (set_status can't, by design: delivered comes only from a tool that delivered something).
 */
export async function sendCustomerMessage(a: { requestId: string; kind: CustomerMessageKind; text: string }, actor: string) {
  const req = await requireRequest(a.requestId);
  // A monitor follow-up of a free sample reaches comms-customer only once the prospect has replied (outbound/monitors.ts
  // followupTarget), so that update goes from hello@ like any customer's; everything else about samples is comms-outreach's.
  if (req.is_free_sample && !(req.source === "monitor" && a.kind === "update")) {
    throw new Error("Free samples and their follow-ups are sent by comms-outreach, not from hello@.");
  }
  let email: RenderedEmail;
  let closes = false;
  if (a.kind === "refusal") {
    if (req.status !== "refused") throw new Error("Record the refusal first: record_screening with allowed=false.");
    email = renderRefusal({ customerName: req.customer_name, reason: a.text });
  } else if (a.kind === "update") {
    assertOpen(req);
    ({ email, closes } = await renderUpdate(req, a.text));
  } else {
    assertOpen(req);
    email = renderClarifyingQuestion({ customerName: req.customer_name, question: req.question, clarifyingQuestion: a.text });
  }
  const sent = await sendToCustomer(req, email, `${req.id}:${a.kind}:${hash(a.text)}`, actor);
  if (a.kind === "clarifying_question" && sent.status === "sent") await setStatus(req.id, "clarifying", actor, "Asked the customer a clarifying question");
  if (closes && sent.status === "sent") await setStatus(req.id, "delivered", actor, "Monitoring update sent to the customer");
  await logEvent("customer_message.sent", actor, { kind: a.kind, status: sent.status, blocked_reason: sent.blocked_reason }, req.id);
  if (!closes) return outcome(sent);
  return {
    ...outcome(sent),
    request_status: sent.status === "sent" ? "delivered" : req.status,
    next: sent.status === "sent"
      ? "The monitoring update was this follow-up's delivery; the request is closed. End your turn."
      : "Not sent (see blocked_reason); the request stays open. Add a note and end your turn; don't retry another way.",
  };
}

/**
 * The quote email: every option (what it answers, detail, delivery, price or range), the recommended one, how to
 * accept (reply, or the accept link), the validity, and that paid data is bought only after acceptance.
 */
export async function sendQuote(requestId: string, actor: string) {
  const req = await requireRequest(requestId);
  assertOpen(req);
  const quote = req.quote_id ? await getQuote(req.quote_id) : null;
  if (!quote) throw new Error("No quote yet; pricing must create_quote first.");
  if (quote.status === "needs_approval") {
    throw new Error(
      `Quote ${quote.id} is a pre-v2 quote held for founder review: hand back to pricing (stage pricing) to re-quote it with price_options and create_quote.`,
    );
  }
  if (!(ACCEPTABLE_QUOTE_STATUSES as readonly string[]).includes(quote.status)) throw new Error(`Quote ${quote.id} is ${quote.status}; there is nothing to send.`);
  if (isQuoteExpired(quote)) {
    throw new Error(`Quote ${quote.id} expired before it was sent; hand back to pricing (stage pricing) for a fresh quote.`);
  }
  const forEmail = quoteForEmail(quote);
  const email = renderQuote({
    customerName: req.customer_name, question: req.question, requestId: req.id, paymentLink: quote.payment_link,
    quote: forEmail, acceptUrl: forEmail.accept_url, statusUrl: requestStatusUrl(req.id),
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
  const accepted = quote?.accepted_option_id ? quote.options?.find((o) => o.option_id === quote.accepted_option_id) : undefined;
  const email = renderReportDelivery({
    customerName: req.customer_name, question: req.question, report: reportForEmail(view),
    paymentLink: quote?.payment_link ?? null, priceUsd: quote ? num(quote.price_usd) : null, offerMonitoring: !req.monitor_id,
    acceptedOption: accepted ? { option_id: accepted.option_id, label: accepted.label, accepted_at: quote?.accepted_at } : null,
    statusUrl: requestStatusUrl(req.id),
  });
  const sent = await sendToCustomer(req, email, `${req.id}:deliver:${report.id}`, actor);
  await logEvent(sent.status === "sent" ? "report.delivered" : "report.delivery_blocked", actor, { report_id: report.id, ...outcome(sent) }, req.id);
  if (sent.status === "sent") await setStatus(req.id, "delivered", actor, `Report ${report.id} delivered`);
  return { ...outcome(sent), url: view.url };
}

/** Who may be opted out from a request: its customer and anyone who wrote to us in its thread (latest first). */
async function requestAddresses(req: RequestRow): Promise<string[]> {
  const rows = await query<{ email: string }>(
    `SELECT lower(counterpart_email) AS email FROM messages
     WHERE direction = 'inbound' AND counterpart_email IS NOT NULL AND (request_id = $1 OR ($2::text IS NOT NULL AND thread_id = $2))
     GROUP BY 1 ORDER BY max(created_at) DESC`,
    [req.id, req.thread_id],
  );
  const out = [req.customer_email ? normalizeEmail(req.customer_email) : null, ...rows.map((r) => r.email)].filter((e): e is string => !!e);
  return [...new Set(out)];
}

/**
 * The customer asked for no more email: suppress the address (our list and AgentMail's block list), note it on the
 * request, cancel the request if it is still open, and stop the monitors that would email them. Only the request's
 * customer or someone who wrote in its thread can be opted out here, so an address quoted in an email can't be
 * silenced on someone else's say-so.
 */
export async function recordCustomerOptOut(a: { requestId: string; email?: string; reason: string }, actor: string) {
  const req = await requireRequest(a.requestId);
  const allowed = await requestAddresses(req);
  const email = normalizeEmail(a.email ?? allowed[0] ?? "");
  if (!email) throw new Error(`Request ${req.id} has no customer email or inbound message; pass the address that asked to opt out.`);
  if (!isValidEmail(email)) throw new Error(`"${email}" is not an email address.`);
  if (isOwnAddress(email)) throw new Error(`${email} is one of our own inboxes.`);
  if (!allowed.includes(email)) {
    throw new Error(`${email} is not the customer on ${req.id} and has not written in its thread; only they can be opted out from this request.`);
  }

  await suppress(email, "opt_out", actor);
  await addNote(req.id, actor, `Opted out of all email (${email}): ${a.reason}`);
  const cancelled = !isTerminal(req);
  if (cancelled) await setStatus(req.id, "cancelled", actor, `Customer opted out of email: ${a.reason}`.slice(0, 1000));
  const monitors = await query<{ id: string }>(
    `UPDATE monitors SET status = 'cancelled' WHERE status = 'active'
       AND request_id IN (SELECT id FROM requests WHERE lower(customer_email) = $1) RETURNING id`,
    [email],
  );
  const others = await query<{ id: string }>(
    `SELECT id FROM requests WHERE lower(customer_email) = $1 AND id <> $2 AND NOT (status = ANY($3::text[])) ORDER BY created_at`,
    [email, req.id, [...TERMINAL_STATUSES]],
  );
  await logEvent("customer.opted_out", actor, { email, reason: a.reason, cancelled, monitors_stopped: monitors.map((m) => m.id) }, req.id);
  return {
    email, suppressed: true,
    request_status: cancelled ? "cancelled" : req.status,
    monitors_stopped: monitors.map((m) => m.id),
    other_open_requests: others.map((o) => o.id),
    next: "Done: nothing more can be emailed to this address (sends to it are blocked). Send nothing else; end your turn.",
  };
}

/**
 * Comms 3 (outreach@): first touches and follow-ups for prospects with a verified free sample.
 * Gates enforced here, on top of sendEmail's own (armed inbox, suppression, approved template, postal address):
 * verified sample report, approved template for the playbook, channel rules, one first touch per business,
 * follow-ups only with new information, CAPS.outreachTouchesPerDay across all channels.
 */
import { createHash } from "node:crypto";
import { inboxAddress } from "../agentmail/config";
import { CAPS, PRICING } from "../config";
import { getDb } from "../db/client";
import { isSuppressed, optOutUrl } from "../email/optout";
import { replyInThread, sendEmail, type SendEmailArgs } from "../email/send";
import { AI_DISCLOSURE, renderFollowup, renderOutreach, TemplateError, type RenderedEmail, type ReportForEmail } from "../email/templates";
import { logEvent } from "../events";
import { newId } from "../ids";
import { chooseChannel, type OutreachChannel } from "./channel";
import { fail } from "./errors";
import { lastTouchAt, newInfoSince } from "./followups";
import { CLOSED_STATUSES, disqualifyBusiness, getProspect, isWarm, REPLIED_STATUSES, sameBusiness, type ProspectRow } from "./prospects";
import { headlineFinding, latestReport, leadImage, reportForEmail } from "./sample-report";
import { iso, num, startOfUtcDay, type OutboundPlaybook } from "./util";

const MESSAGE_RULES = [
  "Lead with their own asset: the image and one specific finding from the verified report.",
  "Give one clear next step with the price.",
  "Say who we are (Terragent) and that an AI agent wrote and sent the message.",
  "Include the opt-out link and honour opt-outs immediately.",
  "Be helpful, not fear-based. We are not insurance adjusters or contractors.",
];

const CONTACT_FORM_RULES = [
  "Use the business's own published website contact form in the Naïve browser (solve_captchas false, stealth false).",
  "Never solve a CAPTCHA: skip the form and record_contact_form_touch status=skipped skip_reason=captcha.",
  "Skip sites or forms that say no solicitations (skip_reason=no_solicitation_notice).",
  "Give reply_to as the email to reply to. One touch per business, ever.",
  "Paste rendered.text (you may shorten it to fit the form, keeping the finding, report link, price, AI disclosure and opt-out).",
  "Right after submitting, call record_contact_form_touch with the exact text you sent.",
];

/** The next step each playbook's first touch offers (spec §2 playbooks). */
const PRICE_BY_PLAYBOOK: Record<OutboundPlaybook, string> = {
  disasters: `$${PRICING.monitoringPerSiteMonthlyUsd} per site per month`,
  deforestation: `$${PRICING.minReportUsd} per additional sourcing area`,
  mining: `$${PRICING.monitoringPerSiteMonthlyUsd} per site per month`,
};

interface TemplateRow {
  id: string;
  version: string;
  subject: string;
  body: string;
}

/** Latest founder-approved template: outreach templates are per playbook; follow-ups may be per playbook or 'all'. */
async function approvedTemplate(playbook: string, kind: "outreach" | "followup"): Promise<TemplateRow | null> {
  const db = await getDb();
  const [row] = await db.query<TemplateRow>(
    `SELECT id, version, subject, body FROM templates
     WHERE status = 'approved' AND kind = $2 AND (playbook = $1 OR ($2 = 'followup' AND playbook = 'all'))
     ORDER BY (playbook = $1) DESC, approved_at DESC NULLS LAST, created_at DESC LIMIT 1`,
    [playbook, kind],
  );
  return row ?? null;
}

/** Outreach touches that went out today (UTC), all channels, first touches and follow-ups. */
export async function touchesToday(): Promise<number> {
  const db = await getDb();
  const [row] = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM messages WHERE direction = 'outbound' AND prospect_id IS NOT NULL
       AND kind IN ('outreach', 'followup') AND status = 'sent' AND coalesce(sent_at, created_at) >= $1`,
    [startOfUtcDay()],
  );
  return num(row?.n);
}

async function touchHistory(prospectId: string) {
  const db = await getDb();
  return db.query<{ kind: string; channel: string; status: string; created_at: unknown }>(
    "SELECT kind, channel, status, created_at FROM messages WHERE prospect_id = $1 AND direction = 'outbound' ORDER BY created_at",
    [prospectId],
  );
}

/** AgentMail id of the latest email that reached this prospect (null for contact-form-only prospects). */
async function lastEmailId(prospectId: string): Promise<string | null> {
  const db = await getDb();
  const [row] = await db.query<{ id: string }>(
    `SELECT agentmail_message_id AS id FROM messages WHERE prospect_id = $1 AND direction = 'outbound' AND status = 'sent'
       AND agentmail_message_id IS NOT NULL ORDER BY coalesce(sent_at, created_at) DESC LIMIT 1`,
    [prospectId],
  );
  return row?.id ?? null;
}

interface OutreachContext {
  prospect: ProspectRow;
  report: ReportForEmail;
  channel: OutreachChannel;
  channelReason: string;
  template: TemplateRow;
  vars: Record<string, string>;
  optOut: string;
  replyTo: string;
  touchesLeft: number;
  history: Awaited<ReturnType<typeof touchHistory>>;
  signal: { title: string; event_time: string | null } | null;
}

async function loadContext(prospectId: string, kind: "outreach" | "followup", agentVars: Record<string, string> = {}): Promise<OutreachContext> {
  const p = await getProspect(prospectId);
  if (!p) fail(`prospect ${prospectId} not found`);
  if (CLOSED_STATUSES.includes(p.status)) fail(`prospect is ${p.status}: do not contact`);
  if (REPLIED_STATUSES.includes(p.status)) fail(`prospect has ${p.status}: comms-customer owns the conversation on hello@`);
  if (p.contact_email && (await isSuppressed(p.contact_email))) fail("contact has opted out: do not contact");
  // One touch per business across playbooks: its other prospect rows count too.
  const siblings = await sameBusiness(p);
  const closed = siblings.find((o) => CLOSED_STATUSES.includes(o.status) || REPLIED_STATUSES.includes(o.status));
  if (closed) fail(`this business is ${closed.status} as prospect ${closed.id} (${closed.playbook}): no outreach from ${p.playbook}`);
  const touched = siblings.find((o) => o.first_touch_at);
  if (kind === "outreach" && touched) {
    fail(`this business was already contacted as prospect ${touched.id} (${touched.playbook}) on ${iso(touched.first_touch_at)?.slice(0, 10)}: one touch per business`);
  }
  if (!p.sample_request_id) fail("no free sample yet: the sourcing agent must request_free_sample first");

  const row = await latestReport(p.sample_request_id);
  if (!row || row.verifier_status !== "pass") {
    fail(`sample report not verified (${row ? `verifier_status ${row.verifier_status}` : "no report yet"}): outreach waits for a verifier pass`);
  }
  const template = await approvedTemplate(p.playbook, kind);
  if (!template) fail("no approved template — a founder must approve one in the dashboard");

  const history = await touchHistory(p.id);
  const first = history.find((t) => t.kind === "outreach" && t.status === "sent");
  if (kind === "outreach" && first) {
    fail(`already contacted on ${iso(first.created_at)?.slice(0, 10)} via ${first.channel}; follow-ups only with new information (list_followups)`);
  }
  if (kind === "followup" && !first) fail("no first touch yet: a follow-up needs an earlier touch");

  const sent = await touchesToday();
  if (sent >= CAPS.outreachTouchesPerDay) fail(`daily outreach cap reached (${sent}/${CAPS.outreachTouchesPerDay}); continue tomorrow`);

  const { channel, reason } = chooseChannel({ email: p.contact_email, warm: await isWarm(p) });
  const replyTo = inboxAddress("hello");
  const optOut = p.contact_email ? await optOutUrl(p.contact_email) : `mailto:${replyTo}?subject=unsubscribe`;
  const report = reportForEmail(row);
  const db = await getDb();
  const [sig] = p.signal_id ? await db.query<{ title: string; event_time: unknown }>("SELECT title, event_time FROM signals WHERE id = $1", [p.signal_id]) : [];
  const signal = sig ? { title: sig.title, event_time: iso(sig.event_time) } : null;
  const [req] = await db.query<{ place: string | null }>("SELECT data_spec->'location'->>'text' AS place FROM requests WHERE id = $1", [p.sample_request_id]);

  // Server facts win over agent-supplied vars so the finding always comes from the verified report.
  // Empty values are left out so template fallbacks ({{contact_name|there}}) apply.
  const facts: Record<string, string | null> = {
    company: p.company,
    contact_name: p.contact_name,
    asset: p.asset_description ?? p.company,
    place: req?.place ?? (p.asset_lat !== null && p.asset_lon !== null ? `${p.asset_lat.toFixed(3)}, ${p.asset_lon.toFixed(3)}` : null),
    event: signal?.title ?? null,
    finding: headlineFinding(report),
    report_url: report.url,
    price: PRICE_BY_PLAYBOOK[p.playbook as OutboundPlaybook] ?? `$${PRICING.minReportUsd} per report`,
  };
  const vars = { ...agentVars, ...Object.fromEntries(Object.entries(facts).filter((e): e is [string, string] => !!e[1]?.trim())) };
  return { prospect: p, report, channel, channelReason: reason, template, vars, optOut, replyTo, touchesLeft: CAPS.outreachTouchesPerDay - sent, history, signal };
}

/** Template problems (missing placeholder, no image) come back as errors the agent can act on. */
function render(c: OutreachContext, newInfo?: string): RenderedEmail {
  const template = { subject: c.template.subject, body: c.template.body };
  try {
    return newInfo === undefined
      ? renderOutreach({ template, vars: c.vars, report: c.report, optOutUrl: c.optOut })
      : renderFollowup({ contactName: c.prospect.contact_name, company: c.prospect.company, newInfo, report: c.report, optOutUrl: c.optOut, template, vars: c.vars });
  } catch (e) {
    if (e instanceof TemplateError) fail(`template ${c.template.version} could not be filled: ${e.message}. Pass the missing values in vars.`);
    throw e;
  }
}

function findForm(p: ProspectRow): string {
  if (p.domain) return `Find the contact page on https://${p.domain}`;
  const website = typeof p.meta?.website === "string" ? p.meta.website : null;
  return website ? `Find their contact form or message option on ${website}` : "No website known: record a skip (no_form_found).";
}

const placeholders = (s: string) => [...new Set([...s.matchAll(/\{\{\s*(\w+)\s*(?:\|[^}]*)?\}\}/g)].map((m) => m[1]))];

export async function getOutreachContext(a: { prospectId: string; vars?: Record<string, string> }) {
  const c = await loadContext(a.prospectId, "outreach", a.vars);
  const p = c.prospect;
  const rendered = render(c);
  return {
    prospect: {
      id: p.id, company: p.company, domain: p.domain, contact_name: p.contact_name, contact_role: p.contact_role,
      asset_description: p.asset_description, asset_lat: p.asset_lat, asset_lon: p.asset_lon, playbook: p.playbook,
      status: p.status, score_total: num(p.score_total),
    },
    signal: c.signal,
    report: {
      id: c.report.id, title: c.report.title, url: c.report.url, confidence: c.report.confidence, finding: c.vars.finding,
      image: leadImage(c.report), limitations: c.report.limitations, human_review_recommended: c.report.human_review_recommended,
    },
    channel: c.channel,
    channel_reason: c.channelReason,
    ...(c.channel === "contact_form"
      ? {
          contact_form: {
            url: p.contact_form_url,
            find_it: p.contact_form_url ? null : findForm(p),
            reply_to: c.replyTo,
            rules: CONTACT_FORM_RULES,
          },
        }
      : { send_with: "send_outreach_email: the server renders this template and sends it from outreach@" }),
    template: { id: c.template.id, version: c.template.version, placeholders: placeholders(`${c.template.subject}\n${c.template.body}`) },
    vars: c.vars,
    rendered: { subject: rendered.subject, text: rendered.text },
    opt_out_url: c.optOut,
    ai_disclosure: AI_DISCLOSURE,
    rules: MESSAGE_RULES,
    touches_left_today: c.touchesLeft,
  };
}

export async function sendOutreachEmail(a: { prospectId: string; kind: "outreach" | "followup"; vars?: Record<string, string>; newInfo?: string; actor: string }) {
  const c = await loadContext(a.prospectId, a.kind, a.vars);
  const p = c.prospect;
  if (c.channel === "contact_form" || !p.contact_email) {
    fail(`channel is contact_form (${c.channelReason}): submit their website form with the browser, then record_contact_form_touch`);
  }
  if (a.kind === "followup") {
    if (!a.newInfo) fail("a follow-up must carry new_info: the new image or change being reported");
    const last = await lastTouchAt(p.id);
    if (!last || !(await newInfoSince(p, last)).length) fail("no new information since the last touch: never send plain reminders");
  }
  const rendered = render(c, a.kind === "followup" ? a.newInfo : undefined);

  // One key per logical message: sendEmail re-checks a blocked row on retry (e.g. after the inbox is armed)
  // and returns a sent row as-is. Each follow-up is a new logical message, numbered by those already sent.
  const sentFollowups = c.history.filter((t) => t.kind === "followup" && t.status === "sent").length;
  const args: SendEmailArgs = {
    inbox: "outreach",
    to: p.contact_email,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    kind: a.kind,
    channel: c.channel,
    requestId: p.sample_request_id ?? undefined,
    prospectId: p.id,
    templateId: c.template.id,
    idempotencyKey: a.kind === "outreach" ? `outreach:${p.id}` : `followup:${p.id}:${sentFollowups + 1}`,
    actor: a.actor,
  };
  // Follow-ups reply in the thread of our last email to them, so they read as one conversation.
  const previous = a.kind === "followup" ? await lastEmailId(p.id) : null;
  const res = previous ? await replyInThread({ ...args, inReplyToMessageId: previous }) : await sendEmail(args);

  if (res.status === "sent" && a.kind === "outreach") {
    const db = await getDb();
    await db.query(
      `UPDATE prospects SET status = 'emailed', channel = $2, message_version = $3,
         outreach_thread_id = coalesce($4, outreach_thread_id), updated_at = now() WHERE id = $1`,
      [p.id, c.channel, c.template.version, res.thread_id ?? null],
    );
  }
  await logEvent(res.status === "sent" ? "outreach.sent" : "outreach.blocked", a.actor,
    { prospect_id: p.id, kind: a.kind, channel: c.channel, message_id: res.message_id, reason: res.blocked_reason ?? null }, p.sample_request_id);
  return {
    status: res.status,
    message_id: res.message_id,
    thread_id: res.thread_id ?? null,
    blocked_reason: res.blocked_reason ?? null,
    channel: c.channel,
    touches_left_today: res.status === "sent" ? c.touchesLeft - 1 : c.touchesLeft,
  };
}

export const SKIP_REASONS = ["captcha", "no_solicitation_notice", "no_form_found", "form_error", "other"] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/** Records a contact-form touch that already happened (or was skipped). Facts are always recorded; rule breaks come back as warnings. */
export async function recordContactFormTouch(a: {
  prospectId: string;
  formUrl: string;
  status: "sent" | "skipped";
  messageText?: string;
  skipReason?: SkipReason;
  note?: string;
  actor: string;
}) {
  const p = await getProspect(a.prospectId);
  if (!p) fail(`prospect ${a.prospectId} not found`);
  if (a.status === "sent" && !a.messageText) fail("message_text is required: record exactly what was submitted");
  if (a.status === "skipped" && !a.skipReason) fail("skip_reason is required for a skipped form");

  const template = await approvedTemplate(p.playbook, "outreach");
  const warnings = a.status === "sent" ? await formTouchRuleBreaks(p, template) : [];

  // Identical retries collapse onto one row; sent_at stays null so form touches don't count against the email cap.
  const fingerprint = createHash("sha256").update(`${a.formUrl}\n${a.status}\n${a.messageText ?? a.skipReason}`).digest("hex").slice(0, 16);
  const id = newId("message");
  const db = await getDb();
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO messages (id, direction, inbox, request_id, prospect_id, counterpart_url, body_text, template_id, status,
       blocked_reason, channel, kind, idempotency_key)
     VALUES ($1, 'outbound', 'outreach', $2, $3, $4, $5, $6, $7, $8, 'contact_form', 'outreach', $9)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [id, p.sample_request_id, p.id, a.formUrl, a.messageText ?? a.note ?? null, template?.id ?? null, a.status,
      a.status === "skipped" ? [a.skipReason, a.note].filter(Boolean).join(": ") : null, `contact_form:${p.id}:${fingerprint}`],
  );
  if (!inserted.length) return { message_id: null, duplicate: true, status: a.status, warnings };

  let disqualified: string[] = [];
  if (a.status === "sent") {
    // Closed or replied prospects keep their status: the touch is recorded and flagged, not promoted.
    await db.query(
      `UPDATE prospects SET status = CASE WHEN status IN ('matched', 'sample_requested', 'sample_ready') THEN 'emailed' ELSE status END,
         channel = 'contact_form', contact_form_url = $2, message_version = coalesce($3, message_version), updated_at = now()
       WHERE id = $1 AND NOT (status = ANY($4))`,
      [p.id, a.formUrl, template?.version ?? null, [...CLOSED_STATUSES, ...REPLIED_STATUSES]],
    );
  } else {
    await db.query(
      `UPDATE prospects SET contact_form_url = coalesce(contact_form_url, $2),
         meta = meta || jsonb_build_object('contact_form_skipped', $3::text), updated_at = now() WHERE id = $1`,
      [p.id, a.formUrl, a.skipReason],
    );
    // A "no solicitations" notice is the business saying no: never contact it, under any playbook.
    if (a.skipReason === "no_solicitation_notice") disqualified = await disqualifyBusiness(p, "no_solicitation_notice");
  }
  await logEvent(
    "outreach.contact_form",
    a.actor,
    { prospect_id: p.id, status: a.status, skip_reason: a.skipReason ?? null, url: a.formUrl, rule_break: warnings.length > 0, warnings, disqualified },
    p.sample_request_id,
  );
  return { message_id: id, duplicate: false, status: a.status, warnings, ...(disqualified.length ? { disqualified } : {}) };
}

/** A form touch is recorded after the fact, so the gates that get_outreach_context enforces come back as warnings. */
async function formTouchRuleBreaks(p: ProspectRow, template: TemplateRow | null): Promise<string[]> {
  const out: string[] = [];
  if (CLOSED_STATUSES.includes(p.status)) out.push(`prospect is ${p.status}: it must not be contacted`);
  if (REPLIED_STATUSES.includes(p.status)) out.push(`prospect has ${p.status}: comms-customer owns the conversation`);
  if (p.contact_email && (await isSuppressed(p.contact_email))) out.push("contact has opted out: it must not be contacted");
  const report = p.sample_request_id ? await latestReport(p.sample_request_id) : null;
  if (report?.verifier_status !== "pass") out.push("no verified sample report: first touches wait for a verifier pass");
  if ((await touchHistory(p.id)).some((t) => t.kind === "outreach" && t.status === "sent")) out.push("this business had already been contacted: one touch per business");
  for (const o of await sameBusiness(p)) {
    if (o.first_touch_at) out.push(`this business was already contacted as prospect ${o.id} (${o.playbook}): one touch per business`);
    else if (CLOSED_STATUSES.includes(o.status) || REPLIED_STATUSES.includes(o.status)) out.push(`this business is ${o.status} as prospect ${o.id} (${o.playbook})`);
  }
  if (!template) out.push("no approved template for this playbook: touches must use an approved template");
  if ((await touchesToday()) >= CAPS.outreachTouchesPerDay) out.push("daily outreach cap exceeded");
  return out;
}

/**
 * Prospects: businesses affected by a signal (work contacts only), scored fit × urgency × ability × reach,
 * and turned into free sample requests through the pipeline before any outreach (spec §3.3).
 */
import { getDb } from "../db/client";
import { prospectScore, ProspectInput, type Playbook } from "../domain";
import { isSuppressed } from "../email/optout";
import { logEvent } from "../events";
import { newId } from "../ids";
import { createRequest, handoff } from "../pipeline/requests";
import { capReachedMessage, sampleCap, withOneStarted } from "./allocation";
import { chooseChannel, emailDomain, isPersonalMailbox, isSharedHost, normalizeDomain } from "./channel";
import { fail } from "./errors";
import { iso, num, truncate, type OutboundPlaybook } from "./util";

export interface ProspectRow {
  id: string;
  signal_id: string | null;
  playbook: string;
  company: string;
  domain: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_role: string | null;
  asset_description: string | null;
  asset_lat: number | null;
  asset_lon: number | null;
  score_total: string | number | null;
  status: string;
  sample_request_id: string | null;
  outreach_thread_id: string | null;
  message_version: string | null;
  channel: string | null;
  contact_form_url: string | null;
  warm: boolean;
  meta: Record<string, unknown>;
  created_at: unknown;
  updated_at: unknown;
}

/** Statuses after which we never start new outreach. */
export const CLOSED_STATUSES = ["opted_out", "disqualified"];
/** They answered: comms-customer owns the conversation from here. */
export const REPLIED_STATUSES = ["replied", "quoted", "paid"];

/**
 * One business, whatever the playbook: same own domain (never a shared host like facebook.com) or same company name.
 * Params: $2 = domain or null, $3 = company.
 */
const SAME_BUSINESS = "(($2::text IS NOT NULL AND lower(domain) = $2) OR lower(company) = lower($3))";

const businessDomain = (domain: string | null) => (domain && !isSharedHost(domain) ? domain.toLowerCase() : null);

export interface SiblingProspect {
  id: string;
  playbook: string;
  status: string;
  first_touch_at: unknown;
}

/** The business's other prospect rows (any playbook), with their first sent outreach touch, if any. */
export async function sameBusiness(p: Pick<ProspectRow, "id" | "domain" | "company">): Promise<SiblingProspect[]> {
  const db = await getDb();
  return db.query<SiblingProspect>(
    `SELECT id, playbook, status,
       (SELECT min(coalesce(m.sent_at, m.created_at)) FROM messages m
        WHERE m.prospect_id = prospects.id AND m.direction = 'outbound' AND m.kind = 'outreach' AND m.status = 'sent') AS first_touch_at
     FROM prospects WHERE id <> $1 AND ${SAME_BUSINESS} ORDER BY created_at`,
    [p.id, businessDomain(p.domain), p.company],
  );
}

/** The business said no (e.g. a "no solicitations" notice): disqualify every prospect row it has. Returns their ids. */
export async function disqualifyBusiness(p: Pick<ProspectRow, "id" | "domain" | "company">, reason: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db.query<{ id: string }>(
    `UPDATE prospects SET status = 'disqualified', meta = meta || jsonb_build_object('disqualified_reason', $4::text), updated_at = now()
     WHERE (id = $1 OR ${SAME_BUSINESS}) AND status NOT IN ('opted_out', 'disqualified') RETURNING id`,
    [p.id, businessDomain(p.domain), p.company, reason],
  );
  return rows.map((r) => r.id);
}

export async function getProspect(id: string): Promise<ProspectRow | null> {
  const db = await getDb();
  const [row] = await db.query<ProspectRow>("SELECT * FROM prospects WHERE id = $1", [id]);
  return row ?? null;
}

/** Warm = a founder marked them, or they have emailed us from that address. */
export async function isWarm(p: Pick<ProspectRow, "warm" | "contact_email">): Promise<boolean> {
  if (p.warm) return true;
  if (!p.contact_email) return false;
  const db = await getDb();
  const rows = await db.query(
    "SELECT 1 FROM messages WHERE direction = 'inbound' AND lower(counterpart_email) = lower($1) LIMIT 1",
    [p.contact_email],
  );
  return rows.length > 0;
}

export async function createProspect(a: { input: unknown; contactFormUrl?: string | null; actor: string }) {
  const parsed = ProspectInput.safeParse(a.input);
  if (!parsed.success) fail(`invalid prospect: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const p = parsed.data;
  if (p.playbook === "inbound") fail("prospects belong to an outbound playbook (disasters, deforestation, mining)");

  const db = await getDb();
  const [signal] = await db.query<{ id: string; status: string }>("SELECT id, status FROM signals WHERE id = $1", [p.signal_id]);
  if (!signal) fail(`signal ${p.signal_id} not found`);

  const warnings: string[] = [];
  let email = p.contact_email?.toLowerCase() ?? null;
  const meta: Record<string, unknown> = { rationale: p.rationale, scores: { fit: p.score_fit, urgency: p.score_urgency, ability: p.score_ability, reach: p.score_reach } };
  if (email && isPersonalMailbox(email)) {
    warnings.push(`dropped personal mailbox ${emailDomain(email)}: work contacts only; reach them through the business's contact form`);
    meta.personal_mailbox_dropped = true;
    email = null;
  }
  const host = normalizeDomain(p.domain) ?? (email ? emailDomain(email) : null);
  // A page on a shared platform (facebook.com/acme) identifies the platform, not the business: keep the URL, dedupe by name.
  const domain = businessDomain(host);
  if (host && !domain) meta.website = p.domain ?? host;

  const [dupe] = await db.query<{ id: string; status: string }>(
    `SELECT id, status FROM prospects WHERE playbook = $1 AND ${SAME_BUSINESS} LIMIT 1`,
    [p.playbook, domain, p.company],
  );
  if (dupe) return { id: dupe.id, duplicate: true, status: dupe.status, warnings: ["already a prospect for this playbook: one touch per business"] };

  const suppressed = email ? await isSuppressed(email) : false;
  const status = suppressed ? "opted_out" : "matched";
  if (suppressed) warnings.push("contact has opted out: stored as opted_out and will not be contacted");

  const id = newId("prospect");
  const score = prospectScore(p);
  const planned = chooseChannel({ email, warm: false }).channel;
  await db.query(
    `INSERT INTO prospects (id, signal_id, playbook, company, domain, contact_name, contact_email, contact_role, asset_description,
       asset_lat, asset_lon, score_fit, score_urgency, score_ability, score_reach, score_total, status, channel, contact_form_url, warm, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,false,$20)`,
    [id, p.signal_id, p.playbook, p.company, domain, p.contact_name, email, p.contact_role, p.asset_description, p.asset_lat, p.asset_lon,
      p.score_fit, p.score_urgency, p.score_ability, p.score_reach, score, status, planned, a.contactFormUrl ?? null, JSON.stringify(meta)],
  );
  if (signal.status === "new") {
    await db.query("UPDATE signals SET status = 'matched', status_reason = $2, updated_at = now() WHERE id = $1", [signal.id, `prospect ${id} created`]);
  }
  await logEvent("prospect.created", a.actor, { prospect_id: id, playbook: p.playbook, company: p.company, score_total: score, signal_id: p.signal_id });
  return { id, duplicate: false, status, score_total: Math.round(score * 10_000) / 10_000, planned_channel: planned, warnings };
}

export async function listProspects(f: { playbook?: string; status?: string; minScore?: number; limit?: number }) {
  const db = await getDb();
  const rows = await db.query<ProspectRow>(
    `SELECT * FROM prospects
     WHERE ($1::text IS NULL OR playbook = $1) AND ($2::text IS NULL OR status = $2) AND coalesce(score_total, 0) >= $3
     ORDER BY score_total DESC NULLS LAST, created_at DESC LIMIT $4`,
    [f.playbook ?? null, f.status ?? null, f.minScore ?? 0, f.limit ?? 30],
  );
  return rows.map((r) => ({
    id: r.id,
    playbook: r.playbook,
    company: r.company,
    domain: r.domain,
    contact_name: r.contact_name,
    contact_role: r.contact_role,
    has_email: !!r.contact_email,
    asset_description: r.asset_description,
    asset_lat: r.asset_lat,
    asset_lon: r.asset_lon,
    score_total: num(r.score_total),
    status: r.status,
    channel: r.channel,
    sample_request_id: r.sample_request_id,
    signal_id: r.signal_id,
    created_at: iso(r.created_at),
  }));
}

const QUESTION_BY_PLAYBOOK: Record<OutboundPlaybook, (asset: string, event: string) => string> = {
  disasters: (asset, event) => `does recent satellite imagery show flooding, burn scars or other visible change at ${asset} after ${event}? Compare before and after the event.`,
  deforestation: (asset, event) => `has tree cover changed at ${asset} (forest loss in this supply area) around ${event}? Compare recent imagery with a year earlier.`,
  mining: (asset, event) => `what do recent satellite images show at ${asset} around ${event}: visible expansion, new ground disturbance or surface mineral indicators (indicators only, never deposits)?`,
};

export function sampleQuestion(p: Pick<ProspectRow, "company" | "asset_description" | "asset_lat" | "asset_lon">, playbook: OutboundPlaybook, signal: { title: string; event_time: string | null } | null) {
  const asset = truncate(p.asset_description || p.company, 300);
  const event = signal ? `"${truncate(signal.title, 200)}"${signal.event_time ? ` (${signal.event_time.slice(0, 10)})` : ""}` : "the latest event";
  return truncate(`Free sample for ${p.company}: ${QUESTION_BY_PLAYBOOK[playbook](asset, event)} Location: ${p.asset_lat}, ${p.asset_lon}.`, 2000);
}

async function sampleSignal(signalId: string | null): Promise<{ title: string; event_time: string | null } | null> {
  if (!signalId) return null;
  const db = await getDb();
  const [row] = await db.query<{ title: string; event_time: unknown }>("SELECT title, event_time FROM signals WHERE id = $1", [signalId]);
  return row ? { title: row.title, event_time: iso(row.event_time) } : null;
}

/** Hands the sample to the planner. A failure is a warning: the request exists and a retry hands it off again. */
async function handoffSample(requestId: string, p: ProspectRow, sig: Awaited<ReturnType<typeof sampleSignal>>, actor: string): Promise<string[]> {
  try {
    await handoff({
      requestId,
      from: actor,
      to: "planner",
      stage: "planning",
      instructions: `Free sample (signal engine) for prospect ${p.id}, ${p.company}. Skip screening and quotes. Build the DataSpec for the asset at ${p.asset_lat}, ${p.asset_lon} (${truncate(p.asset_description ?? "", 200)})${sig ? ` after signal "${truncate(sig.title, 120)}"` : ""}. After verification the report goes to comms-outreach.`,
    });
    return [];
  } catch (e) {
    return [`request created but handoff to planner failed: ${e instanceof Error ? e.message : String(e)}. Call request_free_sample again to retry the handoff.`];
  }
}

/** Second call for a prospect: returns the existing sample, re-trying the planner handoff if it never happened. */
async function existingSample(p: ProspectRow, requestId: string, actor: string) {
  const db = await getDb();
  const [req] = await db.query<{ stage: string | null; owner_agent: string | null }>("SELECT stage, owner_agent FROM requests WHERE id = $1", [requestId]);
  if (!req || req.stage !== null || req.owner_agent !== null) return { request_id: requestId, already_requested: true };
  const warnings = await handoffSample(requestId, p, await sampleSignal(p.signal_id), actor);
  return { request_id: requestId, already_requested: true, handoff_retried: true, warnings };
}

/** Starts the free sample on the background lane (planner first), within the playbook's per-run and per-day caps. */
export async function requestFreeSample(a: { prospectId: string; actor: string }) {
  const p = await getProspect(a.prospectId);
  if (!p) fail(`prospect ${a.prospectId} not found`);
  if (p.sample_request_id) return existingSample(p, p.sample_request_id, a.actor);
  if (p.status !== "matched") fail(`prospect is ${p.status}; only matched prospects get a free sample`);
  if (p.asset_lat === null || p.asset_lon === null) fail("prospect has no asset location");
  const playbook = p.playbook as OutboundPlaybook;

  const cap = await sampleCap(playbook);
  if (cap.remaining <= 0) fail(capReachedMessage(cap));

  const sig = await sampleSignal(p.signal_id);
  // Claim the prospect first so parallel calls for it start one sample, not two.
  const db = await getDb();
  const claimed = await db.query(
    "UPDATE prospects SET status = 'sample_requested', updated_at = now() WHERE id = $1 AND status = 'matched' AND sample_request_id IS NULL RETURNING id",
    [p.id],
  );
  if (!claimed.length) return { request_id: (await getProspect(p.id))?.sample_request_id ?? null, already_requested: true };

  const locationText = truncate(p.asset_description || p.company, 500);
  let req: { id: string };
  try {
    req = await createRequest({
      question: sampleQuestion(p, playbook, sig),
      location_text: locationText.length >= 2 ? locationText : undefined,
      lat: p.asset_lat,
      lon: p.asset_lon,
      company: truncate(p.company, 200),
      source: "signal",
      playbook: playbook as Playbook,
      priority: "background",
      isFreeSample: true,
      prospectId: p.id,
      meta: { signal_id: p.signal_id, prospect_id: p.id, score_total: num(p.score_total) },
      actor: a.actor,
    });
  } catch (e) {
    await db.query("UPDATE prospects SET status = 'matched', updated_at = now() WHERE id = $1 AND status = 'sample_requested' AND sample_request_id IS NULL", [p.id]);
    throw e;
  }
  await db.query("UPDATE prospects SET sample_request_id = $2, updated_at = now() WHERE id = $1", [p.id, req.id]);
  await logEvent("prospect.sample_requested", a.actor, { prospect_id: p.id, playbook }, req.id);

  const warnings = await handoffSample(req.id, p, sig, a.actor);
  return { request_id: req.id, already_requested: false, cap: withOneStarted(cap), warnings };
}

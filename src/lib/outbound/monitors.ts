/**
 * Monitoring (Analytics agent on cron): list monitors that are due, record each re-check, and when the change
 * crosses the threshold or a new clear scene arrived, start a follow-up carrying the new information
 * (customer → comms-customer in their thread; prospect → comms-outreach, or comms-customer once they replied).
 */
import { H3_DEFAULT_RES } from "../config";
import { getDb } from "../db/client";
import { playbookLayer, type AgentName, type Playbook } from "../domain";
import { logDecision, logEvent } from "../events";
import { bboxAround, polygonBbox, pointCell } from "../geo/h3";
import { createRequest, handoff } from "../pipeline/requests";
import { isDue } from "./cadence";
import { fail } from "./errors";
import { CLOSED_STATUSES, getProspect, REPLIED_STATUSES } from "./prospects";
import { iso, truncate } from "./util";

interface MonitorRow {
  id: string;
  request_id: string;
  lat: number;
  lon: number;
  aoi: { type: "Polygon"; coordinates: [number, number][][] } | null;
  recipe: string;
  metric: string;
  threshold: number | null;
  cadence: string;
  last_checked_at: Date | string | null;
  last_value: number | null;
  last_scene_date: string | null;
  status: string;
  created_at: Date | string;
}

interface ParentRequest {
  id: string;
  playbook: string;
  question: string;
  location_text: string | null;
  customer_email: string | null;
  customer_name: string | null;
  company: string | null;
  thread_id: string | null;
  inbox: string | null;
  is_free_sample: boolean;
  prospect_id: string | null;
}

const MONITOR_COLUMNS = ["id", "request_id", "lat", "lon", "aoi", "recipe", "metric", "threshold", "cadence", "last_checked_at",
  "last_value", "last_scene_date::text AS last_scene_date", "status", "created_at"];
const monitorColumns = (alias = "") => MONITOR_COLUMNS.map((c) => alias + c).join(", ");

export async function listDueMonitors(f: { limit?: number; now?: Date } = {}) {
  const db = await getDb();
  const now = f.now ?? new Date();
  const rows = await db.query<MonitorRow & { prospect_id: string | null; playbook: string | null }>(
    `SELECT ${monitorColumns("m.")}, r.prospect_id, r.playbook
     FROM monitors m LEFT JOIN requests r ON r.id = m.request_id
     WHERE m.status = 'active' ORDER BY m.last_checked_at ASC NULLS FIRST`,
  );
  const due = [];
  for (const m of rows) {
    const check = isDue(m.cadence, new Date(m.last_checked_at ?? m.created_at), now);
    if (!check.due) continue;
    due.push({
      id: m.id,
      request_id: m.request_id,
      kind: m.prospect_id ? "prospect" : "customer",
      playbook: m.playbook,
      lat: m.lat,
      lon: m.lon,
      bbox: m.aoi ? polygonBbox(m.aoi) : bboxAround(m.lat, m.lon),
      recipe: m.recipe,
      metric: m.metric,
      threshold: m.threshold,
      cadence: m.cadence,
      ...(check.valid ? {} : { cadence_warning: "cadence is not a valid cron expression; treated as daily" }),
      last_value: m.last_value,
      last_scene_date: m.last_scene_date,
      last_checked_at: iso(m.last_checked_at),
    });
    if (due.length >= (f.limit ?? 20)) break;
  }
  return {
    due,
    how: "For each: search_free_scenes after last_scene_date; if a new clear scene exists run the recipe and record_monitor_check with the value; otherwise record_monitor_check with value null so last_checked_at moves on.",
  };
}

/** Who should hear about new information, or why nobody should. */
async function followupTarget(parent: ParentRequest | null): Promise<{ to: AgentName | null; why: string }> {
  if (!parent) return { to: null, why: "monitor's request no longer exists" };
  if (!parent.prospect_id) return { to: "comms-customer", why: "customer monitor: update the customer in their thread" };
  const p = await getProspect(parent.prospect_id);
  if (!p || CLOSED_STATUSES.includes(p.status)) return { to: null, why: `prospect is ${p?.status ?? "missing"}: never contact` };
  if (REPLIED_STATUSES.includes(p.status)) return { to: "comms-customer", why: "prospect has replied: comms-customer owns the conversation" };
  if (p.status === "emailed" && (p.channel === "email_warm" || p.channel === "email_direct")) {
    return { to: "comms-outreach", why: "emailed prospect: follow up with the new information" };
  }
  return { to: null, why: "prospect not reachable by email (contact forms get one touch only, or no first touch yet)" };
}

export async function recordMonitorCheck(a: {
  monitorId: string;
  value: number | null;
  sceneDate: string | null;
  sceneId?: string;
  clearScene?: boolean;
  note?: string;
  imageUrls?: string[];
  actor: string;
}) {
  const db = await getDb();
  const [m] = await db.query<MonitorRow>(`SELECT ${monitorColumns()} FROM monitors WHERE id = $1`, [a.monitorId]);
  if (!m) fail(`monitor ${a.monitorId} not found`);
  if (m.status !== "active") fail(`monitor is ${m.status}`);

  // A cloudy scene is not "seen": it moves neither last_scene_date nor last_value.
  const cloudy = a.clearScene === false;
  const sceneDate = cloudy || !a.sceneDate ? null : a.sceneDate.slice(0, 10);
  const value = cloudy ? null : a.value;
  const newScene = sceneDate !== null && (!m.last_scene_date || sceneDate > m.last_scene_date);
  const change = value !== null && m.last_value !== null ? value - m.last_value : null;
  const crossed = change !== null && m.threshold !== null && Math.abs(change) >= m.threshold;

  await db.query(
    `UPDATE monitors SET last_value = coalesce($2, last_value), last_scene_date = GREATEST(last_scene_date, $3::date),
       last_checked_at = now() WHERE id = $1`,
    [m.id, value, sceneDate],
  );

  const [parent] = await db.query<ParentRequest>(
    `SELECT id, playbook, question, location_text, customer_email, customer_name, company, thread_id, inbox, is_free_sample, prospect_id
     FROM requests WHERE id = $1`,
    [m.request_id],
  );
  if (value !== null && sceneDate) {
    await db.query(
      `INSERT INTO earth_index (h3_cell, h3_res, layer, metric, value, observed_at, source, change_flag, request_id, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [pointCell(m.lat, m.lon, H3_DEFAULT_RES), H3_DEFAULT_RES, playbookLayer[(parent?.playbook ?? "inbound") as Playbook] ?? "inbound",
        m.metric, value, sceneDate, a.sceneId ?? `monitor:${m.id}`, crossed, m.request_id, JSON.stringify({ monitor_id: m.id })],
    );
  }

  const facts = [
    newScene ? `new clear scene ${sceneDate}` : null,
    change !== null ? `${m.metric} ${m.last_value} → ${value} (change ${change.toFixed(4)}, threshold ${m.threshold ?? "none"})` : null,
    a.note ?? null,
  ].filter(Boolean).join("; ");
  const result = { monitor_id: m.id, new_scene: newScene, change, crossed_threshold: crossed, followup_request_id: null as string | null, followup_to: null as AgentName | null };

  if (!newScene && !crossed) {
    await logDecision({ requestId: m.request_id, kind: "monitoring", choice: "no follow-up", reasoning: facts || "no new clear scene and no value change", agent: a.actor });
    return { ...result, reason: "nothing new: no clear new scene and no change over the threshold" };
  }

  const target = await followupTarget(parent ?? null);
  if (!target.to || !parent) {
    await logDecision({ requestId: m.request_id, kind: "monitoring", choice: "new information, no follow-up", reasoning: `${facts}. ${target.why}`, agent: a.actor });
    return { ...result, reason: target.why };
  }

  const newInfo = truncate(`${facts}${a.imageUrls?.length ? `. Images: ${a.imageUrls.join(" ")}` : ""}`, 1500);
  const followup = await createRequest({
    question: truncate(`Monitoring update (${m.metric}) for: ${parent.question}`, 2000),
    location_text: parent.location_text ?? undefined,
    lat: m.lat,
    lon: m.lon,
    email: parent.customer_email ?? undefined,
    name: parent.customer_name ?? undefined,
    company: parent.company ?? undefined,
    source: "monitor",
    playbook: parent.playbook,
    priority: "background",
    threadId: parent.thread_id ?? undefined,
    inbox: parent.inbox ?? undefined,
    isFreeSample: parent.is_free_sample,
    prospectId: parent.prospect_id ?? undefined,
    meta: { monitor_id: m.id, parent_request_id: parent.id, new_info: newInfo },
    actor: a.actor,
  });
  await db.query("UPDATE requests SET monitor_id = $2 WHERE id = $1", [followup.id, m.id]);
  await logEvent("monitor.followup", a.actor, { monitor_id: m.id, prospect_id: parent.prospect_id, new_info: newInfo, scene_date: sceneDate, to: target.to }, followup.id);
  await logDecision({ requestId: followup.id, kind: "monitoring", choice: `follow up via ${target.to}`, reasoning: `${facts}. ${target.why}`, agent: a.actor });

  const instructions =
    target.to === "comms-outreach"
      ? `Monitor ${m.id} found new information at prospect ${parent.prospect_id}'s asset: ${newInfo}. Send ONE follow-up with send_outreach_email kind=followup and this new_info. No reminders.`
      : `Monitor ${m.id} found new information for request ${parent.id}: ${newInfo}. Reply in the customer's existing thread${parent.thread_id ? ` (${parent.thread_id})` : ""} with this update only.`;
  try {
    await handoff({ requestId: followup.id, from: a.actor, to: target.to, stage: target.to === "comms-outreach" ? "outreach" : "delivery", instructions });
  } catch (e) {
    return { ...result, followup_request_id: followup.id, followup_to: target.to, warning: `handoff failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { ...result, followup_request_id: followup.id, followup_to: target.to };
}

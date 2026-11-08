/**
 * Follow-ups only bring NEW information (spec §8): a newer clear scene or a detected change at the prospect's
 * asset since our last touch. Never plain reminders, and never a second contact-form touch.
 */
import { getDb } from "../db/client";
import { lookupCells } from "../pipeline/earth-index";
import type { ProspectRow } from "./prospects";
import { latestReport } from "./sample-report";
import { iso } from "./util";

export interface NewInfo {
  kind: "change_detected" | "new_clear_scene" | "monitor_followup";
  detail: string;
  observed_at: string | null;
  at: string | null;
}

/** Time of the last outbound touch (first touch or follow-up) that actually went out. */
export async function lastTouchAt(prospectId: string): Promise<Date | null> {
  const db = await getDb();
  const [row] = await db.query<{ at: Date | string | null }>(
    `SELECT max(coalesce(sent_at, created_at)) AS at FROM messages
     WHERE prospect_id = $1 AND direction = 'outbound' AND status = 'sent' AND kind IN ('outreach', 'followup')`,
    [prospectId],
  );
  return row?.at ? new Date(row.at) : null;
}

/** The asset's cells and their neighbours at res 7–9 (the planner's Earth-index lookup), plus the sample's AOI cells. */
async function assetCells(p: Pick<ProspectRow, "asset_lat" | "asset_lon" | "sample_request_id">): Promise<string[]> {
  const cells = new Set<string>();
  if (p.asset_lat !== null && p.asset_lon !== null) for (const c of lookupCells({ lat: p.asset_lat, lon: p.asset_lon })) cells.add(c);
  if (p.sample_request_id) {
    const db = await getDb();
    const [req] = await db.query<{ h3_cells: string[] }>("SELECT h3_cells FROM requests WHERE id = $1", [p.sample_request_id]);
    for (const c of req?.h3_cells ?? []) cells.add(c);
  }
  return [...cells];
}

/** Newest scene date (YYYY-MM-DD) the free sample showed them, from its sources and images. */
async function sampleSceneDate(requestId: string | null): Promise<string | null> {
  const r = requestId ? await latestReport(requestId) : null;
  const dates = [...(r?.sources ?? []).map((x) => x.datetime), ...(r?.images ?? []).map((x) => x.date)]
    .map((d) => d?.slice(0, 10))
    .filter((d): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d));
  return dates.sort().at(-1) ?? null;
}

/**
 * New information about the prospect's asset recorded after `since`: Earth-index rows from a scene newer than anything
 * they have seen (the newest scene indexed before the touch, or the sample's own scene; the touch date if neither),
 * flagged changes first. The sample's own rows never count.
 */
export async function newInfoSince(p: Pick<ProspectRow, "id" | "asset_lat" | "asset_lon" | "sample_request_id">, since: Date): Promise<NewInfo[]> {
  const db = await getDb();
  const out: NewInfo[] = [];
  const cells = await assetCells(p);
  if (cells.length) {
    const rows = await db.query<{ metric: string; value: number; unit: string | null; observed_at: string; source: string; change_flag: boolean; created_at: unknown }>(
      `SELECT metric, value, unit, observed_at::text AS observed_at, source, change_flag, created_at FROM earth_index
       WHERE h3_cell = ANY($1) AND created_at > $2 AND request_id IS DISTINCT FROM $3
         AND observed_at > coalesce(
               GREATEST((SELECT max(observed_at) FROM earth_index WHERE h3_cell = ANY($1) AND created_at <= $2), $4::date), $5::date)
       ORDER BY change_flag DESC, observed_at DESC LIMIT 5`,
      [cells, since, p.sample_request_id, await sampleSceneDate(p.sample_request_id), since.toISOString().slice(0, 10)],
    );
    for (const r of rows) {
      out.push({
        kind: r.change_flag ? "change_detected" : "new_clear_scene",
        detail: `${r.metric} = ${r.value}${r.unit ? ` ${r.unit}` : ""} on ${r.observed_at} (${r.source})`,
        observed_at: r.observed_at,
        at: iso(r.created_at),
      });
    }
  }
  const events = await db.query<{ payload: { new_info?: string; scene_date?: string | null }; created_at: unknown }>(
    `SELECT payload, created_at FROM events
     WHERE type = 'monitor.followup' AND payload->>'prospect_id' = $1 AND created_at > $2 ORDER BY created_at DESC LIMIT 5`,
    [p.id, since],
  );
  for (const e of events) {
    out.push({ kind: "monitor_followup", detail: e.payload.new_info ?? "monitor detected new information", observed_at: e.payload.scene_date ?? null, at: iso(e.created_at) });
  }
  return out;
}

/** Touched-by-email prospects (no reply yet) whose asset has new information since the last touch. */
export async function listFollowups(f: { playbook?: string; limit?: number }) {
  const db = await getDb();
  const candidates = await db.query<ProspectRow>(
    `SELECT * FROM prospects
     WHERE status = 'emailed' AND ($1::text IS NULL OR playbook = $1)
     ORDER BY score_total DESC NULLS LAST LIMIT 200`,
    [f.playbook ?? null],
  );
  const followups = [];
  let contactFormOnly = 0;
  for (const p of candidates) {
    if (p.channel !== "email_warm" && p.channel !== "email_direct") {
      contactFormOnly++;
      continue;
    }
    const last = await lastTouchAt(p.id);
    if (!last) continue;
    const info = await newInfoSince(p, last);
    if (!info.length) continue;
    followups.push({ prospect_id: p.id, company: p.company, playbook: p.playbook, channel: p.channel, last_touch_at: last.toISOString(), new_info: info });
    if (followups.length >= (f.limit ?? 20)) break;
  }
  return {
    followups,
    skipped_contact_form: contactFormOnly,
    rule: "Send only with new information (send_outreach_email kind=followup, new_info). Contact-form prospects get one touch only.",
  };
}

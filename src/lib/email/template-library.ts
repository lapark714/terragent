/**
 * Draft outreach and follow-up templates (spec §8). Seeded as status 'draft'; a founder approves them in the
 * dashboard before any agent may send them. renderOutreach adds the asset image, sender identity, AI disclosure
 * and opt-out link around these bodies, so a template cannot leave them out.
 *
 * Every first touch: a specific finding about THEIR asset, a next step and a price. After disasters: helpful,
 * not fear-based; we are not adjusters or contractors. Mining: indicators only, never "deposits".
 */
import type { Db } from "../db/client";
import { newId } from "../ids";

export interface TemplateSeed { playbook: string; version: string; kind: "outreach" | "followup"; subject: string; body: string }

const disasters: TemplateSeed = {
  playbook: "disasters",
  version: "v1",
  kind: "outreach",
  subject: "Satellite check of {{asset}} after {{event}}",
  body: `Hi {{contact_name|there}},

After {{event}}, we looked at free satellite imagery of {{asset}} near {{place}} to give you an early, remote read on the site.

What the imagery shows: {{finding}}

The before and after images and the measurements are in a short report, free of charge: {{report_url}}

This is a first look from space, not an inspection or a claims assessment, and we are not adjusters or contractors. If it helps, we can keep watching the site and send you an update when the next clear image comes in ({{price}}). Just reply to this email.`,
};

const deforestation: TemplateSeed = {
  playbook: "deforestation",
  version: "v1",
  kind: "outreach",
  subject: "Forest cover check for {{asset}}",
  body: `Hi {{contact_name|there}},

We ran a free satellite check of forest cover at {{asset}} in {{place}}, comparing recent imagery with earlier years.

What we found: {{finding}}

The images, measurements and dated sources are in a short report: {{report_url}}

It's a remote screening to support your due diligence, not a compliance certificate. If it's useful, we can run the same check across your other sourcing areas ({{price}}). Just reply to this email.`,
};

const mining: TemplateSeed = {
  playbook: "mining",
  version: "v1",
  kind: "outreach",
  subject: "Satellite view of {{asset}}",
  body: `Hi {{contact_name|there}},

We looked at recent free satellite imagery of {{asset}} near {{place}}.

What we found: {{finding}}

The images and measurements are in a short report: {{report_url}}

These are surface indicators from multispectral imagery, not evidence of a deposit and not a substitute for fieldwork. If it's useful, we can watch the site for changes such as expansion or new ground disturbance ({{price}}). Just reply to this email.`,
};

export const DEFAULT_FOLLOWUP: TemplateSeed = {
  playbook: "all",
  version: "followup-v1",
  kind: "followup",
  subject: "New satellite image for {{company}}",
  body: `Hi {{contact_name|there}},

A new clear satellite image came in since our last note, and it shows something new: {{new_info}}

Updated report: {{report_url}}

We only write when there's new information to share. If you'd like us to keep watching the site ({{price}}), just reply to this email.`,
};

export const TEMPLATE_SEEDS: readonly TemplateSeed[] = [disasters, deforestation, mining, DEFAULT_FOLLOWUP];

/**
 * Upsert the seeds as drafts. Never touches a template that is approved or retired: approval is for exact text.
 * Returns which (playbook, version) rows were created or updated.
 */
export async function seedTemplates(db: Db): Promise<{ playbook: string; version: string; action: "created" | "updated" | "kept" }[]> {
  const out: { playbook: string; version: string; action: "created" | "updated" | "kept" }[] = [];
  for (const t of TEMPLATE_SEEDS) {
    const [existing] = await db.query<{ status: string }>("SELECT status FROM templates WHERE playbook = $1 AND version = $2", [t.playbook, t.version]);
    if (existing && existing.status !== "draft") {
      out.push({ playbook: t.playbook, version: t.version, action: "kept" });
      continue;
    }
    await db.query(
      `INSERT INTO templates (id, playbook, version, kind, subject, body, status) VALUES ($1, $2, $3, $4, $5, $6, 'draft')
       ON CONFLICT (playbook, version) DO UPDATE SET kind = EXCLUDED.kind, subject = EXCLUDED.subject, body = EXCLUDED.body
       WHERE templates.status = 'draft'`,
      [newId("template"), t.playbook, t.version, t.kind, t.subject, t.body],
    );
    out.push({ playbook: t.playbook, version: t.version, action: existing ? "updated" : "created" });
  }
  return out;
}

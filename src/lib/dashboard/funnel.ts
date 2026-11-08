/**
 * Signal funnel by playbook (spec §7.2): signals → prospects → reports → first touches → replies → quotes → paid.
 * Every stage counts what actually happened; nothing is estimated.
 */
import { getDb } from "../db/client";
import { PLAYBOOKS, type Playbook } from "../domain";
import { num } from "./rows";
import { FUNNEL_STAGES, type FunnelStage, type FunnelStageKey } from "./types";

const STAGE_SQL: Record<FunnelStageKey, string> = {
  signals: "SELECT playbook, count(*)::int AS n FROM signals GROUP BY playbook",
  prospects: "SELECT playbook, count(*)::int AS n FROM prospects GROUP BY playbook",
  // Reports that passed the Verifier, one per request.
  reports: `SELECT r.playbook, count(DISTINCT rp.request_id)::int AS n
            FROM reports rp JOIN requests r ON r.id = rp.request_id
            WHERE rp.verifier_status = 'pass' GROUP BY r.playbook`,
  // First touches: prospects reached at least once, by email or their own contact form.
  touches: `SELECT p.playbook, count(DISTINCT m.prospect_id)::int AS n
            FROM messages m JOIN prospects p ON p.id = m.prospect_id
            WHERE m.direction = 'outbound' AND m.kind = 'outreach' AND m.status = 'sent' GROUP BY p.playbook`,
  replies: `SELECT p.playbook, count(*)::int AS n FROM prospects p
            WHERE p.status IN ('replied', 'quoted', 'paid')
               OR EXISTS (SELECT 1 FROM messages m WHERE m.prospect_id = p.id AND m.direction = 'inbound')
            GROUP BY p.playbook`,
  quotes: `SELECT r.playbook, count(*)::int AS n FROM quotes q JOIN requests r ON r.id = q.request_id
           WHERE q.status <> 'draft' OR q.auto_approved GROUP BY r.playbook`,
  paid: `SELECT COALESCE(r.playbook, 'inbound') AS playbook, count(*)::int AS n
         FROM revenue v LEFT JOIN quotes q ON q.id = v.quote_id
         LEFT JOIN requests r ON r.id = COALESCE(v.request_id, q.request_id)
         WHERE v.kind = 'paid' GROUP BY 1`,
};

const emptyByPlaybook = () => Object.fromEntries(PLAYBOOKS.map((p) => [p, 0])) as Record<Playbook, number>;

export async function getFunnel(): Promise<FunnelStage[]> {
  const db = await getDb();
  const results = await Promise.all(FUNNEL_STAGES.map((key) => db.query<{ playbook: string; n: number }>(STAGE_SQL[key])));
  return FUNNEL_STAGES.map((key, i) => {
    const byPlaybook = emptyByPlaybook();
    for (const row of results[i]) {
      const p = (PLAYBOOKS as readonly string[]).includes(row.playbook) ? (row.playbook as Playbook) : "inbound";
      byPlaybook[p] += num(row.n);
    }
    return { key, total: Object.values(byPlaybook).reduce((a, b) => a + b, 0), byPlaybook };
  });
}

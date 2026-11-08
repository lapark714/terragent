/**
 * Coordinator's playbook effort allocation. History lives in playbook_allocations (one row per playbook per
 * decision), the current split is also snapshotted in settings, and every change is a logged decision.
 */
import { CAPS, DEFAULT_ALLOCATION } from "../config";
import { getDb } from "../db/client";
import { PlaybookAllocation } from "../domain";
import { envNumber } from "../env";
import { logDecision } from "../events";
import { SETTING, setSetting } from "../settings";
import { fail } from "./errors";
import { iso, num, OUTBOUND_PLAYBOOKS, startOfUtcDay, type OutboundPlaybook } from "./util";

export type Weights = Record<OutboundPlaybook, number>;

export interface Allocation {
  weights: Weights;
  source: "coordinator" | "default";
  reason: string | null;
  decided_by: string | null;
  decided_at: string | null;
}

export async function getAllocation(): Promise<Allocation> {
  const db = await getDb();
  const rows = await db.query<{ playbook: string; weight: string; reason: string; decided_by: string; created_at: unknown }>(
    `SELECT DISTINCT ON (playbook) playbook, weight, reason, decided_by, created_at
     FROM playbook_allocations ORDER BY playbook, created_at DESC, id DESC`,
  );
  const latest = rows.filter((r) => (OUTBOUND_PLAYBOOKS as string[]).includes(r.playbook));
  if (!latest.length) return { weights: { ...DEFAULT_ALLOCATION }, source: "default", reason: null, decided_by: null, decided_at: null };
  const weights = { ...DEFAULT_ALLOCATION };
  for (const r of latest) weights[r.playbook as OutboundPlaybook] = num(r.weight);
  const newest = latest.reduce((a, b) => (String(iso(a.created_at)) >= String(iso(b.created_at)) ? a : b));
  return { weights, source: "coordinator", reason: newest.reason, decided_by: newest.decided_by, decided_at: iso(newest.created_at) };
}

/** Validates a PlaybookAllocation: outbound playbooks only, each at most once, weights sum to 1 (±0.001). Missing = 0. */
export function validateAllocation(input: unknown): { weights: Weights; reason: string; metrics: Record<string, unknown> } {
  const parsed = PlaybookAllocation.safeParse(input);
  if (!parsed.success) fail(`invalid allocation: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const weights = Object.fromEntries(OUTBOUND_PLAYBOOKS.map((p) => [p, 0])) as Weights;
  const seen = new Set<string>();
  for (const { playbook, weight } of parsed.data.allocations) {
    if (playbook === "inbound") fail("inbound is not allocated: it is demand-driven and always served");
    if (seen.has(playbook)) fail(`playbook ${playbook} listed twice`);
    seen.add(playbook);
    weights[playbook] = weight;
  }
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 0.001) fail(`weights must sum to 1 (got ${sum.toFixed(4)})`);
  return { weights, reason: parsed.data.reason, metrics: parsed.data.metrics };
}

/** Records a new allocation. `measured` is the server-side metrics snapshot stored alongside what the agent cited. */
export async function setPlaybookAllocation(a: { input: unknown; measured: Record<string, unknown>; actor: string }) {
  const { weights, reason, metrics } = validateAllocation(a.input);
  const previous = await getAllocation();
  const snapshot = { cited: metrics, measured: a.measured };
  const db = await getDb();
  // One multi-row INSERT so the batch shares created_at. Params: (playbook, weight) pairs, then reason, metrics, actor.
  const n = OUTBOUND_PLAYBOOKS.length * 2;
  const values = OUTBOUND_PLAYBOOKS.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2}, $${n + 1}, $${n + 2}, $${n + 3})`);
  await db.query(
    `INSERT INTO playbook_allocations (playbook, weight, reason, metrics, decided_by) VALUES ${values.join(", ")}`,
    [...OUTBOUND_PLAYBOOKS.flatMap((p) => [p, weights[p]]), reason, JSON.stringify(snapshot), a.actor],
  );
  await setSetting(SETTING.allocation, weights, a.actor);
  const fmt = (w: Weights) => OUTBOUND_PLAYBOOKS.map((p) => `${p} ${w[p].toFixed(2)}`).join(", ");
  const decisionId = await logDecision({
    kind: "playbook_allocation",
    choice: fmt(weights),
    reasoning: `${reason}\nMetrics: ${JSON.stringify(snapshot)}`,
    alternatives: [{ option: `keep ${fmt(previous.weights)}`, why_not: reason }],
    agent: a.actor,
  });
  return { weights, previous: previous.weights, decision_id: decisionId };
}

/** A playbook's sweep fires at most every 2 h (naive/deployments.ts), so samples started in the last hour belong to this run. */
export const SAMPLE_RUN_WINDOW_MINUTES = 60;
/** Daily ceiling across a playbook's runs, before its weight (keeps pipeline spend inside the agents' daily budgets). */
export const FREE_SAMPLES_PER_DAY = envNumber("CAP_FREE_SAMPLES_PER_DAY", 40);

export interface SampleCap {
  playbook: OutboundPlaybook;
  weight: number;
  limit_per_run: number;
  started_this_run: number;
  limit_today: number;
  started_today: number;
  /** What this run may still start: the smaller of the run and day room. */
  remaining: number;
}

/** ceil(n × weight), at least 1 when the weight is above 0 (the epsilon keeps 3.0000000000000004 at 3). */
const share = (n: number, w: number) => (w > 0 ? Math.max(1, Math.ceil(n * w - 1e-9)) : 0);

/**
 * Free samples a playbook may still start: CAPS.freeSamplesPerRun × weight per run (as the sourcing prompt says)
 * and FREE_SAMPLES_PER_DAY × weight per UTC day.
 */
export async function sampleCap(playbook: OutboundPlaybook, weights?: Weights): Promise<SampleCap> {
  const weight = (weights ?? (await getAllocation()).weights)[playbook] ?? 0;
  const db = await getDb();
  const [row] = await db.query<{ run: number; today: number }>(
    `SELECT count(*) FILTER (WHERE created_at >= $2)::int AS run, count(*) FILTER (WHERE created_at >= $3)::int AS today
     FROM requests WHERE is_free_sample AND source = 'signal' AND playbook = $1 AND created_at >= least($2::timestamptz, $3::timestamptz)`,
    [playbook, new Date(Date.now() - SAMPLE_RUN_WINDOW_MINUTES * 60_000), startOfUtcDay()],
  );
  const cap = {
    playbook,
    weight,
    limit_per_run: share(CAPS.freeSamplesPerRun, weight),
    started_this_run: num(row?.run),
    limit_today: share(FREE_SAMPLES_PER_DAY, weight),
    started_today: num(row?.today),
  };
  return { ...cap, remaining: Math.max(0, Math.min(cap.limit_per_run - cap.started_this_run, cap.limit_today - cap.started_today)) };
}

/** Why no further sample may start, for the agent. */
export function capReachedMessage(c: SampleCap): string {
  const why = c.weight === 0
    ? "its weight is 0"
    : c.started_today >= c.limit_today
      ? `${c.started_today}/${c.limit_today} today`
      : `${c.started_this_run}/${c.limit_per_run} this run (last ${SAMPLE_RUN_WINDOW_MINUTES} min)`;
  return `free-sample cap reached for ${c.playbook}: ${why} at weight ${c.weight}. Pick only the best prospects; the coordinator sets the weights.`;
}

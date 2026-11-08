/** OWNER: core builder. Request lifecycle services used by the MCP tools, API routes, webhooks and dashboard. */
import { scrubText } from "../mcp/scrub";
import { AGENT_BUDGETS } from "../config";
import { AgentName, type NewRequestInput, type RequestSource, type RequestStatus, TERMINAL_STATUSES } from "../domain";
import { env } from "../env";
import { logEvent } from "../events";
import { pointCell } from "../geo/h3";
import { newId } from "../ids";
import { upsertCard } from "../naive/board";
import { startAgentSession } from "../naive/sessions";
import { errorMessage, json, query, queryOne } from "./db";
import { assertPriceCleared, markQuoteAccepted } from "./gates";

export interface RequestRow {
  id: string; source: RequestSource; playbook: string; status: RequestStatus; owner_agent: string | null; priority: "inbound" | "background";
  customer_email: string | null; customer_name: string | null; company: string | null; question: string; location_text: string | null;
  lat: number | null; lon: number | null; aoi: unknown; h3_cells: string[]; data_spec: unknown; acquisition_plan: unknown;
  quote_id: string | null; report_id: string | null; thread_id: string | null; inbox: string | null; is_free_sample: boolean;
  prospect_id: string | null; stage: string | null; card_id: string | null; revisions: number; cost_usd: string | number; price_usd: string | number | null;
  created_at: string; updated_at: string; meta: Record<string, unknown>;
  naive_session_ids: string[]; refusal_reason: string | null; monitor_id: string | null;
}

/** Pipeline stages an agent can hand a request to, and the board status each one implies. */
export const STAGES = [
  "screening", "clarifying", "planning", "acquisition", "pricing", "quote", "analysis",
  "report", "revision", "verification", "delivery", "outreach", "monitoring", "customer_reply", "prospect_reply",
] as const;
export type Stage = (typeof STAGES)[number];

const STAGE_STATUS: Partial<Record<string, RequestStatus>> = {
  screening: "screening",
  clarifying: "clarifying",
  planning: "planning",
  acquisition: "acquiring",
  pricing: "pricing",
  analysis: "analyzing",
  report: "analyzing",
  revision: "revising",
  verification: "verifying",
  delivery: "delivering",
  outreach: "delivering",
};

export async function createRequest(
  input: NewRequestInput & {
    source: RequestSource; playbook?: string; priority?: "inbound" | "background"; threadId?: string; inbox?: string;
    isFreeSample?: boolean; prospectId?: string; meta?: Record<string, unknown>; actor?: string;
  },
): Promise<RequestRow> {
  const id = newId("request");
  const hasPoint = input.lat !== undefined && input.lon !== undefined;
  const priority = input.priority ?? "inbound";
  await query(
    `INSERT INTO requests (id, source, playbook, priority, customer_email, customer_name, company, question, location_text,
       lat, lon, h3_cells, thread_id, inbox, is_free_sample, prospect_id, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      id, input.source, input.playbook ?? "inbound", priority, input.email ?? null, input.name ?? null, input.company ?? null,
      input.question, input.location_text ?? null, input.lat ?? null, input.lon ?? null,
      hasPoint ? [pointCell(input.lat!, input.lon!)] : [], input.threadId ?? null, input.inbox ?? null,
      input.isFreeSample ?? false, input.prospectId ?? null, json(input.meta ?? {}),
    ],
  );
  await logEvent("request.created", input.actor ?? "system", { source: input.source, priority, is_free_sample: input.isFreeSample ?? false }, id);
  return (await getRequest(id))!;
}

export async function getRequest(id: string): Promise<RequestRow | null> {
  return queryOne<RequestRow>("SELECT * FROM requests WHERE id = $1", [id]);
}

export async function requireRequest(id: string): Promise<RequestRow> {
  const req = await getRequest(id);
  if (!req) throw new Error(`Unknown request ${id}.`);
  return req;
}

export function isTerminal(req: Pick<RequestRow, "status">): boolean {
  return TERMINAL_STATUSES.has(req.status);
}

export async function setStatus(id: string, status: RequestStatus, actor: string, note?: string): Promise<void> {
  const req = await requireRequest(id);
  if (req.status === status) {
    if (note) await addNote(id, actor, note);
    return;
  }
  if (isTerminal(req)) throw new Error(`Request ${id} is ${req.status}; a finished request can't change status.`);
  await query("UPDATE requests SET status = $2, updated_at = now() WHERE id = $1", [id, status]);
  await logEvent("status.changed", actor, { from: req.status, to: status, note: note ?? null }, id);
  if (TERMINAL_STATUSES.has(status)) await closeCard(req, `${status}: ${note ?? status}`);
}

export async function addNote(id: string, actor: string, note: string): Promise<void> {
  await requireRequest(id);
  await logEvent("note", actor, { note }, id);
}

/** Merge keys into requests.meta (shallow). */
export async function mergeMeta(id: string, patch: Record<string, unknown>): Promise<void> {
  await query("UPDATE requests SET meta = meta || $2::jsonb, updated_at = now() WHERE id = $1", [id, json(patch)]);
}

export function handoffBrief(requestId: string, stage: string, instructions: string): string {
  return `Request ${requestId} — stage ${stage}. ${instructions.trim().replace(/\.+$/, "")}. Start with terragent.get_request.`;
}

/** TERRAGENT_LANES=off records handoffs without starting Naïve sessions or board cards (simulator, local dev). */
const lanesOff = () => env("TERRAGENT_LANES") === "off";

/** The request's current board card, kept in requests.meta.card so it can be closed later. */
interface CardRef { key: string; title: string; body: string; assignee: AgentName | null }

const cardTitle = (req: RequestRow, agent: string, stage: string) =>
  `${req.id} · ${stage} → ${agent} · ${req.question.replace(/\s+/g, " ").slice(0, 120)}`;

/** A retried handoff within this window returns the first one's session and card instead of starting another. */
const REPEAT_WINDOW_MINUTES = 5;

/**
 * Hand a request to the next agent: records events, starts the agent (inbound lane) or assigns a board card
 * (background lane). Refuses finished requests, terminal status overrides, customer requests leaving Comms 2
 * before screening allowed them, and analysis before the price is cleared (gates.ts).
 */
export async function handoff(args: {
  requestId: string; from: string; to: AgentName; stage: string; instructions: string; status?: RequestStatus; quoteAccepted?: boolean;
}): Promise<{ session_id?: string; card_id?: string; deduped?: true }> {
  const req = await requireRequest(args.requestId);
  if (isTerminal(req)) throw new Error(`Request ${req.id} is ${req.status}; it can't be handed off.`);
  // The brief becomes the next agent's opening message and is stored in events (returned by get_request): it must
  // carry no personal data, or Naïve flags that agent's chat and every tool call then waits for a human.
  args = { ...args, instructions: scrubText(args.instructions, await requestPeopleNames(req)) };
  if (args.status && TERMINAL_STATUSES.has(args.status)) {
    throw new Error(`handoff can't finish a request (status ${args.status}); use the tool that does it (record_screening, deliver_report, or the coordinator's set_status).`);
  }
  // Comms 2 is the screener, so only it may hold a customer request that hasn't been screened yet.
  if (needsScreening(req) && args.to !== "comms-customer") {
    throw new Error(`Request ${req.id} has not passed screening; comms-customer must record_screening (allowed) first.`);
  }
  if (args.quoteAccepted) await markQuoteAccepted(req, args.from);
  // Work starts only on a cleared price: the pipeline, or the report when the Earth index already answers it.
  if (args.to === "analytics" || args.stage === "report") await assertPriceCleared(req);

  const repeat = await recentSameHandoff(req.id, args);
  if (repeat) return { ...repeat, deduped: true };

  const brief = handoffBrief(req.id, args.stage, args.instructions);
  const lane = req.priority;
  const result: { session_id?: string; card_id?: string } = {};
  let card: CardRef | null = null;

  if (!lanesOff()) {
    // Same n on a retry after a failure, so neither Naïve session nor board card is created twice.
    const [{ n }] = await query<{ n: number }>("SELECT count(*)::int AS n FROM events WHERE request_id = $1 AND type = 'handoff'", [req.id]);
    try {
      if (lane === "inbound") {
        const budget = AGENT_BUDGETS[args.to];
        const { session_id } = await startAgentSession(args.to, brief, {
          requestId: req.id, budgetUsd: budget.maxTaskUsd, window: budget.window, metadata: { request_id: req.id, stage: args.stage },
          idempotencyKey: `handoff:${req.id}:${n}:${args.to}`,
        });
        result.session_id = session_id;
        await recordSession({ sessionId: session_id, agent: args.to, requestId: req.id, stage: args.stage, lane });
        // One mirror card per request, unassigned: Naïve runs one doing card per assignee, so an assigned mirror
        // would hold back that agent's background cards. The owner is in the title (and requests.owner_agent).
        card = { key: `req:${req.id}`, title: cardTitle(req, args.to, args.stage), body: brief, assignee: null };
        result.card_id = await mirrorCard(req, card);
      } else {
        // One card per handoff: Naïve starts a card at most 3 times, and a free sample has six woken stages.
        await closeCard(req, `Handed off to ${args.to} (${args.stage}).`);
        card = { key: `req:${req.id}:${n}:${args.to}`, title: cardTitle(req, args.to, args.stage), body: brief, assignee: args.to };
        result.card_id = (await upsertCard({ ...card, status: "todo" })).id;
      }
    } catch (e) {
      await logEvent("handoff.failed", args.from, { to: args.to, stage: args.stage, lane, error: errorMessage(e) }, req.id);
      throw new Error(`Handoff to ${args.to} failed: ${errorMessage(e)}`);
    }
  }

  await query(
    "UPDATE requests SET owner_agent = $2, stage = $3, card_id = COALESCE($4, card_id), meta = meta || $5::jsonb, updated_at = now() WHERE id = $1",
    [req.id, args.to, args.stage, result.card_id ?? null, json(card ? { card } : {})],
  );
  const status = args.status ?? STAGE_STATUS[args.stage];
  if (status && status !== req.status) await setStatus(req.id, status, args.from, `handoff to ${args.to}`);
  await logEvent("handoff", args.from, { to: args.to, stage: args.stage, lane, instructions: args.instructions, ...result, dry_run: lanesOff() }, req.id);
  return result;
}

/**
 * The previous handoff, when this call repeats it (a retry whose response was lost). Agents may reword a retry,
 * so for them same from/to/stage is enough; system and human handoffs (one per email or approval) must match exactly.
 */
async function recentSameHandoff(requestId: string, a: { from: string; to: string; stage: string; instructions: string }) {
  const last = await queryOne<{ actor: string; payload: Record<string, unknown>; recent: boolean }>(
    `SELECT actor, payload, created_at > now() - make_interval(mins => $2) AS recent FROM events
     WHERE request_id = $1 AND type = 'handoff' ORDER BY id DESC LIMIT 1`,
    [requestId, REPEAT_WINDOW_MINUTES],
  );
  if (!last?.recent || last.actor !== a.from || last.payload.to !== a.to || last.payload.stage !== a.stage) return null;
  if (!AgentName.safeParse(a.from).success && last.payload.instructions !== a.instructions) return null;
  const pick = (k: string) => (typeof last.payload[k] === "string" ? (last.payload[k] as string) : undefined);
  return { session_id: pick("session_id"), card_id: pick("card_id") };
}

function needsScreening(req: RequestRow): boolean {
  if (req.is_free_sample || req.source === "signal" || req.source === "monitor") return false;
  const screening = req.meta?.screening as { allowed?: boolean } | undefined;
  return screening?.allowed !== true;
}

export async function recordSession(s: { sessionId: string; agent: string; requestId: string | null; stage?: string; lane: string }) {
  await query(
    `INSERT INTO agent_sessions (session_id, agent, request_id, stage, lane) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (session_id) DO NOTHING`,
    [s.sessionId, s.agent, s.requestId, s.stage ?? null, s.lane],
  );
  if (s.requestId) {
    await query(
      "UPDATE requests SET naive_session_ids = array_append(naive_session_ids, $2) WHERE id = $1 AND NOT ($2 = ANY(naive_session_ids))",
      [s.requestId, s.sessionId],
    );
  }
}

/** Inbound lane: a visible "doing" card that wakes nobody. Cosmetic, so a board failure never blocks the request. */
async function mirrorCard(req: RequestRow, card: CardRef): Promise<string | undefined> {
  try {
    return (await upsertCard({ ...card, mirror: true })).id;
  } catch (e) {
    await logEvent("board.sync_failed", "system", { error: errorMessage(e) }, req.id);
    return undefined;
  }
}

/** Move the request's current card to done (on a background handoff, or when the request finishes). */
async function closeCard(req: RequestRow, note: string) {
  const card = req.meta?.card as CardRef | undefined;
  if (!card || lanesOff()) return;
  try {
    await upsertCard({ ...card, status: "done", note: note.slice(0, 2000) });
  } catch (e) {
    await logEvent("board.sync_failed", "system", { error: errorMessage(e) }, req.id);
  }
}

/** Portal, public API and inbound email all call this: create the request and hand it to Comms 2 for screening. */
export async function startInboundRequest(input: NewRequestInput & { source: RequestSource; threadId?: string; inbox?: string }): Promise<RequestRow> {
  const req = await createRequest({ ...input, priority: "inbound", inbox: input.inbox ?? (input.threadId ? "hello" : undefined), actor: input.source });
  try {
    await handoff({
      requestId: req.id, from: "system", to: "comms-customer", stage: "screening",
      instructions:
        `New ${input.source} request. Screen it for misuse and record_screening. If allowed, hand off to planner (stage planning); ` +
        "if key details are missing, send_customer_message kind clarifying_question; if refused, send_customer_message kind refusal",
    });
  } catch {
    // Already logged as handoff.failed; the request stays visible as received for the coordinator.
  }
  return (await getRequest(req.id))!;
}

/** Requests that reference a Naïve session (inbound lane sessions we started). */
export async function requestForSession(sessionId: string): Promise<{ request_id: string | null; agent: string | null }> {
  const s = await queryOne<{ request_id: string | null; agent: string }>("SELECT request_id, agent FROM agent_sessions WHERE session_id = $1", [sessionId]);
  if (s) return { request_id: s.request_id, agent: s.agent };
  const r = await queryOne<{ id: string }>("SELECT id FROM requests WHERE $1 = ANY(naive_session_ids) LIMIT 1", [sessionId]);
  return { request_id: r?.id ?? null, agent: null };
}

async function requestPeopleNames(req: { customer_name: string | null; prospect_id: string | null }): Promise<string[]> {
  const names = [req.customer_name];
  if (req.prospect_id) {
    const p = await queryOne<{ contact_name: string | null }>("SELECT contact_name FROM prospects WHERE id = $1", [req.prospect_id]);
    names.push(p?.contact_name ?? null);
  }
  return names.filter((n): n is string => !!n);
}

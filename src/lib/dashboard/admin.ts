/**
 * Founder actions from the dashboard. Every one is authenticated with ADMIN_TOKEN and leaves exactly one
 * intervention (actor + reason), because judges count human steps. Approving an order records the
 * decision only: buying data stays a manual founder step (CLAUDE.md hard rules). Recording a payment is
 * bookkeeping: customers pay through a founder's Stripe link, and nothing reports that back automatically.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { getDb } from "../db/client";
import { Inbox } from "../domain";
import { env } from "../env";
import { logDecision, logEvent, logIntervention } from "../events";
import { decideApproval, listPendingApprovals, type PendingApproval } from "../naive/sessions";
import { approveQuote, rejectQuote } from "../pipeline/quotes";
import { SETTING } from "../settings";
import { getInboxArmed, NAIVE_APPROVALS_CACHE_KEY } from "./approvals";
import { invalidateDashboard } from "./cache";
import { shortId } from "./mask";
import { invalidateLive, num } from "./rows";

export type AdminAuth = "ok" | "disabled" | "denied";

export function checkAdminToken(given: string | null | undefined): AdminAuth {
  const expected = env("ADMIN_TOKEN");
  if (!expected) return "disabled";
  if (!given) return "denied";
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(given), digest(expected)) ? "ok" : "denied";
}

const who = { actor: z.string().trim().min(2).max(60), reason: z.string().trim().min(3).max(500) };
type Who = { actor: string; reason: string };

export const AdminAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("naive-approval"), session_id: z.string().min(1), tool_call_id: z.string().min(1), decision: z.enum(["allow", "deny"]), ...who }),
  z.object({ action: z.literal("order"), order_id: z.string().min(1), decision: z.enum(["approve", "reject"]), ...who }),
  z.object({ action: z.literal("quote"), quote_id: z.string().min(1), decision: z.enum(["approve", "reject"]), ...who }),
  z.object({ action: z.literal("template"), template_id: z.string().min(1), decision: z.enum(["approve", "retire"]), ...who }),
  z.object({ action: z.literal("inbox"), inbox: Inbox, armed: z.boolean(), ...who }),
  z.object({
    action: z.literal("payment"),
    /** The full id (Stripe's client_reference_id on the payment link) or the short id the public dashboard shows. */
    request_id: z.string().trim().regex(/^req_[a-z0-9]{4,32}$/, "Use the request id: req_ and its letters, as on the dashboard or in Stripe."),
    amount_usd: z.number().min(0.01).max(100_000),
    ...who,
  }),
]);
export type AdminAction = z.infer<typeof AdminAction>;

export class AdminConflict extends Error {}

/** The order a parked `terragent.place_paid_order` call is about, if that is what the call is. */
function paidOrderOf(p: PendingApproval): string | null {
  const id = p.args?.order_id;
  return /(^|[._])place_paid_order$/.test(p.tool) && typeof id === "string" ? id : null;
}

/** The parked place_paid_order call for this order, when Naïve is connected. */
async function parkedOrderCall(orderId: string): Promise<PendingApproval | undefined> {
  if (!env("NAIVE_API_KEY")) return undefined;
  return (await listPendingApprovals()).find((p) => paidOrderOf(p) === orderId);
}

/**
 * Takes back the intervention logged just before a Naïve decision that then failed: nothing changed, so it is not
 * a human step (judges count them). The event log keeps a trace.
 */
async function undoIntervention(i: { actor: string; action: string; refId: string; requestId?: string | null }, error: unknown) {
  const db = await getDb();
  await db.query(
    `DELETE FROM interventions WHERE id = (
       SELECT id FROM interventions WHERE actor = $1 AND action = $2 AND ref_id = $3 ORDER BY id DESC LIMIT 1)`,
    [i.actor, i.action, i.refId],
  );
  await logEvent("human.intervention_undone", `human:${i.actor}`, {
    action: i.action, ref_id: i.refId, error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
  }, i.requestId);
}

/**
 * Logs the founder's intervention, THEN answers Naïve. The session may resume (and run the tool through our MCP
 * server) before decideApproval even returns, and core's approveOrder links a fresh dashboard `naive_allow` row to
 * the request instead of logging a second one, so the row has to exist first. A failed decision takes it back.
 */
async function decideInNaive(parked: PendingApproval, decision: "allow" | "deny", intervention: Parameters<typeof logIntervention>[0] & { refId: string }) {
  await logIntervention(intervention);
  try {
    await decideApproval(parked.session_id, parked.tool_call_id, decision, intervention.reason);
  } catch (e) {
    await undoIntervention(intervention, e);
    throw e;
  }
  invalidateLive(NAIVE_APPROVALS_CACHE_KEY);
}

/**
 * One founder decision on a paid order, whichever panel it came from. The order row is decided first, so when Naïve
 * resumes the parked place_paid_order call, core's approveOrder finds it approved and doesn't log a second intervention.
 */
async function decideOrder(orderId: string, decision: "approve" | "reject", by: Who, parked?: PendingApproval) {
  const db = await getDb();
  const status = decision === "approve" ? "approved" : "rejected";
  const [order] = await db.query<{ request_id: string; provider_id: string; est_cost_usd: unknown }>(
    `UPDATE orders SET status = $2, approved_by = $3, decided_at = now(), updated_at = now()
     WHERE id = $1 AND status = 'awaiting_approval' RETURNING request_id, provider_id, est_cost_usd`,
    [orderId, status, by.actor],
  );
  if (!order) throw new AdminConflict("That order is not awaiting approval any more.");
  const intervention = { actor: by.actor, action: `${decision}_order`, reason: by.reason, requestId: order.request_id, refId: orderId };
  if (parked) {
    try {
      await decideInNaive(parked, decision === "approve" ? "allow" : "deny", intervention);
    } catch (e) {
      await db.query("UPDATE orders SET status = 'awaiting_approval', approved_by = NULL, decided_at = NULL, updated_at = now() WHERE id = $1", [orderId]);
      throw e;
    }
  } else {
    await logIntervention(intervention);
  }
  const actor = `human:${by.actor}`;
  await logDecision({
    requestId: order.request_id, kind: "free_vs_paid", agent: actor, reasoning: by.reason,
    choice: `paid order ${orderId} ${status} by a founder (${order.provider_id}, ~$${num(order.est_cost_usd)})${decision === "approve" ? "; founder buys manually" : ""}`,
  });
  await logEvent(`order.${status}`, actor, { order_id: orderId, approved_by: by.actor, purchased: false, via: parked ? "naive" : "dashboard" }, order.request_id);
  return { done: decision === "approve" ? "Order approved. Buying the data is still done by hand." : "Order rejected" };
}

async function decideNaiveCall(a: Extract<AdminAction, { action: "naive-approval" }>) {
  const parked = (await listPendingApprovals()).find((p) => p.session_id === a.session_id && p.tool_call_id === a.tool_call_id);
  if (!parked) throw new AdminConflict("That tool call is not waiting for a decision any more.");
  if (a.decision === "allow" && parked.approvable === false) {
    throw new AdminConflict(`${parked.tool} from ${parked.agent} can only be denied here. Decide it in the Naïve console if it really must run.`);
  }
  const orderId = paidOrderOf(parked);
  if (orderId) {
    const db = await getDb();
    const [order] = await db.query<{ status: string }>("SELECT status FROM orders WHERE id = $1", [orderId]);
    if (order?.status === "awaiting_approval") return decideOrder(orderId, a.decision === "allow" ? "approve" : "reject", a, parked);
  }
  await decideInNaive(parked, a.decision, { actor: a.actor, action: `naive_${a.decision}`, reason: a.reason, refId: a.tool_call_id });
  return { done: `${a.decision === "allow" ? "Allowed" : "Denied"} the paused tool call` };
}

/**
 * Core's approveQuote / rejectQuote log the intervention (with the founder's reason) and hand the request on:
 * approved → comms-customer sends the quote; rejected → pricing looks for a cheaper plan.
 */
async function decideHeldQuote(a: Extract<AdminAction, { action: "quote" }>) {
  const db = await getDb();
  const [quote] = await db.query<{ status: string }>("SELECT status FROM quotes WHERE id = $1", [a.quote_id]);
  if (quote?.status !== "needs_approval") throw new AdminConflict("That quote is not waiting for approval any more.");
  const approve = a.decision === "approve";
  try {
    if (approve) await approveQuote(a.quote_id, a.actor, a.reason);
    else await rejectQuote(a.quote_id, a.actor, a.reason);
  } catch (e) {
    // The decision is saved before the hand-off; say so rather than invite a second click.
    const [after] = await db.query<{ status: string }>("SELECT status FROM quotes WHERE id = $1", [a.quote_id]);
    if (after?.status !== (approve ? "approved" : "declined")) throw e;
    const who = approve ? "the customer agent" : "the pricing agent";
    return { done: `Quote ${approve ? "approved" : "rejected"}, but handing it to ${who} failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { done: approve ? "Quote approved. The customer agent is sending it now." : "Quote rejected. The pricing agent is looking for a cheaper plan." };
}

async function setInboxArmed(a: Extract<AdminAction, { action: "inbox" }>) {
  if ((await getInboxArmed())[a.inbox] === a.armed) throw new AdminConflict(`The ${a.inbox} inbox is already ${a.armed ? "armed" : "disarmed"}.`);
  const db = await getDb();
  // One statement that merges this inbox's flag, so concurrent toggles of different inboxes can't overwrite each other.
  const [row] = await db.query<{ key: string }>(
    `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, jsonb_build_object($2::text, $3::boolean), $4, now())
     ON CONFLICT (key) DO UPDATE SET value = settings.value || EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
     WHERE COALESCE((settings.value ->> $2)::boolean, false) <> $3
     RETURNING key`,
    [SETTING.inboxArmed, a.inbox, a.armed, `human:${a.actor}`],
  );
  if (!row) throw new AdminConflict(`The ${a.inbox} inbox is already ${a.armed ? "armed" : "disarmed"}.`);
  await logIntervention({ actor: a.actor, action: a.armed ? "arm_inbox" : "disarm_inbox", reason: a.reason, refId: a.inbox });
  return { done: `${a.inbox} inbox ${a.armed ? "armed" : "disarmed"}` };
}

interface FoundRequest { id: string; quote_id: string | null; prospect_id: string | null; price: number | null }

/** A request by its full id, or by the dashboard's short id (req_ + 4) when exactly one request has it. */
async function findRequest(id: string): Promise<FoundRequest> {
  const db = await getDb();
  const select = `SELECT r.id, r.quote_id, r.prospect_id, COALESCE(q.price_usd, r.price_usd) AS price
                  FROM requests r LEFT JOIN quotes q ON q.id = r.quote_id`;
  type Row = Omit<FoundRequest, "price"> & { price: unknown };
  let rows = await db.query<Row>(`${select} WHERE r.id = $1`, [id]);
  if (!rows.length && id.length === 8) rows = await db.query<Row>(`${select} WHERE left(r.id, 8) = $1 ORDER BY r.created_at DESC LIMIT 2`, [id]);
  if (rows.length > 1) throw new AdminConflict(`More than one request starts with ${id}. Paste the full id (Stripe shows it as the client reference).`);
  if (!rows.length) throw new AdminConflict(`No request ${id}. Check the id on the dashboard or in Stripe's client reference.`);
  const [r] = rows;
  return { id: r.id, quote_id: r.quote_id, prospect_id: r.prospect_id, price: r.price === null || r.price === undefined ? null : num(r.price) };
}

/** How long an identical payment (same request, same amount) counts as a double click rather than a second payment. */
const DUPLICATE_PAYMENT_MINUTES = 10;

/**
 * Money that was committed (an accepted quote, pipeline/revenue.ts) and is now paid stops counting as committed, so
 * paid + committed never counts the same dollars twice (the coordinator's value input adds them). A partial payment
 * leaves the rest committed.
 */
async function settleCommitted(quoteId: string, amount: number) {
  const db = await getDb();
  const [committed] = await db.query<{ id: string; amount_usd: unknown }>(
    "SELECT id, amount_usd FROM revenue WHERE quote_id = $1 AND kind = 'committed' ORDER BY recorded_at, id LIMIT 1",
    [quoteId],
  );
  if (!committed) return;
  const rest = Math.round((num(committed.amount_usd) - amount) * 100) / 100;
  if (rest > 0) await db.query("UPDATE revenue SET amount_usd = $2 WHERE id = $1", [committed.id, rest]);
  else await db.query("DELETE FROM revenue WHERE id = $1", [committed.id]);
}

/**
 * A founder saw a customer's payment (Stripe link) and records it: one `revenue` row of kind 'paid', linked to the
 * request's quote, so the funnel's paid stage and the Money panel count it. One intervention; no agent is woken.
 */
async function recordPayment(a: Extract<AdminAction, { action: "payment" }>) {
  const db = await getDb();
  const req = await findRequest(a.request_id);
  const amount = Math.round(a.amount_usd * 100) / 100;
  // One statement, so a double click can't record the same payment twice.
  const [row] = await db.query<{ id: string }>(
    `INSERT INTO revenue (request_id, quote_id, amount_usd, kind, note)
     SELECT $1::text, $2::text, $3::numeric, 'paid', $4::text
     WHERE NOT EXISTS (
       SELECT 1 FROM revenue WHERE request_id = $1::text AND kind = 'paid' AND amount_usd = $3::numeric
         AND recorded_at > now() - make_interval(mins => $5::int))
     RETURNING id`,
    [req.id, req.quote_id, amount, `recorded by ${a.actor}: ${a.reason}`.slice(0, 600), DUPLICATE_PAYMENT_MINUTES],
  );
  const label = shortId(req.id);
  if (!row) throw new AdminConflict(`A $${amount} payment for ${label} was already recorded in the last ${DUPLICATE_PAYMENT_MINUTES} minutes.`);
  if (req.quote_id) await settleCommitted(req.quote_id, amount);
  await logIntervention({ actor: a.actor, action: "record_payment", reason: a.reason, requestId: req.id, refId: req.quote_id ?? req.id });
  await logEvent("payment.recorded", `human:${a.actor}`, { amount_usd: amount, quote_id: req.quote_id, revenue_id: String(row.id) }, req.id);
  // The business behind a free sample paid: the outbound funnel counts it from here.
  if (req.prospect_id) {
    await db.query(
      "UPDATE prospects SET status = 'paid', updated_at = now() WHERE id = $1 AND status NOT IN ('paid', 'opted_out', 'disqualified')",
      [req.prospect_id],
    );
  }
  const off = req.price !== null && Math.abs(req.price - amount) >= 0.01 ? ` (the quoted price was $${req.price})` : "";
  return { done: `Recorded a $${amount} payment for ${label}${off}.` };
}

/** Runs one founder action, then drops the cached dashboard reads so every viewer sees it on the next poll. */
export async function runAdminAction(a: AdminAction): Promise<{ done: string }> {
  try {
    return await dispatch(a);
  } finally {
    invalidateDashboard();
  }
}

async function dispatch(a: AdminAction): Promise<{ done: string }> {
  switch (a.action) {
    case "naive-approval":
      return decideNaiveCall(a);
    case "order":
      return decideOrder(a.order_id, a.decision, a, await parkedOrderCall(a.order_id));
    case "quote":
      return decideHeldQuote(a);
    case "template": {
      const db = await getDb();
      const [row] =
        a.decision === "approve"
          ? await db.query<{ id: string }>(
              "UPDATE templates SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1 AND status = 'draft' RETURNING id",
              [a.template_id, a.actor],
            )
          : await db.query<{ id: string }>("UPDATE templates SET status = 'retired' WHERE id = $1 AND status = 'draft' RETURNING id", [a.template_id]);
      if (!row) throw new AdminConflict("That template is not a draft any more.");
      await logIntervention({ actor: a.actor, action: `${a.decision}_template`, reason: a.reason, refId: a.template_id });
      return { done: a.decision === "approve" ? "Template approved" : "Template retired" };
    }
    case "inbox":
      return setInboxArmed(a);
    case "payment":
      return recordPayment(a);
  }
}

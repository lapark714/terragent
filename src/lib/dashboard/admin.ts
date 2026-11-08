/**
 * Founder actions from the dashboard. Every one is authenticated with ADMIN_TOKEN and leaves exactly one
 * intervention (actor + reason), because judges count human steps. Approving an order records the
 * decision only: buying data stays a manual founder step (CLAUDE.md hard rules).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { getDb } from "../db/client";
import { Inbox } from "../domain";
import { env } from "../env";
import { logDecision, logEvent, logIntervention } from "../events";
import { decideApproval, listPendingApprovals, type PendingApproval } from "../naive/sessions";
import { approveQuote } from "../pipeline/quotes";
import { SETTING } from "../settings";
import { getInboxArmed, NAIVE_APPROVALS_CACHE_KEY } from "./approvals";
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
  z.object({ action: z.literal("quote"), quote_id: z.string().min(1), decision: z.literal("approve"), ...who }),
  z.object({ action: z.literal("template"), template_id: z.string().min(1), decision: z.enum(["approve", "retire"]), ...who }),
  z.object({ action: z.literal("inbox"), inbox: Inbox, armed: z.boolean(), ...who }),
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
  if (parked) {
    try {
      await decideApproval(parked.session_id, parked.tool_call_id, decision === "approve" ? "allow" : "deny", by.reason);
    } catch (e) {
      await db.query("UPDATE orders SET status = 'awaiting_approval', approved_by = NULL, decided_at = NULL, updated_at = now() WHERE id = $1", [orderId]);
      throw e;
    }
    invalidateLive(NAIVE_APPROVALS_CACHE_KEY);
  }
  const actor = `human:${by.actor}`;
  await logIntervention({ actor: by.actor, action: `${decision}_order`, reason: by.reason, requestId: order.request_id, refId: orderId });
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
  const orderId = paidOrderOf(parked);
  if (orderId) {
    const db = await getDb();
    const [order] = await db.query<{ status: string }>("SELECT status FROM orders WHERE id = $1", [orderId]);
    if (order?.status === "awaiting_approval") return decideOrder(orderId, a.decision === "allow" ? "approve" : "reject", a, parked);
  }
  await decideApproval(a.session_id, a.tool_call_id, a.decision, a.reason);
  invalidateLive(NAIVE_APPROVALS_CACHE_KEY);
  await logIntervention({ actor: a.actor, action: `naive_${a.decision}`, reason: a.reason, refId: a.tool_call_id });
  return { done: `${a.decision === "allow" ? "Allowed" : "Denied"} the paused tool call` };
}

/** Core's approveQuote logs the intervention and hands the quote to comms-customer to send. */
async function approveHeldQuote(a: Extract<AdminAction, { action: "quote" }>) {
  const db = await getDb();
  const [quote] = await db.query<{ status: string }>("SELECT status FROM quotes WHERE id = $1", [a.quote_id]);
  if (quote?.status !== "needs_approval") throw new AdminConflict("That quote is not waiting for approval any more.");
  try {
    await approveQuote(a.quote_id, a.actor);
  } catch (e) {
    // The approval is saved before the hand-off; say so rather than invite a second click.
    const [after] = await db.query<{ status: string }>("SELECT status FROM quotes WHERE id = $1", [a.quote_id]);
    if (after?.status !== "approved") throw e;
    return { done: `Quote approved, but handing it to the customer agent failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { done: "Quote approved. The customer agent is sending it now." };
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

export async function runAdminAction(a: AdminAction): Promise<{ done: string }> {
  switch (a.action) {
    case "naive-approval":
      return decideNaiveCall(a);
    case "order":
      return decideOrder(a.order_id, a.decision, a, await parkedOrderCall(a.order_id));
    case "quote":
      return approveHeldQuote(a);
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
  }
}

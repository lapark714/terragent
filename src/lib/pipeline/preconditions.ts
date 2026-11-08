/**
 * Handoff preconditions: a stage is handed on only once the step before it saved its output.
 *
 * Why: Naïve parks every tool call of our agents for approval, and confirming a parked call does not run it: the model
 * must re-issue each approved call itself. In a parallel batch (log_decision ×2, save_acquisition_plan, handoff) it
 * sometimes re-issued only the handoff, so pricing got a request with no plan (req_ybnemrwx4g, req_bkxpefeuns).
 * handoff() now refuses such a handoff with the exact missing tool, the way the screening guard already did, so the
 * agent does that step and hands off again within its own session.
 *
 * Two kinds of rule, checked in this order:
 * - CONSUMER rules, keyed on the destination: what the next stage needs (acquisition a spec, pricing a current plan,
 *   the interpreter an analysis from this run, the verifier a pending draft, delivery a passed report, …). They apply to
 *   every non-human sender: agents, the coordinator, system, and the internal handoffs of create_quote, save_verdict
 *   and accept_quote.
 * - PRODUCER freshness rules, on three edges only: planner→acquisition, acquisition→pricing (and a free sample's
 *   acquisition→analytics/interpreter) and pricing→comms-customer (stage quote). The producer must have saved its
 *   output in THIS run, i.e. since the latest handoff to it, so a re-plan can't pass on the previous run's plan.
 *
 * Exemptions: human:* senders (founder restarts, approveQuote, rejectQuote, markOrderDelivered) skip every rule;
 * monitoring follow-ups (source monitor) skip the analysis, report, delivery and outreach rules.
 *
 * LEAF module: it imports only ./db, ./gates and types, never the pipeline services (they import requests.ts).
 * Event-id comparisons happen in SQL: events.id is a bigserial and pg returns bigint as a string.
 */
import type { AcquisitionPlan } from "../domain";
import { query, queryOne } from "./db";
import { acceptedOptionBuysData, WAITING_ORDER_STATUSES } from "./gates";
import type { RequestRow } from "./requests";

export interface HandoffEdge { from: string; to: string; stage: string }

/**
 * awaiting_approval means a founder has to buy held paid data, and the coordinator is told never to touch it. An agent
 * that parks anything else there strands it: no cron or review ever picks it up again (seen live on two free samples).
 */
export async function parkingRefusal(requestId: string): Promise<string | null> {
  const held = await query<{ id: string }>("SELECT id FROM orders WHERE request_id = $1 AND status = ANY($2)", [requestId, [...WAITING_ORDER_STATUSES]]);
  if (held.length) return null;
  return `Request ${requestId} has no paid order waiting on a founder, so it can't be awaiting_approval: nothing would ever pick it up again. ` +
    "terragent.add_note with what is blocking it, then hand it to the agent that should act, or leave it for the next company review.";
}

/** How every refusal to the sending agent ends: do the named step, then hand off again, alone. */
const again = (to?: string) => `then call terragent.handoff${to ? ` to ${to}` : ""} again on its own`;

/** What acquisition owes before its plan can move on: saveAcquisitionPlan refuses without this run's two decisions. */
const LOG_THEN_SAVE_PLAN =
  "call terragent.log_decision (kinds source_selection and free_vs_paid) unless both are already logged in this run, wait for the results, " +
  "then call terragent.save_acquisition_plan";

/** Why this handoff can't happen yet (null when it can). Called by handoff() after the screening and price gates. */
export async function handoffBlockedReason(req: RequestRow, a: HandoffEdge): Promise<string | null> {
  if (a.from.startsWith("human:")) return null;
  return (await consumerBlockedReason(req, a)) ?? (await producerBlockedReason(req, a));
}

// ---------------------------------------------------------------------------
// Consumer rules (the destination's needs)
// ---------------------------------------------------------------------------

async function consumerBlockedReason(req: RequestRow, a: HandoffEdge): Promise<string | null> {
  const id = req.id;
  const plan = req.acquisition_plan as AcquisitionPlan | null;
  const monitor = req.source === "monitor";

  // A. acquisition needs a data spec.
  if ((a.to === "acquisition" || a.stage === "acquisition") && !req.data_spec) {
    return a.from === "planner"
      ? `Request ${id} has no saved data spec: call terragent.save_data_spec, wait for its result, ${again("acquisition")}.`
      : `Request ${id} has no data spec: hand it to planner (stage planning) to save_data_spec first.`;
  }

  // B. pricing needs a quotable request with a spec and a plan no older than the spec.
  if (a.to === "pricing" || a.stage === "pricing") {
    if (req.is_free_sample) {
      return `Request ${id} is a free sample and is never quoted: hand it to analytics (stage analysis), or to interpreter (stage report) when its plan reuses the Earth index.`;
    }
    if (!req.data_spec) return `Request ${id} has no data spec: hand it to planner (stage planning) to start the chain.`;
    if (!plan) {
      return a.from === "acquisition"
        ? `No acquisition plan saved for ${id}: ${LOG_THEN_SAVE_PLAN}, wait for its result, ${again("pricing")}.`
        : `Request ${id} has no acquisition plan: hand it to acquisition (stage acquisition) to save_acquisition_plan first.`;
    }
    if (await olderThan(id, "acquisition_plan.saved", "data_spec.saved")) {
      return a.from === "acquisition"
        ? `The acquisition plan on ${id} is older than its data spec: ${LOG_THEN_SAVE_PLAN} for the current spec, wait for its result, ${again("pricing")}.`
        : `The acquisition plan on ${id} is older than its data spec: hand it to acquisition (stage acquisition) to save a plan for the new spec first.`;
    }
  }

  // C. analysis needs a plan that runs the pipeline, and no paid data still on order.
  if ((a.stage === "analysis" || (a.to === "analytics" && a.stage !== "monitoring")) && !monitor) {
    if (!plan) {
      return a.from === "acquisition"
        ? `No acquisition plan saved for ${id}: ${LOG_THEN_SAVE_PLAN} (free data for a free sample), wait for its result, ${again("analytics")}.`
        : `Request ${id} has no acquisition plan: hand it to acquisition (stage acquisition) first.`;
    }
    if (plan.choice === "existing_index") return `Request ${id}'s plan reuses the Earth index: hand it to interpreter (stage report), not analytics.`;
    const waiting = await query<{ id: string }>(
      "SELECT id FROM orders WHERE request_id = $1 AND status = ANY($2::text[]) ORDER BY created_at",
      [id, WAITING_ORDER_STATUSES],
    );
    if (waiting.length) {
      return `Request ${id} waits on paid data a founder hasn't marked delivered (orders ${waiting.map((o) => o.id).join(", ")}): the analysis starts by ` +
        "itself when a founder marks it delivered. terragent.add_note and leave it waiting.";
    }
    // An accepted paid option never runs on free data, even with no order held (never prepared, or rejected).
    const paidData = await acceptedPaidData(req, plan);
    if (paidData && !paidData.delivered) {
      return `Request ${id}'s accepted option buys paid data and none has been marked delivered: the analysis starts when a founder marks it delivered. ` +
        "If no order is held, hand it to acquisition (stage acquisition) to prepare one; never run it on free data.";
    }
    // The coordinator doesn't start paid work: a delivery whose analysis never started goes through acquisition
    // (also once acquisition has it). An analysis already running can be re-kicked like any stale request.
    if (paidData && a.from === "coordinator" && (req.status === "awaiting_approval" || req.status === "acquiring")) {
      return `The paid data on ${id} arrived but the analysis never started: hand it to acquisition (stage acquisition), saying so, with the order ids.`;
    }
  }

  // D. the report needs an analysis saved after the current plan and the acceptance (unless it comes from the Earth index).
  if (a.to === "interpreter" && a.stage === "report" && !monitor && plan?.choice !== "existing_index") {
    // A free sample's Earth-index plan that never ran: the plan is the missing step, not an analysis.
    if (!plan && a.from === "acquisition") {
      return `No acquisition plan saved for ${id}: ${LOG_THEN_SAVE_PLAN}, wait for its result, ${again("interpreter")}.`;
    }
    if (!(await analysisIsCurrent(id))) {
      return a.from === "analytics"
        ? `No analysis saved for ${id} in this run: call terragent.run_analysis({ request_id }) and wait for its result (it saves the analysis), ` +
            `${again("interpreter")}.`
        : `Request ${id} has no analysis yet: hand it to analytics (stage analysis) to run_analysis first.`;
    }
  }

  const reportStage = a.to === "verifier" || ["verification", "revision", "delivery", "outreach"].includes(a.stage);
  const report = reportStage ? await currentReport(req) : null;

  // E. verification needs a draft nobody has graded yet.
  if ((a.to === "verifier" || a.stage === "verification") && report?.verifier_status !== "pending") {
    return a.from === "interpreter"
      ? `No new report draft to verify for ${id} (latest: ${report ? `${report.id}, ${report.verifier_status}` : "none"}): call terragent.save_report_draft, ` +
          `then terragent.check_report_rules on the report_id it returns, ${again("verifier")}.`
      : `Request ${id} has no report draft waiting for review: hand it to interpreter (stage report, or revision after a failed verdict) first.`;
  }

  // F. a revision needs a failing verdict.
  if (a.stage === "revision" && report?.verifier_status !== "fail") {
    return `Report ${report?.id ?? "(none)"} on ${id} has no failing verdict: the verifier must call terragent.save_verdict (pass=false with required_fixes); ` +
      "it sends the report back to the interpreter itself.";
  }

  // G, H. delivery and outreach need a passed report; free samples go to outreach, never delivery.
  if (a.stage === "delivery" && !monitor && req.is_free_sample) return "Free sample reports go to comms-outreach (stage outreach), not delivery.";
  if ((a.stage === "delivery" || a.stage === "outreach") && !monitor && report?.verifier_status !== "pass") {
    return `Report ${report?.id ?? "(none)"} for ${id} is not verified (status ${report?.verifier_status ?? "none"}): the verifier must call ` +
      "terragent.save_verdict first; a pass hands the report on by itself.";
  }

  // I. the quote stage needs a sendable quote priced on the current plan.
  if (a.stage === "quote") {
    const quote = await currentQuote(req);
    if (!quote || !["approved", "sent"].includes(quote.status) || quote.expired) {
      return `Request ${id} has no quote ready to send: pricing must call terragent.create_quote (it hands the quote to comms-customer itself).`;
    }
    if (await olderThan(id, "quote.created", "acquisition_plan.saved")) {
      return `Quote ${quote.id} predates ${id}'s current acquisition plan: pricing must call terragent.price_options, then terragent.create_quote again.`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Producer freshness rules (the sender saved its output in this run)
// ---------------------------------------------------------------------------

async function producerBlockedReason(req: RequestRow, a: HandoffEdge): Promise<string | null> {
  const id = req.id;

  // P1. planner → acquisition: a spec saved since the request last came to the planner.
  if (a.from === "planner" && a.to === "acquisition" && !(await savedSinceHandoffTo(id, "data_spec.saved", "planner"))) {
    return `The data spec on ${id} was not saved in this planning run: call terragent.save_data_spec (the updated spec), wait for its result, ` +
      `${again("acquisition")}.`;
  }

  // P2. acquisition → pricing (a free sample: → analytics or interpreter): a plan saved since the request last came to acquisition.
  const planConsumer = a.to === "pricing" || (req.is_free_sample && (a.to === "analytics" || a.to === "interpreter"));
  if (a.from === "acquisition" && planConsumer && !(await savedSinceHandoffTo(id, "acquisition_plan.saved", "acquisition"))) {
    return `No acquisition plan saved in this run (the one on ${id} and its decisions are from an earlier run): ${LOG_THEN_SAVE_PLAN}, even if nothing ` +
      `changed, wait for its result, ${again()}.`;
  }

  // P3. pricing → quote: the quote is still unsent, or pricing made a new one in this run.
  if (a.from === "pricing" && a.stage === "quote") {
    const quote = await currentQuote(req);
    if (quote && quote.status !== "approved" && !(await savedSinceHandoffTo(id, "quote.created", "pricing"))) {
      return `No new quote in this pricing run (quote ${quote.id} was already sent): call terragent.create_quote with the customer's changes; ` +
        "it hands the new quote to comms-customer itself.";
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** An event of `type` logged after the latest handoff to `to` (or ever, when the request never went to `to`). */
async function savedSinceHandoffTo(requestId: string, type: string, to: string): Promise<boolean> {
  const row = await queryOne<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM events e WHERE e.request_id = $1 AND e.type = $2 AND e.id > COALESCE(
         (SELECT max(h.id) FROM events h WHERE h.request_id = $1 AND h.type = 'handoff' AND h.payload->>'to' = $3), 0)
     ) AS ok`,
    [requestId, type, to],
  );
  return row?.ok === true;
}

/** The latest `a` event is older than the latest `b` event. Either one missing counts as not stale. */
async function olderThan(requestId: string, a: string, b: string): Promise<boolean> {
  const row = await queryOne<{ stale: boolean | null }>(
    `SELECT (SELECT max(id) FROM events WHERE request_id = $1 AND type = $2)
          < (SELECT max(id) FROM events WHERE request_id = $1 AND type = $3) AS stale`,
    [requestId, a, b],
  );
  return row?.stale === true;
}

/** An analysis saved after both the latest plan and the latest acceptance. */
async function analysisIsCurrent(requestId: string): Promise<boolean> {
  const row = await queryOne<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM events e WHERE e.request_id = $1 AND e.type = 'analysis.saved' AND e.id > GREATEST(
         COALESCE((SELECT max(id) FROM events WHERE request_id = $1 AND type = 'acquisition_plan.saved'), 0),
         COALESCE((SELECT max(id) FROM events WHERE request_id = $1 AND type = 'quote.accepted'), 0))
     ) AS ok`,
    [requestId],
  );
  return row?.ok === true;
}

/** For a request whose accepted option buys data: whether any of it has been delivered. Null for every other request. */
async function acceptedPaidData(req: Pick<RequestRow, "quote_id">, plan: AcquisitionPlan | null) {
  if (!req.quote_id) return null;
  const quote = await queryOne<{ accepted_option_id: string | null; options: unknown; delivered: boolean }>(
    `SELECT q.accepted_option_id, q.options, EXISTS (SELECT 1 FROM orders o WHERE o.request_id = q.request_id AND o.status = 'delivered') AS delivered
     FROM quotes q WHERE q.id = $1 AND q.status = 'accepted'`,
    [req.quote_id],
  );
  return quote && acceptedOptionBuysData(quote, plan?.choice) ? { delivered: quote.delivered } : null;
}

async function currentReport(req: Pick<RequestRow, "report_id">) {
  if (!req.report_id) return null;
  return queryOne<{ id: string; verifier_status: string }>("SELECT id, verifier_status FROM reports WHERE id = $1", [req.report_id]);
}

async function currentQuote(req: Pick<RequestRow, "quote_id">) {
  if (!req.quote_id) return null;
  return queryOne<{ id: string; status: string; expired: boolean }>(
    "SELECT id, status, (valid_until IS NOT NULL AND valid_until < now()) AS expired FROM quotes WHERE id = $1",
    [req.quote_id],
  );
}

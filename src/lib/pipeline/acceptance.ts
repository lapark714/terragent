/**
 * Quote acceptance (pricing v2): the ONE way customer work starts. Shared by the accept_quote tool (comms-customer reads
 * the customer's reply) and the accept link (POST /api/quotes/accept → acceptQuoteByToken, actor "customer (link)").
 *
 * Records the chosen option (once; idempotent for the same option), committed revenue at the option's price (the low
 * end of a range), and a pricing decision; then:
 *   free-data option  → analytics (stage analysis), or interpreter (stage report) when the Earth index answers it;
 *   paid-data option  → a held paid order per paid data item (a founder buys by hand, spec §0), the request waits at
 *                       awaiting_approval with a board card for the coordinator, and analysis does NOT start on free data
 *                       meanwhile (next: awaiting_data_purchase). A founder marking the data delivered (dashboard,
 *                       orders.ts markOrderDelivered) hands it to analytics.
 */
import { type AcquisitionPlan, optionPriceLow, type QuoteOption, QuoteOptionId } from "../domain";
import { logDecision, logEvent } from "../events";
import { scrubText } from "../mcp/scrub";
import { errorMessage, json, query, queryOne } from "./db";
import { prepareOrder } from "./orders";
import { fmtPrice } from "./pricing-engine";
import { getProvider } from "./providers";
import {
  ACCEPTABLE_QUOTE_STATUSES, getQuote, getQuoteByAcceptToken, mirrorColumns, optionLineItems, type QuoteRow,
} from "./quotes";
import { recordCommittedRevenue } from "./revenue";
import { addNote, handoff, isTerminal, requireRequest, setStatus } from "./requests";

export const LINK_ACTOR = "customer (link)";

export type AcceptErrorCode =
  | "not_found" | "no_quote" | "free_sample" | "bad_option" | "superseded" | "expired" | "already_accepted" | "not_acceptable" | "closed";

/** A refusal the caller can map to an HTTP status (route) or show the agent as { error }. */
export class QuoteAcceptError extends Error {
  constructor(public code: AcceptErrorCode, message: string) {
    super(message);
    this.name = "QuoteAcceptError";
  }
}

export type AcceptNext = "analysis" | "report" | "awaiting_data_purchase";

export interface AcceptResult {
  request_id: string;
  quote_id: string;
  option_id: string;
  /** The request's status after acceptance. */
  status: string;
  next: AcceptNext;
  already_accepted: boolean;
  accepted_at: string | null;
  price_usd: number | null;
  price_range_usd: [number, number] | null;
  order_ids: string[];
  warnings: string[];
  note: string;
}

/** A pre-v2 quote has no options: treat it as one option A at its price (paid when the plan bought data). */
function legacyOption(q: QuoteRow, plan: AcquisitionPlan | null): QuoteOption {
  return {
    option_id: "A", label: "Quoted report", answers: "The answer as quoted", kind: plan?.choice === "paid" ? "archive" : "free_data", data: [],
    analysis_cost_usd: Number(q.analysis_cost_usd) || 0, risk_buffer_usd: 0, margin_usd: Number(q.margin_usd) || 0,
    price_usd: Number(q.price_usd) || 0, price_range_usd: null, delivery_time: "as quoted", confidence: "medium", notes: [],
  };
}

const optionsOf = (q: QuoteRow): QuoteOption[] => (Array.isArray(q.options) ? q.options : []);

function nextNote(next: AcceptNext, optionId: string): string {
  if (next === "awaiting_data_purchase") {
    return `Option ${optionId} buys paid data: the order is held for a founder to place by hand, and the analysis starts by itself once ` +
      "a founder marks the data delivered. Don't hand off; end your turn (you may send_customer_message kind update to say the data is being ordered).";
  }
  return `Option ${optionId} accepted and the work has started (${next === "report" ? "interpreter, from the Earth index" : "analytics"}). ` +
    "Don't hand off again; end your turn (you may send_customer_message kind update to confirm).";
}

async function result(reqId: string, q: QuoteRow, option: QuoteOption, next: AcceptNext, extra: Partial<AcceptResult> = {}): Promise<AcceptResult> {
  const req = await requireRequest(reqId);
  const fresh = (await getQuote(q.id)) ?? q;
  return {
    request_id: req.id, quote_id: q.id, option_id: option.option_id, status: req.status, next, already_accepted: false,
    accepted_at: fresh.accepted_at ? new Date(fresh.accepted_at).toISOString() : null,
    price_usd: option.price_usd, price_range_usd: option.price_range_usd, order_ids: [], warnings: [], note: nextNote(next, option.option_id),
    ...extra,
  };
}

/** Where an already-accepted request stands, for an idempotent repeat (double-click, retried tool call). */
async function repeatNext(requestId: string, option: QuoteOption): Promise<AcceptNext> {
  if (option.kind !== "free_data") return "awaiting_data_purchase";
  const req = await requireRequest(requestId);
  return (req.acquisition_plan as AcquisitionPlan | null)?.choice === "existing_index" ? "report" : "analysis";
}

/**
 * Accept one option of the request's current quote. `optionId` defaults to the recommended one (a plain "yes").
 * `token` (the accept link) must belong to the current quote, so an old link can't accept a superseded quote.
 */
export async function acceptQuote(a: { requestId: string; optionId?: string | null; actor: string; evidence?: string | null; token?: string }): Promise<AcceptResult> {
  const req = await requireRequest(a.requestId);
  if (req.is_free_sample) throw new QuoteAcceptError("free_sample", "Free samples are not quoted; there is nothing to accept.");
  const quote = req.quote_id ? await getQuote(req.quote_id) : null;
  if (!quote) throw new QuoteAcceptError("no_quote", `Request ${req.id} has no quote yet; pricing must create_quote first.`);
  if (a.token !== undefined && quote.accept_token !== a.token) {
    throw new QuoteAcceptError("superseded", "This accept link is for an earlier quote that has been replaced; use the latest quote.");
  }

  const plan = req.acquisition_plan as AcquisitionPlan | null;
  const options = optionsOf(quote);
  const wanted = (a.optionId ?? quote.recommended_option_id ?? (options.length <= 1 ? "A" : "")).toString().trim().toUpperCase();
  const parsedId = QuoteOptionId.safeParse(wanted);
  const option = parsedId.success
    ? options.find((o) => o.option_id === parsedId.data) ?? (options.length === 0 && parsedId.data === "A" ? legacyOption(quote, plan) : undefined)
    : undefined;
  if (!option) {
    const ids = options.map((o) => o.option_id).join(", ") || "A";
    throw new QuoteAcceptError("bad_option", `Quote ${quote.id} has no option "${wanted || "?"}"; choose one of ${ids}.`);
  }

  // Idempotent for the same option; a different option needs a new quote.
  if (quote.accepted_option_id || quote.status === "accepted") {
    if ((quote.accepted_option_id ?? "A") === option.option_id) {
      return result(req.id, quote, option, await repeatNext(req.id, option), {
        already_accepted: true, note: `Option ${option.option_id} was already accepted; nothing more to do. End your turn.`,
      });
    }
    throw new QuoteAcceptError(
      "already_accepted",
      `Quote ${quote.id} was already accepted with option ${quote.accepted_option_id}; to change it, add_note with what the customer wants and hand back to pricing.`,
    );
  }
  if (isTerminal(req)) throw new QuoteAcceptError("closed", `Request ${req.id} is ${req.status}; its quote can't be accepted.`);
  if (!(ACCEPTABLE_QUOTE_STATUSES as readonly string[]).includes(quote.status)) {
    const code: AcceptErrorCode = quote.status === "superseded" ? "superseded" : quote.status === "expired" ? "expired" : "not_acceptable";
    throw new QuoteAcceptError(code, `Quote ${quote.id} is ${quote.status}; it can't be accepted. Hand back to pricing for a current quote.`);
  }
  if (quote.valid_until && new Date(quote.valid_until).getTime() < Date.now()) {
    await query("UPDATE quotes SET status = 'expired', updated_at = now() WHERE id = $1 AND accepted_option_id IS NULL", [quote.id]);
    await logEvent("quote.expired", a.actor, { quote_id: quote.id }, req.id);
    throw new QuoteAcceptError(
      "expired",
      `Quote ${quote.id} expired on ${new Date(quote.valid_until).toISOString().slice(0, 10)}; hand back to pricing (stage pricing) for a fresh quote.`,
    );
  }

  // Claim it atomically: of two concurrent accepts (link double-submit, reply + link) exactly one records.
  const m = options.length ? mirrorColumns(option) : null;
  const claimed = await queryOne<{ id: string }>(
    `UPDATE quotes SET status = 'accepted', accepted_option_id = $2, accepted_at = now(), updated_at = now(),
       data_cost_usd = COALESCE($3, data_cost_usd), analysis_cost_usd = COALESCE($4, analysis_cost_usd), margin_usd = COALESCE($5, margin_usd),
       price_usd = COALESCE($6, price_usd), line_items = COALESCE($7::jsonb, line_items)
     WHERE id = $1 AND accepted_option_id IS NULL AND status = ANY($8::text[]) RETURNING id`,
    [quote.id, option.option_id, m?.data_cost_usd ?? null, m?.analysis_cost_usd ?? null, m?.margin_usd ?? null, m?.price_usd ?? null,
      m ? json(optionLineItems(option)) : null, [...ACCEPTABLE_QUOTE_STATUSES]],
  );
  if (!claimed) {
    const now = await getQuote(quote.id);
    if (now?.accepted_option_id === option.option_id) {
      return result(req.id, quote, option, await repeatNext(req.id, option), { already_accepted: true, note: `Option ${option.option_id} was already accepted.` });
    }
    throw new QuoteAcceptError("not_acceptable", `Quote ${quote.id} changed while accepting (now ${now?.status ?? "missing"}); read it again.`);
  }

  const price = optionPriceLow(option);
  await query("UPDATE requests SET price_usd = $2, updated_at = now() WHERE id = $1", [req.id, price]);
  await recordCommittedRevenue({ requestId: req.id, quoteId: quote.id, actor: a.actor });
  const evidence = scrubText((a.evidence ?? "").trim(), [req.customer_name]).replace(/\s+/g, " ").slice(0, 300) ||
    (a.actor === LINK_ACTOR ? "Accepted with the quote's accept link" : "Accepted in the email thread");
  const others = options.filter((o) => o.option_id !== option.option_id);
  await logDecision({
    requestId: req.id, kind: "pricing", agent: a.actor,
    choice: `customer accepted option ${option.option_id} (${option.label}) at ${fmtPrice(option)}`,
    reasoning: `Customer's words: "${evidence}". Option kind ${option.kind}; ${option.answers}`.slice(0, 2000),
    alternatives: others.map((o) => ({ option: `${o.option_id}: ${o.label}`, cost_usd: optionPriceLow(o), why_not: `not chosen (${fmtPrice(o)})` })),
  });
  await logEvent("quote.accepted", a.actor, {
    quote_id: quote.id, option_id: option.option_id, kind: option.kind, price_usd: option.price_usd, price_range_usd: option.price_range_usd,
  }, req.id);

  // Paid data: hold an order per paid item for a founder; nothing runs on free data meanwhile.
  const paid: QuoteOption["data"] = [];
  for (const d of option.data) {
    const p = await getProvider(d.provider_id);
    if (p && !p.is_free) paid.push(d);
  }
  const warnings: string[] = [];
  if (option.kind !== "free_data" || paid.length) {
    const orderIds: string[] = [];
    for (const d of paid) {
      try {
        const open = await queryOne<{ id: string }>(
          `SELECT id FROM orders WHERE request_id = $1 AND provider_id = $2 AND status IN ('quote_requested', 'awaiting_approval')
           ORDER BY created_at DESC LIMIT 1`,
          [req.id, d.provider_id],
        );
        const order = await prepareOrder({
          requestId: req.id, providerId: d.provider_id, product: d.product, areaKm2: d.area_km2,
          estCostUsd: d.data_cost_usd ?? d.data_cost_range_usd?.[1] ?? 0,
          justification: `Customer accepted option ${option.option_id} (${option.label}): ${option.answers}`.slice(0, 1000),
          deliveryTime: option.delivery_time, orderId: open?.id,
        }, a.actor);
        orderIds.push(order.order_id);
      } catch (e) {
        warnings.push(`Order for ${d.provider_id} not prepared: ${errorMessage(e)}`);
      }
    }
    const now = await requireRequest(req.id);
    if (now.status !== "awaiting_approval") {
      await setStatus(req.id, "awaiting_approval", a.actor, `Customer accepted option ${option.option_id}; paid data held for a founder to buy`);
    }
    const held = orderIds.join(", ") || "(none prepared; see warnings)";
    await addNote(
      req.id, a.actor,
      `For coordinator: the customer accepted option ${option.option_id} (${fmtPrice(option)}), which needs paid data. ` +
        `Held order(s) ${held} wait for a founder to buy by hand; the analysis starts when a founder marks the data delivered, ` +
        "not on free data meanwhile.",
    );
    // A board card (background lane, even for an inbound request) so the coordinator tracks the purchase; no session.
    try {
      await handoff({
        requestId: req.id, from: a.actor, to: "coordinator", stage: "data_purchase", status: "awaiting_approval", lane: "background",
        instructions:
          `The customer accepted option ${option.option_id} of quote ${quote.id}, which needs paid data. Held order(s) ${held} wait for a founder ` +
          "on the dashboard (Paid data orders): a founder buys the data by hand, then marks the order delivered, which starts the analysis by itself. " +
          "Leave it waiting: never approve an order or start the analysis yourself. If no order was prepared, add_note with what is missing and hand off to acquisition",
      });
    } catch (e) {
      warnings.push(`Coordinator card not created (${errorMessage(e)}); the held orders still show on the dashboard.`);
    }
    return result(req.id, quote, option, "awaiting_data_purchase", { order_ids: orderIds, warnings });
  }

  const toReport = plan?.choice === "existing_index";
  const next: AcceptNext = toReport ? "report" : "analysis";
  try {
    await handoff({
      requestId: req.id, from: a.actor, to: toReport ? "interpreter" : "analytics", stage: toReport ? "report" : "analysis",
      instructions: toReport
        ? `The customer accepted option ${option.option_id} of quote ${quote.id}. The Earth index already answers it: write the report from the index (no pipeline run)`
        : `The customer accepted option ${option.option_id} of quote ${quote.id} (${option.label}). Run the analysis: get_analysis_job, then the pipeline`,
    });
  } catch (e) {
    warnings.push(`Accepted, but the handoff failed (${errorMessage(e)}); the coordinator sees it as stuck.`);
  }
  return result(req.id, quote, option, next, { warnings });
}

/** The accept link: resolve the token to its request, then the same acceptance as accept_quote. */
export async function acceptQuoteByToken(a: { token: string; optionId: string; actor?: string; evidence?: string | null }): Promise<AcceptResult> {
  const quote = await getQuoteByAcceptToken(a.token);
  if (!quote) throw new QuoteAcceptError("not_found", "Unknown quote link.");
  return acceptQuote({
    requestId: quote.request_id, optionId: a.optionId, actor: a.actor ?? LINK_ACTOR, evidence: a.evidence ?? null, token: a.token,
  });
}

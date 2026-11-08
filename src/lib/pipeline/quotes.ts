/** Pricing (spec §6): quote = data cost + analysis cost (real Naïve spend + estimate) + margin; auto-approved under the cap. */
import { PRICING } from "../config";
import type { AcquisitionPlan, Quote } from "../domain";
import { env } from "../env";
import { logDecision, logEvent, logIntervention } from "../events";
import { newId } from "../ids";
import { sessionCostUsd } from "../naive/spend";
import { errorMessage, json, num, query, queryOne, round2 } from "./db";
import { isPriceCleared } from "./gates";
import { handoff, isTerminal, requireRequest, setStatus } from "./requests";

export interface QuoteRow {
  id: string; request_id: string; data_cost_usd: string | number; analysis_cost_usd: string | number; margin_usd: string | number;
  price_usd: string | number; auto_approved: boolean; status: string; line_items: { label: string; amount_usd: number }[];
  payment_link: string | null; created_at: string; updated_at: string;
}

export async function getQuote(id: string): Promise<QuoteRow | null> {
  return queryOne<QuoteRow>("SELECT * FROM quotes WHERE id = $1", [id]);
}

export function quoteView(q: QuoteRow) {
  return {
    id: q.id, request_id: q.request_id, data_cost_usd: num(q.data_cost_usd), analysis_cost_usd: num(q.analysis_cost_usd),
    margin_usd: num(q.margin_usd), price_usd: num(q.price_usd), auto_approved: q.auto_approved, status: q.status,
    line_items: q.line_items, payment_link: q.payment_link,
  };
}

/** Real Naïve spend for the request's sessions so far, plus the estimated rest of the analysis. */
export async function estimateCosts(requestId: string) {
  const req = await requireRequest(requestId);
  const warnings: string[] = [];
  const sessions = await Promise.all(
    req.naive_session_ids.map(async (id) => {
      try {
        return { session_id: id, cost_usd: await sessionCostUsd(id) };
      } catch (e) {
        warnings.push(`spend for ${id} unavailable: ${errorMessage(e)}`);
        return { session_id: id, cost_usd: 0 };
      }
    }),
  );
  const spent = round2(sessions.reduce((s, x) => s + x.cost_usd, 0));
  const plan = req.acquisition_plan as AcquisitionPlan | null;
  const data = plan?.choice === "paid" ? plan.data_cost_usd : 0;
  return {
    request_id: req.id, data_cost_usd: data, spent_so_far_usd: spent, remaining_estimate_usd: PRICING.defaultAnalysisCostUsd,
    analysis_cost_usd: round2(spent + PRICING.defaultAnalysisCostUsd), sessions, warnings,
  };
}

/** Pure pricing formula, exported for tests and the dashboard. Whole-dollar price; margin absorbs the rounding. */
export function priceQuote(dataCostUsd: number, analysisCostUsd: number): Omit<Quote, "request_id"> {
  const cost = dataCostUsd + analysisCostUsd;
  let price = cost + Math.max(PRICING.marginFloorUsd, PRICING.marginMultiple * cost);
  if (dataCostUsd === 0) price = Math.max(price, PRICING.minReportUsd);
  price = Math.ceil(price);
  const autoApproved = price <= PRICING.autoApproveCapUsd;
  const lineItems = [
    ...(dataCostUsd > 0 ? [{ label: "Satellite data", amount_usd: round2(dataCostUsd) }] : []),
    { label: "Analysis and verified report", amount_usd: round2(price - dataCostUsd) },
  ];
  return {
    data_cost_usd: round2(dataCostUsd), analysis_cost_usd: round2(analysisCostUsd), margin_usd: round2(price - cost), price_usd: price,
    auto_approved: autoApproved,
    needs_approval_reason: autoApproved ? null : `Price $${price} is above the $${PRICING.autoApproveCapUsd} auto-approve cap.`,
    line_items: lineItems,
  };
}

export function paymentLink(requestId: string): string | null {
  const base = env("PAYMENT_LINK_URL");
  if (!base) return null;
  return `${base}${base.includes("?") ? "&" : "?"}client_reference_id=${encodeURIComponent(requestId)}`;
}

export async function createQuote(a: { requestId: string; dataCostUsd?: number; note?: string }, actor: string) {
  const req = await requireRequest(a.requestId);
  if (isTerminal(req)) throw new Error(`Request ${req.id} is ${req.status}.`);
  if (req.is_free_sample) throw new Error("Free samples are not quoted; hand straight to analytics.");
  if (!req.acquisition_plan) throw new Error("No acquisition plan yet; acquisition must save_acquisition_plan first.");

  const plan = req.acquisition_plan as AcquisitionPlan;
  const existing = req.quote_id ? await getQuote(req.quote_id) : null;
  if (existing && ["sent", "accepted"].includes(existing.status)) {
    return { quote: quoteView(existing), warnings: [`Quote ${existing.id} is already ${existing.status} to the customer; it can't be re-priced.`], next: nextStep(existing, plan) };
  }
  if (existing && a.dataCostUsd === undefined && ["approved", "needs_approval"].includes(existing.status)) {
    return { quote: quoteView(existing), warnings: ["Already quoted; returning the existing quote (pass data_cost_usd to re-price)."], next: nextStep(existing, plan) };
  }

  const costs = await estimateCosts(req.id);
  const data = a.dataCostUsd ?? costs.data_cost_usd;
  const q = priceQuote(data, costs.analysis_cost_usd);
  const id = newId("quote");
  const status = q.auto_approved ? "approved" : "needs_approval";
  await query(
    `INSERT INTO quotes (id, request_id, data_cost_usd, analysis_cost_usd, margin_usd, price_usd, auto_approved, status, line_items, payment_link)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, req.id, q.data_cost_usd, q.analysis_cost_usd, q.margin_usd, q.price_usd, q.auto_approved, status, json(q.line_items), paymentLink(req.id)],
  );
  await query("UPDATE requests SET quote_id = $2, price_usd = $3, updated_at = now() WHERE id = $1", [req.id, id, q.price_usd]);
  await logDecision({
    requestId: req.id, kind: "pricing", agent: actor, choice: `$${q.price_usd} (${q.auto_approved ? "auto-approved" : "needs founder approval"})`,
    reasoning: `data $${q.data_cost_usd} + analysis $${q.analysis_cost_usd} (Naïve spend $${costs.spent_so_far_usd} + estimate $${costs.remaining_estimate_usd}) + margin $${q.margin_usd}.${a.note ? ` ${a.note}` : ""}`,
  });
  await logEvent("quote.created", actor, { quote_id: id, price_usd: q.price_usd, auto_approved: q.auto_approved }, req.id);
  if (!q.auto_approved) await setStatus(req.id, "awaiting_approval", actor, q.needs_approval_reason ?? undefined);

  return { quote: { id, request_id: req.id, ...q, status }, warnings: costs.warnings, next: nextStep({ id, auto_approved: q.auto_approved, status }, plan) };
}

function nextStep(q: Pick<QuoteRow, "id" | "auto_approved" | "status">, plan: AcquisitionPlan) {
  if (q.status === "needs_approval") {
    return { to: null, stage: null, note: "Held for a founder in the dashboard. Add a note and stop; a founder's approval sends it to comms-customer." };
  }
  if (!isPriceCleared(q)) return { to: null, stage: null, note: "With comms-customer: work starts once the customer accepts the quote." };
  return plan.choice === "existing_index"
    ? { to: "interpreter", stage: "report", note: "Price cleared, and the Earth index already answers it: the interpreter writes the report (no pipeline run)." }
    : { to: "analytics", stage: "analysis", note: "Price cleared: start the analysis now; the price goes in the delivery email." };
}

async function requirePendingQuote(quoteId: string): Promise<QuoteRow> {
  const quote = await getQuote(quoteId);
  if (!quote) throw new Error(`Unknown quote ${quoteId}.`);
  if (quote.status !== "needs_approval") throw new Error(`Quote ${quoteId} is ${quote.status}, not waiting for a founder.`);
  return quote;
}

/** Dashboard action: a founder approves a quote above the cap, then Comms 2 sends it and waits for the customer. */
export async function approveQuote(quoteId: string, founder: string, reason?: string) {
  const quote = await requirePendingQuote(quoteId);
  await query("UPDATE quotes SET status = 'approved', updated_at = now() WHERE id = $1", [quoteId]);
  await logIntervention({ actor: founder, action: "approve_quote", reason: reason ?? `Approved $${num(quote.price_usd)} quote`, requestId: quote.request_id, refId: quoteId });
  await setStatus(quote.request_id, "pricing", `human:${founder}`, "Quote approved by a founder");
  return handoff({
    requestId: quote.request_id, from: `human:${founder}`, to: "comms-customer", stage: "quote",
    instructions:
      `A founder approved quote ${quoteId}. Send it to the customer with send_quote and wait for their reply. When they accept, hand off with ` +
      "quote_accepted=true to analytics (stage analysis), or to interpreter (stage report) if the plan reuses the Earth index",
  });
}

/** Dashboard action: a founder rejects a quote above the cap; Pricing looks for a cheaper plan or closes it out. */
export async function rejectQuote(quoteId: string, founder: string, reason: string) {
  const quote = await requirePendingQuote(quoteId);
  await query("UPDATE quotes SET status = 'declined', updated_at = now() WHERE id = $1", [quoteId]);
  await logIntervention({ actor: founder, action: "reject_quote", reason, requestId: quote.request_id, refId: quoteId });
  await setStatus(quote.request_id, "pricing", `human:${founder}`, `Quote ${quoteId} rejected by a founder: ${reason}`);
  return handoff({
    requestId: quote.request_id, from: `human:${founder}`, to: "pricing", stage: "pricing",
    instructions:
      `A founder rejected quote ${quoteId} ($${num(quote.price_usd)}); the reason is in the request's notes. Hand off to acquisition ` +
      "for a cheaper plan if one exists, else add a note and hand off to coordinator",
  });
}

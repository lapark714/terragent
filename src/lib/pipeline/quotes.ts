/**
 * Pricing v2 quotes (NOTES 2026-11-08). The investigation (planning + source comparison) is free; its output is a
 * quote of 1–3 options priced bottom-up by pricing-engine.ts. Quotes go out without founder review, and NOTHING
 * starts until the customer accepts an option (acceptance.ts: accept_quote, or the accept link).
 * The legacy columns (data/analysis/margin/price) mirror the recommended option, and the accepted one once accepted.
 */
import { PRICING } from "../config";
import { type AcquisitionPlan, type DataSpec, optionPriceLow, QuoteOption, type QuoteOptionId } from "../domain";
import { quoteAcceptUrl } from "../email/templates";
import { env } from "../env";
import { logDecision, logEvent, logIntervention } from "../events";
import { newId, newToken } from "../ids";
import { sessionCostUsd } from "../naive/spend";
import { errorMessage, json, num, query, queryOne, round2 } from "./db";
import {
  buildQuoteOptions, fmtPrice, isHighStakesQuestion, itemMode, priceMismatch, type QuoteContext, type QuoteOptionsResult, repriceOption,
} from "./pricing-engine";
import type { ProviderRow } from "./providers";
import { handoff, isTerminal, requireRequest, setStatus, type RequestRow } from "./requests";

export interface QuoteRow {
  id: string; request_id: string; data_cost_usd: string | number; analysis_cost_usd: string | number; margin_usd: string | number;
  price_usd: string | number; auto_approved: boolean; status: string; line_items: { label: string; amount_usd: number }[];
  payment_link: string | null; created_at: string; updated_at: string;
  // Pricing v2 (migration 080). Pre-v2 rows have options = [] and nulls.
  options: QuoteOption[]; recommended_option_id: string | null; accepted_option_id: string | null; accepted_at: string | null;
  accept_token: string | null; valid_until: string | null;
}

/** Quote statuses a customer can still accept ('approved' = priced and cleared to send; no founder review since v2). */
export const ACCEPTABLE_QUOTE_STATUSES = ["approved", "sent"] as const;

export async function getQuote(id: string): Promise<QuoteRow | null> {
  return queryOne<QuoteRow>("SELECT * FROM quotes WHERE id = $1", [id]);
}

const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
export async function getQuoteByAcceptToken(token: string): Promise<QuoteRow | null> {
  if (!TOKEN_RE.test(token)) return null;
  return queryOne<QuoteRow>("SELECT * FROM quotes WHERE accept_token = $1", [token]);
}

const iso = (v: string | Date | null | undefined) => (v ? new Date(v).toISOString() : null);

/** Past its valid_until (an expired quote can't be sent or accepted). */
export const isQuoteExpired = (q: Pick<QuoteRow, "valid_until">, now = new Date()) =>
  !!q.valid_until && new Date(q.valid_until).getTime() < now.getTime();

/** Agent / dashboard view. The accept token stays server-side (it is the customer's key). */
export function quoteView(q: QuoteRow) {
  return {
    id: q.id, request_id: q.request_id, data_cost_usd: num(q.data_cost_usd), analysis_cost_usd: num(q.analysis_cost_usd),
    margin_usd: num(q.margin_usd), price_usd: num(q.price_usd), auto_approved: q.auto_approved, status: q.status,
    line_items: q.line_items, payment_link: q.payment_link,
    options: q.options ?? [], recommended_option_id: q.recommended_option_id, accepted_option_id: q.accepted_option_id,
    accepted_at: iso(q.accepted_at), valid_until: iso(q.valid_until),
  };
}

/**
 * Everything the quote email needs (send_quote → renderQuote): the options, the recommendation, the validity and the
 * accept link, plus the legacy single price for a quote from before options. The customer-facing views of a quote
 * (status JSON, quote page) are src/lib/dashboard/public.ts publicQuote; the accept URL is templates.quoteAcceptUrl.
 */
export function quoteForEmail(q: QuoteRow) {
  return {
    price_usd: num(q.price_usd) ?? 0, line_items: q.line_items, auto_approved: q.auto_approved,
    options: q.options ?? [], recommended_option_id: q.recommended_option_id, valid_until: iso(q.valid_until),
    accept_url: q.accept_token ? quoteAcceptUrl(q.accept_token) : null,
  };
}

/** Real Naïve spend for the request's sessions so far, plus the estimated rest of the analysis (estimate_costs). */
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
    note: "The investigation is free to the customer; quotes are priced per option by price_options (this is our cost view only).",
  };
}

export function paymentLink(requestId: string): string | null {
  const base = env("PAYMENT_LINK_URL");
  if (!base) return null;
  return `${base}${base.includes("?") ? "&" : "?"}client_reference_id=${encodeURIComponent(requestId)}`;
}

/** Legacy line items for an option: data (low end when a range) + analysis and report; they sum to the option's low price. */
export function optionLineItems(o: QuoteOption): { label: string; amount_usd: number }[] {
  const data = round2(o.data.reduce((s, d) => s + (d.data_cost_usd ?? d.data_cost_range_usd?.[0] ?? 0), 0));
  const estimate = o.data.some((d) => d.needs_supplier_quote);
  return [
    ...(data > 0 ? [{ label: estimate ? "Satellite data (estimate, from)" : "Satellite data", amount_usd: data }] : []),
    { label: "Analysis and verified report", amount_usd: round2(optionPriceLow(o) - data) },
  ];
}

/** Mirror columns for an option: data + analysis + margin (incl. risk buffer and rounding) = its (low) price. */
export function mirrorColumns(o: QuoteOption) {
  const price = optionPriceLow(o);
  const items = optionLineItems(o);
  const data = items.length > 1 ? items[0].amount_usd : 0;
  return {
    data_cost_usd: data, analysis_cost_usd: round2(o.analysis_cost_usd), margin_usd: round2(Math.max(0, price - data - o.analysis_cost_usd)),
    price_usd: price, line_items: items,
  };
}

// ---------------------------------------------------------------------------
// price_options: the server's options for a request (no DB write)
// ---------------------------------------------------------------------------

interface Priceable { req: RequestRow; spec: DataSpec; plan: AcquisitionPlan; registry: ProviderRow[]; ctx: QuoteContext; epochsNote: string | null }

/**
 * The dates a request is priced for: the spec's own (2 with a before window, else 1), or the agent's `epochs` for a
 * longer series, never fewer than the spec needs and never more than the pipeline analyses (PRICING.maxAnalysisEpochs),
 * so a quote never sells dates nobody computes. price_options and create_quote must use the same value.
 */
export function pricedEpochs(spec: Pick<DataSpec, "before">, requested?: number): { epochs: number; note: string | null } {
  const base = spec.before ? 2 : 1;
  const max = Math.max(base, PRICING.maxAnalysisEpochs);
  const want = requested === undefined || !Number.isFinite(requested) ? base : Math.max(1, Math.round(requested));
  const epochs = Math.min(Math.max(want, base), max);
  if (want > max) {
    return {
      epochs,
      note: `Asked for ${want} dates, but the analysis compares ${max} dates (before and after) today, so every option is priced and ` +
        `delivered for ${max}. Say that in each option's answers (e.g. "compares the first and last clear dates"); never promise the full series.`,
    };
  }
  if (want < base) return { epochs, note: `The data spec has a before and an after window, so options are priced for ${base} dates, not ${want}.` };
  return { epochs, note: null };
}

async function priceable(requestId: string, opts: { epochs?: number } = {}): Promise<Priceable> {
  const req = await requireRequest(requestId);
  if (isTerminal(req)) throw new Error(`Request ${req.id} is ${req.status}.`);
  if (req.is_free_sample) throw new Error("Free samples are not quoted (they are our marketing cost); hand straight to analytics.");
  if (!req.data_spec) throw new Error("No data spec yet; the planner must save_data_spec first.");
  if (!req.acquisition_plan) throw new Error("No acquisition plan yet; acquisition must save_acquisition_plan first.");
  const [registry, quotes] = await Promise.all([
    query<ProviderRow>("SELECT * FROM providers WHERE active"),
    query<{ provider_id: string; supplier_quote_usd: string | number }>(
      "SELECT provider_id, supplier_quote_usd FROM orders WHERE request_id = $1 AND supplier_quote_usd IS NOT NULL ORDER BY updated_at",
      [req.id],
    ),
  ]);
  const supplier_quotes: Record<string, number> = {};
  for (const q of quotes) if (num(q.supplier_quote_usd)) supplier_quotes[q.provider_id] = num(q.supplier_quote_usd)!;
  const spec = req.data_spec as DataSpec;
  const { epochs, note } = pricedEpochs(spec, opts.epochs);
  return {
    req, spec, plan: req.acquisition_plan as AcquisitionPlan, registry, epochsNote: note,
    ctx: { today: new Date(), epochs, high_stakes: isHighStakesQuestion(req.question), supplier_quotes },
  };
}

export async function priceOptions(requestId: string, opts: { epochs?: number } = {}) {
  const { req, spec, plan, registry, ctx, epochsNote } = await priceable(requestId, opts);
  const result: QuoteOptionsResult = buildQuoteOptions(plan, spec, registry, ctx);
  const sameEpochs = opts.epochs !== undefined ? ` Pass epochs ${opts.epochs} to create_quote too (the server re-prices with it).` : "";
  return {
    request_id: req.id, ...result, epochs: ctx.epochs!, notes: epochsNote ? [epochsNote, ...result.notes] : result.notes,
    next: result.options.length
      ? "Adjust labels, answers and notes if they read badly (never the prices or data items), then create_quote with these options and " +
        `recommended_option_id.${sameEpochs} Never describe any option as a free answer: the cheapest still costs its price.`
      : "No option could be priced: add_note with why and hand back to acquisition (stage acquisition) for another source.",
  };
}

// ---------------------------------------------------------------------------
// create_quote
// ---------------------------------------------------------------------------

export interface CreateQuoteInput {
  requestId: string;
  /** 1–3 options (normally price_options' output with adjusted words). Left out → the server's own options. */
  options?: QuoteOption[];
  /** Required when `options` drop the server's recommended option; otherwise defaults to it. */
  recommendedOptionId?: QuoteOptionId;
  /** The same `epochs` the agent passed to price_options (dates the question needs); default the data spec's. */
  epochs?: number;
  notes?: string;
  /** @deprecated alias of notes */
  note?: string;
}

/** create_quote refused the agent's prices: here are the server's, to send back unchanged (words may change). */
export interface CreateQuoteRejection {
  error: string; server_options: QuoteOption[]; recommended_option_id: string | null; mismatches: { option_id: string; reason: string }[];
}
export interface CreateQuoteSaved {
  quote: ReturnType<typeof quoteView>; recommended_option_id: string; valid_until: string | null; warnings: string[];
  handoff: { session_id?: string; card_id?: string; deduped?: true } | null; next: string;
}
export type CreateQuoteResult = CreateQuoteSaved | CreateQuoteRejection;

/** Key-order-independent JSON (jsonb reorders object keys), so a stored quote compares equal to a freshly priced one. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}
const fingerprint = (options: QuoteOption[], rec: string | null) => stableJson({ options, rec });

/**
 * What an option buys, item by item: provider, free / archive / tasking, and dates. create_quote accepts an agent's
 * option only when these match one of the server's own options exactly, so quantities can't be edited to move a price.
 */
function itemKeys(o: Pick<QuoteOption, "data">, registry: readonly ProviderRow[]): string[] {
  return o.data.map((d) => {
    const p = registry.find((r) => r.id === d.provider_id);
    return `${d.provider_id}|${p ? itemMode(p, d.product) : "unknown"}|${Math.max(1, Math.round(d.epochs))}`;
  }).sort();
}
const sameKeys = (a: string[], b: string[]) => a.length === b.length && a.every((k, i) => k === b[i]);

/** Why an agent's option doesn't match the server's options (data items, area, kind), or null when it does. */
function quantityMismatch(
  agent: QuoteOption, repriced: QuoteOption, server: QuoteOption[], spec: DataSpec, registry: readonly ProviderRow[],
): string | null {
  const keys = itemKeys(agent, registry);
  const match = server.find((s) => sameKeys(itemKeys(s, registry), keys));
  if (!match) {
    return agent.data.length
      ? "its data items (provider, archive / tasking / free, dates) don't match any option price_options offers"
      : "it has no data items, but every option price_options offers for this request needs data";
  }
  const short = agent.data.find((d) => d.area_km2 < spec.area_km2 * 0.95);
  if (short) return `it covers ${round2(short.area_km2)} km² of the ${round2(spec.area_km2)} km² area of interest`;
  if (agent.kind !== repriced.kind) return `it is labelled ${agent.kind} but its data makes it ${repriced.kind}`;
  return null;
}
/**
 * Save the quote: re-price every option on the server (an agent's price more than 5% off is refused with the server's
 * numbers), set a 7-day validity and an accept token, mark the request quoted and hand it to comms-customer to send.
 * A new quote supersedes an earlier unaccepted one (the customer asked for changes); an accepted quote is final.
 */
export async function createQuote(a: CreateQuoteInput, actor: string): Promise<CreateQuoteResult> {
  const { req, spec, plan, registry, ctx, epochsNote } = await priceable(a.requestId, { epochs: a.epochs });
  const existing = req.quote_id ? await getQuote(req.quote_id) : null;
  if (existing && (existing.status === "accepted" || existing.accepted_option_id)) {
    throw new Error(`Quote ${existing.id} was already accepted (option ${existing.accepted_option_id ?? "?"}); it can't be re-priced.`);
  }

  const warnings: string[] = [];
  let options: QuoteOption[];
  let recommended: string | null;
  const server = buildQuoteOptions(plan, spec, registry, ctx);
  if (a.options?.length) {
    const parsed = a.options.map((o) => QuoteOption.parse(o));
    const ids = parsed.map((o) => o.option_id);
    if (new Set(ids).size !== ids.length) throw new Error("Option ids must be unique (A, B, C).");
    if (parsed.length > 3) throw new Error("A quote has at most 3 options.");
    options = parsed.map((o) => repriceOption(o, plan, spec, registry, ctx));
    // Quantities first (agents can't move a price through area, dates or products), then the prices themselves.
    const quantity = parsed
      .map((o, i) => ({ option_id: o.option_id, reason: quantityMismatch(o, options[i], server.options, spec, registry) }))
      .filter((m): m is { option_id: QuoteOptionId; reason: string } => m.reason !== null);
    if (quantity.length) {
      return {
        error: `Data items come from the server, not the agent: ${quantity.map((m) => `option ${m.option_id}: ${m.reason}`).join("; ")}. ` +
          `Call create_quote again with server_options (you may drop an option and change labels, answers and notes only)` +
          `${a.epochs === undefined ? "; if you priced with epochs, pass the same epochs" : ""}.`,
        server_options: server.options, recommended_option_id: server.recommended_option_id, mismatches: quantity,
      } satisfies CreateQuoteRejection;
    }
    const mismatches = parsed
      .map((o, i) => ({ option_id: o.option_id, reason: priceMismatch(o, options[i]) }))
      .filter((m): m is { option_id: QuoteOptionId; reason: string } => m.reason !== null);
    if (mismatches.length) {
      return {
        error: `Prices come from the server, not the agent: ${mismatches.map((m) => `option ${m.option_id}: ${m.reason}`).join("; ")}. ` +
          "Call create_quote again with server_options (you may change labels, answers and notes only).",
        server_options: options, recommended_option_id: a.recommendedOptionId ?? null, mismatches,
      } satisfies CreateQuoteRejection;
    }
    if (a.recommendedOptionId) {
      recommended = a.recommendedOptionId;
    } else {
      // The server's recommendation is the cheapest option that ANSWERS (not just the cheapest): find it among the agent's.
      const serverRec = server.options.find((s) => s.option_id === server.recommended_option_id);
      const recKeys = serverRec ? itemKeys(serverRec, registry) : null;
      const same = recKeys ? options.find((o) => sameKeys(itemKeys(o, registry), recKeys)) : undefined;
      if (!same) {
        throw new Error(
          "recommended_option_id is required: price_options' recommended option is not among these options. Recommend the cheapest option that answers the question.",
        );
      }
      recommended = same.option_id;
    }
  } else {
    options = server.options;
    recommended = a.recommendedOptionId ?? server.recommended_option_id;
    warnings.push(...server.notes);
  }
  if (epochsNote) warnings.push(epochsNote);
  if (!options.length) throw new Error(`No option could be priced. ${server.notes.join(" ")}`.trim());
  const rec = options.find((o) => o.option_id === recommended);
  if (!rec) throw new Error(`recommended_option_id ${recommended} is not one of the options (${options.map((o) => o.option_id).join(", ")}).`);

  // A retry with the same options returns the quote already made instead of sending the customer a second one.
  // An expired quote can't be sent or accepted, so it falls through and is replaced.
  if (existing && (existing.status === "approved" || existing.status === "sent") && !isQuoteExpired(existing) &&
      fingerprint(existing.options ?? [], existing.recommended_option_id) === fingerprint(options, rec.option_id)) {
    return {
      quote: quoteView(existing), recommended_option_id: rec.option_id, valid_until: iso(existing.valid_until), handoff: null,
      warnings: [...warnings, `Same options as quote ${existing.id} (${existing.status}); returned it unchanged.`],
      next: "Nothing more to do: comms-customer has this quote. End your turn.",
    };
  }
  if (existing && !["declined", "expired", "superseded"].includes(existing.status)) {
    await query("UPDATE quotes SET status = 'superseded', updated_at = now() WHERE id = $1 AND accepted_option_id IS NULL", [existing.id]);
    await logEvent("quote.superseded", actor, { quote_id: existing.id }, req.id);
  }

  const id = newId("quote");
  const token = newToken();
  const m = mirrorColumns(rec);
  const validUntil = new Date(Date.now() + PRICING.quoteValidDays * 86_400_000);
  await query(
    `INSERT INTO quotes (id, request_id, data_cost_usd, analysis_cost_usd, margin_usd, price_usd, auto_approved, status, line_items, payment_link,
       options, recommended_option_id, accept_token, valid_until)
     VALUES ($1,$2,$3,$4,$5,$6,false,'approved',$7,$8,$9,$10,$11,$12)`,
    [id, req.id, m.data_cost_usd, m.analysis_cost_usd, m.margin_usd, m.price_usd, json(m.line_items), paymentLink(req.id),
      json(options), rec.option_id, token, validUntil.toISOString()],
  );
  await query("UPDATE requests SET quote_id = $2, price_usd = $3, updated_at = now() WHERE id = $1", [req.id, id, m.price_usd]);
  const notes = (a.notes ?? a.note ?? "").trim();
  await logDecision({
    requestId: req.id, kind: "pricing", agent: actor,
    choice: `${options.length} option${options.length > 1 ? "s" : ""}; recommended ${rec.option_id} at ${fmtPrice(rec)}`,
    reasoning: (options.map((o) => {
      const data = o.data.reduce((s, d) => s + (d.data_cost_usd ?? d.data_cost_range_usd?.[1] ?? 0), 0);
      return `${o.option_id} ${o.kind}: data $${round2(data)} + analysis $${o.analysis_cost_usd} + risk $${o.risk_buffer_usd} + margin $${o.margin_usd} = ${fmtPrice(o)}`;
    }).join("; ") + `. Server-priced (pricing v2).${notes ? ` ${notes}` : ""}`).slice(0, 4000),
    alternatives: options.filter((o) => o.option_id !== rec.option_id).map((o) => ({
      option: `${o.option_id}: ${o.label}`, cost_usd: optionPriceLow(o), why_not: `offered as an alternative at ${fmtPrice(o)}; the customer chooses`,
    })),
  });
  await logEvent("quote.created", actor, {
    quote_id: id, options: options.length, recommended_option_id: rec.option_id, price_usd: rec.price_usd, price_range_usd: rec.price_range_usd,
    auto_approved: false,
  }, req.id);
  await setStatus(req.id, "quoted", actor, `Quote ${id}: ${options.length} option(s), recommended ${rec.option_id} at ${fmtPrice(rec)}; waiting for the customer`);

  let handed: CreateQuoteSaved["handoff"] = null;
  const contact = !!(req.customer_email || req.thread_id);
  if (contact) {
    try {
      handed = await handoff({
        requestId: req.id, from: actor, to: "comms-customer", stage: "quote",
        instructions:
          `Quote ${id} is ready: ${options.length} option(s), recommended ${rec.option_id} (${fmtPrice(rec)}). Send it with send_quote. ` +
          "When the customer replies, call accept_quote with the option they name (a plain yes means the recommended one). If they decline " +
          "or ask for changes, add_note with what they want and hand back to pricing (stage pricing). Never start work without an accepted option",
      });
    } catch (e) {
      warnings.push(`Handoff to comms-customer failed: ${errorMessage(e)}`);
    }
  } else {
    warnings.push(
      "No email or thread on this request (API): the client sees the options and accept_url in GET /api/answer/{id} and accepts with " +
        "POST /api/quotes/accept.",
    );
  }

  const quote = (await getQuote(id))!;
  return {
    quote: quoteView(quote), recommended_option_id: rec.option_id, valid_until: validUntil.toISOString(), warnings, handoff: handed,
    next: handed
      ? "Done: comms-customer sends the quote and waits for the customer's choice. Don't hand off again; end your turn."
      : contact
        ? "Quote saved but the handoff failed (see warnings): hand off to comms-customer (stage quote) to send it."
        : "Quote saved; the API client accepts it from its status response (GET /api/answer/{id}). End your turn.",
  };
}

// ---------------------------------------------------------------------------
// Legacy founder review (pre-v2 'needs_approval' quotes only; create_quote no longer holds quotes for a founder)
// ---------------------------------------------------------------------------

async function requirePendingQuote(quoteId: string): Promise<QuoteRow> {
  const quote = await getQuote(quoteId);
  if (!quote) throw new Error(`Unknown quote ${quoteId}.`);
  if (quote.status !== "needs_approval") throw new Error(`Quote ${quoteId} is ${quote.status}, not waiting for a founder.`);
  return quote;
}

/** Dashboard action on a pre-v2 held quote: a founder releases it; Comms 2 sends it and waits for the customer to accept. */
export async function approveQuote(quoteId: string, founder: string, reason?: string) {
  const quote = await requirePendingQuote(quoteId);
  await query("UPDATE quotes SET status = 'approved', updated_at = now() WHERE id = $1", [quoteId]);
  await logIntervention({ actor: founder, action: "approve_quote", reason: reason ?? `Approved $${num(quote.price_usd)} quote`, requestId: quote.request_id, refId: quoteId });
  await setStatus(quote.request_id, "pricing", `human:${founder}`, "Quote approved by a founder");
  return handoff({
    requestId: quote.request_id, from: `human:${founder}`, to: "comms-customer", stage: "quote",
    instructions:
      `A founder released quote ${quoteId}. Send it to the customer with send_quote and wait for their reply. When they accept, call ` +
      "accept_quote; work starts only on an accepted option",
  });
}

/** Dashboard action on a pre-v2 held quote: a founder rejects it; Pricing re-quotes or closes it out. */
export async function rejectQuote(quoteId: string, founder: string, reason: string) {
  const quote = await requirePendingQuote(quoteId);
  await query("UPDATE quotes SET status = 'declined', updated_at = now() WHERE id = $1", [quoteId]);
  await logIntervention({ actor: founder, action: "reject_quote", reason, requestId: quote.request_id, refId: quoteId });
  await setStatus(quote.request_id, "pricing", `human:${founder}`, `Quote ${quoteId} rejected by a founder: ${reason}`);
  return handoff({
    requestId: quote.request_id, from: `human:${founder}`, to: "pricing", stage: "pricing",
    instructions:
      `A founder rejected quote ${quoteId} ($${num(quote.price_usd)}); the reason is in the request's notes. Re-quote with price_options ` +
      "and create_quote, or add a note and hand off to coordinator",
  });
}

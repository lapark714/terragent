# Pricing v2: what changed for the UI (Aiden's public pages, Aarush's dashboard)

Decision (Laurence, 2026-11-08, NOTES): no free answers. The free part is the investigation (planning and comparing
sources), and its output is a quote of **1–3 options**. Nothing else runs until the customer **accepts one option**,
by replying to the quote email or through the accept link. Quotes go out automatically, so founders no longer review
large quotes. The only human step left is buying paid data, which a founder does by hand. Free samples for outbound
prospects are the one exception (no quote).

This note covers the new fields and endpoints. Nothing in your files was changed.

## 1. Status JSON: `GET /api/requests/{id}/status` gets `quote`

`RequestProgress` in `src/lib/dashboard/public.ts` now has `quote: PublicQuote | null` (snake_case inside,
following the pricing contract). It is `null` until the request has a quote with options. Older single-price quotes
also give `null`. It goes through the same 8 s cache as the rest of the status JSON. An acceptance through the link
clears that cache, so the next poll shows it.

```ts
quote: {
  id: string;                         // "qte_…"
  status: string;                     // the quote row's status, for information only
  options: {
    option_id: "A" | "B" | "C";
    label: string;                    // e.g. "Sharp archive image"
    answers: string;                  // what this option can answer
    kind: "free_data" | "archive" | "tasking" | "mixed";
    resolution_m: number | null;      // finest resolution across its data, metres
    data_types: string[];             // "optical", "radar", …
    epochs: number | null;            // most dates any of its data covers
    price_usd: number | null;         // exactly one of these two is set:
    price_range_usd: [number, number] | null; // a range while a supplier price is unconfirmed
    needs_supplier_quote: boolean;
    delivery_time: string | null;     // free text from pricing, e.g. "1–2 days"
    confidence: "high" | "medium" | "low";
    recommended: boolean;
  }[];
  recommended_option_id: "A" | "B" | "C" | null;
  accepted_option_id: "A" | "B" | "C" | null;
  accepted_at: string | null;         // ISO
  valid_until: string | null;         // ISO (7 days after the quote)
  closed_reason: "accepted" | "expired" | "superseded" | "closed" | null;  // null while it can be accepted
  accept_url: string | null;          // https://…/quote/<token>; null once it can't be accepted
} | null
```

The customer never sees costs, margin, risk buffer, unit prices, supplier ids or the pricing notes. These are
dropped server-side.

## 1b. API clients: `GET /api/answer/{id}` gets the options and an accept call

An API request (`POST /api/answer`) usually has no email, so its quote reaches the client only through the
`status_url` it was given (`/api/answer/{id}`). Since the review fix, that response's `quote` keeps the legacy fields
(`id`, `price_usd` = the recommended option's price, `status`, `auto_approved` = always false, `line_items`,
`payment_link`) and adds the public quote fields from §1: `options`, `recommended_option_id`, `accepted_option_id`,
`accepted_at`, `valid_until`, `closed_reason`, `accept_url`, plus a ready-to-send call while the quote is open:

```json
"accept": { "method": "POST", "url": "https://…/api/quotes/accept", "body": { "token": "…", "option_id": "A" } }
```

`body.option_id` is the recommended option; the client may send any other option id instead. A pre-v2 quote shows
`options: []` and `accept: null`. Accepting starts the analysis (free-data option) or the paid-data purchase, and the
same response then shows `accepted_option_id` and the request's next status. Tested in
`src/app/api/answer/answer-quote.test.ts`.

## 2. Accepting: `POST /api/quotes/accept`

Body `{ token, option_id }`, as JSON or as a classic form post. `token` is the last path segment of `accept_url`.

| Result | Status | Body |
|---|---|---|
| accepted | 200 | `{ request_id, status, accepted_option_id, already_accepted: false }` |
| same option again (double click, retry) | 200 | `{ …, already_accepted: true }` |
| another option after acceptance | 409 | `{ error: "already_accepted", accepted_option_id, message }` |
| option not in the quote | 400 | `{ error: "unknown_option", message }` |
| expired / replaced by a newer quote / request closed / quote not open | 410 / 409 / 409 / 409 | `{ error: "expired" \| "superseded" \| "closed" \| "not_acceptable", message }` |
| malformed body | 400 | `{ error: "invalid_request", message }` |
| unknown token | 404 | `{ error: "not_found", message }` |
| too many posts from one IP (20/min) | 429 | `{ error: "rate_limited", retry_after_s, message }` + `Retry-After` |
| database trouble | 503 | `{ error: "db_suspended" \| "unavailable", message }` |

Every error has a `message` in the customer's words, ready to show as is. The same texts are exported as
`QUOTE_ACCEPT_ERRORS` from `src/lib/dashboard/public.ts`. A form post with a well-formed
token answers with a `303` to `/quote/<token>`, plus `?error=<code>` when it failed. There is no GET. Keep it that way: link scanners
prefetch GETs.

## 3. The quote page `/quote/[token]` (new, plain, yours to restyle)

`src/app/quote/[token]/page.tsx` is a deliberately plain, server-rendered page. It shows the question, one card per
option (label, what it answers, data and detail, delivery, price or range, the recommended mark) and a plain
`<form method="post" action="/api/quotes/accept">` per option with hidden `token` and `option_id` fields. It also
shows the accepted, expired, superseded and closed states and the `?error=` message. GET never changes anything.
**Aiden: restyle it freely.** Keep the two hidden fields, the POST target, no state change on GET, and
`robots: noindex`.

## 4. Suggested Accept button on `/request/[id]` (Aiden)

When `progress.quote?.accept_url` is set (usually while `status` is `quoted`), show a "Your quote" block in place
of the "waiting on you" text for `quoted`:

- one card per `quote.options`, the `recommended` one first or highlighted. Show the price as `$29`, or `$180–$260`
  plus "estimate: the supplier's exact price isn't confirmed yet" when `price_range_usd` is set.
- one button per option, "Accept option B · $180–$260". Simplest: a plain form post exactly like the quote page.
  With JS: `fetch("/api/quotes/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, option_id }) })`
  with `token = new URL(quote.accept_url).pathname.split("/").pop()`, then show `message` on error. A 200 with
  `already_accepted` also counts as success.
- small print: "Prefer email? Reply 'yes' to the quote email for option {recommended_option_id}, or name A/B/C."
  Also: "We buy paid imagery only after you accept." Validity: `valid_until`.
- when `quote.accepted_option_id` is set: "You chose option B on {accepted_at}" and no buttons. The status moves on
  to `analyzing`, or to `awaiting_approval` for paid data (a founder buys it by hand, then the analysis starts).
- when `closed_reason` is `expired` or `superseded`, say so and point to the email thread.

`src/components/request/progress.ts` already counts `quoted` as waiting on the person. For a paid option,
`awaiting_approval` now means "a founder is buying the data", not "a founder is checking the price".

## 5. Dashboard (Aarush)

New columns on `quotes` (migration `db/migrations/080_pricing_v2.sql`): `options jsonb` (QuoteOption[], full
internal costs included: `data[]`, `analysis_cost_usd`, `risk_buffer_usd`, `margin_usd`, `notes`),
`recommended_option_id`, `accepted_option_id`, `accepted_at`, `accept_token`, `valid_until`. `data_cost_usd`,
`analysis_cost_usd`, `margin_usd` and `price_usd` still mirror the recommended option (the accepted one once
accepted; the low end for a range), so current panels keep working.

Changes in meaning:

- **No more "quotes above the cap" approvals.** Nothing waits on a founder for a price. `PendingQuote` /
  `Approvals.quotes` will stay empty, so the Approve/Reject quote UI can go or be hidden when empty. Held **paid data
  orders** (`Approvals.orders`) are still the one founder action.
- `auto_approved` is always false for new quotes. Don't show "auto-approved".
- Worth showing on a request or the board, if the lead adds fields to `src/lib/dashboard/types.ts` (additive): the
  option count, recommended option and its price or range, `valid_until`, "waiting on customer since" (quote
  created), and after acceptance the accepted option, `accepted_at` and whether it is waiting on a data purchase.
- Committed revenue is recorded when an option is accepted (`revenue.kind = 'committed'`, the option's price or the
  low end of its range).
- Never show `accept_token` on the dashboard: the dashboard is public, and the token accepts the quote.

Paid data orders after the review fixes:

- **An order can be approved only for an option the customer accepted.** `prepare_paid_order`, `place_paid_order`
  and the dashboard's order approve all refuse a request whose quote has no accepted option that buys from that
  provider. On the dashboard that is a `409 { error: "conflict", message }`, so show `message` as is. Rejecting is
  always allowed.
- **New action: Mark delivered.** After a founder has bought the data by hand and it arrived:
  `POST /api/admin/order` with `{ order_id, decision: "delivered", actor, reason, file_ids?, note? }`. `file_ids` are
  Naïve `fil_…` ids of the purchased imagery (max 20), and `note` is a few words on where the data is, with no
  personal data. It logs one intervention, marks the order delivered and, once no other paid order of the request
  waits, hands the request to analytics. It answers `{ done }` with one of "Marked delivered. The analysis has
  started.", "Marked delivered. The analysis starts once order(s) … arrive too." or a warning. It returns 409 when the
  order is already delivered or the option wasn't accepted. Without this button nothing starts an accepted paid
  option, so it is the one new control the panel needs.
- `Approvals.orders` lists only `awaiting_approval` orders. Mark delivered also works on a held order and records the
  approval at the same time, so the simplest UI is a **Mark delivered** button next to Approve / Reject on each held
  order. To also list approved orders that haven't arrived yet, `src/lib/dashboard/approvals.ts` needs
  `status IN ('awaiting_approval', 'approved', 'placed')` and a `status` field on `PendingOrder` (an additive change to
  `types.ts`). Not done here, because those files are yours.
- Copy to change in `ApprovalsPanel.tsx`: "No quotes are held. Quotes at or under the auto-approve cap go out on their
  own." Suggested: "No quotes wait on a founder. Quotes go to the customer, and work starts only when they accept an
  option." The comment at the top of `src/lib/dashboard/approvals.ts` and on `Approvals.quotes` in `types.ts` still
  says "quotes above the cap". Only pre-v2 quotes can be held now.
- Monitoring is a paid subscription. `create_monitor` needs the customer's words accepting $49 per site per month
  (decision kind `monitoring`, event `monitor.accepted`). The only free monitor is the system's own on a verified
  free sample.

## 6. Email

The quote email (`renderQuote` in `src/lib/email/templates.ts`) lists each option on one line (label, what it
answers, data and detail, delivery, price or range) and marks the recommended one. It explains how to accept (reply
"yes" for the recommended option, or name A/B/C, or use the accept link), when the quote expires, and that paid
imagery is bought only after acceptance. A reply to an open quote reaches comms-customer with a note that it may be
an acceptance (`src/lib/email/inbound.ts`). The reply's own words stay in the thread, never in the agent brief.

## 7. Copy that is now wrong on the public pages (Aiden)

These are your files, so they were not edited. The code no longer does what they say.

- `src/app/page.tsx`, API section: "A quote up to ${PRICING.autoApproveCapUsd} goes ahead at once and shows in the status
  response; a higher one is emailed to you to accept." and "without one, a quote above
  ${PRICING.autoApproveCapUsd} can't reach you." Suggested: "Each answer is quoted like any report, from
  ${PRICING.minReportUsd} when free imagery answers it. The status response carries the quote's options and a ready
  accept call, and nothing runs until you accept one." and "Add an `email` to get the quote and the answer there too."
- `src/app/terms/page.tsx`, "Prices and payment": "up to ${PRICING.autoApproveCapUsd} the price comes with the report.
  Anything above that, or anything that needs paid imagery, is quoted to you before the work starts." Suggested:
  "Every request is quoted before the work starts. The quote offers one to three options, and nothing beyond our free
  look at the question runs until you accept one. Paid imagery is bought only after you accept an option that needs
  it." The sentences after it (a founder approves each data purchase, free samples) are still right.
- `PRICING.autoApproveCapUsd` is display-only now, so these pages shouldn't use it for any promise.

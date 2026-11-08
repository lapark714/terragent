# Email stack change: cold outbound on a Naïve identity inbox, AgentMail for intake and replies

Status: DESIGN, 2026-11-08 ~01:50 UTC (Sat 2026-11-07 evening PT). No code was edited. Nothing was created, sent or
bought. Founder request (NOTES "Email stack change"): AgentMail can't do cold outreach, so cold email goes out from a
Naïve agent's identity email, and AgentMail keeps intake (people who write to us first) and replies.

Inputs: [naive-email.md](naive-email.md) (platform facts, live GETs), [cold-email-compliance.md](cold-email-compliance.md)
(law, deliverability, warm-up), [ARCHITECTURE.md](../ARCHITECTURE.md) §4-5, `src/lib/email/send.ts`,
`src/lib/outbound/{channel,outreach}.ts`, `src/lib/email/{inbound,optout,templates,threads}.ts`,
`src/lib/pipeline/deliver.ts`, `src/lib/mcp/catalog.ts`, `naive/agents/{comms-outreach,tools}.ts`, SDK
`@usenaive-sdk/managed-agents@0.12.3` d.ts (`EmailSend` 3409, `emails.*` 8203-8290, `ClientConfig.idempotencyKey` 21-28).

Live re-check, GET only, 2026-11-08 01:46 UTC: **unchanged since the research docs.** 62 sends to 62 distinct addresses
(00:59:40 to 01:29:55 UTC), 1 inbound message (an auto-reply, guard `auto_reply`, unread, didn't wake anyone). The inbox
`outreach@terragent-qqhrnj.usenaive.ai` still has `wake: true`. Agent `terragent-outreach` still has `email.read`,
`email.send` and `email.inboxes` enabled at `allow`, with no MCP servers.

---

## 0. Recommendation in one screen

| Traffic | System and address | Who decides | Who sends | Gates |
|---|---|---|---|---|
| **Cold first touch** (and follow-ups that carry new information) | Naïve identity "Terragent", inbox `outreach@terragent-qqhrnj.usenaive.ai` (free system domain) | **comms-outreach** (Naïve agent) calls `terragent.send_outreach_email` | **Our MCP gateway** queues it, then sends with `POST /v1/identities/{idn}/emails/{eml}/send` | Every `send.ts` gate plus new Naïve gates: written-OK flag, armed flag, warm-up ramp, pacing, send window, MX check, jurisdiction. The send is queued, not immediate (§7). |
| Warm email (`email_warm`: they wrote to us, or a founder marked them warm) | AgentMail `terragent-outreach@agentmail.to` | comms-outreach | gateway → AgentMail | unchanged |
| Intake out of the blue | AgentMail hello@ / data@ → webhook | comms-customer / comms-suppliers | gateway → AgentMail | unchanged |
| **Replies to cold mail** | Arrive at the **Naïve inbox** (Reply-To can't be set, §5.1) | Our **server polls** the inbox (wake off) and routes each message into the existing inbound flow | comms-customer answers from **hello@** (AgentMail), which starts a new thread | Existing inbound guards, plus the opt-out, complaint and bounce rules in §6 |
| Contact forms | Business website, Naïve browser | comms-outreach | the agent | unchanged. Stays the cold default while Naïve email isn't approved or the recipient isn't eligible. |
| `email_direct` (cold email through AgentMail) | none | none | none | **Retired.** The gate refuses it permanently. |

**Blockers before any further cold send.** Building can start now. Sending waits on all of these:

1. **B1. Naïve's written OK.** Naïve's own Terms don't forbid cold email in so many words: §4.2 bans "spam" without
   defining it. But §5.2 makes third-party terms our responsibility, and the email layer under Naïve appears to be
   Resend, whose AUP bans "cold outreach" by name (naive-email.md §3.10, compliance §1.5). That inference rests on DNS
   records only. **This is not a stop on building, but no more cold mail goes out until Naïve says yes in writing.** If
   Naïve says no, stop cold email entirely, keep only Phase A (§10) running for 30 days, and keep contact forms as the
   cold channel. A purchased domain doesn't help, because the provider stays the same.
2. **B2. A real postal address** in `COMPANY_POSTAL_ADDRESS`. The 62 emails carry 459 Lagunita Drive, which is
   Stanford's student union (compliance §0, §1.1 #4).
3. **B3. Close the bypass.** Today any human reply wakes `terragent-outreach`, which answers on its own with
   `email.send` at `allow`, outside every gate. Turn the inbox's wake off and lock that agent (§3) **now**.
4. **B4. The inbox poller is deployed and running** (§5.2). It has to process opt-outs from the 62 recipients however
   the rest of this goes, and it has to keep running for at least 30 days after the last cold send (CAN-SPAM 7704(a)(3)).
5. **B5. A public deploy.** The opt-out link must be public https (the existing `optout_url_not_public` gate), and
   agents reach the gateway only on a public URL. `PUBLIC_BASE_URL` isn't set in `.env`, and the first deploy needs
   Laurence's final OK (NOTES 2026-11-07).
6. **B6. The template carries the solicitation line** ("This is a one-time commercial message", compliance §1.1 #3),
   and a founder approves it (H8).

**Not a blocker: buying a domain.** The free system domain is live and its DKIM, SPF and DMARC records pass. A domain
registered tonight would be a negative signal, not a help (compliance §2.2). Recommendation: **buy nothing now** (§9, F4).

---

## 1. What exists (live, read-only)

| Object | Id | Note |
|---|---|---|
| Domain `terragent-qqhrnj.usenaive.ai` | `dom_za03faqys03yb0md5c2qb6086a` | `kind: system`, free, active. Its zone is list-only. Our reputation is pooled with every other org on `usenaive.ai`. |
| Identity "Terragent" | `idn_9zr1eayedzpjsxvhrdcggegz2h` | Belongs to the org. Granted to `terragent-outreach` only. |
| Inbox `outreach@terragent-qqhrnj.usenaive.ai` | `eml_sbxjqy0jzn9pq14ebjz9hebqcj` | `owning_agent_id` = `terragent-outreach`, which is **fixed at creation** (naive-email §3.3). `wake: true`. |
| Agent `terragent-outreach` | `agt_zx126fy82bx63qg57d8er9wm5e` | **Not in the repo.** Created with key `main2`. `email.*` enabled at `allow`. Not on the coordinator's team. |
| Repo agent `comms-outreach` | (provisioned by `naive/provision.ts`) | `email.send` / `email.read` explicitly `deny` (`naive/agents/tools.ts` NEVER list). Holds no identity. |

## 2. Shape of the change

```
comms-outreach (Naïve agent) ── terragent.send_outreach_email ──▶ /api/mcp (our gateway)
                                                                   │ gates (send.ts) → messages row status 'queued'
                         Vercel Cron */5 + Naïve-webhook backstop ─┤ tickEmailNaive():
                                                                   │   1. sync Naïve inbox (GET …/messages, mark read)
                                                                   │   2. drain ≤ 1 queued send (re-run gates)
                                                                   ▼
             POST api.vetta.sh/v1/identities/idn_9zr1…/emails/eml_sbxj…/send  {to:[1], subject, text}
                                                                   │
recipient ◀── From outreach@terragent-qqhrnj.usenaive.ai ──────────┘
    │ reply (lands in the Naïve inbox; wake off, so no agent session starts)
    ▼
tickEmailNaive() → handleInboundEmail(source: naive) → opt-out / complaint / bounce → suppression
                                                    → prospect "replied" → request → comms-customer
                                                    → send_customer_message from hello@ (AgentMail, new thread)
```

## 3. Who owns what

- **Identity:** "Terragent" (`idn_9zr1…`) stays as it is. Identities belong to the org, and agents receive grants.
  **Add a grant to comms-outreach** with `identities.attach(<comms-outreach id>, "Terragent")`, which is idempotent and
  needs `agents:write`. That makes comms-outreach the Naïve agent that holds the persona and acts for it. Its email
  tools stay `deny` (NEVER list) and our `sessions.create` calls never pass `identity`, so it gets no `email.*` tools
  and can't trip the read-people's-data flag.
- **Sending inbox:** keep `outreach@terragent-qqhrnj.usenaive.ai`. Its owner can't be changed without deleting and
  re-creating the inbox. That risks losing the address 62 people may reply "stop" to, and the address has to keep
  working for 30 days after each send (≥ 2026-12-08 for the current batch). With `wake: false` the owner never runs, so
  ownership only matters on paper.
- **Lock `terragent-outreach`:** set `email.send`, `email.read` and `email.inboxes` to `{enabled:false, permission:"deny"}`
  (`agents.update` with `expected_version`). It then exists only as the inbox's nominal owner. If anyone turns wake back
  on, it can't send.
- **Later, with a new domain** (§9 F4): create the new inbox with `owning_agent_id` = comms-outreach, `wake: false`,
  and keep polling the old inbox until 30 days after its last send. The poll is per identity
  (`GET /v1/identities/{idn}/messages`), so a second inbox on the same identity needs no change to the poller.
- *Optional now, not recommended:* a second inbox on the system domain owned by comms-outreach, so the From address
  literally belongs to it. It's free, but it changes the From address in the middle of the campaign for no
  deliverability gain.

## 4. Send path

### 4.1 Why the gateway and not the agent's `email.send`

| | Gateway → Naïve REST (**recommended**) | Agent `email.send` at `allow` (how the 62 went out) | Agent `email.send` at `ask` |
|---|---|---|---|
| Code gates (suppression, caps, approved template, postal address, opt-out link, AI disclosure, one touch per business) | **Enforced** | None: whatever the model writes goes out | A human reads every send |
| Idempotency | Deterministic `Idempotency-Key` | None. A retry after an ambiguous failure can double-send. | n/a |
| Pacing (the email layer returns 429 on bursts) | Serialized by the queue | Parallel tool calls: 24 of 104 failed | n/a |
| Cost per send | **$0.0008** | $0.0125 (model tokens) | $0.0125 plus a person |
| Autonomy | Full | Full | One intervention per email (fails spec §11) |
| Naïve `/sent` log | `actor` = our runtime key, `sent_by_agent_id` = null | `sent_by_agent_id` = the agent | same as allow |

The agent still decides each touch and starts it. The mail goes out from the Naïve identity's inbox, through Naïve's
messaging API. The trade-off: Naïve's own log attributes the send to the key, not to comms-outreach. Our `messages`
row and the `outreach.sent` event record `actor = comms-outreach`.

### 4.2 Flow

1. comms-outreach calls `terragent.get_outreach_context`. When the prospect is eligible, the context returns
   `channel: "email_naive"`.
2. comms-outreach calls `terragent.send_outreach_email`. That's the same tool as today: no new tool, no new Naïve tool
   configs.
3. `sendOutreachEmail` renders the approved template from server facts (unchanged), then calls `sendEmail` with
   `channel: "email_naive"`.
4. `send.ts` runs every permanent gate **synchronously**, so the agent gets an immediate, actionable error for a
   suppressed contact, a missing template, an unapproved channel, a missing postal address, no MX record and so on.
   If they all pass, it writes the `messages` row with `status: 'queued'` and `not_before` set to the next allowed
   slot. The agent receives `{status:"queued", eta}`.
5. On the next tick, `drainNaiveQueue()` claims one due row atomically (`… FOR UPDATE SKIP LOCKED`). It re-runs the
   gates, because an opt-out may have arrived in the meantime, then sends.

Every Naïve cold send goes through the queue. That gives us four things: no bursts (the provider 429s parallel sends),
the send window is honoured even though the overnight signal engine verifies samples at 3 am, there's no
agent-side retry loop, and one place owns pacing.

### 4.3 The REST call (from `src/lib/naive/email.ts`, new)

- `POST https://api.vetta.sh/v1/identities/${NAIVE_COLD_IDENTITY_ID}/emails/${NAIVE_COLD_INBOX_ID}/send`, headers
  `authorization: Bearer <VETTA_API_KEY>`, `vetta-version: 2026-09-30`, and `idempotency-key: uuidFrom(sha256(messages.idempotency_key))`.
  On Vercel that key is `vercel-runtime`, which has `sessions:write`. The body is **exactly** `{ to: [one address], subject, text }`
  (d.ts `EmailSend`). Unknown keys are refused. Use plain `fetch`: the SDK sends a random idempotency key on every write
  (naive-email §3.5).
- **Text only.** Drop `html`, refuse attachments (`attachments_not_supported`), and leave the image-URL line out of the
  text. The report page shows the images, so the email carries two links, both on our own domain: the report and the opt-out.

Results and errors:

| Result | Handling |
|---|---|
| `202 {accepted:true, from, to, sent_at}` | `status 'sent'`, `sent_at` from the receipt, receipt stored in `meta.naive`. There's no provider message id (it's hidden). |
| `409 job_not_ready` | Requeue with `not_before` 2 min later. |
| 429, or "the email layer could not send a message (429)" | Requeue with backoff of 2, 4, then 8 min. After the 3rd attempt, `blocked provider_limit:naive_429` (counts for the cool-down like AgentMail's). |
| `402 insufficient_credits` | `blocked provider_rejected:insufficient_credits`, pause the channel, and add a dashboard intervention. |
| `409 idempotency_conflict` | A previous attempt with this key was accepted (a key survives only a 2xx). Mark it `sent` with `meta.idempotency_conflict` and **never resend**. |
| `400 validation_failed` | `failed send_failed:validation`. It's a bug, so raise an alert. |
| 5xx or network error | `failed`. The row can be re-claimed after the existing 10-minute stale window with the **same** key. Whether this route actually dedupes on `Idempotency-Key` is unverified, so first check `GET …/sent` for the same `to` and `subject` since the row's `sent_at`. If one is found, mark the row `sent`. |

## 5. Replies and the Naïve inbox

### 5.1 No Reply-To

`sendEmail`'s body has no `reply_to`, headers, cc/bcc or html field, and unknown keys are refused (naive-email §3.5,
discrepancy #2). Replies therefore land in the Naïve inbox. The closest thing to "Reply-To hello@" is one body line,
"You can also write to us at terragent@agentmail.to". A reply to either address reaches the same prospect, because
`matchThread` falls back to matching the sender's email or domain against prospects in `emailed`.

### 5.2 Poller: wake off, our server reads over REST

- **Turn the wake off:** `PATCH /v1/identities/idn_9zr1…/emails/eml_sbxj… {"wake": false}` (`agents:write`). Mail is
  still stored and no agent session starts.
- **Read:** `GET /v1/identities/{idn}/messages?channel=email&limit=100` (scope `agents:write`, which `vercel-runtime`
  has). Page with `next_cursor` and process **unread messages, oldest first**. Our idempotency key `in:naive:<inb_id>`
  stops duplicates. Mark each message `POST …/messages/{inb_id}/read {"read":true}` once it's stored, the same
  "stored = handled" rule the AgentMail webhook follows (a routing error leaves `meta.route_error` and an event). Use
  raw `fetch`, because the SDK's `emails.messages` has no `after` parameter.
- **Process guarded messages too.** Naïve stores and holds messages from its guards (`auto_reply`, `sender_rate_limit`,
  `endpoint_rate_limit`, `thread_turn_cap`) without waking anyone. A second "stop" within an hour is one of them.
  `own_persona` messages are ignored. `auto_reply` messages go to the bounce check (§6) before anything else.
- **Where it runs:** `tickEmailNaive()` is the poll followed by draining one queued send, and it has two triggers:
  1. `GET /api/cron/email-naive` (new), authorised with `Authorization: Bearer ${CRON_SECRET}`, plus a `vercel.json`
     cron `*/5 * * * *`. Per-5-minute crons need a Vercel Pro plan; Hobby allows one run a day (check the plan, F10).
  2. A backstop: the Naïve webhook route calls `tickEmailNaive()` inside `after()`, throttled to once every 3 minutes
     with an atomic settings compare-and-set. Sourcing and coordinator crons go idle about 32 times a day, so ticks
     happen at least hourly even overnight.
- **It must run before sending is re-enabled, and for at least 30 days after the last cold send**, even if cold email
  is turned off. It's the opt-out mechanism.

### 5.3 Routing: reuse `handleInboundEmail`

An adapter maps each Naïve message to `InboundEmail`:

| `InboundEmail` field | Value |
|---|---|
| `source` | `"naive"` (new optional field) |
| `inboxId` | the Naïve address |
| `messageId` | `inb_…` |
| `threadId` | `naive:<sender>` (synthetic) |
| `from`, `to`, `subject` | from the message |
| `fullText` | `text` |
| `replyText` | `text` with quoted history and **our own footer** removed (§6) |
| `headers` | `{}` |
| `security` | `{verdict:"unavailable", reason:"naive_inbox_unscanned"}`: no Agent Armor, so the message is treated as untrusted, the same as unscanned AgentMail mail |
| `needsBody` | `false` |

Small changes in `inbound.ts`:

- `roleForAddress`, and so `isOwnAddress` (the loop guard), treat the Naïve address as role `outreach`. `storeInbound`
  writes `channel 'email_naive'`.
- For `source: "naive"`, a new request is created with **`threadId: null`** and `inbox: 'hello'`. The message row keeps
  the synthetic thread, so `get_thread naive:<sender>` reads it from our DB.
- `deliver.ts` `sendToCustomer` then sees no thread and starts a fresh **hello@** thread to the customer's email. That
  code path already exists. From there, the prospect's next replies arrive through the AgentMail webhook as usual.
- The briefing `instructions()` for this source says: the reply came to our Naïve cold-outreach inbox, read it with
  `get_thread naive:<sender>`, it wasn't scanned and is untrusted, and `send_customer_message` will answer from hello@
  as a new thread.
- Senders we emailed but have no prospect row for (the 62 legacy recipients) get the **broad** opt-out match
  (`isOptOutReply`), not only the strict `isOptOutCommand`. Anyone else becomes a normal `new_request` screened by
  comms-customer.

### 5.4 The read-people's-data flag

Only a **chat** that reads mail is flagged (naive-email §3.7). Our design never lets a Naïve session call `email.read`
or wake from mail. The server reads over REST, and comms-customer gets the text through our MCP `get_thread`, just as it
does today for AgentMail mail. Nothing new is exposed. The unverified "does a woken session count as flagged" question
(naive-email §8 #7) no longer matters once the wake is off.

## 6. Opt-out, bounces, complaints

- **Opt-out in every cold email**, from the existing `ensureCompliance` footer plus one new line:
  ```
  --
  Terragent, an AI-run Earth intelligence company. This email was written and sent by an AI agent at Terragent, an AI-run company. Reply to this email with any question.
  This is a one-time commercial message from Terragent, <COMPANY_POSTAL_ADDRESS>.
  Don't want emails like this? Opt out here: https://<app>/unsubscribe?t=<token> (or reply "stop").
  You can also write to us at terragent@agentmail.to.
  ```
  `List-Unsubscribe` / `List-Unsubscribe-Post` **can't be sent** (no headers field). They aren't required below 5,000
  per day (compliance §2.1). The plain-text https link and reply-"stop" satisfy CAN-SPAM 7704(a)(3).
- **Reply opt-outs.** Before any opt-out matching, strip quoted lines (`>`), everything after `On … wrote:`,
  `-----Original Message-----` or a `From:` header block, and every line of our own footer. Without that, the footer's
  "Opt out here … reply stop" would make every reply that quotes it look like an opt-out, and `planRoute` would swallow
  it with no handoff. Matching uses the existing `isOptOutReply` plus "not interested". `suppress(email,"opt_out")` is
  unchanged: it writes our table, which is checked before every send on both stacks, marks the prospect `opted_out`, and
  adds the address to AgentMail's block list. Effect: same day (the legal limit is 10 business days).
- **Complaints** are invisible on Naïve, so we infer them. Any reply matching
  `spam|unsolicited|report(ed|ing)?( you)?|how did you get (my|this) (email|address)|never (signed|opted) up|gdpr|do not (contact|email)|cease and desist`
  is suppressed as `complaint` and gets no answer. One complaint in the trailing 7 days pauses Naïve cold sends for
  24 h and halves the next day's ramp. A second keeps them paused until a founder clears it (setting plus an
  intervention row). Thresholds come from compliance §2.3. Resend's 0.08% ceiling means one complaint in 44 emails is
  already about 2.3%.
- **Bounces** are invisible too. Return-path NDRs go to Amazon SES, not to us (naive-email §3.8). Three things instead:
  1. **Prevent them.** A new gate requires the recipient domain to have an MX record (`node:dns` `resolveMx`, 2 s
     timeout, cached per domain) and the prospect's `meta.email_source` to be `published` or `verified`, never
     guessed. That's CAN-SPAM 7704(b)(1). `create_prospect` gains an optional `email_source` input; the tool name
     doesn't change.
  2. **Infer them.** Auto-replies matching
     `address not found|does not exist|no such user|user unknown|mailbox (unavailable|full|disabled)|no longer (with|at|employed)|recipient rejected|550 5\.`
     are suppressed as `bounce`. Inferred bounces at or above 3% of the trailing 7 days' sends (minimum 2 events) halve
     the ramp; 4% or more pauses the channel.
  3. **Ask Naïve** (F1) for our org's bounce and complaint data, and whether it suppresses hard bounces org-wide.

## 7. Caps, pacing, warm-up (new domain)

All the numbers come from compliance §2.3 and §4.4. The ramp lives in code, so it doesn't depend on someone
remembering to change an env var.

| Rule | Value | Where |
|---|---|---|
| Daily cap (UTC day), by day index from the first `email_naive` send (back-filled: 2026-11-08) | Day 1: 20, day 2: 25, days 3-4: 30, days 5-7: 40, then 50. `CAP_NAIVE_COLD_PER_DAY` overrides it (a founder-only knob). The existing `CAP_OUTREACH_PER_DAY` (40, all channels) still applies. | `naiveColdCapToday()` in `send.ts` |
| Day 1 (2026-11-08 UTC) | **Already spent: 62 sends against a budget of 20.** No more until 2026-11-09 (F5). | follows from the ramp |
| Hourly | at most 10 | queue drain |
| Spacing | at most 1 send per tick, at least 180 s apart | queue drain plus a settings timestamp |
| Send window | Mon-Fri 16:00-23:00 UTC (11:00-18:00 EST, 08:00-15:00 PST) | `not_before` |
| Queue expiry | 72 h, then `blocked queue_expired`, so disaster mail doesn't go out days late | drain |
| Parallelism | none; claimed with `FOR UPDATE SKIP LOCKED` | drain |
| Jurisdiction | Cold Naïve email only to non-EU, non-`.ca` domains; `.uk` only to role addresses (`info@`, `contact@`…). Everyone else falls back to `contact_form`. Personal mailboxes are already excluded. | `chooseChannel` |
| Kill switches | `OUTREACH_NAIVE_EMAIL_APPROVED` (Naïve's OK, env), the armed flag `email.inbox_armed.naive_cold` (founder, dashboard), and `email.naive_cold_paused_until` (circuit breaker) | `send.ts` gate |

Cost at 50 sends a day: about $0.04 in Naïve email fees. Polling has no documented per-call fee.

## 8. Code changes

### 8.1 Files

| File (module owner) | Change |
|---|---|
| `src/lib/naive/email.ts` (naive, **new**) | `sendNaiveEmail({to, subject, text, key})`, `listNaiveInbound()`, `markNaiveRead(id)`. Raw `fetch`, pinned `vetta-version`, `uuidFrom(key)`, error mapping (§4.3). Offline mode throws like `getNaive()`. |
| `src/lib/email/send.ts` (email) | Add `channel: "email_naive"` to `SendEmailArgs` and `SendResult.status` gains `"queued"`. In `gate()` for `email_naive`: `OUTREACH_NAIVE_EMAIL_APPROVED`, armed `naive_cold`, not paused, ramp cap, MX, `email_source`, text only. Write `status 'queued'` and `not_before` instead of calling a provider. New `drainNaiveQueue()` calls `callNaive()`. `email_direct` returns `channel_retired`. `sentToday` and the caps count `email_naive` rows by `sent_at` (the queue doesn't count until sent). |
| `src/lib/email/naive-inbound.ts` (email, **new**) | `syncNaiveInbox()` with the adapter in §5.3, footer and quote stripping, complaint and bounce classifiers, the circuit breaker, and mark-read. `tickEmailNaive()` = sync, then drain one, behind a settings compare-and-set throttle. |
| `src/lib/email/inbound.ts` (email) | `InboundEmail.source`, `storeInbound` writes `channel`, and the `source: "naive"` behaviour from §5.3 (request `threadId: null` and `inbox: 'hello'`, instructions, broad opt-out matching for anyone we cold-emailed). |
| `src/lib/email/inbound-parse.ts` (email) | `source?: "agentmail" \| "naive"` on the type. |
| `src/lib/agentmail/config.ts` (email) | `roleForAddress` also maps `NAIVE_COLD_FROM` to `outreach`, so `isOwnAddress` covers it. `inboxes()` is unchanged (it remains the AgentMail config). |
| `src/lib/email/templates.ts` (email) | `footerLines` adds the solicitation line for outreach and follow-ups (kind-aware: "one-time" for first touches) and an optional "write to us at hello@" line. Add a `textOnly` render option that leaves out the image-URL line. |
| `src/lib/email/threads.ts` (email) | For `naive:` ids, read stored rows only, with no AgentMail fetch. `fromRow` shows the Naïve address for `email_naive` rows. |
| `src/lib/outbound/channel.ts` (outbound) | `OutreachChannel` gains `"email_naive"`. `chooseChannel`: warm → `email_warm`; cold work email with `OUTREACH_NAIVE_EMAIL_APPROVED`, not a personal mailbox, eligible jurisdiction and `email_source` known → `email_naive`; otherwise `contact_form`. `email_direct` is never chosen again but stays in the type for old rows. |
| `src/lib/outbound/outreach.ts` (outbound) | Handle `queued`: return `eta`, finish the held request as `delivered` with the note "queued, goes out by <eta>". The dashboard funnel counts only `sent` rows, so it stays honest. `send_with` text. One touch per business also checks outbound outreach rows by **recipient domain**, which covers the back-filled 62 that have no prospect rows. Follow-ups on `email_naive` use `sendEmail` with a new subject and never a fake "Re:" (`lastEmailId` already skips rows without an AgentMail id). |
| `src/lib/pipeline/verdicts.ts:75`, `src/lib/outbound/followups.ts:100`, `src/lib/outbound/monitors.ts:96` (core, outbound) | Add `"email_naive"` next to `email_warm` and `email_direct` in the follow-up channel lists. |
| `src/lib/mcp/tools/prospects.ts` (outbound) | `create_prospect` takes an optional `email_source: "published" \| "verified" \| "other"`, stored in `meta`. |
| `src/app/api/cron/email-naive/route.ts` (email, **new**), `vercel.json` (**new**) | The cron endpoint (Bearer `CRON_SECRET`, `maxDuration` 60) and `{"crons":[{"path":"/api/cron/email-naive","schedule":"*/5 * * * *"}]}`. |
| `src/app/api/webhooks/naive/route.ts` (core) | Inside `after()`, also call `tickEmailNaive()` (throttled). |
| `src/lib/dashboard/admin.ts` + channel labels (web) | The `inbox` action accepts the target `naive_cold`. Show the channel "email (Naïve)", queue depth, pause state and today's ramp budget. |
| `naive/agents/comms-outreach.ts` (naive) | Prompt: channel `email_naive` → `send_outreach_email`; `queued` means done, don't retry or use another channel. Replies arrive at hello@ **or** the Naïve inbox and the server routes both to comms-customer. Drop the AgentMail-only wording from the `provider_limit` step. The NEVER list stays as it is, so no repo agent gets `email.send` or `email.read`. |
| `src/lib/mcp/catalog.ts` (shared, description-only edits) | `send_outreach_email`: "Email a prospect: warm contacts from outreach@ (AgentMail); cold work email from the Naïve identity inbox when enabled (queued and paced server-side). Gated server-side." `get_outreach_context`: mention `email_naive`. `get_thread`: also reads stored Naïve threads (`naive:` ids). **No new tools and no renames**, so Naïve `tools.configs` and the "every tool registered once" test are unaffected. Re-provision anyway, because the prompt changed; that bumps comms-outreach's version and the provisioner re-pins the coordinator roster (`naive/provision.ts:303`). |

### 8.2 New env vars (add to `.env.example` and the `scripts/vercel-env.sh` allowlist)

| Var | Value / default | Kind |
|---|---|---|
| `NAIVE_COLD_IDENTITY_ID` | `idn_9zr1eayedzpjsxvhrdcggegz2h` | config |
| `NAIVE_COLD_INBOX_ID` | `eml_sbxjqy0jzn9pq14ebjz9hebqcj` | config |
| `NAIVE_COLD_FROM` | `outreach@terragent-qqhrnj.usenaive.ai` | config |
| `OUTREACH_NAIVE_EMAIL_APPROVED` | `false` until Naïve's written OK (B1) | config |
| `CAP_NAIVE_COLD_PER_DAY` | unset, so the ramp applies; a number overrides the ramp | config |
| `NAIVE_COLD_MAX_PER_HOUR` / `NAIVE_COLD_MIN_GAP_SECONDS` | `10` / `180` | config |
| `NAIVE_COLD_SEND_WINDOW_UTC` | `16-23` (Mon-Fri) | config |
| `CRON_SECRET` | random, generated at deploy | secret |
| `COMPANY_POSTAL_ADDRESS` | **already exists, still unset (B2)** | config |

No new Naïve key is needed. `vercel-runtime` (`VETTA_API_KEY` on Vercel) already has `sessions:write` for the send
and `agents:write` for the poll and mark-read.

New settings keys (no env needed): `email.inbox_armed.naive_cold` (bool), `email.naive_cold_paused_until`,
`email.naive_last_send_at`, `email.naive_tick_at`.

### 8.3 Migration `db/migrations/061_email_naive.sql`

```sql
-- Naïve cold outbound (docs/platform/email-stack-change.md). messages.channel gains 'email_naive';
-- messages.status gains 'queued' (text columns, no constraint change).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS not_before timestamptz;   -- queued email_naive send: earliest send time
CREATE INDEX IF NOT EXISTS messages_queue_idx ON messages (not_before, created_at) WHERE status = 'queued';
-- One touch per business by recipient domain (covers back-filled sends with no prospect row).
CREATE INDEX IF NOT EXISTS messages_outreach_domain_idx
  ON messages (lower(split_part(counterpart_email, '@', 2)))
  WHERE direction = 'outbound' AND kind IN ('outreach', 'followup');
```

### 8.4 Scripts

- `scripts/provision-naive-email.ts` (naive, **new**, idempotent, dry run unless `--apply`). It resolves the identity
  by name and the inbox by address, PATCHes `wake:false`, attaches "Terragent" to comms-outreach and prints the
  `NAIVE_COLD_*` values. With `--lock-legacy-agent` it also denies `email.*` on `terragent-outreach`; run that only
  after F3. Use `main2` locally or `vercel-runtime`.
- `scripts/backfill-naive-sent.ts` (email, **new**). It reads every page of `GET …/sent` and inserts each send as a
  `messages` row: `outbound`, inbox `outreach`, channel `email_naive`, kind `outreach`, status `sent`, `sent_at` from
  the log, plus `counterpart_email`, subject and body. The idempotency key is `naive-sent:<id>`, and `meta` carries
  `{backfilled:true, sent_by_agent_id, approved_template:false}`. `prospect_id` is filled when a prospect has that
  `contact_email`. The script logs `email.backfilled`. The result: caps, the ramp anchor, one-touch-per-business and
  reply matching all see the 62, and the dashboard shows them as touches sent outside the approved template.

### 8.5 Tests (no network)

- `send.test.ts`: each `email_naive` gate in order; queued, then drain, then sent; 409 `idempotency_conflict` marks the
  row sent; a 429 requeues with backoff; a retry with the same key never sends twice; `email_direct` returns
  `channel_retired`; the drain re-checks suppression.
- `naive-inbound.test.ts`: a "stop" reply that quotes our footer suppresses once, and a positive reply quoting the
  footer is **not** suppressed; a `sender_rate_limit`-guarded "stop" is still honoured; a complaint suppresses and
  pauses; an NDR-like auto-reply suppresses as a bounce; mark-read happens after storing; reruns are idempotent.
- `channel.test.ts`, `outreach.test.ts`: the eligibility matrix, a queued result closing the request, domain dedupe
  against back-filled rows.

### 8.6 Docs to update when this lands

ARCHITECTURE §1, §4 (channels, step 4 replies) and §5 (new rows: Naïve written-OK flag, ramp, inbox poll as the
opt-out mechanism). Spec §3.1 (Comms 3 row), §4.1 (identity bullet) and §4.2 ("Don't run Naïve identity email
alongside it" is superseded). NOTES: rewrite the "Email stack change" decision (no purchase needed; Reply-To isn't
possible), add F1-F10 to the founder table, and turn H2f into the AgentMail question in F6. Add this file to the
`docs/platform/README.md` index, and point `naive-orchestration.md` §3.9 here.

## 9. Founder decisions and purchases

| # | Decision | Recommendation | Who | Blocks |
|---|---|---|---|---|
| **F1** | **Ask Naïve in writing:** "We want to send cold B2B email from our Naïve identity inbox on the system domain `terragent-qqhrnj.usenaive.ai`. That means one personalised email per business with a free satellite analysis of its own asset, AI-disclosed and CAN-SPAM compliant (real postal address, opt-out link plus reply 'stop' honoured the same day), to US businesses at verified published addresses, at no more than 25-50 a day. 62 such emails went out on 2026-11-08 between 00:59 and 01:30 UTC. Is this allowed under your terms and your email provider's policy? Can you share bounce and complaint data for our org, and do you suppress hard bounces org-wide?" | Ask now. **If the answer is no, cold email stops.** | whoever talks to the Naïve sponsor | every cold send |
| **F2** | A valid postal address in `COMPANY_POSTAL_ADDRESS`: a founder's real business or home address, a USPS PO box, or a CMRA virtual mailbox (USPS Form 1583). | Use whichever exists today; a PO box or CMRA mailbox costs a monthly fee (not quoted). | a founder | every cold send |
| **F3** | Approve, **now**, turning the legacy inbox's wake off and locking `terragent-outreach` (deny `email.*`). Also tell us who created that agent with `main2`. | Yes. It closes the autonomous-reply bypass. | Laurence, or whoever set it up | B3 |
| **F4** | **Domain.** (a) Stay on the free system subdomain: **$0**, no DNS work, already passing DKIM/SPF/DMARC. (b) Later, if cold email continues past the hackathon and Naïve agrees, BYOD a **dedicated sending domain**, not the brand domain (for example `terragent-mail.com`; availability not checked). That's about $10-15 a year for a `.com` at a registrar (not quoted). A founder buys it on their own card. DNS steps: `naive identity domain connect --domain <name>` (POST `/v1/domains` `{kind:"external"}`); add the returned SPF TXT, DKIM, inbound MX and `_dmarc` records exactly as given and never edit the managed ones; run `verify` until `dns_status: provisioned` and `inbound_status: verified`; add the Google Postmaster TXT; put a one-page site with a privacy note at the apex; create `outreach@<name>` with `owning_agent_id` = comms-outreach and `wake:false`; restart the ramp at day 1. (c) Buy through Naïve with credits (`POST /v1/domains/purchase`, `billing:write`, so only `main2` can, locally). It needs no card, but Naïve manages the zone, and whether we could add Postmaster records is unverified. | **(a) now; (b) only after F1 is a yes and volume needs it.** None of these changes the provider risk in B1. | a founder (purchase and DNS) | nothing this weekend |
| **F5** | Volume this weekend. Day 1 is already at 62 sends against a budget of 20. | **No more cold sends until Mon 2026-11-09 16:00 UTC** (ramp day 2: 25). The alternative is the compliance doc's "at most ~20 more Sunday morning PT", set by a founder with `CAP_NAIVE_COLD_PER_DAY=82` and `CAP_OUTREACH_PER_DAY` above 82 for that UTC day (the back-filled 62 count toward both), unset afterwards, and the send window widened to include Sunday. | a founder | volume |
| **F6** | Who answers replies to cold mail. | **comms-customer, from hello@ (AgentMail), as a new thread.** The alternative of answering from the Naïve inbox is text-only, with no attachments and no threading. Rewrite H2f as a question for AgentMail: "Is it OK for hello@ to answer people who replied to a cold email we sent from another provider?" | founder (and whoever talks to the AgentMail sponsor) | reply handling |
| **F7** | Approve the updated outreach templates (solicitation line, hello@ line), arm `naive_cold` in the dashboard, and set `OUTREACH_NAIVE_EMAIL_APPROVED=true`. | Do it only after F1, F2 and B5. | any founder (H8) | go-live |
| **F8** | Keep the Naïve inbox, identity, domain and a paid Naïve plan (Standard, $20/month, pricing.md) alive and polled until at least 30 days after the last cold send (≥ 2026-12-08 for the current batch). Don't delete any of them after the hackathon. | Yes. Decide who pays the plan after the hackathon. | founders | legal duty |
| **F9** | The 62 legacy recipients. | Back-fill them, send **no follow-ups** (they didn't use an approved template), and honour every opt-out. | build agent (delegated) | none |
| **F10** | Vercel plan. A `*/5` cron needs Pro; Hobby crons run once a day. | Check the plan. The webhook backstop works on Hobby, so this isn't a purchase. | Laurence | poll latency |

## 10. Rollout order

- **Phase A: needed whatever F1 says.** This covers the CAN-SPAM duty for the 62 already sent.
  1. After F3, run `provision-naive-email.ts --apply --lock-legacy-agent`.
  2. Run migration 061 and the back-fill.
  3. Ship the poller, inbound routing and the opt-out, complaint and bounce rules (§5-6), then deploy (B5).
  4. Until the poller is live, a founder checks the Naïve inbox by hand at least every few days, which is within the
     10-business-day opt-out limit.
- **Phase B: build only once F1 is a yes.** The send path, the queue, the ramp, `chooseChannel`, templates, the
  comms-outreach prompt and catalog descriptions, the dashboard, and re-provisioning.
- **Phase C: go-live.** F2, F6 and F7, then the first sends on ramp day 2 or later, inside the window, with the
  circuit breaker on.
- **If F1 is a no:** delete nothing. Keep Phase A running until at least 30 days after the last send. Cold outreach
  stays on contact forms (`OUTREACH_CONTACT_FORM_APPROVED=true` is already set).

## 11. Unverified and residual risks

1. That the provider is Resend, and whether Naïve would enforce its AUP against us (B1). If Naïve suspends the org, all
   Naïve agents stop, not only email.
2. Whether `Idempotency-Key` dedupes the send route (§4.3 checks `/sent` before re-sending a stale row), and whether
   unknown body keys are refused on that route (we send none).
3. The From display name recipients see (we can't set it).
4. Inbox placement for a random-looking `*.usenaive.ai` subdomain with `p=none`. We can't verify it in Google
   Postmaster or measure it.
5. Real bounce and complaint rates. The §6 inference catches only bounces and complaints that come back as mail.
6. Whether Vercel Hobby or Pro limits apply to this project (F10).
7. Replies whose sender domains fail SPF/DKIM/DMARC are dropped by Naïve before storage, so we never see them,
   opt-outs included. The https opt-out link is the backstop for those senders.
8. The AgentMail answer in F6. Until it arrives, replies from hello@ go only to people who replied to us, which fits
   the existing `email_warm` definition.

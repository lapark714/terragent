# Naïve identity email: verified platform reference (Terragent)

Status: COMPLETE for this research pass, 2026-11-08 01:38 UTC (2026-11-07 17:38 PT). **Read-only pass:** it created no
identity, domain, inbox, agent or deployment, bought nothing and sent nothing.

Evidence base:
- Docs fetched 2026-11-08 ~01:30 UTC from https://usenaive.ai/docs/llms.txt and the linked identity, email, domain,
  messaging, pricing and policy pages: `identity/{overview,personas,domains,email,inbound,policies,vault,connections}`,
  `api/{identities,domains,messaging,webhooks,overview,authentication,audit-logs,sessions,deployments}`,
  `sdk/{identities,domains,emails}`, `cli/{identity,comms}`, `capabilities/{identity,tools,webhooks,deployments}`,
  `platform/{pricing,billing}` (all `https://usenaive.ai/docs/<path>.md`). Pages self-reference `vetta.sh/docs`; same content.
- Live OpenAPI `GET https://api.vetta.sh/v1/openapi.json` (version `2026-09-30`, request bodies and `x-vetta-scope` per route).
- SDK `@usenaive-sdk/managed-agents@0.12.3`, `node_modules/@usenaive-sdk/managed-agents/dist/index.d.ts` ("d.ts:N") and `dist/index.js`.
- Live **GET-only** calls with key `main2` (org `org_wqyydghx5dvtvxwg88dyqqhrnj` "Terragent", `live` mode): `/v1/me`,
  `/v1/identities`, `/v1/domains`, `/v1/identities/{id}/{emails,agents,phones,messages,sent}`, `/v1/agents/{id}`,
  `/v1/sessions?agent_id=`, `/v1/sessions/{id}/events`, `/v1/credits/spend`, `/v1/agents/{id}/spend`, `/v1/audit_logs`,
  `/v1/api_keys` (names and scopes only), `/v1/organizations`. Public DNS via `https://dns.google/resolve`.
- Policies: https://usenaive.ai/terms (last updated 2026-10-28), https://usenaive.ai/privacy (2026-09-25),
  https://resend.com/legal/acceptable-use (last update 2026-10-13). No AUP or email policy page exists on usenaive.ai
  (`/acceptable-use`, `/aup`, `/legal/*`, `/policies`, `/usage-policy` all 404; the sitemap lists only `/terms`, `/privacy`, `/licenses`).
- Raw captures stayed in the session scratchpad (`research/naive-email/`), not in the repo.

## 1. TL;DR for builders

- **The Naïve outbound inbox already exists and has already sent 62 cold emails.** Before this pass, something using key
  `main2` (no repo code references it) set up the free system domain `terragent-qqhrnj.usenaive.ai`, identity
  "Terragent", agent `terragent-outreach` and inbox `outreach@terragent-qqhrnj.usenaive.ai`. Between 00:59 and 01:30 UTC
  that agent sent **62 emails to 62 distinct business addresses** with `email.send` set to `allow`, outside our app's
  gates (suppression table, caps, template approval). Details in §4. Founders should know this before the design docs land.
- **No domain purchase is needed.** Every org can mint one free `system` domain, a subdomain of Naïve's shared mail
  apex (live: `{org-slug}-{last 6 of org id}.usenaive.ai`). Naïve publishes its DNS. It went active in about 87 s live.
  You can also bring your own domain (`external`: we add the returned SPF/DKIM/MX/DMARC records at our registrar) or
  buy one with Naïve credits (`purchased`: `POST /v1/domains/purchase`, `billing:write`, explicit max price, no card,
  auto-renew off).
- **Sending is plain text only, on both paths.** REST `POST /v1/identities/{idn}/emails/{eml}/send` body is exactly
  `{ to: string[] (1-50), subject (1-998 chars), text }`. The agent tool `email.send` takes `{ to, subject, text, from? }`,
  where `from` must be the inbox's `eml_` id (live validation error when the agent passed the address). There is **no
  html, cc/bcc, reply_to, custom headers (no List-Unsubscribe), attachments or display name**, and unknown body keys are
  refused under `Vetta-Version` ≥ 2026-09-01. So **Reply-To hello@ is impossible**: replies come back to the Naïve inbox.
- **Our server can send as the identity** with any key holding `sessions:write` (the Vercel key `vercel-runtime` has it).
  It answers `202` with a receipt `{object:"email_send", accepted, from, to, sent_at}`. The provider message id is
  deliberately hidden. The send is logged in `GET /v1/identities/{idn}/sent` with `actor` = the key.
- **Price verified live: $0.0008 per send call however many recipients** (62 sends = 49,600 micro-USD on the `email`
  component). Sending through the agent cost **$0.0125 per email** once model tokens are counted ($0.772 for 62),
  about 15 times the REST path.
- **Receiving:** a new inbox has `wake: true`, so each inbound mail that passes the guards starts one session of the
  inbox's owning agent as the persona. `PATCH /v1/identities/{idn}/emails/{eml} {"wake": false}` stores mail without
  waking. Read it with `GET /v1/identities/{idn}/messages?channel=email&limit=&after=` (scope **`agents:write`**). Fields:
  `from, to, subject, text, auth{spf,dkim,dmarc}, session_id, guard_reason, received_at, read_at`. There is **no html,
  no attachments, no Message-ID or thread id**. Mark processed messages with `POST .../messages/{mid}/read`. **No webhook
  event exists for inbound mail.** Only a woken session reaches us, via `session.idle` with `metadata.inbound_message_id`.
- **Limits:** no daily cap or warm-up ramp is documented, and none was hit at 62 distinct new recipients in 30 minutes
  (AgentMail's new-org ramp is 10 per day). But **parallel bursts fail**: 24 of 104 agent `email.send` calls returned
  `the email layer could not send a message (429)`. Successful completions ran at 3 per second or fewer. Send one at a
  time and back off on 429.
- **Bounces and complaints are invisible.** There is no event, delivery status or suppression API. The return path is
  the provider's (`send.<sub>` MX points at `feedback-smtp.us-east-1.amazonses.com`), so bounces never reach our inbox.
- **Terms: cold outreach is not clearly allowed.** Naïve's Terms have no cold-email clause. They permit sales and
  marketing automation, ban spam and unlawful use, and make AI disclosure the customer's job. **But our domain's DNS is
  Resend's record pattern** (`resend._domainkey`, a `send.` MX to Amazon SES feedback, SPF `include:amazonses.com`).
  Inference: Naïve's email layer is Resend. Resend's AUP names cold outreach as prohibited spam, requires opted-in
  recipients, and shuts accounts above a 4% bounce or 0.08% complaint rate. Our mail also rides Naïve's own
  `usenaive.ai` apex. **Get the Naïve team's written OK**, just as H2f asks AgentMail.
- **"Read people's data" flag:** it attaches to a **chat** that reads contacts, mail or messages (for example with
  `email.read`). While flagged, `bash` is refused and every send, `web_fetch`, MCP or connected-app call asks each
  time, even at `allow`. A server reading the inbox over REST is not a chat, so the documented flag doesn't apply.
  Never let an unattended sending session call `email.read`.

## 2. Install & setup

### 2.1 What exists in the org now (live GETs, 2026-11-08 01:38 UTC)

| Object | Id | State |
|---|---|---|
| Domain `terragent-qqhrnj.usenaive.ai` | `dom_za03faqys03yb0md5c2qb6086a` | `kind: system`, `status: active`, `dns_status: provisioned`, `inbound_status: verified`, `app_connect_status: pending`. Created 00:56:39 UTC, verified 00:58:06 (87 s). The only domain in the org. |
| Identity "Terragent" | `idn_9zr1eayedzpjsxvhrdcggegz2h` | Description: Terragent, an AI-run Earth intelligence company… `emails: [outreach@terragent-qqhrnj.usenaive.ai]`, `domains: [terragent-qqhrnj.usenaive.ai]`, no phones or connections. Created 00:57:43. Held by 1 agent: `terragent-outreach`. |
| Inbox `outreach@terragent-qqhrnj.usenaive.ai` | `eml_sbxjqy0jzn9pq14ebjz9hebqcj` | `owning_agent_id: agt_zx126fy82bx63qg57d8er9wm5e`, **`wake: true`**, `status: active`. Created 00:58:17. |
| Agent `terragent-outreach` | `agt_zx126fy82bx63qg57d8er9wm5e` | v2, `anthropic/claude-sonnet-5`, harness `pi`, `immediate`. Budget $10/month cap, $3 max per task. `tools.default_config.permission: deny`; only `email.inboxes`, `email.read` and **`email.send` are enabled, all `allow`**. No MCP servers or skills. System prompt (2,276 chars): send each given email exactly as written, answer replies (pricing-survey answers, report requests, questions), honour "stop", end every email with an AI disclosure, a Stanford postal address and a reply-"stop" opt-out. v2 saved 01:23:47 by key `main2` (audit log). Not defined anywhere in the repo (`naive/`, `scripts/`, `src/`). |
| Identity "store" | `idn_vw2gwkykvqqk6npg4htzq3trzb` | From the paused starter "shop" template. No inboxes. Held by `analyst`, `marketer`, `merchandiser`, `store-manager`. |
| Phones | none | |
| Sent | 62 messages | See §4. |
| Inbound | 1 message | Auto-reply from a recipient, 01:28:27, `auth: {spf: pass, dkim: pass, dmarc: pass}`, `guard_reason: auto_reply`, `session_id: null` (did not wake). |

Domain, identity and inbox creation are **not** in the audit log (`GET /v1/audit_logs`; those actions aren't on the
audited list at https://usenaive.ai/docs/api/audit-logs.md). Only the agent update is attributable (to `main2`, the
local provisioning key per NOTES H1b/H1d).

### 2.2 How it is set up (reference only; already done, do not re-run)

```ts
import { createClient } from "@usenaive-sdk/managed-agents"; // 0.12.3
const naive = createClient({ apiKey: process.env.VETTA_API_KEY! });

const dom = await naive.domains.create({ kind: "system" });            // POST /v1/domains (agents:write). Idempotent: returns the same domain again
const idn = await naive.identities.create({ name: "Terragent", description: "…" }); // POST /v1/identities (agents:write); name unique, case-insensitive
await naive.identities.attach(agentId, idn.id);                        // POST /v1/agents/{id}/identities (agents:write); idempotent
const inbox = await naive.emails.create(idn.id, { address: "outreach@" + dom.name, owning_agent_id: agentId }); // POST /v1/identities/{id}/emails
// While a system domain is still pending: 409 job_not_ready (retryable). Address taken: 409 name_conflict (param "address").
```
CLI equivalents: `naive identity domain connect` (no `--domain` mints the system domain), `naive identity create`,
`naive identity attach --agent agt_… --identity "Terragent"`,
`naive identity email provision --identity idn_… --address … --agent agt_…`,
`naive identity email update --identity idn_… --inbox eml_… --wake off`. Sources: https://usenaive.ai/docs/cli/comms.md,
https://usenaive.ai/docs/cli/identity.md, https://usenaive.ai/docs/sdk/emails.md, https://usenaive.ai/docs/sdk/domains.md.

The SDK's `InboxCreate` type has no `wake` field (d.ts:3402-3408) but the server accepts `wake` at create (OpenAPI
`createInbox` body: `address`, `domain_id`, `owning_agent_id` (required), `wake`). To create with `wake: false`, call REST
directly or PATCH right after.

## 3. API reference

### 3.1 Identities (personas)

| Route | Scope (OpenAPI `x-vetta-scope`) | Notes |
|---|---|---|
| `POST /v1/identities` | `agents:write` | Body `{ name (1-128, required), description? (≤1024 or null), metadata? }`. Endpoint lists can't be sent here (`validation_failed`). |
| `GET /v1/identities` | `agents:read` | `limit`, `after`. |
| `GET /v1/identities/{id}` | `agents:read` | |
| `PATCH /v1/identities/{id}` | `agents:write` | `name`, `description`, `metadata` (replaced wholesale). |
| `DELETE /v1/identities/{id}` | `agents:write` | Revokes every grant and **deletes its inboxes**. Refused 409 while it owns phone numbers. |
| `GET /v1/identities/{id}/agents` | `agents:read` | Who may wear the persona. |
| `GET /v1/agents/{id}/identities` | `agents:read` | Personas an agent may wear. |
| `POST /v1/agents/{id}/identities` | `agents:write` | `{ identity: "idn_…" }`. Idempotent (`attached: true, created: false`). SDK `identities.attach(agentId, idOrName)`. |
| `DELETE /v1/agents/{id}/identities/{idn}` | `agents:write` | Running sessions aren't interrupted; the next session can't select it. |

Object: `{ id, object:"identity", name, description, emails[], phones[], domains[], connections[], metadata, created_at, updated_at }`
(SDK d.ts ~6442; live). Sources: https://usenaive.ai/docs/api/identities.md, https://usenaive.ai/docs/identity/personas.md.

**Grants and selection.** The grant is many-to-many and hangs off the agent. The acting persona is chosen per run:
`sessions.create({ agent_id, identity: "idn_…" | name, message })`, or the deployment's `identity` for cron fires (checked
when the schedule is written; with none, each fire runs as no persona). Inbound mail selects the persona automatically:
it wakes the inbox's owning agent as that persona, so the owner must hold the grant. Sources:
https://usenaive.ai/docs/identity/personas.md, https://usenaive.ai/docs/api/deployments.md, https://usenaive.ai/docs/api/sessions.md.

**What the agent sees.** For that run only, the persona's name, description and owned addresses are put in front of the
model; no new agent version is minted (personas.md). A session whose selected identity owns an inbox is offered
`email.inboxes`, `email.read` and `email.send` (https://usenaive.ai/docs/capabilities/tools.md#email-tools). Live
`email.inboxes` output is `{"inboxes":[<the inbox object>]}`. A session with no selected identity gets no email tools.

### 3.2 Domains

| Route | Scope | Notes |
|---|---|---|
| `POST /v1/domains` | `agents:write` | `{ kind: "system" \| "external" (default), name? (required for external), receive? (default true) }`. Idempotent on name. |
| `POST /v1/domains/quote` | `billing:read` | `{ name }` → `{ available, tier: standard\|premium\|null, registration_price_micro_usd, renewal_price_micro_usd, currency:"usd", reason }`. Documented as read-only (no reservation, no credits move), but it's a POST, so this GET-only pass did **not** call it. |
| `POST /v1/domains/purchase` | `billing:write` | `{ name, max_price_micro_usd, receive? }` + `Idempotency-Key`. Rechecks price, refuses premium names and prices over the ceiling, debits **Naïve credits** before registering. Platform registrar account; no card. One year, auto-renew off. 201 done / 202 pending (platform finishes within ~10 min). Registrar rejection or no registration within a day: refunded. |
| `GET /v1/domains`, `GET /v1/domains/{id}` | `agents:read` | Paginated. |
| `POST /v1/domains/{id}/verify` | `agents:write` | Re-runnable; each track advances on its own. |
| `GET /v1/domains/{id}/records` | `agents:read` | `{ type: TXT\|CNAME\|MX, host, value, priority, managed }`. |
| `DELETE /v1/domains/{id}` | `agents:write` | Inboxes on it stop delivering. |

Three readiness tracks: `dns_status` (`pending_verification` → `provisioned`) gates **sending**; `inbound_status`
(`pending` → `verified`) gates **receiving**; `app_connect_status` is web hosting only. `status` (`pending_dns` → `active`)
gates **creating an inbox**. A send before `provisioned` returns retryable `409 job_not_ready`. Domains belong to the
**org**, not an identity. Sources: https://usenaive.ai/docs/api/domains.md, https://usenaive.ai/docs/identity/domains.md,
SDK d.ts 8075-8200.

**Options and timings:**
- **system** (free, one per org): DNS is written into Naïve's shared apex zone, verification starts at create and
  normally clears within about a minute (live: 87 s). The zone is list-only, so any record edit gets `403`. Live name:
  `terragent-qqhrnj.usenaive.ai`, a subdomain of **`usenaive.ai`, Naïve's own brand domain** (its MX is Google Workspace).
- **external** (BYOD): `connect` returns a dynamic record set to add at **our** registrar, typically SPF TXT, DKIM
  TXT/CNAME, an inbound MX and a `_dmarc` TXT, then `verify`. The docs put propagation at minutes to hours, depending on the registrar.
  The managed records (DKIM, `_dmarc`, inbound MX) must never be edited.
- **purchased**: as above; Naïve manages the zone. Price: only the docs' illustrative `12000000` (= $12) ceiling is
  published. A founder can get the real price with `naive identity domain quote --domain <name>` (read-only by the docs).

**Live record set of our system domain** (`GET /v1/domains`, matched by public DNS):

| Host | Type | Value | Managed | What it is |
|---|---|---|---|---|
| `resend._domainkey.terragent-qqhrnj` | TXT | `p=MIGfMA0…` (RSA key) | yes | DKIM, selector `resend` |
| `send.terragent-qqhrnj` | MX 10 | `feedback-smtp.us-east-1.amazonses.com` | no | bounce / return path (Amazon SES) |
| `send.terragent-qqhrnj` | TXT | `v=spf1 include:amazonses.com ~all` | no | SPF for the return-path domain |
| `rsend.terragent-qqhrnj` | CNAME | `send.forge.rmta.net` | no | unidentified (rmta.net, registrar Amazon) |
| `terragent-qqhrnj` | MX 10 | `receive.forge.rmta.net` | yes | inbound MX |
| `_dmarc` (public: `_dmarc.terragent-qqhrnj.usenaive.ai`) | TXT | `v=DMARC1; p=none;` | yes | DMARC monitor-only. `usenaive.ai` itself publishes no DMARC. |

Those three record names together are the layout Resend generates for a sending domain. That is the basis for the
"provider is Resend" inference in §3.8. Naïve's docs never name the provider; they call it the email layer or the comms provider.

### 3.3 Inboxes

| Route | Scope | Body / notes |
|---|---|---|
| `POST /v1/identities/{id}/emails` | `agents:write` | `owning_agent_id` (required; the agent must hold the persona) + **either** `address` (localpart `[a-z0-9._-]{2,64}`) **or** `domain_id` (localpart derived from the agent name, ≤32 chars, `-2`, `-3` suffixes) + `wake` (default `true`). Errors: 400 both or malformed, 404, 409 `name_conflict`, 409 `job_not_ready`. |
| `GET /v1/identities/{id}/emails` | `agents:read` | `limit`. |
| `PATCH /v1/identities/{id}/emails/{eid}` | `agents:write` | Strict body `{ wake: boolean }` only (`additionalProperties: false`). Audited as `email.updated` per the docs. |
| `DELETE /v1/identities/{id}/emails/{eid}` | `agents:write` | Mail to the address stops being accepted. |

Object: `{ id:"eml_…", object:"email_inbox", identity_id, domain_id, address, localpart, owning_agent_id, wake, status: active|disabled, created_at }`.
**`owning_agent_id` is fixed at creation.** Changing the owner means deleting and re-creating the inbox. Sources:
https://usenaive.ai/docs/api/messaging.md, OpenAPI `createInbox`/`updateInbox`, SDK d.ts 8203-8252.

### 3.4 Sending as an agent: the built-in `email.send` tool

- Offered only when the session's selected identity owns an inbox. **Ask by default** even under a `default_config`
  of `allow`; a per-tool `configs` entry wins; a `deny` default denies it (https://usenaive.ai/docs/capabilities/tools.md#permission-policies,
  https://usenaive.ai/docs/identity/policies.md). An `ask` parks the session `awaiting_approval` until someone answers
  (`sessions.confirmTool`). An unattended cron session therefore stalls unless `email.send` is `allow`.
- **Arguments (live, from tool events; built-in tool schemas aren't in the SDK types):** `{ to: string[], subject, text, from? }`.
  `from` is **optional** and must be the **`eml_` inbox id**. Passing the address failed 18 times with
  `Validation failed for tool "email.send": from: must match pattern "^eml_.*"`. Omitting `from` worked (the identity has
  one inbox). There is no html, cc/bcc, reply-to, headers or attachments.
- Each send is credit-checked against the session's budget and gated on `dns_status: provisioned`.
- It returns the same receipt as REST: `{"object":"email_send","accepted":true,"from":…,"to":[…],"sent_at":…}`.
- Failures seen live: `the email layer could not send a message (429)` when several sends ran in parallel (see §4).
  Failed attempts don't appear in `/sent` and weren't billed (62 billed = 62 in `/sent`).
- Logged in `GET /v1/identities/{id}/sent` with `sent_by_agent_id` set and `actor: null`.
- `email.read` reads mail that arrived at the identity's inboxes, newest first, optionally since an instant or for one
  inbox. **Reading mail flags the chat** (§3.7). Exact `email.read` argument names are unverified.

### 3.5 Sending from our server (REST)

`POST /v1/identities/{id}/emails/{eid}/send`, scope **`sessions:write`** (OpenAPI `sendEmail`). Body, verbatim from the live
OpenAPI: `to` array of 1-50 email-pattern strings, `subject` string 1-998, `text` string ≥1, all required. Answers **`202`**
with `{ object:"email_send", accepted, from, to, sent_at }`. Errors: `409 job_not_ready` (domain not provisioned, retry),
`400 validation_failed`, `402 insufficient_credits` (checked before sending). Billed once per call, not per recipient.
Sources: https://usenaive.ai/docs/api/messaging.md#send-email, https://usenaive.ai/docs/sdk/emails.md, SDK d.ts:3409-3413, 8253-8259.

```ts
// Server-side cold send from the identity inbox. One recipient per call (all `to` addresses see each other: no bcc).
const r = await fetch(`https://api.vetta.sh/v1/identities/${IDN}/emails/${EML}/send`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${process.env.VETTA_DEPLOY_API_KEY}`, // vercel-runtime key: has sessions:write
    "vetta-version": "2026-09-30",
    "content-type": "application/json",
    // Deterministic per (prospect, template version): a retry replays the first response instead of sending twice.
    // Docs: every mutating POST honours Idempotency-Key; not tested on this route. Prefer a UUIDv5 of the pair.
    "idempotency-key": idempotencyUuid(prospectId, templateVersion),
  },
  body: JSON.stringify({ to: [email], subject, text }), // any other key → 400 (unknown body keys are refused)
});
// 202 → store the receipt. 409 job_not_ready / 429 → back off and retry with the SAME key. 402 → stop, alert.
```
The SDK's `emails.send(identityId, inboxId, { to, subject, text })` sends a random UUID idempotency key on every write.
Its only override for that is the client-level `createClient({ apiKey, idempotencyKey: () => key })` (d.ts:21-28, `dist/index.js:5557`),
so a deterministic key needs a client per send, or plain `fetch` as above.

**What a server send can't do:** set Reply-To, From display name, html, `List-Unsubscribe` / `List-Unsubscribe-Post`,
attachments (no PDF report), or thread headers. A plain-text URL to our own `/unsubscribe` page in the body *is* possible.

### 3.6 Receiving

- **Path:** the provider calls Naïve's receiver `POST /v1/webhooks/inbound/email`. Mail is matched by **exact address** to
  an active inbox (no match: dropped) and authenticated: it must pass **SPF/DKIM/DMARC** or it is dropped. Then the
  guards run, the message is **always stored**, and if no guard holds it and `wake: true`, one session of the owning
  agent starts as the persona. The message is the first input, fenced as untrusted, and the session carries
  `metadata.inbound_message_id`. A wake that can't start (balance too low, agent lacks the grant) is retried about every
  2 min for 15 min. Mail that arrived with no owner is never woken later. Sources: https://usenaive.ai/docs/identity/inbound.md,
  https://usenaive.ai/docs/identity/email.md, https://usenaive.ai/docs/api/webhooks.md#inbound-receivers.
- **Guards** (`guard_reason`): `sender_rate_limit` (more than 5 per hour from one sender to one inbox),
  `endpoint_rate_limit` (more than 20 per hour to one inbox, all senders), `thread_turn_cap` (the 11th turn from one
  sender in one thread within a day), `auto_reply` (`Auto-Submitted` other than `no`, or `Precedence: bulk/list/junk/auto_reply`),
  `own_persona`. A held message is stored and **never** wakes. Live: the one inbound so far was held as `auto_reply`.
- **Turning the wake off:** yes, per inbox. Create with `wake: false`, or `PATCH /v1/identities/{id}/emails/{eid} {"wake": false}`
  (`agents:write`). Mail is still stored. An `owning_agent_id` is still required.
- **Reading via API:** `GET /v1/identities/{id}/messages`, scope **`agents:write`** (deliberately, so a hosted app's
  read-only key can't read strangers' mail). Query `channel` (`email`|`sms`), `limit`, `after` (OpenAPI). Page shape
  `{ data, has_more, next_cursor }`. Item: `{ id:"inb_…", object:"inbound_message", channel, identity_id, endpoint_id, from, to, subject, text, auth, session_id, guard_reason, received_at, read_at }`
  (live and d.ts 8260-8285). `POST /v1/identities/{id}/messages/{mid}/read {"read": true|false}` (`agents:write`) tracks
  processing; re-marking keeps the first read time. SDK: `emails.messages(idn, { channel, limit })` has **no `after`**,
  and `identities.messages(ref, { channel })` has no `limit` either. Page with raw `fetch`.
- **Push:** there is **no** webhook event type for inbound mail (event list: sessions, media jobs, browser, files/apps,
  wallets, cards; https://usenaive.ai/docs/capabilities/webhooks.md#event-types). With `wake: true` our server learns of a
  reply only through the woken session's `session.idle` / `message.completed`. With `wake: false`, **poll**.
- **Content limits:** text only. No html, no attachments, no Message-ID / In-Reply-To / thread id. Match a reply to its
  outreach by `from` + `Re:` subject.
- **Cost:** a woken session is an ordinary session under the owning agent's per-task budget. Idle costs only storage.

### 3.7 The "read people's data" flag

From https://usenaive.ai/docs/capabilities/tools.md (section on chats that have read people's data), paraphrased: reading contacts, mail,
messages or a connected app **flags the chat, and any chat a flagged one hands work to**. While flagged:
`bash`, `build_3d` and publishing with `apps` are refused (and `write`/`edit`/`fetch_file` on an agent that holds `bash`).
**Every send, `board_write`, `mobile`, `data_run`, a browser that moves or writes, every `web_fetch` and every
connected-app or MCP tool asks each time, even at `allow`**, and a chat-wide grant doesn't cover them. Reading and
writing the company's own records keeps working. `claude_code`-harness agents aren't given these reads at all.

How it applies to us:
- **Server reads the inbox over REST** (`GET …/messages`): this is an API call, not a chat, so nothing is flagged. The
  docs scope the flag to chats; no API-side equivalent is documented. If the server then pastes that mail into a new
  session's `message`, the docs don't say whether that session counts as having "read mail". Unverified; the
  conservative assumption is no flag, since no read tool ran.
- **Agent session calls `email.read`:** flagged. Its subsequent `email.send` calls ask every time, so an unattended
  reply loop would park. The cold-send sessions so far never called `email.read` (live events: only `email.send` and
  `email.inboxes`).
- **Inbound-woken session:** the mail arrives as input, not via a read tool. Whether that alone flags the chat is
  **unverified**. If it does, the outreach agent's autonomous replies will park `awaiting_approval`.

### 3.8 Limits, bounces, complaints, events

- **Documented caps:** none for email beyond the general API rate limit (429 + `Retry-After`, `RateLimit-*` headers;
  https://usenaive.ai/docs/api/overview.md) and 50 recipients per send. No per-inbox or per-org daily cap, no warm-up
  or ramp, no reputation docs.
- **Observed:** 62 distinct new recipients accepted in 30 minutes with no ramp refusal. Bursts of 8-18 parallel tool calls
  hit `the email layer could not send a message (429)` (24 of 104 calls), and successful completions ran at 3 per second
  or fewer. That fits a per-second provider rate limit, not a daily one.
- **Bounces/complaints:** nothing exposed: no delivery status on `/sent`, no events, no suppression list, provider
  message id hidden. NDRs go to the provider's return path, not our inbox (zero NDRs in the inbound feed after 62 sends).
  We can't measure our own bounce or complaint rate. Verify addresses before sending (Monid verified emails) and keep
  volume low.
- **Who enforces:** if the provider is Resend (inferred), its AUP shuts accounts above a **4% bounce or 0.08% complaint
  rate**, with no warning required. The account at Resend is Naïve's, so Naïve would act on our org (Terms §13.2 lets
  Naïve suspend use that risks the Service or other users).

### 3.9 Pricing

| Item | Price | Source |
|---|---|---|
| Outbound email | **$0.0008 per send call however many recipients**, booked after provider acceptance. Below that balance: `402 insufficient_credits` before sending. | https://usenaive.ai/docs/platform/pricing.md; **live:** `GET /v1/agents/agt_zx12…/spend?by=component` → `email: 49600` µUSD for 62 sends (800 each) |
| Inbound email | No per-message fee. A woken session pays model tokens like any session. | inbound.md, section What it costs |
| System domain | Free | identity/domains.md |
| Purchased domain | Quote-dependent (illustrative ceiling $12). Debited from Naïve credits, not a card. Auto-renew off. | api/domains.md, sdk/domains.md |
| Agent-sent cold email, all-in | **$0.0125/email** live ($0.772 for 62 sends over 4 Sonnet 5 sessions: $0.071, $0.187, $0.332, $0.182) | `GET /v1/credits/spend?agent_id=…` |
| Plan | Standard $20/mo or Pro $200/mo required for every non-billing route | pricing.md |

### 3.10 Terms and policy

**Naïve Terms of Service** (https://usenaive.ai/terms, Relixir, Inc., last updated 2026-10-28). There is no separate
acceptable-use or email policy page.
- §4.1 Permitted use: lawful business purposes. The Service is described as AI automation for marketing, content, SEO,
  sales, software and commerce. Sales outreach fits the stated purpose.
- §4.2 Restrictions include the one line that matters here: "Use the Service to generate spam, misleading content, or
  content that violates third-party rights". Spam is not defined. Also: no unlawful use (so CAN-SPAM, GDPR and PECR
  apply through the "unlawful" clause), no circumventing usage or rate limits, and realistic AI-generated content
  published without the AI disclosure that the platform or law requires is prohibited. **Disclosure is the customer's
  responsibility.**
- §5.1 We are responsible for reviewing and approving agent actions before they take effect in production contexts.
- §13.2 Naïve may suspend or terminate for violations or where use risks the Service or other users, with notice where possible.
- §18 (People, Company & Social Data features) requires business-to-business use only and makes us controller of
  personal data obtained through them. That covers how we find contacts, not the email itself.
- **Verdict for one personalised, relevant, AI-disclosed, opt-out email per business at low volume:** *not forbidden in
  so many words, not explicitly allowed either*. Naïve's own docs model the use case: the example persona is an outbound
  SDR persona for prospecting (identity/overview.md, personas.md), and the site lists templates that do candidate
  outreach. Naïve imposes no AI-disclosure or opt-out-header rule of its own beyond the law.

**The underlying provider (inferred).** The record pattern in §3.2 is Resend's. Resend's AUP
(https://resend.com/legal/acceptable-use, 2026-10-13), paraphrased: under *Prohibited Sending Purposes → Spamming* it
bans unsolicited messages of any kind and names **cold outreach**, purchased lists and scraped contacts. *Appropriate
Mailing Lists* requires recipients who explicitly opted in. Bulk sends must carry a valid address and company name, say
why the recipient is being contacted, and offer frictionless opt-out honoured within 7 days. Complaint rate must stay
below 0.08% and bounce rate below 4%, or the account may be shut down without warning. We have no contract with Resend,
but Naïve does, and our mail goes out under Naïve's `usenaive.ai` apex. **Practical reading: cold outreach through
Naïve email is the same policy exposure as through AgentMail, moved one layer down.** A purchased or BYOD domain changes
the From domain but not the provider (the "email layer" is the same for every kind).

## 4. Live findings (detail)

Agent `terragent-outreach`: 4 sessions, all created over the API (`deployment_id: null`), all with
`identity_id: idn_9zr1…`, all `idle / end_turn` at 01:38 UTC, none `awaiting_approval`:

| Session | Created (UTC) | Cost | `email.send` calls (ok / 429 / bad `from`) |
|---|---|---|---|
| `ses_22emm27fzec3z3pq9chrdkmgam` | 00:59:12 | $0.071 | 8 / 0 / 0 |
| `ses_fqrxmfmaqz6gwy4s4011jdwbn3` | 01:24:09 | $0.187 | 18 / 8 / 0 |
| `ses_gt0s4s9qs1yffmh9ghwsr72j06` | 01:25:53 | $0.332 | 18 / 8 / 18 |
| `ses_a65468s7tnbn7t1pbch016arp9` | 01:28:34 | $0.182 | 18 / 8 / 0 |

- `/sent`: **62 messages, 62 distinct recipients, 1 recipient each**, first 00:59:40, last 01:29:55. All have
  `sent_by_agent_id: agt_zx12…` and `actor: null`. No duplicate recipient despite up to 3 attempts per address (failed
  attempts aren't sent).
- Targets: business role addresses (info@, claims@, hello@, ir@…) across flood claims (Verde Valley flood, Isaias),
  Phase I ESA consultants, ag lenders and crop insurers, construction-draw lenders, EUDR coffee/cocoa traders, mineral
  explorers and land sellers. Eleven subject lines.
- Bodies (text only, 661-778 chars, no links) end with
  `Terragent` / `Sent by Terragent's AI agent from 459 Lagunita Drive, Stanford, CA 94305; reply "stop" to opt out.`
  All 62 carry the AI disclosure and the reply-stop opt-out. None names hello@ or links an unsubscribe page. Several ask
  a multiple-choice pricing question (four price bands, a to d), which is market research inside a cold email.
- Inbound: 1 auto-reply (held, no wake). No human replies yet. **Any human reply will wake `terragent-outreach`, and it
  will answer autonomously** (`email.send: allow`), subject to the unverified flag question in §3.7.
- Org balance after all this: 249,985,519 µUSD ($249.99) (`GET /v1/organizations`).

## 5. Discrepancies with the master prompt, NOTES and other docs

| # | Says | Reality (source) | Impact |
|---|---|---|---|
| 1 | NOTES 2026-11-08: a native inbox needs a verified domain, "so this likely needs a domain purchase". | Free `system` domain, already active (§2.1; identity/domains.md). | No purchase or founder approval needed to start. Buying a domain is optional (reputation isolation from `usenaive.ai`, nicer From). |
| 2 | NOTES 2026-11-08 plan: "Reply-To hello@ so replies land in AgentMail intake". | Send body is exactly `{to, subject, text}`; unknown keys are refused; the agent tool has no reply-to either (OpenAPI `sendEmail`; api/overview.md versioning). | Replies land in the Naïve inbox. Options: let the outreach agent answer (current), or `wake:false` + server poll → card for comms-customer; mention hello@ in the body text. |
| 3 | NOTES 2026-11-08 plan: sends still go through our MCP gateway so the code gates apply. | Live agent calls `email.send` directly at `allow`; the gateway is bypassed (§2.1, §4). | To make the gates real, `deny` `email.send` on the agent and send from the gateway over REST (§3.5), or set it to `ask`. |
| 4 | NOTES decision 4 (2026-11-08): email outreach stays blocked (`missing_postal_address`) until a founder sets `COMPANY_POSTAL_ADDRESS`; H8 template approval by a founder. | 62 sends already went out with a Stanford street address in the footer, outside the app (no `outreach_touches` rows, no template id). | A founder must confirm the address is one where the company actually receives mail (CAN-SPAM), and the touches should be back-filled into the dashboard log. |
| 5 | Spec §4.1: no custom domain, "skip domains". Spec §4.2: don't run Naïve identity email alongside AgentMail. | Superseded by the founder's 2026-11-08 decision. The system domain isn't custom or purchased. | Update spec §4.1/§4.2 when the design docs land. |
| 6 | Spec §8: every outbound email has an opt-out **link**. | No List-Unsubscribe header possible. A plain-text URL is possible; today's emails use reply-"stop" only. | Add a plain-text `https://<app>/unsubscribe?t=<opaque token>` line; process "stop" replies from the inbound feed. |
| 7 | naive-orchestration.md §3.9: no functional impact for Terragent, because we use AgentMail. | Now relevant: the outreach inbox is a Naïve inbox with `wake: true`. | Read §3.6 here instead. |
| 8 | identity/domains.md: the system domain is created at signup. The same page and api/domains.md: minted with one call. | Live: minted 2026-11-08 00:56, five hours after the org was created (2026-11-07 19:41). | On demand, not at signup. |
| 9 | sdk/emails.md: `messages(identityId, { channel, limit })`. | OpenAPI also accepts `after`; d.ts lacks it (8260); `identities.messages` takes only `channel`. | Page with raw `fetch` or the exported `send` helper. |
| 10 | capabilities/tools.md: `email.send` sends plain text from one of the identity's inboxes (no `from` format given). | The tool's `from` must be the `eml_` id, not the address (live validation error). | Tell agents to call `email.inboxes` first or omit `from`. |
| 11 | cli/comms.md: outbound may answer `501 feature_not_configured`. | Configured in production: sends succeed. | None. |
| 12 | Founder premise: move cold email to Naïve because AgentMail forbids it. | Naïve's provider (inferred: Resend) forbids cold outreach by name (§3.10). | Same policy risk; get Naïve's written OK. |

## 6. Credentials needed

| Need | Scope | Key that has it |
|---|---|---|
| Send from the inbox (server) | `sessions:write` | `vercel-runtime` (`VETTA_DEPLOY_API_KEY`), `main2` |
| Read inbound feed, mark read, read `/sent` | `agents:write` | `vercel-runtime`, `main2` (not the read-only `app store` key) |
| Toggle `wake`, create/delete inbox, identity, grant, system/BYOD domain | `agents:write` | `vercel-runtime`, `main2` |
| List identities, domains, inboxes, records | `agents:read` | all three keys |
| Quote a domain | `billing:read` | `vercel-runtime`, `main2` |
| Buy a domain (charges Naïve credits) | `billing:write` | `main2` only (keep it local) |

No new credential is needed. Founder action is limited to the decisions in §9.

## 7. Gotchas & limits

1. **Email tools exist only in sessions whose selected identity owns an inbox.** A cron deployment without `identity`,
   a plain `sessions.create` without `identity`, and (unverified) board-assigned or delegated sessions get no `email.*`.
2. `email.send` is ask-by-default. At `allow` nothing checks the content: what the model writes goes out.
3. One send with several `to` addresses shows every recipient to the others (no bcc) and still bills once. Always use
   one recipient per send.
4. **Never fire sends in parallel.** The email layer answers 429 to bursts. Send sequentially, about 1 per second, and
   retry 429s with backoff. Retries through the agent tool have no idempotency key, so a retry after an ambiguous
   failure could double-send. Over REST, send a fixed `Idempotency-Key`.
5. Keys are kept forever and bound to method + path + body. Reusing one with a different body gives
   `409 idempotency_conflict`. A non-2xx releases the key.
6. **Opt-outs can be held by a guard.** A "stop" sent twice in an hour, from an auto-responder, or as the 11th thread
   turn is stored but never wakes the agent. Our server must poll `/messages` (all of them, including guarded ones),
   honour every opt-out into one suppression table shared with AgentMail, and mark each processed message read.
7. Owner is fixed at inbox creation. Deleting the identity deletes its inboxes. Deleting the domain silences all of them.
8. The system zone is list-only: no stricter DMARC (`p=none` is fixed), no BIMI, no custom records. The organizational
   domain is `usenaive.ai`, so our reputation is pooled with every other Naïve org's system mail.
9. No visibility into delivery, bounces, spam placement or complaints. `accepted: true` only means the provider took it.
10. Inbound is text only. Customers' attachments and html never reach us, so keep **customer intake on AgentMail**
    (hello@, data@), which has attachments, threads and Agent Armor.
11. Reading `/messages` needs `agents:write`, a broader key than reading anything else.
12. A woken session draws on the owning agent's budget (`terragent-outreach`: $3 per task, $10 per month). If the cap
    is hit, wakes are refused, retried for 15 min, then left stored. Replies sit unanswered with no alert.
13. Calling `email.read` (or any people's-data read) in a chat makes every later send in it ask, and kills `bash`. Keep
    sending sessions read-free, or read on the server.
14. `sent_at` in `/sent` is provider acceptance, and failed attempts aren't listed. Count spend from `/v1/credits/spend`
    (`email` tier), not from tool calls.
15. Domain, identity and inbox changes aren't audit-logged (only `agent.updated` and similar). Keep our own log of who
    changed the email setup.

## 8. Unverified

1. **That the provider is Resend.** Inferred only from DNS record names and targets. The inbound MX
   (`receive.forge.rmta.net`) and `rsend` CNAME (`send.forge.rmta.net`) belong to an unidentified operator. Ask Naïve.
2. **Whether Naïve accepts our cold-outreach use** (and would enforce Resend's AUP or thresholds against our org). Ask in
   writing, describing exactly what was sent (§4).
3. Whether unknown keys such as `reply_to`, `html` or `headers` are refused on `sendEmail`. The documented version rule
   says yes; the OpenAPI schema for this body doesn't set `additionalProperties: false` (the PATCH body does). Not
   tested, since testing means sending.
4. The From display name recipients see (no field to set it; maybe the persona name, maybe the bare address).
5. Whether `Idempotency-Key` dedupes the send route, and whether it must be a UUID.
6. Inbox placement and spam-folder rate for a new `*.usenaive.ai` subdomain with `p=none` and no warm-up.
7. Whether an inbound-woken session counts as having "read people's data" (which would make its `email.send` ask each
   time), and whether server-pasted mail flags a session.
8. Whether board-card or delegated sessions of an identity-holding agent get the persona (and so the email tools).
9. Where hard bounces and complaints go after the provider, and whether Naïve suppresses those addresses org-wide.
10. Thread headers (In-Reply-To/References) on agent replies. The marketing page claims threads stay intact; no API
    field supports it.
11. The REST status code for the provider's 429 (the tool surfaced it as an error string).
12. Real price of a purchased domain (needs `POST /v1/domains/quote`, which this GET-only pass didn't call), and maximum
    `limit` on `/messages` (100 worked on `/sent`).
13. `email.read` argument names.

## 9. Implications for the stack change (input to email-stack-change.md / cold-email-compliance.md)

- **Cold outbound on Naïve works today** with no purchase: identity "Terragent", inbox `outreach@terragent-qqhrnj.usenaive.ai`,
  agent `terragent-outreach`. AgentMail stays for intake (hello@, data@) and replies to people who wrote to us first.
  `terragent-outreach@agentmail.to` can then stop sending cold mail.
- **Choose one cold-send path:**
  (a) the **agent sends** (`email.send`): "sent by a Naïve agent" literally, but it bypasses our code gates, costs about
  15 times more, and has no idempotency; or
  (b) the **agent drafts and our gateway sends over REST on the agent's identity inbox** (same From, same `/sent` log,
  `actor` = key): suppression, caps, approved template, idempotency, postal address and AI disclosure are all
  enforced in code. Recommended: (b), with `email.send` set to `deny` on the agent (or `ask` for one-offs).
- **Replies:** decide between `wake: true` (the outreach agent answers strangers autonomously, at Sonnet prices) and
  `wake: false` + a server poll every few minutes. The poll turns each reply into a board card for comms-customer and
  feeds every "stop" into the shared suppression table. The poll is needed either way for guarded messages.
- **Before more sends:** get the Naïve team's written answer (Unverified 1-2). Keep volume low and verify addresses,
  since bounces are invisible to us. Back-fill the 62 sends into the touch log.

# AgentMail — verified platform reference (Terragent)

Status: COMPLETE (research pass 2026-11-07). Every TS snippet in §3 (incl. the Next.js route) was type-checked with `tsc 5.9.3 --strict` against `agentmail@0.5.53` + `svix@2.9.1`; webhook sign/verify/parse behaviour was exercised locally with a fake, locally generated secret.
Evidence base: docs fetched 2026-11-07 from https://docs.agentmail.to (llms.txt + `.md` pages + openapi.json), pricing from https://www.agentmail.to/pricing.md, npm `agentmail@0.5.53` `.d.ts` files (paths below are relative to `node_modules/agentmail/dist/cjs/`). No API key was available, so no live authenticated calls were made.

## 1. TL;DR for builders
- `npm i agentmail svix` → `import { AgentMailClient, AgentMail, AgentMailError, serialization } from "agentmail"`; `new AgentMailClient({ apiKey: process.env.AGENTMAIL_API_KEY })`. TS fields are camelCase; wire/webhook JSON is snake_case.
- 5 calls: `am.inboxes.create({ username, displayName, clientId })` · `am.inboxes.messages.send(inboxId, { to, subject, text, html, attachments }, { idempotencyKey })` · `am.inboxes.messages.reply(inboxId, messageId, { text, html, attachments }, { idempotencyKey })` · `am.webhooks.create({ url, eventTypes: ["message.received", …], inboxIds, clientId })` · `am.lists.create("send", "block", { entry, reason })` (opt-outs).
- `inboxId` IS the email address (`terragent-hello@agentmail.to`); `messageId` is an RFC Message-ID with angle brackets (`<…@…>`). There is no top-level `am.messages`.
- `hello@` / `data@` / `outreach@agentmail.to` are almost certainly taken (usernames are global on the shared domain → `403 resource_taken`, no auto-suffix). Use e.g. `terragent-hello`, and handle the error.
- Free plan = exactly 3 inboxes, 100 emails/day, 3,000/month, "Sent via AgentMail" footer, and (per docs, at least for agent-created orgs) a new-account ramp of 3/5/10 distinct new recipients in the first hour/day/week.
- **AgentMail ToS forbids cold outreach** (KB: "AgentMail does not support cold outreach"). The `outreach@` signal-engine plan conflicts with this — see §4. Bounces/complaints can suspend the whole org (inbound keeps working, sends stop).
- Webhooks are Svix-signed (`svix-id`/`svix-timestamp`/`svix-signature`, secret `whsec_…` = `webhook.secret`). **svix 2.x `verify()` returns `undefined`** — JSON.parse the raw body yourself. SDK `parseOrThrow` is strict and throws on unknown keys — use `.parse(p, { unrecognizedObjectKeys: "passthrough" })`.
- Webhook must 2xx within 15 s; at-least-once, unordered → dedupe on `event_id`. Body inline only ≤ 64 KiB (else `body_url`). Read `extracted_text` (reply without quoted history), fall back to `text`, then `html`.
- Always pass `idempotencyKey` on sends: the SDK auto-retries 5xx/408/429 (2 retries) and a retried send without a key can go out twice.
- Attachments: base64 `content` (whole request ≤ 6 MB) or `url` (~30 MB total). MCP: `https://mcp.agentmail.to/mcp` (Streamable HTTP, `x-api-key` header **or `Authorization: Bearer am_…`** — both routed identically, so a Naïve vault `static_bearer` works; see §3.10 (critic-verified)).

## 2. Install & setup

- TypeScript: `npm install agentmail` — verified `agentmail@0.5.53` (npm `latest`, modified 2026-11-06, repo github.com/agentmail-to/agentmail-node, dep `ws@^8.20.0`). Dual CJS/ESM, types included. Fern-generated SDK.
- Python: `pip install agentmail` — verified `agentmail==2.0.25` on PyPI (uploaded 2026-11-06, requires Python >=3.10,<4.0; repo github.com/agentmail-to/agentmail-python). Python and TS versions are numbered independently. Python: `from agentmail import AgentMail, AsyncAgentMail`; `client.inboxes.messages.send(inbox_id, to=..., subject=..., text=..., html=..., attachments=[...], idempotency_key=...)`; `client.inboxes.create(request=CreateInboxRequest(username=..., display_name=..., client_id=...))` (`from agentmail.inboxes import CreateInboxRequest`). Source: PyPI JSON https://pypi.org/pypi/agentmail/json; `inspect.signature` on the installed 2.0.25 package.
- Webhook verification lib: `svix` — verified npm `svix@2.9.1` (latest; 2.0.0 shipped 2026-08-19; last 1.x is 1.99.1) and PyPI `svix==2.9.1`. In both, `Webhook.verify()` returns nothing (TS `undefined`, Python `None`) — see §3.5.
- MCP stdio bridge (optional): npm `agentmail-mcp@1.1.0`, PyPI `agentmail-mcp==1.0.0`.
- Toolkit (optional, not needed): npm `agentmail-toolkit@0.18.0` (Vercel AI SDK tools).
- Env var: `AGENTMAIL_API_KEY` — the TS SDK reads it automatically when `apiKey` is omitted (`auth/BearerAuthProvider.js:50` `const ENV_TOKEN = "AGENTMAIL_API_KEY"`; also `wrapper/Client.js:100`). Keys start with `am_` (Source: https://docs.agentmail.to/errors.md `invalid_token_type`).
- Base URL: `https://api.agentmail.to` (REST, all paths under `/v0/...`), WebSockets `wss://ws.agentmail.to`. EU: `https://api.agentmail.eu` / `wss://ws.agentmail.eu` (Enterprise only per pricing). Source: `environments.d.ts`.
- Auth header: `Authorization: Bearer am_...` (case-sensitive `Bearer `). Source: errors.md `missing_authorization`.

```ts
import { AgentMailClient, AgentMail } from "agentmail"; // AgentMail = namespace of types
const am = new AgentMailClient({ apiKey: process.env.AGENTMAIL_API_KEY! });
// options (BaseClient.d.ts:4-18): environment, baseUrl, headers, timeoutInSeconds, maxRetries (default 2), fetch, logging
```
Source: `index.d.ts` (exports `AgentMailClient` from `./wrapper`, `AgentMail` namespace, `AgentMailEnvironment`, `AgentMailError`, `AgentMailTimeoutError`); `wrapper/Client.d.ts:7-28`; `BaseClient.d.ts:4-18`.

**Import trap:** `webhook-verification.md` shows `import AgentMail from "agentmail"; new AgentMail()` — wrong for TS: there is no default export and `AgentMail` is a types namespace. Use `new AgentMailClient()` (`index.d.ts`).

**Casing trap:** the TS SDK uses camelCase (`inboxId`, `displayName`, `clientId`, `threadId`), the wire/REST/Python use snake_case (`inbox_id`, `display_name`). Several doc snippets mix them (e.g. inboxes.md uses `newInbox.id` and `retrievedInbox.inbox_id` in TS — both wrong for TS; the field is `inbox.inboxId`).

## 3. API reference

### 3.1 Inboxes

Top-level client resources (`Client.d.ts:44-59`): `inboxes, pods, webhooks, accounts, agent, apiKeys, apps, auth, domains, drafts, forwarding, lists, metrics, organizations, threads, websockets`. **There is no top-level `messages`** — messages live at `client.inboxes.messages` (`api/resources/inboxes/client/Client.d.ts:37-48`: `threads, messages, drafts, webhooks, lists, forwarding, metrics, events, apiKeys, accounts, calendar, files`).

```ts
// POST /v0/inboxes
const inbox = await am.inboxes.create({
  username: "terragent-hello",      // optional; random if omitted (e.g. "cleverstar482")
  domain: "agentmail.to",           // optional; default "agentmail.to"
  displayName: "Terragent",          // optional; default display name is "AgentMail"
  clientId: "terragent-hello-v1",    // optional idempotency key: same clientId => returns the same inbox (no '@' allowed)
  metadata: { role: "comms2" },      // optional; <=256 keys, keys/string values <=256 chars; values string|number|boolean
  signature: { text: "…", html: "…" } // optional; text<=1000 chars, html<=4000 chars; appended to every send/reply/forward
  // also: status?: "active"|"deactivated", deactivateAt?: Date
});
inbox.inboxId; // === the email address, e.g. "terragent-hello@agentmail.to"
inbox.email;   // same address
inbox.podId;   // every inbox belongs to a pod (default pod if none given)
// Inbox fields: podId, inboxId, email, displayName?, clientId?, status?, deactivateAt?, signature?, metadata?, updatedAt: Date, createdAt: Date

await am.inboxes.get(inboxId);                         // GET /v0/inboxes/{inbox_id}
await am.inboxes.list({ limit, pageToken, ascending }); // GET /v0/inboxes -> { count, limit?, nextPageToken?, inboxes: Inbox[] } (created_at desc)
await am.inboxes.update(inboxId, { displayName, status, deactivateAt, signature, metadata }); // PATCH; at least one field required
await am.inboxes.delete(inboxId);                       // DELETE -> 202, async; 409 resource_deleting while running; poll get() until 404
await am.inboxes.search({ q: "hello" });                // GET /v0/inboxes/search (prefix-word match, limit<=100)
```
Source: `api/resources/inboxes/client/Client.d.ts:61-156`; `api/resources/inboxes/types/{CreateInboxRequest,Inbox,UpdateInboxRequest,ListInboxesResponse,Metadata,InboxSignature,InboxStatus}.d.ts`; https://docs.agentmail.to/api-reference/inboxes/create.md; https://docs.agentmail.to/knowledge-base/creating-first-inbox.md.

**Address availability on the shared domain (critical for hello@/data@/outreach@):** usernames on `agentmail.to` are global across all AgentMail customers. If another customer has the username you get `403 resource_taken` ("The address is not available to your organization, usually because another AgentMail user already has that username on agentmail.to"), sometimes with a `suggestions` field listing available usernames. Your own org already having it: `403 already_exists` (use the same `clientId` to get it back instead). Plan limit hit: `403 limit_exceeded` (Free = 3 inboxes). Names are NOT randomised/suffixed when you pass `username` — the call fails instead. `hello@agentmail.to`, `data@agentmail.to`, `outreach@agentmail.to` are near-certainly taken; use prefixed usernames (e.g. `terragent-hello`, `terragent-data`, `terragent-outreach`) and handle `resource_taken` by trying a fallback. Source: https://docs.agentmail.to/knowledge-base/creating-first-inbox.md ("Common issues" table); https://docs.agentmail.to/errors.md `resource_taken`, `already_exists`.

### 3.2 Sending a new message (starts a new thread)

```ts
// POST /v0/inboxes/{inbox_id}/messages/send
const sent = await am.inboxes.messages.send(
  "terragent-hello@agentmail.to",                 // inbox_id = the sending inbox's address
  {
    to: "customer@example.com",                   // string | string[]   (Addresses)
    cc: ["founder@example.com"],                  // optional, string | string[]
    bcc: undefined,                               // optional
    replyTo: "terragent-hello@agentmail.to",      // optional, string | string[]
    subject: "Your Terragent quote",
    text: "Plain text body …",                    // send BOTH text and html (docs recommendation)
    html: "<p>HTML body …</p>",
    labels: ["quote", "playbook:disasters"],      // string[]; your own labels
    attachments: [{                               // SendAttachment[]: provide content OR url
      filename: "report.pdf",
      contentType: "application/pdf",
      content: pdfBuffer.toString("base64"),      // base64
      // url: "https://…/report.pdf",             // alternative: AgentMail downloads it (no auth headers/cookies; redirects + presigned OK)
      // contentDisposition: "inline" | "attachment", contentId: "cid…" (inline images)
    }],
    headers: { "X-Terragent-Request": "req_123" }, // Record<string,string> custom headers
    // trackOpens: true  // requires a CUSTOM domain with tracking enabled -> not usable for us
  },
  { idempotencyKey: "quote-req_123-v1" },          // 3rd arg MessagesClient.IdempotentRequestOptions -> sends `Idempotency-Key` header
);
sent.messageId; // RFC Message-ID string, e.g. "<abc123@agentmail.to>" (angle brackets included)
sent.threadId;  // thread id
```
- `SendMessageRequest` fields (all optional in the type): `labels, replyTo, to, cc, bcc, subject, text, html, attachments, headers, trackOpens`. Response `SendMessageResponse { messageId, threadId }`. Source: `api/resources/messages/types/SendMessageRequest.d.ts:2-14`, `SendMessageResponse.d.ts:2-5`, `Addresses.d.ts` (`string | string[]`), `SendMessageHeaders.d.ts`, `TrackOpens.d.ts`; method `api/resources/inboxes/resources/messages/client/Client.d.ts:265`.
- Errors thrown: `ValidationError` (400), `NotFoundError` (404), `ConflictError` (409: idempotency key in flight / reused with a different body), `MessageRejectedError` (**every** 403 on send/reply/forward — branch on `body.code`: `message_rejected` = recipient on a send block list / not on an active allow list / unfetchable attachment URL; `account_suspended`, `inbox_suspended`, `pod_suspended` (with `suspended_reason`); `inbox_deactivated`; `missing_permission`). `413 {"message":"Request Entity Too Large"}` (no `code`) for > 6 MB inline. `429 rate_limit_exceeded` for daily/recipient limits. A send with no recipient in to/cc/bcc → 422 `unprocessable`. Source: Client.d.ts JSDoc; `messages/client/Client.js:1041`; https://docs.agentmail.to/errors.md (`message_rejected`, `account_suspended`, `inbox_deactivated`, 413 section, `rate_limit_exceeded`).
- Max **50 recipients** combined across to+cc+bcc per send/reply. Source: https://docs.agentmail.to/messages.md (Warning box).
- **Free tier appends a "Sent via AgentMail" footer** to every message (removed on paid plans). Source: messages.md; pricing.md.
- Idempotency: `Idempotency-Key` header (TS: `{ idempotencyKey }` request option, or `{ headers: { "Idempotency-Key": k } }` as the docs show). Retry with same key → original `message_id`/`thread_id`, no second email; same key + different request → 409; empty key → 400; keys org-scoped, expire 24 h after send; charset `A-Z a-z 0-9 - . _ ~`, 1–256 chars. Source: https://docs.agentmail.to/idempotency.md; `BaseClient.d.ts:31-33` (`BaseIdempotentRequestOptions { idempotencyKey?: string }`).
- Attachments: inline base64 `content` → whole request ≤ **6 MB** (else `413`); `url` attachments → ~**30 MB** combined per message. Source: `api/resources/attachments/types/SendAttachment.d.ts`; https://docs.agentmail.to/attachments.md ("Attachment size limits"). For a PDF report > ~4 MB raw (base64 inflates ×1.33), host it (e.g. Vercel Blob / Naïve Files presigned URL) and pass `url`.

### 3.3 Replying in a thread

```ts
// POST /v0/inboxes/{inbox_id}/messages/{message_id}/reply
const r = await am.inboxes.messages.reply(
  "terragent-hello@agentmail.to",   // inbox you reply FROM (the one that received it)
  inboundMessageId,                 // e.g. "<CAF…@mail.gmail.com>" from the webhook payload
  {
    text: "…", html: "<p>…</p>",
    attachments: [{ filename: "report.pdf", contentType: "application/pdf", content: b64 }],
    labels: ["delivered"],
    // also: replyTo, to, cc, bcc (override recipients), replyAll?: boolean, headers, trackOpens
  },
  { idempotencyKey: `reply-${sha256(inboxId + ":" + inboundMessageId)}` },
); // -> { messageId, threadId }  (threadId == original thread)

await am.inboxes.messages.replyAll(inboxId, messageId, { text, html, attachments, labels, replyTo, headers }); // POST …/reply-all
await am.inboxes.messages.forward(inboxId, messageId, { to, subject?, text?, html?, … }); // POST …/forward (SendMessageRequest)
```
- `ReplyToMessageRequest`: `labels, replyTo, to, cc, bcc, replyAll, text, html, attachments, headers, trackOpens` — **no `subject`** (AgentMail derives it). `ReplyAllMessageRequest`: `labels, replyTo, text, html, attachments, headers, trackOpens`. Source: `api/resources/messages/types/ReplyToMessageRequest.d.ts`, `ReplyAllMessageRequest.d.ts`; Client.d.ts:286,307,328.
- Threading headers are automatic: "AgentMail handles threading automatically using standard email headers (`Message-ID`, `In-Reply-To`, `References`)" — you never set In-Reply-To yourself; reply via the `reply` endpoint with the inbound `message_id`. Replies by the customer to our sent mail land in the same `thread_id`. Source: https://docs.agentmail.to/knowledge-base/threaded-conversations.md.
- Reply to the **latest** message of the thread (KB recommendation). Inbox id in reply = the inbox you send FROM (messages.md note).

### 3.4 Reading messages and threads

```ts
const msg = await am.inboxes.messages.get(inboxId, messageId);          // GET …/messages/{message_id} -> Message
const list = await am.inboxes.messages.list(inboxId, { limit: 20, labels: ["unread"] }); // -> { count, limit?, nextPageToken?, messages: MessageItem[] } (timestamp desc)
await am.inboxes.messages.update(inboxId, messageId, { addLabels: ["handled"], removeLabels: ["unread"] });
await am.inboxes.messages.batchUpdate(inboxId, { messageIds: [...], addLabels: [...], removeLabels: [...] }); // up to 50 messages
const att = await am.inboxes.messages.getAttachment(inboxId, messageId, attachmentId); // JSON, NOT bytes
const bytes = Buffer.from(await (await fetch(att.downloadUrl)).arrayBuffer()); // downloadUrl expires at att.expiresAt
const raw = await am.inboxes.messages.getRaw(inboxId, messageId);       // signed URL to .eml

const thread = await am.inboxes.threads.get(inboxId, threadId, { limit: 100 }); // or org-wide: am.threads.get(threadId, {limit, pageToken})
// Thread: inboxId, threadId, labels, timestamp, receivedTimestamp?, sentTimestamp?, senders, recipients, subject?, preview?,
//         attachments?, lastMessageId, messageCount, size, updatedAt, createdAt, count, limit?, nextPageToken?, messages: Message[]
// PAGING TRAP: first page = NEWEST messages; within a page ascending by timestamp; follow nextPageToken for OLDER pages.
await am.inboxes.threads.list(inboxId, { labels: ["unread"], senders: [...], subject: [...], limit, pageToken });
await am.threads.list(); // org-wide across all inboxes
```
`Message` fields (TS): `inboxId, threadId, messageId, labels: string[], timestamp, from: string, replyTo?: string[], to: string[], cc?, bcc?, subject?, preview?, text?, html?, extractedText?, extractedHtml?, attachments?: Attachment[], inReplyTo?, calendarEventId?, trackOpens?, openedAt?, references?: string[], headers?: Record<string,string>, authenticationResults?, agentArmor?, size, updatedAt, createdAt`. `MessageItem` (list results) = same minus `text/html/extractedText/extractedHtml/replyTo` — **list results have no body; call `get` for the body**. `Attachment { attachmentId, filename?, size, contentType?, contentDisposition?: "inline"|"attachment", contentId? }`. `AttachmentResponse` adds `downloadUrl, textUrl?, expiresAt`. `from` is `"Name <addr>"` or bare `addr` — parse it.
Source: `api/resources/messages/types/{Message,MessageItem,MessageFrom,MessageTo,ListMessagesResponse,UpdateMessageRequest}.d.ts`; `api/resources/threads/types/Thread.d.ts`; `api/resources/attachments/types/{Attachment,AttachmentResponse}.d.ts`; `api/resources/inboxes/resources/threads/client/requests/GetInboxThreadRequest.d.ts` (limit ≤100); `api/resources/inboxes/resources/messages/client/requests/ListMessagesRequest.d.ts`; https://docs.agentmail.to/attachments.md.
- `extracted_text` / `extracted_html`: only the new reply content (quoted history + trailing boilerplate stripped). Use `msg.extractedText ?? msg.text`. For forwarded mail read `text`/`html` (extraction can drop forwarded content). Source: messages.md; reply-extraction.md.
- System label `unread` is added to every received message; `replied`/`resolved` etc. are your own. Source: threaded-conversations KB.

### 3.5 Webhooks (inbound email trigger)

Create (org-level, optionally filtered to inboxes/pods):
```ts
// POST /v0/webhooks
const wh = await am.webhooks.create({
  url: "https://terragent.vercel.app/api/agentmail/webhook",
  eventTypes: ["message.received", "message.bounced", "message.complained", "message.rejected", "message.delivered"], // REQUIRED, non-empty, no "all" default
  inboxIds: ["terragent-hello@agentmail.to", "terragent-data@agentmail.to", "terragent-outreach@agentmail.to"], // optional; max 10 inboxes+pods combined
  // podIds: ["pod_…"],
  clientId: "terragent-webhook-v1",         // idempotent create
  headers: { "X-Terragent-Hook": "…" },      // optional custom delivery headers (write-only)
});
wh.webhookId; wh.secret; /* "whsec_…" signing secret */ wh.enabled;
// Webhook fields: webhookId, url, eventTypes?, podIds?, inboxIds?, podId?, inboxId?, secret, enabled, updatedAt, createdAt, clientId?
await am.webhooks.list(); await am.webhooks.get(id); await am.webhooks.delete(id);
await am.webhooks.update(id, { eventTypes, enabled: true, addInboxIds, removeInboxIds, addPodIds, removePodIds }); // eventTypes REPLACES list; [] => 400
await am.inboxes.webhooks.create(inboxId, { url, eventTypes, clientId?, headers? }); // inbox-scoped variant
await am.pods.webhooks.create(podId, { url, eventTypes, inboxIds?, clientId?, headers? }); // pod-scoped variant
```
Source: `api/resources/webhooks/client/Client.d.ts:28-130`; `api/resources/webhooks/types/{CreateWebhookRequest,CreatePodWebhookRequest,CreateInboxWebhookRequest,CreateWebhookEventTypes,Webhook,WebhookHeaders,UpdateWebhookRequest,UpdatePodWebhookRequest}.d.ts`; https://docs.agentmail.to/webhooks-overview.md.

**Event types (complete enum, 20 values)** — `api/resources/events/types/EventType.d.ts`:
`message.received`, `message.received.spam`, `message.received.blocked`, `message.received.unauthenticated`, `message.security.completed`, `message.security.review`, `message.security.override`, `message.sent`, `message.delivered`, `message.bounced`, `message.complained`, `message.rejected`, `message.opened`, `domain.verified`, `calendar.event.created`, `calendar.event.updated`, `calendar.event.deleted`, `calendar.event.responded`, `calendar.event.starting`, `calendar.event.ending`.
- spam/blocked/unauthenticated mail is NOT sent as `message.received`; subscribe explicitly (needs `label_spam_read` / `label_blocked_read` / `label_unauthenticated_read` on the creating key). `message.security.*` needs `message_read`; `calendar.event.*` needs `calendar_event_read`. `message.opened` needs open tracking (custom domain only). Source: webhooks-overview.md "Available Events".

**Wire payloads are snake_case.** Envelope `{ type: "event", event_type, event_id, ... }`. Per type (SDK `api/resources/events/types/*.d.ts`, docs https://docs.agentmail.to/events.md):

| event_type | top-level object | fields (wire names) |
|---|---|---|
| `message.received` (+ `.spam`/`.blocked`/`.unauthenticated`) | `message` + `thread` | message: `inbox_id, thread_id, message_id, labels[], timestamp, from` (string `"Name <addr>"`), `reply_to?[], to[], cc?[], bcc?[], subject?, preview?, text?, html?, extracted_text?, extracted_html?, attachments?[{attachment_id, filename?, size, content_type?, content_disposition?, content_id?}], in_reply_to?, references?[], headers?{}, authentication_results?, agent_armor?, size, updated_at, created_at, body_url?, body_expires_at?`. thread: `inbox_id, thread_id, labels, timestamp, senders[], recipients[], subject?, preview?, attachments?, last_message_id, message_count, size, updated_at, created_at` |
| `message.sent` | `send` | `inbox_id, thread_id, message_id, timestamp, recipients: string[]` |
| `message.delivered` | `delivery` | `inbox_id, thread_id, message_id, timestamp, recipients: string[]` |
| `message.bounced` | `bounce` | `inbox_id, thread_id, message_id, timestamp, type` (e.g. "Permanent"), `sub_type` (e.g. "General"), `recipients: [{address, status}]` |
| `message.complained` | `complaint` | `inbox_id, thread_id, message_id, timestamp, type` (e.g. "abuse"), `sub_type`, `recipients: string[]` |
| `message.rejected` | `reject` | `inbox_id, thread_id, message_id, timestamp, reason` |

- Only `message.received*` carry message content. Body (`text/html/extracted_*`) is inline only if stored body ≤ **64 KiB**; otherwise `body_url` (presigned, valid 1 h) + `body_expires_at` are sent instead — or just call `messages.get`. `text` may be absent for HTML-only mail: fall back to `html`. Attachment bytes are never in the payload. Source: `api/resources/events/types/ReceivedMessage.d.ts`; webhooks-overview.md "Payload size limit"; events.md warning.
- `inbox_id` in real payloads should be the inbox address (SDK: `InboxId` = address; docs examples show placeholder `"inbox_456def"`). Treat as opaque and pass back verbatim.
- Delivery: success = `2xx` within **15 s** (redirects count as failure). Retries: immediately, 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h (8 attempts / ~27.5 h). Endpoint failing for **5 days → auto-disabled silently** (`enabled: false`); events while disabled are not redelivered. At-least-once: **dedupe on `event_id`** (same across retries and across webhooks), not `svix-id`. **No ordering guarantee.** Catch-up: `messages.list(inboxId, { after, ascending: true })`. Source: webhooks-overview.md "Delivery, retries, and missed events".

**Signature verification = Svix.** Headers: `svix-id`, `svix-timestamp` (unix seconds), `svix-signature` (space-delimited `v1,<base64>`). Secret = `webhook.secret` (`whsec_…`), per-webhook. Source: https://docs.agentmail.to/webhook-verification.md.

**TRAP (verified locally):** with current `svix@2.9.1` (npm latest; 2.0.0 released 2026-08-19), `new Webhook(secret).verify(payload, headers)` returns **`undefined`** (`verify(...): undefined` in `svix/dist/index.d.mts:4932`) and throws `WebhookVerificationError` on failure. The AgentMail docs' `const msg = wh.verify(...); msg.event_type` pattern only works with svix 1.x. Verify, then `JSON.parse(rawBody)` yourself. Local test (`/private/tmp/claude-504/-Users-laurence-terragent/22c3e839-95bd-4a29-a8d4-0ec9c4c36ffd/scratchpad/research/agentmail/scripts/verify-test2.mjs`, fake locally generated secret): verify returned `undefined`; tampered body → `WebhookVerificationError: No matching signature found`; 10-minute-old timestamp → `Message timestamp too old` (±5 min tolerance); `Object.fromEntries(request.headers)` works as the headers arg.

**TRAP (verified locally):** `serialization.events.MessageReceivedEvent.parseOrThrow(payload)` (the docs' TS parsing pattern) is **strict**: any key not in the SDK schema throws (`Unexpected key "organization_id"`). The webhooks-overview.md sample payload has such keys (`from_` array, `organization_id`, `sort_key`, attachment `inline`) and fails to parse. Use the lenient form `parse(payload, { unrecognizedObjectKeys: "passthrough", allowUnrecognizedEnumValues: true })` (returns `{ ok, value | errors }`), or read the raw snake_case JSON directly. The SDK parse converts to camelCase and turns timestamps into `Date`. Python is lenient: `agentmail.MessageReceivedEvent(**payload)` (2.0.25) accepted a payload with extra `organization_id`/`sort_key` keys; the sender is `event.message.from_` in Python. Source: `core/schemas/Schema.d.ts:46-76`; local test output (`scripts/verify-test2.mjs`, `scripts/py_parse.py`).

Next.js App Router handler (`app/api/agentmail/webhook/route.ts`) — type-checks under `tsc --strict` with agentmail@0.5.53 + svix@2.9.1:
```ts
import { Webhook } from "svix";               // npm i svix  (2.x: verify() returns void)
import { serialization, type AgentMail } from "agentmail";

export const runtime = "nodejs";               // svix + agentmail are Node libs; avoid edge
export const dynamic = "force-dynamic";

const wh = new Webhook(process.env.AGENTMAIL_WEBHOOK_SECRET!); // whsec_… from webhooks.create/get

export async function POST(req: Request) {
  const raw = await req.text();                // RAW body: do not req.json() before verifying
  try {
    wh.verify(raw, {
      "svix-id": req.headers.get("svix-id") ?? "",
      "svix-timestamp": req.headers.get("svix-timestamp") ?? "",
      "svix-signature": req.headers.get("svix-signature") ?? "",
    });
  } catch {
    return new Response("invalid signature", { status: 400 });
  }
  const payload = JSON.parse(raw) as { type: "event"; event_type: string; event_id: string; [k: string]: unknown };

  // Idempotency: AgentMail delivers at least once. Insert event_id into Neon with ON CONFLICT DO NOTHING; if 0 rows, return 200.
  // if (!(await recordEventOnce(payload.event_id))) return new Response("dup", { status: 200 });

  switch (payload.event_type) {
    case "message.received": {
      const r = serialization.events.MessageReceivedEvent.parse(payload, {
        unrecognizedObjectKeys: "passthrough", allowUnrecognizedEnumValues: true,
      });
      if (!r.ok) { console.error("agentmail parse", r.errors); break; }
      const ev: AgentMail.MessageReceivedEvent = r.value;
      const m = ev.message;
      const job = {
        inboxId: m.inboxId,                       // which of hello/data/outreach received it
        threadId: m.threadId,
        messageId: m.messageId,                   // pass to inboxes.messages.reply(inboxId, messageId, …)
        from: m.from,                             // "Jane <jane@x.com>" or "jane@x.com"
        subject: m.subject ?? "",
        body: m.extractedText ?? m.text ?? m.extractedHtml ?? m.html ?? "", // may be absent if > 64 KiB -> fetch below
        needsFetch: !!m.bodyUrl,
        attachments: (m.attachments ?? []).map(a => ({ id: a.attachmentId, filename: a.filename, type: a.contentType, size: a.size })),
        isReply: !!m.inReplyTo,
      };
      // Hand off quickly (must 2xx within 15 s): enqueue / create Naive board card / start Naive session, then return.
      // await startNaiveSession(job)   // keep it fast; do heavy work async
      break;
    }
    case "message.bounced": {
      const r = serialization.events.MessageBouncedEvent.parse(payload, { unrecognizedObjectKeys: "passthrough" });
      if (r.ok) {
        const addrs: string[] = r.value.bounce.recipients.map(x => x.address); // bounce.type "Permanent" | "Transient"
        // for (const a of addrs) await am.lists.create("send", "block", { entry: a, reason: "bounced" });
        void addrs;
      }
      break;
    }
    case "message.complained": {
      const r = serialization.events.MessageComplainedEvent.parse(payload, { unrecognizedObjectKeys: "passthrough" });
      if (r.ok) {
        const addrs: string[] = r.value.complaint.recipients; // plain strings here (bounce uses {address,status})
        // for (const a of addrs) await am.lists.create("send", "block", { entry: a, reason: "complained" });
        void addrs;
      }
      break;
    }
    default:
      break;
  }
  return new Response("ok", { status: 200 });
}
```
Store `AGENTMAIL_WEBHOOK_SECRET` from `wh.secret` right after `webhooks.create`. Return fast (<15 s); a Vercel function that awaits a full Naïve run will time out and get retried.

### 3.6 Alternatives to push webhooks

- **WebSockets** (`wss://ws.agentmail.to`): `const socket = await am.websockets.connect({ autoReconnect: true /*default*/, waitForOpen: true /*default*/ }); socket.on("open", () => socket.sendSubscribe({ type: "subscribe", inboxIds: [...], podIds?: [...], eventTypes?: [...] })); socket.on("message", ev => { if (ev.type === "event" && ev.eventType === "message.received") … });` Auto-reconnect: exponential backoff 1 s→60 s with re-subscribe; stops on 401/402/403. Without `eventTypes` you get everything except calendar events. WebSocket events omit the body if the serialized event > 30 KiB. Needs a long-running process (not Vercel serverless) — e.g. the Naïve sandbox computer. Source: `wrapper/WebsocketsClient.d.ts`; `api/resources/websockets/types/Subscribe.d.ts`; https://docs.agentmail.to/websockets.md; `ReceivedMessage.d.ts`.
- **Polling webhooks** (US region only): `const sub = await am.webhooks.polling.create({ clientId: "comms2", eventTypes: ["message.received"], inboxIds: [...] }); sub.token` (returned ONCE; re-create with same clientId → new token, old one invalidated). Read with svix `new AutoConfigConsumer(token, {})` → `receive("worker-1", { limit: 50 })` / `commit("worker-1", event.offset)`; `event.payload` = same object a webhook POST carries. Good fit for a Naïve cron agent with no public URL. Source: https://docs.agentmail.to/webhook-polling.md; `api/resources/webhooks/resources/polling/types/*`; `svix/dist/index.d.mts:5024-5031`.
- **Inbox events feed** `GET /v0/inboxes/{inbox_id}/events` (`label.added` per label) and plain `messages.list(..., { labels: ["unread"] })` for catch-up. Source: webhooks-overview.md.

### 3.7 Lists (allow/block) — opt-out handling

```ts
// org-wide send block list = our suppression list (opt-outs, bounces, complaints)
await am.lists.create("send", "block", { entry: "jane@example.com", reason: "opted out by reply" }); // POST /v0/lists/send/block
await am.lists.get("send", "block", "jane@example.com");
await am.lists.list("send", "block", { limit: 100 });
await am.lists.delete("send", "block", "jane@example.com");
// scoped variants: am.pods.lists.*(podId, …), am.inboxes.lists.*(inboxId, …)
```
- `Direction` = `"send" | "receive" | "reply"`, `ListType` = `"allow" | "block"`; `CreateListEntryRequest { entry: string /* address or domain */; reason?: string }`. Source: `api/resources/lists/types/{Direction,ListType,CreateListEntryRequest}.d.ts`; `api/resources/lists/client/Client.d.ts:27-83`.
- A later send to a blocked address → `403` `message_rejected` (`MessageRejectedError`). Narrowest scope wins (inbox > pod > org); an allow entry for the same address at any scope, or for its domain at pod/inbox level, overrides an org block — don't create allow entries for opted-out people. Reply lists apply to inbound mail whose `In-Reply-To` matches our outbound; receive lists apply to everything else. Source: https://docs.agentmail.to/lists.md; https://docs.agentmail.to/knowledge-base/cold-outreach.md.
- Unverified agent-sign-up orgs cannot create list entries (`list_entry_create` denied) — another reason a human should create the org. Source: https://docs.agentmail.to/permissions.md "Agent verification".

### 3.8 Pods, scoped API keys, permissions

```ts
const pod = await am.pods.create({ name: "terragent", clientId: "terragent-pod-v1" }); // Pod { podId, name, updatedAt, createdAt, clientId? }
await am.pods.inboxes.create(pod.podId, { username: "terragent-hello", displayName: "Terragent" });

// per-inbox key for one Naive Comms agent (store in Naive vault); apiKey string is returned ONCE
const k = await am.inboxes.apiKeys.create("terragent-outreach@agentmail.to", {
  name: "comms3-outreach",
  permissions: { inboxRead: true, messageRead: true, messageSend: true, messageUpdate: true, draftCreate: true, draftSend: true, draftRead: true },
  // expiresAt?: Date  (immutable; cannot outlive the creating key)
});
k; // CreateApiKeyResult = CreateApiKeyResponse { apiKeyId, apiKey, prefix, name, podId?, inboxId?, permissions?, createdAt, expiresAt? } | PublicKeyCredential
// also: am.apiKeys.create({...}) (org), am.pods.apiKeys.create(podId, {...}) (pod)
```
- Every inbox lives in a pod; a `Default Pod` is created at sign-up and can never be deleted. A pod can't be deleted while it still has inboxes/domains/API keys. Source: https://docs.agentmail.to/documentation/core-concepts/pods.md; `api/resources/pods/types/{CreatePodRequest,Pod}.d.ts`.
- Permissions: omit `permissions` → full access within scope (except opt-in `agentArmorRelease`); provide it → whitelist (only `true` granted). Effective = scope ∩ permissions; a key can't mint a more-privileged child (`permission_escalation`). 52 boolean flags in `ApiKeyPermissions` (wire snake_case: `inbox_read, inbox_create, inbox_update, inbox_delete, message_read, message_reply, message_send, message_update, message_delete, agent_armor_release, label_spam_read, label_blocked_read, label_unauthenticated_read, label_trash_read, draft_*, webhook_*, domain_*, list_entry_*, metrics_read, api_key_*, app_*, …`). Threads use message permissions. Source: `api/resources/apiKeys/types/{ApiKeyPermissions,CreateBearerApiKeyRequest,ApiKeyMutableFields,CreateApiKeyResponse}.d.ts`; https://docs.agentmail.to/permissions.md.
- Inbox-scoped keys: an inbox with its own API keys can't be deleted (`409 cannot_delete`) until they're revoked; inbox-scoped keys can't change `deactivateAt`. Source: `api/resources/inboxes/client/Client.d.ts` delete JSDoc; `UpdateInboxRequest.d.ts`.
- For Terragent: pods are unnecessary (single tenant; Free plan's 3 inboxes all in the Default Pod). Inbox-scoped keys are worth it if each Comms agent gets its own vault secret; otherwise one org key server-side is simpler.

### 3.9 Errors, retries, timeouts (SDK behaviour)

- Every error body (documented): `{ name, code?, message, fix?, docs? }` — **branch on `code`**, not `name`/`message`. Source: `api/types/ErrorResponse.d.ts`; https://docs.agentmail.to/errors.md. Live: an unauthenticated request returns `401 {"message":"Unauthorized"}` with **no `code`** and header `www-authenticate: Bearer resource_metadata="https://api.agentmail.to/.well-known/oauth-protected-resource"` (live `GET https://api.agentmail.to/v0/inboxes`, 2026-11-07).
- SDK error classes: base `AgentMailError { statusCode?, body?, rawResponse? }`, `AgentMailTimeoutError`; typed `ValidationError` (400), `NotFoundError` (404), `ConflictError` (409), `UnprocessableError` (422), `IsTakenError`, and `MessageRejectedError` (any 403 on send/reply/replyAll/forward). `inboxes.create` maps only 400/422 to typed errors — a 403 (`resource_taken` / `already_exists` / `limit_exceeded`) arrives as a plain `AgentMailError` with `statusCode === 403`; read `(e.body as any)?.code`. Source: `errors/AgentMailError.d.ts`; `api/errors/index.d.ts`; `api/resources/messages/errors/MessageRejectedError.d.ts`; `api/resources/inboxes/client/Client.js` (`__create` switch: 400, 422 only); `api/resources/inboxes/resources/messages/client/Client.js:1041` (`case 403: throw new AgentMail.MessageRejectedError`).
- SDK retries **408, 429 and all 5xx**, `maxRetries` default 2, backoff from 1 s up to 60 s; default request timeout **60 s**. Source: `core/fetcher/requestWithRetries.js:13-14,56`; `api/resources/inboxes/resources/messages/client/Client.js:120` (`?? 60`). **Because sends are retried on 5xx, always pass `idempotencyKey` on send/reply/forward** or a retry can double-send. The SDK puts it in the `Idempotency-Key` header (`messages/client/Client.js:984`).

```ts
import { AgentMailError } from "agentmail";
async function ensureInbox(username: string, clientId: string, displayName: string) {
  try {
    return await am.inboxes.create({ username, clientId, displayName });
  } catch (e) {
    const code = e instanceof AgentMailError ? (e.body as { code?: string; suggestions?: string[] } | undefined)?.code : undefined;
    if (code === "resource_taken") { /* username owned by another AgentMail customer: try `${username}-2` or e.body.suggestions */ }
    if (code === "limit_exceeded") { /* Free plan = 3 inboxes */ }
    throw e;
  }
}
```

### 3.10 MCP server (for Naïve agents)

- URL: `https://mcp.agentmail.to/mcp`, transport **Streamable HTTP** (remote). Auth: **`x-api-key: <AGENTMAIL_API_KEY>` header** for agents/SDK clients (docs: query-string keys end up in logs — don't), or OAuth via Clerk (`https://clerk.console.agentmail.to`) for Claude Desktop/ChatGPT. Source: https://docs.agentmail.to/integrations/mcp.md; https://docs.agentmail.to/integrations/claude-agent-sdk.md (`headers: { "x-api-key": process.env.AGENTMAIL_API_KEY! }`); https://github.com/agentmail-to/agentmail-mcp README.
- **Live check (2026-11-07):** unauthenticated `POST https://mcp.agentmail.to/mcp` (JSON-RPC `initialize`) → `HTTP/2 401 {"error":"Unauthorized"}`, `www-authenticate: Bearer resource_metadata=https://mcp.agentmail.to/.well-known/oauth-protected-resource/mcp`; `GET /.well-known/oauth-protected-resource` → `{"resource":"https://mcp.agentmail.to","authorization_servers":["https://clerk.console.agentmail.to"],"scopes_supported":["openid","email","profile","user:org:read"],…}`. The x-api-key path itself was not exercised (no key).
- stdio bridge (if a client can't send headers): `npx -y agentmail-mcp` (npm `agentmail-mcp@1.1.0`, Node ≥ 20) or `uvx agentmail-mcp` (PyPI 1.0.0) with env `AGENTMAIL_API_KEY`; `--tools name1,name2` filters the catalog. Source: agentmail-mcp README; `npm view agentmail-mcp`.
- Tools: docs say "47 tools" (+2 org-selection tools for OAuth); the generated `mcp-manifest.json` (github main, digest `sha256:8fcd04da…`) lists **53**: `list_inboxes, search_inboxes, get_inbox, create_inbox, update_inbox, delete_inbox, list_threads, search_threads, get_thread, get_attachment, update_thread, delete_thread, list_messages, search_messages, send_message, reply_to_message, forward_message, update_message, get_message, create_draft, list_drafts, get_draft, update_draft, send_draft, delete_draft, upload_file, list_files, get_file, delete_file, get_agenda, get_event, create_event, update_event, delete_event, respond_to_invitation, get_calendar, update_calendar, list_list_entries, get_list_entry, create_list_entry, delete_list_entry, agent_attach_human, agent_verify, get_labs, join_labs, list_apps, search_apps, get_app, list_accounts, connect_app, authorize_inbox, list_organizations, select_organization`.
- Key tool params (manifest, camelCase): `send_message { inboxId*, to*, cc, bcc, replyTo, subject, text, html, labels, attachments[{filename, contentType, contentDisposition, contentId, content (base64) | url}] }`; `reply_to_message { inboxId*, messageId*, text, html, labels, attachments, replyAll, to, cc, bcc, replyTo }`; `get_message { inboxId*, messageId* }`; `list_messages { inboxId*, limit, pageToken, labels, before, after, ascending, from, to, subject, include* }`; `create_list_entry { inboxId*, direction*, listType*, entry*, reason }` (MCP list tools are **inbox-scoped**, not org-wide); `get_attachment { inboxId*, threadId*, attachmentId* }` (by thread, returns download URL + extracted text for PDF/DOCX). MCP tools have **no idempotency-key parameter** — agent retries can double-send.
- Recommendation: give Naïve Comms agents the MCP server (vault-injected `x-api-key`, policy `ask` or `allow` per tool; deny `delete_*`, `create_inbox`, `agent_*`, `connect_app`, `authorize_inbox`, `join_labs`), but do the inbound webhook + any bulk/outreach sends in our own TS code where we control idempotency, opt-out checks and caps.
- **(critic-verified, live 2026-11-07) Bearer auth works on the hosted MCP, so the Naïve vault can carry the key.** Naïve rejects an inline `x-api-key` header and its vault only injects a bearer token (`static_bearer`, see naive-orchestration.md §3.7). Probe of `POST https://mcp.agentmail.to/mcp` with dummy values: `Authorization: Bearer am_000…` and `x-api-key: am_000…` behaved identically: `initialize` 200 (`serverInfo.name "AgentMail"`, `protocolVersion "2025-06-18"`), `tools/list` 200 with **54 tools** (the 53 above plus `send_feedback`), and `tools/call list_inboxes` reached the API and came back `isError: true`, "Forbidden (HTTP 403) — the authenticated credential lacks permission". A bearer without the `am_` prefix (`Bearer notanagentmailkey`) was refused at the edge with `401 {"error":"Unauthorized"}` (it is treated as an OAuth token). So: store `AGENTMAIL_API_KEY` as a Naïve vault `static_bearer` with `mcp_server_url: "https://mcp.agentmail.to/mcp"` (exact string) and declare `mcp_servers: [{ name: "agentmail", url: "https://mcp.agentmail.to/mcp" }]`. Still unverified: that Naïve presents `static_bearer` as `Authorization: Bearer <value>` (documented only as "a fixed bearer token"). Live MCP schemas: `send_message` required `[inboxId, to]`, `reply_to_message` required `[inboxId, messageId]`; neither has an idempotency field. Raw output: scratch `research/critic/am_tools.json`.

## 4. Discrepancies with the master prompt

| # | Spec says | Reality (source) | Impact on build |
|---|---|---|---|
| 1 | §3.1/§3.3/§8/§11: Comms 3 sends personalised outbound from `outreach@` to businesses that never contacted us; target 50+ free reports. | AgentMail KB: "**No.** AgentMail does not support cold outreach … an automated sales sequence. Writing each message with an LLM does not change that." ToS 8(h) bans unsolicited promotional email; 4(f) requires opt-out; 8(j) AI disclosure; suspensions for bounce/complaint rates (https://docs.agentmail.to/knowledge-base/cold-outreach.md, …/account-suspended.md). | A suspension is org-wide: it would also stop `hello@` and `data@` from sending (inbound still works). Decision for founders: (a) ask the AgentMail sponsor team on-site whether "free, specific analysis of the recipient's own asset, AI-disclosed, opt-out, tiny volume" is acceptable, in writing; (b) otherwise restrict `outreach@` to warm/opted-in contacts (attendees, people who requested, judges) and keep the signal engine producing reports + drafts for human review; (c) if cold sends go ahead, put outreach in a separate AgentMail org (separate account + key) so a suspension can't take down `hello@`. |
| 2 | §4.2: "three inboxes on AgentMail's default domain called `hello`, `data`, `outreach`". | Usernames on `agentmail.to` are global; a taken one returns `403 resource_taken` (optionally with `suggestions`); no auto-suffix (https://docs.agentmail.to/knowledge-base/creating-first-inbox.md). | Addresses will be like `terragent-hello@agentmail.to`. Make usernames config (`AGENTMAIL_INBOX_HELLO` etc.), not hard-coded. |
| 3 | §11: 50+ outbound reports overnight; 15+ inbound requests answered. | Free: 100 emails/day (each recipient counts), 3,000/month; docs describe a new-account ramp of **3 distinct new recipients in the first hour, 5 in the first day, 10 in the first week** (stated for agent-signed-up orgs after verification/claim; whether console sign-ups get the same ramp is unverified) (https://docs.agentmail.to/knowledge-base/agent-sign-up-limits.md, agent-onboarding.md). Over-limit → `429 rate_limit_exceeded` "Recipient limit exceeded". | If the ramp applies, the weekend can reach ~10 distinct new recipients total — fatal for both goals. Sign up **now**, test sending to 4+ distinct external addresses in hour 1, and if limited ask AgentMail (sponsor) to lift it or buy Developer ($20/mo, 1,000/day). |
| 4 | §4.2: SDK `pip install agentmail` (TS also available); `client.inboxes.create()`. | TS package `agentmail@0.5.53` (class `AgentMailClient`), Python `agentmail==2.0.25` (class `AgentMail`). Messages are under `inboxes.messages`, not top-level. | Use the TS SDK in the Next.js app; Python only in the Naïve sandbox if needed. |
| 5 | §4.2: "webhooks/events for incoming mail". | Confirmed: `message.received` webhook, Svix-signed. But svix 2.x `verify()` returns `undefined` (AgentMail docs assume 1.x return value) and the SDK's documented `parseOrThrow` rejects unknown keys. | Use the route in §3.5 as-is. |
| 6 | §4.2: answers go back "in the same thread with a PDF or HTML report attached". | Supported via `messages.reply` (threading headers automatic) with `attachments`. Inline base64 capped at **6 MB per request**; larger → `url` attachment (~30 MB). Reply has no `subject` field. | Keep reports < ~4 MB raw or host them and pass `url`. |
| 7 | §8: every outbound email has an opt-out link. | No built-in unsubscribe link/page/API event. On the shared `@agentmail.to` domain AgentMail adds `List-Unsubscribe` headers automatically (not on custom domains); recipients who unsubscribe/complain (and hard bounces) are auto-suppressed as **read-only entries on the send block list** that the API cannot delete (lifting complaints/unsubscribes needs support). There is no `unsubscribed` webhook event. (cold-outreach.md; emails-bouncing.md; events enum) | Build our own `/unsubscribe?t=<opaque token>` page that calls `am.lists.create("send","block",{entry, reason})`; also treat reply text like "stop/unsubscribe" (via `extracted_text`) as opt-out. Never put the email address in the URL. |
| 8 | §8: AI disclosure + sender identity in every email. | ToS 8(j) requires AI disclosure where the law requires it. Inbox `signature` (text ≤1,000 chars, html ≤4,000) is appended automatically to every send/reply/forward/draft. | Put AI disclosure + identity + opt-out notice text in the inbox `signature` so no agent can forget it (the opt-out link itself must be per-recipient → add in the body). |
| 9 | §7 stack: "Webhooks from Naïve and AgentMail keep the database current" (implies Vercel). | Webhook must 2xx within 15 s; 8 retries over ~27.5 h; endpoint silently auto-disabled after 5 days of failures. | Handler must enqueue/insert and return; don't await Naïve sessions inline. Monitor `webhook.enabled`. |
| 10 | §0 "Humans do account creation". | AgentMail also offers agent self-sign-up (`POST /v0/agent/sign-up`), but such orgs are limited (1 inbox, 10/day, only to the attached human) until verified, and can't create list entries/API keys/pods. | Founder signs up in the console (or via Vercel Marketplace, which injects `AGENTMAIL_API_KEY`). Don't use agent sign-up. |
| 11 | Docs internal inconsistency (not spec): Free custom domains/monthly cap. | pricing.md: Free = 1 custom domain, 3,000/month. KB rate-limits: Free = no custom domain, "No monthly cap". | Irrelevant (no custom domain planned); assume the stricter 3,000/month. |
| 12 | Docs internal inconsistency: webhook payload shape. | webhooks-overview.md example uses `from_` (array), `organization_id`, `sort_key`, attachment `inline`; events.md + SDK use `from` (string) and none of those. | Treat SDK types as truth; parse leniently; handle `from` as string. |

## 5. Answers to open questions (spec section 14)

Only the AgentMail-relevant parts of §14 can be answered here.

- **Q: Does incoming email wake Naïve agents? (We use AgentMail webhooks regardless.)** — AgentMail side: yes, inbound mail fires `message.received` to a registered HTTPS webhook (Svix-signed, ≤15 s ack, at-least-once), or via WebSocket / polling webhook. Whether the target is a Naïve webhook-triggered session directly is a Naïve question; AgentMail can add custom static headers to deliveries (`headers` on webhooks.create) if a Naïve endpoint needs a bearer token, but it cannot transform the payload. Recommended path: AgentMail → our Next.js route (verify, dedupe, write Neon) → Naïve API (start session / create board card). Confidence: high for AgentMail behaviour (webhooks-overview.md, webhook-verification.md); unverified for direct-to-Naïve.
- **Q: What does each sponsor count as "best use"? Do they give credits?** — Not documented by AgentMail. The pricing page offers a launch offer ("Early-stage startups get a free month on our Startup tier", apply https://tally.so/r/QKrxj8) and Free tier needs no card. Hackathon credits/judging criteria must be asked of the AgentMail team on-site. Confidence: low (nothing published).
- **Q (implicit in §4.2): Can we get `hello@`, `data@`, `outreach@` on the default domain?** — Almost certainly not: usernames on `agentmail.to` are shared across all customers and taken ones return `403 resource_taken` (no randomisation when `username` is given). Use prefixed names. Confidence: high that the mechanism is as described (creating-first-inbox.md); medium that those exact names are taken (not checked — needs a key).
- **Q (implicit): Is the Free plan enough?** — Inboxes yes (exactly 3). Volume: 100/day and 3,000/month is enough for inbound + modest outreach, but the documented new-recipient ramp (3/5/10 in first hour/day/week) may block outreach entirely if it applies to console sign-ups. Free also adds a "Sent via AgentMail" footer. Developer ($20/mo) removes footer, 1,000/day. Confidence: medium.

## 6. Credentials needed

| Env var | Service | Where to get it | Cost | Needed for |
|---|---|---|---|---|
| `AGENTMAIL_API_KEY` | AgentMail API (org-scoped key, starts `am_`) | Founder signs up at https://console.agentmail.to → API Keys → Create (shown once). Or install AgentMail from the Vercel Marketplace (`vercel integration add agentmail`), which injects `AGENTMAIL_API_KEY` into the project. | Free plan $0, no card (Developer $20/mo if limits bite) | Everything: inbox creation, send/reply, webhooks, lists. Also the MCP server's `x-api-key` header. Store in Vercel env + Naïve vault. (critic-verified) The vault entry must be a `static_bearer` credential with `mcp_server_url` exactly `https://mcp.agentmail.to/mcp`. The hosted MCP accepts `Authorization: Bearer am_…` (§3.10). The vault cannot inject it anywhere else, e.g. not into REST calls from the sandbox. |
| `AGENTMAIL_WEBHOOK_SECRET` | Svix signing secret for our webhook (`whsec_…`) | Returned as `secret` by `am.webhooks.create(...)` / `am.webhooks.get(id)`; also visible in the console. | Free | Verifying `/api/agentmail/webhook` requests. |
| (optional) per-inbox keys, e.g. `AGENTMAIL_KEY_OUTREACH` | Inbox-scoped AgentMail keys | `am.inboxes.apiKeys.create(inboxId, { name, permissions })` using the org key (key string returned once). | Free | Least-privilege keys for individual Naïve Comms agents via the vault. |
| (optional) `AGENTMAIL_INBOX_HELLO`, `AGENTMAIL_INBOX_DATA`, `AGENTMAIL_INBOX_OUTREACH` | Config, not secrets | Set to the addresses actually obtained (e.g. `terragent-hello@agentmail.to`). | — | Routing by `message.inbox_id`. |

No credential is needed to read docs; the MCP endpoint and REST API both return 401 without one (verified live).

## 7. Gotchas & limits

Plans (Source: https://www.agentmail.to/pricing.md, fetched 2026-11-07; and https://docs.agentmail.to/knowledge-base/rate-limits.md):

| Plan | Price | Inboxes | Emails/day | Emails/month | Emails/5 min | Custom domains | Storage | "Sent via AgentMail" footer |
|---|---|---|---|---|---|---|---|---|
| Free | $0, no card | 3 | 100 | 3,000 (KB rate-limits page says "No monthly cap") | no separate cap | 1 (KB says "None") | 3 GB | yes (footer present) |
| Developer | $20/mo | 10 | 1,000 | 10,000 | 100 | 10 | 10 GB | removed |
| Startup | $200/mo | 150 | 15,000 | no separate cap | 1,500 | 150 | unlimited | removed |
| Enterprise | custom | custom | custom | custom | custom | custom | custom | removed |

Add-ons (Developer/Startup only): +$2/mo per inbox, +$2/mo per domain, +$2/mo per 1,000 monthly sends, +$5/mo per seat. Launch offer: early-stage startups can apply for a free month of Startup (https://tally.so/r/QKrxj8). Team members on Free: 2.

Sending / deliverability
- Each recipient counts as one email toward daily limits; max **50 recipients** (to+cc+bcc) per send. Over daily limit → `429 rate_limit_exceeded` "Daily send limit exceeded" with `Retry-After` (agent-sign-up-limits.md; messages.md).
- New-account recipient ramp (documented for agent-created orgs after verification/claim): 3 distinct new recipients in first hour, 5 in first day, 10 in first week → `429` "Recipient limit exceeded…" (agent-sign-up-limits.md). Test immediately after sign-up.
- Auto-suppression: AgentMail refuses sends to addresses that previously bounced, were rejected, complained, or unsubscribed. Hard bounces can be reactivated once by an admin within 90 days (console Lists page); complaints/unsubscribes only via support@agentmail.cc. Keep bounce rate < 2%. (emails-bouncing.md)
- Suspension: high bounce/complaint rates → `403 account_suspended` (`suspended_reason`: `message.bounced` / `message.complained` / `unauthorized.signup` / `signup.domain_limit`) on all sends; inbound + webhooks keep working; only support can lift. Inbox/pod-level suspension codes: `inbox_suspended`, `pod_suspended`. Check with `am.organizations.get()` (`suspended_reason`, `suspended_at` present but not in SDK type) and `am.metrics.queryRates()`. (account-suspended.md)
- Never let a model guess/construct addresses (top suspension cause per docs). Validate addresses before sending.
- Deliverability guidance: send text+html; first message without images/links/tracking pixels; personalise; warm up (10 → 20 → 40/day per inbox); spread volume over inboxes; don't use third-party warm-up tools (email-deliverability.md; cold-outreach.md). `track_opens` needs a custom domain → unavailable to us.
- Free-tier messages get a "Sent via AgentMail" footer appended (messages.md).
- `display_name` defaults to "AgentMail" if not set — always set it (creating-first-inbox.md).

API / webhooks
- API rate limits: per-org, numbers not published; `429` + `Retry-After` (usually 1 s); SDK auto-retries. Don't poll (rate-limits.md).
- SDK: default timeout 60 s, `maxRetries` 2, retries 408/429/5xx (`core/fetcher/requestWithRetries.js`).
- Payload limits: inline base64 attachments → whole request ≤ 6 MB (`413` otherwise); URL attachments ~30 MB/message; webhook body inline ≤ 64 KiB stored body (else `body_url`, valid 1 h); WebSocket event body omitted if event > 30 KiB.
- Webhook: ack 2xx within 15 s; retries 8× over ~27.5 h; silently disabled after 5 days failing; at-least-once, unordered; ≤ 10 inboxes+pods per webhook; `eventTypes` required, update replaces the list; webhook endpoint count limit exists (`limit_exceeded`, number unpublished).
- Svix timestamp tolerance ±5 min (verified locally: 10-min-old timestamp rejected "Message timestamp too old").
- Idempotency: `clientId` on creates (no `@`); `Idempotency-Key` on sends (24 h, chars `A-Za-z0-9-._~`, 1–256). MCP tools expose no idempotency key.
- Inbox delete is async (202; `409 resource_deleting`); can't delete an inbox that still has inbox-scoped keys (`409 cannot_delete`). Deactivated inboxes silently drop inbound mail (not bounced, not delivered later).
- List endpoints (`messages.list`, `threads.list`) return no bodies — call `messages.get` / `threads.get`. Thread pages: newest page first, ascending within a page.
- Spam / blocked / unauthenticated inbound mail does NOT fire `message.received` (separate opt-in event types needing label permissions). Some legit customer mail could land there — consider subscribing to `message.received.unauthenticated` too.
- Agent Armor (Labs, free while in Labs): prompt-injection scanning of inbound mail, verdict `clear`/`review` on `message.agent_armor`; Monitor mode (default) or Hold mode; enable in console Settings → Labs. Useful for Comms 2 misuse screening (agent-armor.md).
- Auto-forwarding (new 2026-11-03): inboxes can forward a copy of every received email to up to 5 verified addresses — an easy human-in-the-loop copy to founders (changelog.md; auto-forwarding.md).
- Message expiry (24 h access expiry) is an opt-in early-access org feature — not on by default (message-expiry.md, not investigated further).

## 8. Unverified

Could not be confirmed without an API key (no account was created). How to confirm once `AGENTMAIL_API_KEY` exists:

1. **Whether `hello`, `data`, `outreach` (or `terragent-*`) usernames are free on `agentmail.to`.** Run `am.inboxes.create({ username, clientId })` and inspect `403 resource_taken` + `body.suggestions`. (There is also `am.inboxes.search({ q })` but it only searches our own org.)
2. **Whether the 3/5/10 new-recipient ramp applies to console-created Free orgs** (docs state it for agent sign-ups after verification/claim; cold-outreach.md just says "New accounts start with sending limits"). Send to 4 distinct external test addresses within the first hour and watch for `429` "Recipient limit exceeded". Also check whether replies to people who emailed us first count as "new recipients".
3. **Exact `403` body for `resource_taken`** (presence/shape of `suggestions`) and that `inboxes.create` surfaces it as a plain `AgentMailError` (inferred from SDK `Client.js` switch, which maps only 400/422).
4. **Real `message.received` payload shape** — confirm `inbox_id` is the address, `from` is a string (not `from_` array), and whether extra keys (`organization_id`, `sort_key`, …) are present (which would make `parseOrThrow` throw). Capture one real delivery and paste it into this doc.
5. ~~That the hosted MCP server accepts `x-api-key` for a Streamable-HTTP client like Naïve~~ **Resolved (critic-verified, §3.10):** `Authorization: Bearer am_…` and `x-api-key` are routed the same way, and `tools/list` returns 54 tools. Still open: a real key's `tools/call` succeeding, and Naïve's bearer header format.
6. **`Idempotency-Key` on reply/forward** returns the original message on retry (docs say all sends; only send is shown in examples).
7. **Whether the "Sent via AgentMail" footer is added to replies as well as new sends**, and what it looks like (affects report emails' professionalism).
8. **How `List-Unsubscribe` unsubscribes surface via the API.** errors.md says they become read-only send-block entries (added automatically "from bounces, complaints, and unsubscribes"), but no `unsubscribed` event exists; confirm with `am.lists.list("send","block")` after a test unsubscribe and poll it into our own suppression table.
9. **API rate-limit numbers** and the **webhook endpoint count limit** — unpublished; observe `429`/`limit_exceeded` `fix` text.
10. **Hackathon-specific AgentMail credits/plan upgrades and "Best Use of AgentMail" criteria** — ask the sponsor team.
11. **Whether AgentMail would accept the Terragent outbound use case** (free, specific asset analysis to businesses, AI-disclosed, opt-out, low volume) — ask support@agentmail.cc / on-site team before the first `outreach@` send, per their KB.

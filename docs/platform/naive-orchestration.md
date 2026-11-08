# Naïve orchestration reference (teams, board, deployments/cron, webhooks, policies, vault, MCP)

Status: COMPLETE for this research pass. Verified on 2026-11-07 against docs at
`https://usenaive.ai/docs/*.md` (77 pages re-fetched today, byte-identical to copies fetched ~13:03 PT),
the live OpenAPI at `https://api.vetta.sh/v1/openapi.json` (header `vetta-version: 2026-09-30`), and the
published SDK `@usenaive-sdk/managed-agents@0.12.3` `dist/index.d.ts` (13,329 lines).
"SDK d.ts:N" below = `node_modules/@usenaive-sdk/managed-agents/dist/index.d.ts` line N.

## 1. TL;DR for builders

- `npm i @usenaive-sdk/managed-agents@0.12.3` (NOT the deprecated `@usenaive-sdk/vetta`); `import { createClient } from "@usenaive-sdk/managed-agents"`; `createClient({ apiKey })` (base URL defaults to `https://api.vetta.sh`). CLI: `npm i -g @usenaive-sdk/cli@1.0.3` → `naive …` (reads `NAIVE_API_KEY` or `VETTA_API_KEY`).
- The 5 calls that matter: (1) `agents.update(coordId, { expected_version, multiagent: { type: "coordinator", agents: [{ type: "agent", id, version }], board: true } })`; (2) `board.cards.create(coordAgtId, { key, title, body, assignee: "<agent NAME>" })` — assigning starts the teammate; (3) `deployments.create({ agent_id, cron, input_template, budget_micro_usd, window: "loose", on_idle })`; (4) `webhooks.create({ url, events: ["session.idle","message.completed","budget.exceeded"] })` → save `secret`, verify `Vetta-Signature`/`Vetta-Timestamp` HMAC; (5) `sessions.list({ stop_reason: "awaiting_approval" })` + `sessions.confirmTool(sid, { tool_call_id, decision })` for the paid-order approval queue.
- Board API addresses a board by the coordinator's `agt_` id; card `assignee` is an agent **name**, not an id. No delete for cards. Page the WHOLE list (cards are column-sorted before pagination).
- Vault injects ONLY into MCP server connections (`static_bearer`/`mcp_oauth`, exact-URL match). `env_var` → 501. AgentMail MCP wants `x-api-key` (forbidden inline) and Monid MCP is OAuth-only → make our Terragent MCP on Vercel the gateway for Neon/AgentMail/Monid (keys in Vercel env) and vault only its bearer token.
- `mcp_servers: [{ name, url, headers? }]` — no `type` field; MCP tools default to `ask` and must each be listed in `tools.configs` (`"<server>.<tool>"`) or the save fails.
- Traps: `data_run` and MCP tools ask by default → an unattended cron run parks and **skips subsequent fires** until answered; `ask` needs a `pi` or `vetta` harness (`claude_code`/`hermes` → 400); `tool.confirm` is never delivered to webhooks (approvals push only as `session.idle` with `stop_reason: "awaiting_approval"`); deployment `timezone` defaults to the org's, not UTC; cron ≥ 5 min apart; webhook handlers must 2xx within 10 s and dedupe on envelope `id`; digest needs an active plan.

## 2. Install & setup

| Package | Verified version (npm view, 2026-11-07) | Status |
|---|---|---|
| `@usenaive-sdk/managed-agents` | 0.12.3 (latest) | **Use this.** `"type": "module"`, ESM only (`exports["."].import`), dependency `zod ^4.4.3`, `engines.node >=20` |
| `@usenaive-sdk/cli` | 1.0.3 (latest), bins `naive` and `vetta` | **Use this.** |
| `@usenaive-sdk/vetta` | 0.11.0 | **Deprecated**: "Renamed to @usenaive-sdk/managed-agents. Change the package name in your imports; the API is the same." |
| `@usenaive-sdk/vetta-cli` | 0.11.0 | **Deprecated**: "Renamed to @usenaive-sdk/cli. Run: npm rm -g @usenaive-sdk/vetta-cli && npm i -g @usenaive-sdk/cli" |

```bash
npm i @usenaive-sdk/managed-agents        # SDK
npm i -g @usenaive-sdk/cli                # CLI: `naive …` (alias `vetta …`)
```

```ts
import { createClient } from "@usenaive-sdk/managed-agents";
const naive = createClient({ apiKey: process.env.VETTA_API_KEY! }); // baseUrl defaults to https://api.vetta.sh
```
- `createClient(options: Partial<ClientConfig> & Pick<ClientConfig,"apiKey">)` — only `apiKey` required; `baseUrl` default `https://api.vetta.sh` (a trailing `/v1` is trimmed). Source: SDK d.ts:3880-3886.
- Every request sends `authorization: Bearer <key>`, `vetta-version: 2026-09-30`, and on POST/PATCH/PUT/DELETE an auto `idempotency-key` (random UUID). Source: `dist/index.js:5548-5558`, `API_VERSION` at `dist/index.js:348`.
- Errors throw `ApiError { type, code, status, requestId, param }`; an unreadable 2xx throws `ResponseParseError` (client/server drift). Source: SDK d.ts:33-52.
- Pagination: `ListQuery = { limit?: number; after?: string }`; pages are `{ data, has_more, next_cursor }`. Source: SDK d.ts:2879-2882.
- Live check (no key, 2026-11-07 22:3x UTC): `GET https://api.vetta.sh/v1/boards/agt_000…/cards`, `GET /v1/digest`, `GET /v1/deployments` all answer `HTTP/2 401`, header `vetta-version: 2026-09-30`, body `{"error":{"type":"authentication","code":"unauthorized","message":"missing bearer API key","request_id":"req_qj3jvcjb7m2eryp6jyfq3tycmp"}}` — routes exist in production. `GET /v1/openapi.json` (no key) = OpenAPI 3.1, title "Naive Managed Agents API", version `2026-09-30`; every route in this doc is present there with its `x-vetta-scope`.
- API versioning: header `Vetta-Version` (SDK pins `2026-09-30`). Since `2026-09-01`, **unknown body keys and query params are refused (400), not dropped**. Source: https://usenaive.ai/docs/api/overview.md.

## 3. API reference

### 3.1 Teams (coordinator + roster)

A team is NOT a separate object: it is an agent whose config has `multiagent`. Create agents first, then PATCH the coordinator.

```ts
// SDK types (AgentSchema.multiagent, SDK d.ts:469-484):
// multiagent: boolean | null | {
//   type: "coordinator";
//   agents: Array<string /* "agt_…" → {type:"agent",id} */ | { type: "agent"; id: string; version?: number }
//                 | { type: "self" } | { type: "advisor"; model: string }>;
//   board?: boolean;
// }
await naive.agents.update(coordinator.id, {
  expected_version: coordinator.current_version,   // optimistic concurrency (AgentPatch, SDK d.ts:2857)
  multiagent: {
    type: "coordinator",
    agents: [
      { type: "agent", id: "agt_…planner", version: 3 },
      { type: "agent", id: "agt_…acquisition" },     // version omitted → server pins CURRENT version at save
    ],
    board: true,
  },
});
```
- `agents`: 1–20 entries; at most one `self`, at most one `advisor`. A bare `"agt_…"` string normalises to `{type:"agent",id}`.
- `advisor` entries are **refused at save** ("advisor roster entries are not yet served"). Don't use.
- On the wire roster ids must be `agt_` ids (API rejects names); the CLI resolves `name@version`.
- Omitting `version` pins the member's current version at save time; stored roster always has an explicit pin; it never drifts. Changing the roster mints a new coordinator version.
- `multiagent: null` on PATCH clears a roster (`false` cannot, it is the create default). `true` = coordinator with empty roster, no board (degenerate).
- Session-level config overrides on the coordinator do NOT reach id-referenced members (they do reach `self` copies).
- `board: true` gives the coordinator AND every rostered agent the `board_read` / `board_write` tools. Without it the team has delegation only.
- Coordinator tools: `send_to_agent`, `wait_for_agents`, `list_agents` (delegation) + `board_read`, `board_write` (if `board:true`).
- Related agent field `handoffs: boolean | "team" | string[]` (who this agent may `send_to_agent`): `true` = any agent in the org (create-time default!), `false` = nobody and no agent tools offered, `"team"` = its own roster, list = agent **names**. Source: SDK d.ts:427-436.
- CLI: `naive team set agt_… --member web-researcher@3 --member fact-checker@1 --member self --board`.

Source: https://usenaive.ai/docs/team/overview.md, https://usenaive.ai/docs/team/coordinator.md; SDK d.ts:427-484.

### 3.2 Shared board

**Statuses (fixed enum):** `todo | doing | blocked | done` (SDK d.ts:608-614 `BoardStatusSchema`).

**Card object** (SDK d.ts:5571-5592, wins over docs example which omits `wake_count`):
```ts
type BoardCard = {
  id: string;                 // "crd_…" — derived (board + key, or board + session + title), not random
  object: "board_card";
  board_id: string;           // "brd_…"
  title: string;              // 1–200 chars
  body: string;               // the brief (≤20,000 chars)
  note: string | null;        // what the holder wrote back; required for `done`
  status: "todo" | "doing" | "blocked" | "done";
  assignee: string | null;    // agent NAME (not id); null = unclaimed
  blocked_by: string[];       // crd_ ids (≤50), already stripped of done ones
  woken_session_id: string | null;  // ses_ started for this card (read-only)
  reported_status: "todo"|"doing"|"blocked"|"done" | null; // last status told to owner (read-only)
  wake_count: number;         // board-started sessions for this card, max 3 then parked blocked
  created_at: string; updated_at: string;
};
type BoardComment = { id: string /* bcm_… */; object: "board_comment"; card_id: string; author: string /* usr_|key_|ses_ */; body: string; created_at: string };
type Board = { id: string /* brd_… */; object: "board"; agent_id: string; cards: { todo: number; doing: number; blocked: number; done: number }; created_at: string };
```

**SDK methods** (`client.board`, SDK d.ts:5552-5700). `boardRef` = `brd_…` OR the coordinator's `agt_…` id (use the agt id — works before the board exists):
```ts
naive.board.create(agentId)                                  // POST /v1/boards {agent_id} — ensure (201 minted / 200 existing)
naive.board.get(boardRef)                                    // GET  /v1/boards/{id} → Board (404 if not minted yet)
naive.board.cards.list(boardRef, { limit, after })           // GET  /v1/boards/{id}/cards → Page<BoardCard>, column order then oldest first
naive.board.cards.ofAgent(agentId, q)                        // GET  /v1/agents/{id}/board (empty page, not 404, before first card)
naive.board.cards.create(boardRef, { title, body?, status?, assignee?, blocked_by?, key? })  // POST /v1/boards/{id}/cards
naive.board.cards.get(boardRef, cardId)                      // GET  /v1/boards/{id}/cards/{cid}
naive.board.cards.update(boardRef, cardId, { title?, body?, status?, assignee?, blocked_by?, note? }) // PATCH (operator override)
naive.board.cards.assign(boardRef, cardId, assignee | null)  // PATCH with {assignee}
naive.board.cards.comments(boardRef, cardId, q)              // GET  …/comments (oldest first)
naive.board.cards.comment(boardRef, cardId, { body })        // POST …/comments (NO author field; sending one = 400)
```
`CardCreate`/`CardPatch` types: SDK d.ts:3679-3693.

**Webhook → card (our use case):**
```ts
// Next.js route handling an AgentMail inbound webhook → card for Comms 2
await naive.board.cards.create(COORDINATOR_AGT_ID, {
  key: `agentmail:${messageId}`,            // idempotent: same key → 200 with existing card, body ignored
  title: `Inbound request: ${subject}`.slice(0, 200),
  body: `From ${from}\nThread ${threadId}\n\n${text}`.slice(0, 20000),
  assignee: "comms-customer",               // agent NAME; must be a live agent or 400 validation_failed param=assignee (unknown_member)
});
```
- **Assignment is the wake.** A card that is `todo` + has `assignee` + no open blocker + assignee not busy on that board + not already woken is *due*. Made due through the API → session started **in the same request** and `woken_session_id` is in the response. Exception: a create **with `key`** is treated as a seed and left to the board clock (sweeps **once a minute**). So with `key`, expect up to ~60 s before the assignee starts. (Source: api/board.md "Add a card → assignee".)
- **(critic-verified against api/board.md, team/board.md and api/sessions.md) Choosing between keyed and un-keyed cards for an inbound-email webhook.** The `key` is an idempotency key of 1–128 chars, unique within the board. A replay answers `200` with the existing card and ignores the body. A keyed create "is a seed … left to the board's clock", which "sweeps once a minute". So:
  - For the ≤2-minute demo path, create the card **without** `key`. The assignee starts in the same request, and `woken_session_id` comes back in the response. Dedupe yourself first: insert the AgentMail `event_id` into Neon with `ON CONFLICT DO NOTHING`.
  - If you use a key, derive it as `am:` + the first 40 hex chars of `sha256(message_id)`. RFC Message-IDs can exceed 128 chars and contain `<>@`.
  - `POST /v1/sessions` returns `201` with `status: "queued"` and does not wait for the first turn. Either call fits AgentMail's 15 s ack window.
  - Put the email text in the card `body` or session `message` (≤20,000 chars). Then the Comms agent never reads mail through a tool. Reading contacts, mail, messages or a connected app flags the chat, and a flagged chat can't run `bash`, and every send, MCP tool and `board_write` asks a human each time (capabilities/tools.md "Once a chat has read people's data").
- The woken session is an ordinary top-level session of the assignee on its OWN budget; its `metadata.board = { card_id, board_id }`; opening message tells it to `board_read({card_id})`, claim (`doing`), comment, and finish `done` with a note or `blocked` with a comment.
- **One in-flight card per assignee per board** (5 cards for one agent = 1 session at a time).
- Session ends with card still `todo`/`doing` → next tick parks it `blocked` (empty `blocked_by`) with a system comment "Session ses_… ended (end_turn) with this card still doing. Parked for the board's owner."
- Each card started at most 3 times (`wake_count`), then parked `blocked` for the owner.
- `blocked_by` all `done` → card healed back to `todo` (on read, on tick, or immediately on a teammate's write).
- **Owner digest:** cards whose `status ∈ {done, blocked}` and `≠ reported_status` are grouped per board and the owner (coordinator) gets ONE new session per board per tick listing them. `done` cards whose note starts `STOPPED:` are listed as `stopped`.
- PATCH is an operator override: no claim guards, can reopen `done`; only refusal is `{status:"done"}` with no note anywhere → `409 state_conflict` (`missing_note`). `assignee` not a live agent name → `400 validation_failed` `param:"assignee"`; bad/cyclic `blocked_by` → `400 validation_failed` `param:"blocked_by"`. Writing `assignee` clears `woken_session_id` (re-wakes); omitting it leaves holder alone; `null` unclaims (wakes nobody).
- **No delete** for boards or cards; kept for org lifetime. Move to `done`.
- Scopes: reads `agents:read`, writes `agents:write`.
- Deployments seated on a board get one **standing card** per schedule (`Recurring: <first line of prompt>`), claimed `doing` by the fire; each fire's run is a comment on it.
- **Company board:** the board owned by the company's CEO agent seats every agent in the company automatically. Resolution order for a session's board: own agent's board if `multiagent.board` true → the board of the owner whose roster names it (earliest-created owner wins) → company board → none.

**Agent-side tools** (what the model calls; not callable by us):
- `board_read({ status?, owner?, card_id?, limit? })` → list `{ board_id, you, cards }` (no bodies/comments) or single `{ card, comments }` (≤50 comments). limit default 50, max 100.
- `board_write({ op: "create" | "update" | "comment" | "assign", card_id?, title?, body?, status?, assignee?, blocked_by? })`. `update` is a status move only (body → `note`); `assign` only on `todo`/`blocked` cards.
- Named refusals (tool results, not errors): `already_claimed`, `already_working`, `blocked`, `already_resolved`, `missing_note`, `unknown_member`, `missing_assignee`, `unknown_card`, `unsupported_update`, `missing_title`, `missing_card`, `no_board`.

**Live board in the dashboard:** there is no board-specific webhook/SSE in the docs. Poll `GET /v1/boards/{agt}/cards?limit=100` (paginate with `after`) + `GET /v1/boards/{agt}` for column counts. (Card-woken sessions do emit normal session webhooks, see 3.5.)

Source: https://usenaive.ai/docs/team/board.md, https://usenaive.ai/docs/api/board.md, https://usenaive.ai/docs/sdk/board.md; SDK d.ts:608-614, 3679-3693, 5552-5700.

### 3.3 Delegation vs handoff (`send_to_agent`)

Agent-side built-in tools (the model calls them; you configure them via `handoffs` + `tools.configs`):

| Tool | Coordinator | Member |
|---|---|---|
| `send_to_agent({ agent, message, wait: true, output_schema? })` — **delegate** | yes | refused `no_delegation` |
| `send_to_agent({ agent, message, wait: false, handoff_key?, budget_micro_usd? })` — **handoff** | yes | yes |
| `wait_for_agents()` (no args) | yes | no |
| `list_agents({ query? })` → `{name, description, project, team, typed}[]` + `concurrency:{running,limit}` | yes | yes |

- `agent`: target **name**; `message`: ≤20,000 chars and is the target's ENTIRE context.
- `send_to_agent` returns immediately with the new session id, `status`, and `wait`.
- **`wait: true` (delegation):** target runs as a *thread of the coordinator's session*, on the **coordinator's budget**, at its roster-pinned version. The coordinator calls `wait_for_agents`, its turn ends with stop reason `awaiting_delegation`, and it resumes with results folded back as the tool result (free text, or `structured_output` if `output_schema` given). Only `pi` serves typed results reliably today (the `vetta` harness reports `typed` but cannot submit one — don't pass `output_schema` to `vetta` members).
- **`wait: false` (handoff):** a normal top-level session of the target on the **target's own budget** (optionally capped by `budget_micro_usd`), `metadata.handoff = { from_session, from_agent, key, depth }`. **Nothing comes back** to the sender. Limits: chain depth 4, max 8 handoffs started per session, repeat under a running `handoff_key` → `status: "already_running"`.
- `wait_for_agents` never waits on board cards; card results come back through the board digest.
- Refusals are tool results: `unknown_agent`, `no_structured_output`, `at_capacity`, `no_delegation`, `handoff_only`, `wait_required`, `forbidden`/`not_found`.
- Bounds: ≤20 unique roster agents; delegation depth 1 (a member that itself has a roster fails validation); concurrent members capped (number unpublished; `list_agents` tells the model).
- Every agent can always hand work to the company CEO unless `handoffs: false`.
- On `claude_code`/`hermes` coordinators `wait_for_agents` does not pause the turn (parks when the turn idles; a few extra model calls).
- **Coordinator events** (on the coordinator's own session stream): `thread.created` {`thread_id`,`agent_id`,`member`}, `thread.idle` {`thread_id`,`member`,`status`,`stop_reason`,`summary`(≤160 chars) or `error`}, `thread.terminated` {`thread_id`,`member`,`error`} (failed to start). `thread.running` is in the enum but never written.
- Human/script door for handoffs: `POST /v1/sessions/{id}/handoffs` (operationId `createSessionHandoffs`, scope `sessions:write`) — hand work from one of your sessions to up to 6 agents at once under that session's agent's `handoffs` policy; the 8-per-session quota does not apply.

Terragent mapping: pipeline steps that must return an answer into the coordinator's turn → `wait: true`. Pipeline stages that have an owner/state and should show on the dashboard → board cards. Comms 3 → Comms 2 reply routing → `wait: false` handoff or (better, visible) a card.

Source: https://usenaive.ai/docs/team/delegation.md, https://usenaive.ai/docs/capabilities/tools.md#handoffs, https://usenaive.ai/docs/team/context-and-budgets.md#events; SDK d.ts:427-436 (`HandoffsField`); OpenAPI `createSessionHandoffs`.

### 3.4 Deployments & cron

**CLI (every flag verified in `@usenaive-sdk/cli@1.0.3` `dist/index.js:49398-49449` and flag table `:51776-51786`):**
```bash
naive deploy create --agent agt_… --cron "0 */2 * * *" --budget-usd 0.50 --window loose \
  --prompt "Scan NWS/USGS/FIRMS feeds for new events…" \
  --on-idle https://terragent.vercel.app/api/webhooks/naive \
  [--timezone America/Los_Angeles] [--agent-version 4] [--identity <idn_|name>]
naive deploy list [--limit N --after cur] | show <dep> | update <dep> [same flags as create minus --agent]
naive deploy run <dep>        # fire once now (works while paused)
naive deploy runs <dep> [--limit --after]
naive deploy pause <dep> | resume <dep> | delete <dep>
```
Flag → field: `--prompt`→`input_template`, `--budget-usd`→`budget_micro_usd` (decimal USD string ×1e6), `--on-idle`→`on_idle`, `--agent-version`→`agent_version`. All spec flags exist. There is no `--enabled` flag (use pause/resume).

**SDK / REST (equivalent for provisioning from a script):**
```ts
// DeploymentCreate = Pick<…,"agent_id"|"cron"|"input_template"|"budget_micro_usd"> & Partial<…> (SDK d.ts:3063-3066)
const dep = await naive.deployments.create({
  agent_id: SOURCING_AGT,
  cron: "0 */2 * * *",                 // 5-field cron; min interval 5 minutes (any two fires closer → 400)
  timezone: "America/Los_Angeles",     // IANA; default = ORGANIZATION timezone, not UTC
  input_template: "Disasters playbook: scan feeds since the last run…",
  budget_micro_usd: 500_000,           // REQUIRED per-run cap; 0 = use agent's budget.max_task_micro_usd; must be ≤ agent cap_micro_usd
  window: "loose",                     // "immediate"|"priority"|"loose"; default = agent's window
  agent_version: undefined,            // null/omitted = track current_version
  on_idle: "https://terragent.vercel.app/api/webhooks/naive", // must be https://; provisions a webhook endpoint
  identity: undefined,                 // idn_ id or persona name (agent must hold a grant)
  enabled: true,
});
naive.deployments.list({ limit, after });          // GET    /v1/deployments
naive.deployments.get(id);                          // GET    /v1/deployments/{id}
naive.deployments.update(id, { cron, enabled, … }); // PATCH  /v1/deployments/{id} (agent_id NOT patchable)
naive.deployments.run(id);                          // POST   /v1/deployments/{id}/run → 202 {id, session_id, status, started_at}
naive.deployments.runs(id, { limit, after });       // GET    /v1/deployments/{id}/runs (newest first)
naive.deployments.pause(id); naive.deployments.resume(id); // POST …/pause | …/resume
naive.deployments.delete(id);                       // DELETE /v1/deployments/{id} → {id, object, deleted:true}; past sessions kept
```
**Deployment object** (SDK d.ts:810-835): `{ id: "dep_…", object: "deployment", agent_id, agent_version: number|null, cron, timezone, input_template, budget_micro_usd, window, on_idle: string|null, identity: string|null /* idn_ */, enabled, schedule_status: "scheduled"|"paused"|"unscheduled", next_run_at: string|null, created_at }`.
Run row (SDK d.ts:12458-12473): `{ id, session_id, status: "failed"|"cancelled"|"queued"|"running"|"idle"|"completed", started_at: string|null }`.

Semantics:
- Each fire = an ordinary new session with `deployment_id` set (filter with `naive.sessions.list({ deployment_id })`).
- The fire's input = `input_template` + appended scheduled time (deployment tz and UTC), so the prompt can say "since the last run".
- **A run waiting on a human answer/approval holds the schedule**: the next fire is SKIPPED ("Skipped: waiting on you" on the schedule's card). Important for agents with `ask` tools on cron.
- Budget overrun → run goes idle early with `stop_reason: "budget_paused"`.
- If the agent is seated on a board: one standing card per schedule (`Recurring: <first line of prompt>`), claimed `doing` by each fire; runs comment on it.
- `schedule_status: "unscheduled"` = enabled but no clock on this installation; `next_run_at` null; manual `run` still works. CHECK THIS right after creating the first deployment.
- `on_idle` POST body (enveloped `session.idle`): `{ id: "evt_…", type: "session.idle", created_at, data: { stop_reason, structured_output /* null unless output_schema */, session_id, deployment_id } }`. Nothing else — fetch cost via `GET /v1/sessions/{session_id}` (`consumed_micro_usd`).
- `on_idle` creates a webhook endpoint listed in `GET /v1/webhooks` with `events: ["deployment.on_idle"]`; get its signing secret with `POST /v1/webhooks/{id}/rotate` (secret is NOT returned on deployment create). `on_idle: null` on PATCH deletes the endpoint + secret; a new URL re-enables an auto-disabled endpoint.
- Scopes: create/patch/delete/pause/resume `agents:write`; `run` `sessions:write`; reads `agents:read`.
- Cron string format: "standard 5-field cron". Whether `@hourly`-style macros / 6-field seconds are accepted is UNVERIFIED (assume not).

Source: https://usenaive.ai/docs/capabilities/deployments.md, https://usenaive.ai/docs/api/deployments.md, https://usenaive.ai/docs/sdk/deployments.md; SDK d.ts:810-835, 3063-3066, 12385-12513; OpenAPI `createDeployment`/`patchDeployment` bodies (on_idle `pattern ^https://`).

### 3.5 Webhooks (outbound: Naïve → our Next.js)

**Register (API/SDK; secret returned ONCE):**
```ts
// client.webhooks (SDK d.ts:12514-12613); scope "webhooks:*"
const hook = await naive.webhooks.create({
  url: "https://terragent.vercel.app/api/webhooks/naive",   // https, public host only
  events: ["session.idle", "message.completed", "budget.exceeded"], // or ["*"]
}); // → { id: "whk_…", object: "webhook_endpoint", url, events, enabled, created_at, secret: "whsec_…" }
naive.webhooks.list({ limit, after }); naive.webhooks.get(id);
naive.webhooks.update(id, { url?, events?, enabled? });     // WebhookPatch, SDK d.ts:3067-3071
naive.webhooks.rotate(id, overlapHours?);                   // → { id, secret, overlap_expires_at }; overlap 0–24 (default 24)
naive.webhooks.deliveries(id, q); naive.webhooks.delivery(id, did);
naive.webhooks.test(id);                                    // 202, queues a `webhook.test` delivery
naive.webhooks.redeliver(id, did);                          // 202, same envelope id
naive.webhooks.delete(id);
```
CLI: `naive webhook add --url <u> --events session.idle,message.completed,budget.exceeded`; `list`, `show`, `update <id> [--url --events --enable --disable]`, `rotate <id> [--overlap-hours N]`, `deliveries <id>`, `delivery <id> <did>`, `test <id>`, `redeliver <id> <did>`, `rm <id>` (flag table `@usenaive-sdk/cli/dist/index.js:51787-51798`). Dashboard registration: not covered by the pages read (UNVERIFIED).

**Event names.** `events` accepts `"*"` or any name in the event enum (60 names; SDK d.ts:526-595 = OpenAPI `createWebhook` enum). Unknown names are refused at create. **But only these are ever DELIVERED to webhooks** (capabilities/webhooks.md "Event types"):

| Area | Delivered types |
|---|---|
| Sessions | `session.idle`, `message.completed`, `budget.exceeded` |
| Media | `media.job.queued`, `media.job.completed`, `media.job.failed` |
| Browser | `browser.session.opened`, `browser.session.closed`, `browser.context.saved`, `browser.context.granted`, `browser.context.revoked` |
| Files & apps | `file.imported`, `app.db.migrated`, `app.storage.bucket.created`, `app.storage.bucket.deleted` |
| Wallets | `wallet.created`, `wallet.policy.updated`, `wallet.transaction.confirmed`, `wallet.swept` |
| Cards | `card.issued`, `card.failed`, `card.cancelled`, `card.refunded`, `card.credentials_revealed` |
| (test) | `webhook.test` (from `POST …/test`, ignores the filter) |
| (deployment) | `deployment.on_idle` endpoints receive `session.idle` envelopes for that deployment only |

Everything else (`tool.confirm`, `tool.started/completed`, `thread.*`, `message.delta`, `span.*`, `session.running`, `session.degraded`, …) is **accepted in `events` but never delivered** — stream/poll for those. `tool.confirm.answered` and `outcome.evaluation.*` are explicitly "never sent to webhooks". → An approval is pushed only as `session.idle` with `data.stop_reason: "awaiting_approval"`.

**Envelope** (POST body, JSON):
```ts
type NaiveWebhook = {
  id: string;            // "evt_…", stable across retries/redeliveries → dedupe key
  type: string;          // e.g. "session.idle"
  created_at: string;
  data: Record<string, unknown>;
};
// data by type (docs/api/events.md "Event types"):
// session.idle      { session_id, stop_reason, pending_actions?, structured_output, error?, code?, background?, deployment_id? }
// message.completed { content, role?, client_message_id?, from? }  (+ session_id — UNVERIFIED for the webhook envelope)
// budget.exceeded   { message, code: "budget_exceeded" | "insufficient_credits", param?: "budget_micro_usd" | "budget.cap_micro_usd" | "budget.max_task_micro_usd" }
```
`stop_reason` enum (SDK d.ts:153-165): `end_turn | awaiting_input | awaiting_approval | budget_paused | interrupted | max_iterations | context_exhausted | awaiting_delegation | awaiting_answer | error`.

**Signature verification** — headers `Vetta-Signature: v1=<hex>[,v1=<hex>]` and `Vetta-Timestamp: <unix seconds>`; HMAC-SHA256 (key = endpoint `secret`) over `` `${timestamp}.${rawBody}` ``, hex; accept if ANY `v1=` matches; reject if |now − ts| > 300 s. The SDK ships no verifier. Next.js App Router version:
```ts
// app/api/webhooks/naive/route.ts
import { createHmac, timingSafeEqual } from "node:crypto";
export const runtime = "nodejs";
export async function POST(req: Request) {
  const raw = Buffer.from(await req.arrayBuffer());              // RAW bytes, never re-serialize
  const ts = Number(req.headers.get("vetta-timestamp"));
  const sigs = (req.headers.get("vetta-signature") ?? "").split(",").map(s => s.trim()).filter(s => s.startsWith("v1="));
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return new Response("stale", { status: 400 });
  const want = createHmac("sha256", process.env.NAIVE_WEBHOOK_SECRET!).update(`${ts}.`).update(raw).digest();
  const ok = sigs.some(s => { const got = Buffer.from(s.slice(3), "hex"); return got.length === want.length && timingSafeEqual(got, want); });
  if (!ok) return new Response("bad signature", { status: 400 });
  const evt = JSON.parse(raw.toString("utf8")) as { id: string; type: string; data: any };
  // dedupe on evt.id (insert … on conflict do nothing in Neon), then ack fast; do heavy work async
  return new Response("ok");
}
```
Each endpoint (incl. each `on_idle` one) has its OWN secret → store per-endpoint secrets (e.g. `NAIVE_WEBHOOK_SECRET`, `NAIVE_ONIDLE_SECRET_<dep>`) or verify against a list.

**Delivery/retries:** respond 2xx within **10 s** (redirects count as failure). Retries: up to 5 more at +30 s, +2 min, +10 min, +1 h, +6 h (~7.5 h), then `failed` until redelivered. Duplicates possible → dedupe on `id`. **Auto-disable** (`enabled:false`) after 10 consecutive failed attempts or 24 h without success; re-enable with `update(id,{enabled:true})`, then `test`, then `redeliver` missed ones. Delivery record: `{ id: "whd_…", event_id, event_type, status: "pending"|"succeeded"|"failed", attempts, response_status, response_snippet, delivered_at, next_retry_at }`.

**URL rules:** https only; loopback/private/shared/link-local/unique-local/IPv6-literal addresses and `localhost`/`*.localhost`/`*.local`/`*.internal` (or names resolving to them) → `400 validation_failed` on `url`. Local dev needs a public tunnel. Vercel preview URLs with Deployment Protection will fail delivery (UNVERIFIED but likely) — use the production URL or disable protection for the route.

Source: https://usenaive.ai/docs/capabilities/webhooks.md, https://usenaive.ai/docs/api/webhooks.md, https://usenaive.ai/docs/api/events.md; SDK d.ts:153-165, 490-552, 3067-3071, 12514-12613; OpenAPI `createWebhook`/`patchWebhook`/`rotateWebhook`.

### 3.6 Tool policies (allow / ask / deny) and human approvals

**Config shape** (per agent; no org-wide policy layer). SDK d.ts:390-425 `ToolsetSchema`:
```ts
tools: {
  default_config: { permission: "allow" | "ask" | "deny" },          // ONLY `permission` here
  configs: Record<string /* tool name or "<server>.<tool>" */, {
    enabled?: boolean;                                                 // default true
    permission: "allow" | "ask" | "deny";                              // required per entry
    config?: Record<string, unknown>;                                  // tool-specific (web_fetch: allowed_domains/blocked_domains/max_content_tokens)
  }>;
}
```
- `allow` runs silently; `ask` pauses (emits `tool.confirm`, session → `idle` + `stop_reason: "awaiting_approval"`); `deny` = tool never offered to the model. Disable under an allow default: `{ enabled: false, permission: "deny" }`.
- Built-in **ask-by-default** tools (resolve to `ask` unless named in `configs`, or `deny` under a deny default): `social.post`, `social.cancel`, `email.send`, `phone.send`, `legal.*`, `wallet.pay`, `wallet.transfer`, `card.issue`, `card.credentials`, `card.cancel`, `trading.*` writes, `company.set_*`, `apps.request_access`, `payments_request`, `vault.request_secret`, `operator.request`, `list_as_template`, `pay_out_earnings`, `build_media_skill`, `mobile`, **`data_run`**, `generate_video`, `edit_video`, `create_character`. MCP tools are `ask` by default too.
- **`data_run` (Naïve's paid data tools) asks by default** → the Sourcing agent on cron will park on every data run unless you set `"data_run": { permission: "allow" }` (and a parked run SKIPS the next cron fire).
- Helper: `withTool(tools, name, settings)` returns a new toolset with one tool changed (SDK d.ts:3877).
- Running sessions keep the toolset they started with.
- **"Read people's data" flag:** once a chat reads contacts/mail/messages/a connected app, every send, `board_write`, `data_run`, `web_fetch`, and every connected-app or **MCP tool asks each time, even at `allow`** (and `bash` is refused). Keep inbox-reading agents separate from agents that must run unattended.

**Paid-order approval pattern for Terragent:** expose `prepare_paid_order` / `place_paid_order` on our Terragent MCP and set `"terragent.place_paid_order": { permission: "ask" }`. The agent's call parks; the dashboard lists it; a founder approves/denies; the approval is recorded with the approver.

**Listing what waits on a human (dashboard):**
```ts
// Option A — one call (needs scopes sessions:read + agents:read and an ACTIVE PLAN, else `subscription_required`):
const d = await naive.digest.get();          // GET /v1/digest
d.waiting.awaiting_approval.data;            // Session[] (top-level only, newest first, cap 100) + has_more
// Option B — paginated filter:
const page = await naive.sessions.list({ stop_reason: "awaiting_approval", agent_id?, limit, after }); // SessionFilter, SDK d.ts:2916-2935
for (const s of page.data) for (const a of s.pending_actions) {
  if (a.kind !== "tool") continue;           // kind defaults "tool"; "question" rows are answered, not approved
  // a.tool_call_id, a.name (e.g. "terragent.place_paid_order"), a.args (render these), a.thread_id? (helper thread the coordinator adopted it from)
}
```
`PendingAction` (SDK d.ts:177-240): `{ kind: "tool"|"question", tool_call_id, name, args, question?, thread_id?, parked_seq?, read_people?: true }`.

**Approve / deny:**
```ts
await naive.sessions.confirmTool(sessionId, {   // POST /v1/sessions/{id}/tool_confirmations → 202 + session
  tool_call_id: a.tool_call_id,
  decision: "allow",                          // or "deny"
  reason: "Customer paid; founder approved",  // on deny, fed back to the model as the tool result
  scope: "call",                              // "call" (default) | "session" (per-tool-name grant for the rest of this session; allow only; read_people cards offer none). Terragent always passes "call".
});
// questions (ask_operator): naive.sessions.answer(sessionId, { tool_call_id, answers: { key: "value" } })  // POST /v1/sessions/{id}/answers
```
CLI: `naive session inbox [--stop-reason awaiting_approval] [--agent …]`, `naive session confirm --session $SID --tool-call $CALL --allow | --deny --reason "…"`, `naive session answer $SID`.
- Resumes automatically once the last pending action is answered. The 202 means accepted; the tool has not run, and Naïve never runs it for you (see "Observed 2026-11-08" below).
- A held call costs nothing while waiting; it waits indefinitely.
- Push signal: webhook `session.idle` with `data.stop_reason === "awaiting_approval"` (includes `pending_actions?`). `tool.confirm` itself is not delivered to webhooks.
- Approver is recorded: event `tool.confirm.resolved` `{ tool_call_id, decision, reason, scope, actor, decided_at, proposed_args, final_args }` (on the member's session for a team member's call) and audit action `tool.approved` (SDK audit enum).
- Delegated member threads (`wait:true`): their parked call is adopted onto the coordinator's top-level session with `pending_actions[].thread_id` (server schema comment, `cli/dist/index.js:27629-27633`), and api/agents.md says a member's approvals "link the coordinator's session, where they are answered" → confirm on the **coordinator** session id. Card-woken crew sessions are top-level sessions of their own and park on their own session id.
- Agent `notifications: { email, approvals, questions, updates }`: email preferences; "approval and question messages deep-link to the paused session"; on a team a member's approvals/questions are mailed from its coordinator's settings; `email` required when any toggle is on (api/agents.md; server zod `AgentNotificationsSchema` in `cli/dist/index.js`). Cheap fallback alert for founders overnight.

**Observed 2026-11-08: what confirmTool does (and does not).** From live sessions (`scripts/session-events.ts <ses_…> --approvals` prints each parked batch in confirm order and whether each allowed call was re-issued):
- `tool_call_id` is `tc_<hash of name + args>`, not the model's `toolu_…` id.
- A parked call returns `terragent.X is waiting for approval` (`is_error: true`) to the model at once; the session then idles `awaiting_approval` with one `tool.confirm` row per parked call.
- `allow` does NOT run the call. On resume Naïve rewrites each confirmed call as the call, a "has NOT run, and this is not its result" tool result, and a user-role "APPROVED … issue X again now … byte for byte" message, in the order we confirmed them (probe `ses_fbp7vg8waqzwzqmagsndsv2rtt`). The model must re-issue each call itself.
- The model re-issues the **last-confirmed** call first (9 of 11 production batches).
- An identical re-issue runs once without parking and uses up the allow; a second identical call parks again; changed args make a new card (`ses_6q16adj9dsbq5cza8pdxtksvkv`, `ses_y45vyjt8fpc8mdkdtb86f83cjf`).
- Multi-call batches can lose calls: 2 of 11 batches lost saves, and 5 of 25 allowed calls never ran. In `ses_nb14t9050y73z5j5mkbfyg7r6n` (acquisition, req_ybnemrwx4g) the batch `log_decision, log_decision, save_acquisition_plan, handoff` was confirmed in that order; the model re-issued only the handoff, whose result says to end the turn, so the plan and both decisions never ran (same in `ses_2c8a0rtfaqkwr56ph9y6f0s0hn`, req_bkxpefeuns: `log_decision, save_acquisition_plan, handoff`, only the handoff re-issued). Pricing then found no plan and bounced the request back.
- `tool.confirm.resolved` shows only with `include_accepted=true` on the events list.
- The intermediate bare `session.idle` rows did not reach our webhook (one per batch).
- `scope: "session"` is a per-tool-name grant, allow only, but read_people cards offer no grant (capabilities/tools.md "Once a chat has read people's data"), so Terragent always uses `scope: "call"`. A session grant would also cover every later args of that tool name.
- A save re-issued before its `log_decision` is refused and uses up its allow, so the identical save parks again (`ses_y45vyjt8fpc8mdkdtb86f83cjf`). In the 4 production batches where `log_decision` was confirmed last, it was re-issued first and the other call then ran (`ses_sdd0g7j1…`, `ses_ews1k894…`, `ses_37wp3ygz…`, `ses_bsxpn5rr…`).
- Terragent's policy (`src/lib/pipeline/approval-policy.ts`): because the last-confirmed call is re-issued first, a call others depend on is confirmed last. Three groups, each in pending order: turn-ending and outbound calls (`CONFIRM_FIRST`: handoff, set_status, the send_* tools, deliver_report, record_contact_form_touch, submit_output), then the other allowed calls, then `terragent.log_decision`, so a decision is re-issued before the save that requires it. One failed confirm is held for a founder and the loop continues; a failed audit-event write doesn't stop it either. Server-side handoff preconditions refuse a handoff whose saves are missing.
- A parked `browser` call clears only with a string `args.action` that is neither `signup`/`login` nor in that agent's `ask_actions`; anything else stays parked (the row shape has not been observed live).
- Open questions for the Naïve team: what `deny` does to an identical re-issue (same `tc_` hash); whether `scope: "session"` on a read_people card returns 400; what sets read_people (the first `get_request` in each flagged session ran unparked and every later call parked).

Source: https://usenaive.ai/docs/concepts/policies.md, https://usenaive.ai/docs/capabilities/tools.md#permission-policies, https://usenaive.ai/docs/concepts/session-operations.md#awaiting-approval-loop, https://usenaive.ai/docs/api/sessions.md#respond-to-a-tool-confirmation, https://usenaive.ai/docs/api/digest.md; SDK d.ts:153-240, 390-423, 2916-2935, 3877, 10420-10432, 10520-10523.

### 3.7 Vault (credentials)

**Only MCP-connector injection exists today.** Kinds: `static_bearer`, `mcp_oauth` (live). `env_var` is in the enum but **refused `501 feature_not_configured`** (the egress substitution boundary "does not exist yet"). So the vault can only hold secrets that are sent to an **HTTPS MCP server URL** declared in `mcp_servers`. It cannot inject into `bash`/`web_fetch`/HTTP calls from the sandbox.

```ts
// SDK d.ts:3439-3457 (VaultCreate, CredentialCreate); client.vaults at SDK d.ts:6990-7065
const vault = await naive.vaults.create({ display_name: "terragent-secrets", identity_id: null /* org-wide */ });
await naive.vaults.credentials.create(vault.id, {
  kind: "static_bearer",               // "static_bearer" | "mcp_oauth" ("env_var" → 501)
  key: "Terragent MCP",                // label (required)
  value: process.env.TERRAGENT_MCP_TOKEN!, // write-only, never returned
  mcp_server_url: "https://terragent.vercel.app/api/mcp", // MUST equal the agent's mcp_servers[].url exactly
  agent_id: "agt_…",                   // optional: inject into this agent's sessions only (makes the agent admin-only to edit)
  expires_at: undefined,               // optional RFC 3339, must be in the future
});
naive.vaults.list({ limit, after }); naive.vaults.get(id); naive.vaults.delete(id);
naive.vaults.credentials.list(vaultId, q); naive.vaults.credentials.delete(vaultId, credId);
```
- Credential response: `{ id: "vcr_…", object: "vault_credential", vault_id, kind, key, host, mcp_server_url, agent_id, placeholder_ref: "vetta_ref_…", expires_at, last_injected_at, created_at }` — no `value`, no reveal route, **no update route** (rotate = create new + delete old).
- Matching rule: injected when `mcp_server_url` **equals** one of the agent version's `mcp_servers[].url`. Without `agent_id`, ANY agent that declares that URL gets it.
- Binding a credential to an agent (`agent_id`) makes PATCH/rollback/DELETE of that agent require the `admin` scope; sessions/schedules/rosters pinned to a version older than the binding run without the credential unless that version is still current.
- Scopes: `POST /v1/vaults`, `DELETE /v1/vaults/{id}`, `POST/DELETE …/credentials` = `admin`; `GET` routes = `agents:read`.
- Deleting a vault hard-deletes its secrets (irreversible).
- CLI: `naive vault create --name <n> [--identity <idn>]`; `printf '%s' "$TOKEN" | naive vault set --vault vlt_… --mcp-bearer <url> [--key <label>] [--expires-at <iso>]` (`--mcp-oauth <url>` for OAuth; secret from stdin, `--value` for CI); `naive vault credentials --vault vlt_…`; `naive vault rm --vault vlt_… --credential vcr_…`. (CLI docs still show `--env/--host`; the API refuses that kind.)
- Dashboard: not documented for vault writes in the pages read (see Unverified).
- How the bearer is sent to the MCP server (header name/format) is not stated beyond "fixed bearer token … injected server-side"; assume `Authorization: Bearer <value>` — UNVERIFIED.

Source: https://usenaive.ai/docs/identity/vault.md, https://usenaive.ai/docs/api/vaults.md, https://usenaive.ai/docs/cli/vault.md; SDK d.ts:1003-1008, 3427-3457, 6990-7065; OpenAPI scopes (`createVault: admin`, `listVaults: agents:read`).

### 3.8 MCP servers (remote HTTP)

```ts
// AgentSchema.mcp_servers (SDK d.ts:463-467) and OpenAPI createAgent body:
// mcp_servers: Array<{ name: string /*1-64*/; url: string /*https://…*/; headers?: Record<string /*≤128*/, string /*≤4096*/> }>  (max 20)
// (an http:// URL is accepted by the OpenAPI schema only with NO headers; docs say HTTPS required)
await naive.agents.update(agentId, {
  expected_version: v,
  mcp_servers: [
    { name: "terragent", url: "https://terragent.vercel.app/api/mcp" },
    { name: "agentmail", url: "<AgentMail remote MCP URL>" },   // confirm URL + auth scheme with the AgentMail researcher
    { name: "monid",     url: "<Monid remote MCP URL>" },
  ],
  tools: {                                                       // tool names below are ILLUSTRATIVE — use each server's real tools/list names
    default_config: { permission: "allow" },
    configs: {
      "terragent.query_earth_index": { permission: "allow" },
      "terragent.prepare_paid_order": { permission: "ask" },   // human approval
      "agentmail.send_message":       { permission: "ask" },
      "monid.run":                    { permission: "allow" },
      "agentmail.delete_inbox":       { enabled: false, permission: "deny" },
    },
  },
});
```
- **No `type` field.** The docs example `{ "type": "url", "name", "url" }` does not match the SDK type, the OpenAPI body schema, or the server zod schema in the CLI bundle (`McpServerSchema`, `@usenaive-sdk/cli/dist/index.js:28488`). Since API version `2026-09-01` "Unknown body keys and query parameters are refused, not dropped" → sending `type` will most likely 400. Omit it.
- MCP tools are keyed `<server name>.<tool name>` in `tools.configs`. **Default permission for MCP tools is `ask`** even under an `allow` default ("a newly exposed server tool never auto-runs") → you must explicitly `allow` each MCP tool you want to auto-run. No server-wide trust switch.
- Every declared server must be referenced by ≥1 enabled tool in `configs`, and every referenced tool must resolve to a declared server (save-time validation). So you must know the MCP tool names before saving the agent.
- URL must be public; private/loopback/link-local IPs, `localhost`, `.local`, `.internal` → `400 validation_failed`, `param: "mcp_servers.0.url"`. URL may not contain userinfo (`user:pass@`).
- Inline `headers` whose name matches `/^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)$/i` are rejected ("credentials belong in a vault-bound MCP credential, not agent config"). Non-secret headers are allowed. Do NOT put secrets in other header names: agent config is readable.
- Auth = vault credential (`static_bearer` or `mcp_oauth`) whose `mcp_server_url` equals the server `url`, injected server-side at session start/connect.
- ≤100 tools per server; names/descriptions/schemas/responses are capped before entering context.
- Server name `vetta` and the platform's own `https://api.vetta.sh/v1/mcp` are reserved (need `admin` scope).
- Connection/auth failure does not fail the session: emits `session.degraded` with `reason: "mcp_server_unavailable"` and retries on next wake.
- Transport is not a config field. The platform's OWN MCP server (`POST /v1/mcp`) speaks MCP revision `2025-06-18` JSON-RPC over `POST` (`initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`; api/mcp.md) — a hint that the client side is Streamable HTTP too. Whether SSE-only legacy servers work is UNVERIFIED — serve our Terragent MCP as Streamable HTTP (`POST /mcp`).
- Alternative for our own server: a Naïve-hosted **fullstack app** with `"mcp": "/mcp"` auto-registers its tools as `<app-name>.<tool>` for every agent with access, with a platform-minted bearer pushed into the app as secret `VETTA_MCP_TOKEN`. (We host on Vercel, so we use `mcp_servers` + vault instead.)
- Running sessions keep the toolset they started with; edits apply to new sessions.
- Tip: non-secret `headers` are allowed, e.g. `{ "x-terragent-agent": "sourcing" }`, so our MCP can tell which agent is calling (the bearer is shared per URL unless bound with `agent_id`). Our MCP must reject requests without the vaulted bearer.
- Harness: an agent with `mcp_servers` must be on a harness with `injected_tools: true` (all four published harnesses are). Because MCP tools default to `ask`, an MCP-using agent on `claude_code`/`hermes` (no approvals) must `allow` every MCP tool or sessions 400 at start (`param: "harness"`; concepts/harness-capabilities.md).

**Cross-check with the sibling research docs (read-only, 2026-11-07):**
- `docs/platform/agentmail.md` says AgentMail's remote MCP (`https://mcp.agentmail.to/mcp`, Streamable HTTP) authenticates with an **`x-api-key` header** (or OAuth via Clerk). Naïve **rejects `x-api-key` as an inline header** (SECRET_HEADER regex above) and the vault's `static_bearer` is documented only as a "fixed bearer token". So vault-injecting the AgentMail key works only if AgentMail's MCP also accepts `Authorization: Bearer am_…` (UNVERIFIED; its 401 advertises `www-authenticate: Bearer resource_metadata=…`, i.e. OAuth bearer) or via an `mcp_oauth` credential holding an AgentMail OAuth access token (no refresh in Naïve → expires).
- `docs/platform/monid.md` says Monid's MCP (`https://mcp.monid.ai/v1`) is **OAuth 2.1 only** and proposes a fallback of "the vault injecting `Authorization: Bearer <MONID_API_KEY>` for hosts `api.monid.ai`/`sfs.monid.ai`". **That fallback does not exist in Naïve**: host-bound injection is the `env_var` kind, refused `501 feature_not_configured`. An `mcp_oauth` credential could carry a manually obtained Monid access token, but Naïve never refreshes it.
- **(critic-verified, live 2026-11-07) The AgentMail half of this is resolved: the hosted AgentMail MCP accepts `Authorization: Bearer am_…`.** Dummy-key probes with `Authorization: Bearer am_000…` and `x-api-key: am_000…` behaved identically: `initialize` 200, `tools/list` 200 (54 tools), and `tools/call` forwarded to the AgentMail API, which answered 403. A non-`am_` bearer got `401` at the edge. So a vault `static_bearer` holding `AGENTMAIL_API_KEY`, with `mcp_server_url` exactly `https://mcp.agentmail.to/mcp`, should work. That assumes Naïve sends the bearer as `Authorization: Bearer`, which is still unverified. The Monid half stands: OAuth only, so use the gateway. Details: agentmail.md §3.10.
- **Recommended architecture:** make our **Terragent MCP server (Vercel)** the single gateway. It holds `DATABASE_URL`, `AGENTMAIL_API_KEY`, `MONID_API_KEY` in Vercel env and exposes narrow tools (`earth_index.*`, `email.send_reply`, `monid.discover/run`, `orders.prepare/place`). The Naïve vault then holds exactly one `static_bearer` (`TERRAGENT_MCP_TOKEN`) matched to our MCP URL. Per-tool `allow/ask/deny` still applies to every gateway tool. Connect AgentMail's own MCP directly only after confirming it accepts `Authorization: Bearer`.

Source: https://usenaive.ai/docs/capabilities/tools.md#mcp-connector, https://usenaive.ai/docs/concepts/harness-capabilities.md, https://usenaive.ai/docs/api/mcp.md; SDK d.ts:463-467; OpenAPI `createAgent`/`patchAgent` body `mcp_servers`; `@usenaive-sdk/cli/dist/index.js:28487-28519`.

### 3.9 Inbound messages (does inbound wake an agent?)

Resolved: **yes, as of the docs fetched 2026-11-07 — every page agrees** that inbound email/SMS to a Naïve identity's inbox/number starts one session of the endpoint's owning agent (identity/inbound.md, identity/email.md, identity/phone.md, capabilities/identity.md, capabilities/webhooks.md, api/messaging.md, concepts/runtime.md). The two remaining "does not wake" statements are narrower:
1. "Connection webhooks don't wake an agent yet" (identity/inbound.md, top note and "Matching rules") — third-party connection lifecycle events only.
2. "An inbox made before inbound mail woke agents doesn't wake until you turn it on" (`wake: false` on legacy inboxes; `naive identity email update --identity idn_… --inbox eml_… --wake on` / `PATCH /v1/identities/{id}/emails/{eid}`).
The spec's "one page says they don't wake" was most likely an older version of one of these pages; no current page says email/SMS don't wake.

Guards on the wake: SPF/DKIM/DMARC; ≤5 msgs/hour/sender/endpoint (`sender_rate_limit`), ≤20/hour/endpoint (`endpoint_rate_limit`), auto-replies/bulk and own-persona mail never wake, a thread stops waking after 10 turns/day (`thread_turn_cap`). Woken session has `metadata.inbound_message_id`. Native inbox requires a verified domain.

**Impact for Terragent: none functionally** — we use AgentMail (no custom domain, spec 4.2 says don't run Naïve identity email alongside). Our path: AgentMail webhook → Next.js → `board.cards.create(..., { assignee: "comms-customer" })` (or `sessions.create`). Note the AgentMail inbound guards above do NOT apply on our path; implement our own rate limit/loop guard (auto-reply detection) before creating cards.

Source: https://usenaive.ai/docs/identity/inbound.md, https://usenaive.ai/docs/identity/email.md, https://usenaive.ai/docs/api/messaging.md.

### 3.10 Audit logs, digest, reviews (intervention log)

**Audit logs** — `GET /v1/audit_logs` (scope `audit:read`), newest first, cursor-paginated, append-only.
```ts
const page = await naive.auditLogs.list({ actor?, resource?, action?, request_id?, from?, to?, limit?, after? }); // AuditFilter, SDK d.ts:3033-3043
// → { data: AuditEntry[], has_more, next_cursor, skipped: number }   (SDK d.ts:13224-13250; `skipped` not in docs)
type AuditEntry = {
  id: string /* aud_… */; object: "audit_entry";
  actor: { type: "user" | "key" | "system"; id: string };   // docs list only user|key; SDK adds "system"
  action: string;  // open string; SDK enum includes "tool.approved", "policy.denied", "agent.updated", "deployment.paused", "session.cancelled", "session.interrupted", "session.budget_updated", "vault.created", "credential.sealed", "webhook.created", …
  resource_type: string; resource_id: string; request_id: string; metadata: Record<string, unknown>; created_at: string;
};
```
`from` inclusive / `to` exclusive; date `2026-08-01` or timestamp (`+` as `%2B`). CLI: `naive audit` (see cli/audit.md).
Intervention log: poll `auditLogs.list({ from: lastSeen })` and keep rows where `actor.type === "user"` (a founder in the dashboard) and/or `action ∈ {tool.approved, session.interrupted, session.cancelled, session.budget_updated, agent.updated, deployment.paused, deployment.resumed, …}`. Note our own API key's writes also appear (`actor.type: "key"`) — use a separate API key per surface so dashboard-human actions vs automation are distinguishable. Also record `tool.confirm.resolved` events (via `GET /v1/sessions/{id}/events?include_accepted=true`) for the approver per call.

**Digest** — `GET /v1/digest` (scopes `sessions:read` + `agents:read`, no params), `naive.digest.get()`: `{ object: "digest", agents, waiting: { awaiting_approval, awaiting_answer, budget_paused }, failed, recent, channels }`; each list `{ data, has_more }` with caps 100/100/100/100, failed 50, recent 50; sessions are top-level only, full session objects. **Requires an active plan** (`subscription_required` otherwise, "except for the person setting it up and its CEO"); an agent's own token cannot read it.

**Reviews** — `POST /v1/reviews` (scope `sessions:write`): `{ decision: "approve"|"reject"|"edit", reason?, file_ids?: string[] (≤50), session_id?, subject?: object, before?: object, after?: object }` → `201 { id: "rev_…", object: "review", session_id, board_card_id }`. Use it to record human decisions made OUTSIDE Naïve's approval box (e.g. a founder approving an outbound template in our dashboard) so the intervention shows up attributed in Naïve too. The SDK 0.12.3 has **no** `reviews` client (no `reviews` group in `createClient`’s return type, no `/v1/reviews` path in `dist/index.js`) → call it with `fetch`.

Source: https://usenaive.ai/docs/api/audit-logs.md, https://usenaive.ai/docs/api/digest.md, https://usenaive.ai/docs/sdk/digest.md, https://usenaive.ai/docs/api/reviews.md; SDK d.ts:3033-3043, 7437, 13224-13250; OpenAPI `listAuditLogs` (audit:read), `getDigest` (sessions:read), `createReview` (sessions:write).

## 4. Discrepancies with the master prompt

| Spec says | Reality (source) | Impact on build |
|---|---|---|
| SDK `@usenaive-sdk/vetta`, CLI `@usenaive-sdk/vetta-cli` (4.1) | Both deprecated on npm at 0.11.0: "Renamed to @usenaive-sdk/managed-agents … the API is the same" / "Renamed to @usenaive-sdk/cli". Latest: `@usenaive-sdk/managed-agents@0.12.3`, `@usenaive-sdk/cli@1.0.3` (`npm view`). | Use the new names. Same `createClient`, same `vetta.sh` API host, CLI binary `naive` (alias `vetta`). |
| Teams snippet `multiagent: { type:"coordinator", agents:[{type:"agent", id, version: 4}], board: true }` (4.1) | Exact shape confirmed (SDK d.ts:469-484, OpenAPI). Also allowed: bare `"agt_…"` strings, `{type:"self"}`; `advisor` refused at save. `version` optional (pinned at save). | None; snippet is correct. Use `agt_` ids, not names. |
| "Assigning a card starts the teammate" (4.1) | True, but the woken session is the assignee's own top-level session on its own budget; one in-flight card per assignee per board; max 3 wakes per card; cards created via API **with a `key`** wait for the 1-minute board clock. | Expect ≤60 s latency for keyed cards; set budgets on every member agent, not just the coordinator. |
| "`send_to_agent` with `wait: false` is a handoff" (4.1) | Confirmed. Nothing comes back to the sender; target runs on its own budget; depth ≤4, ≤8 handoffs/session. Results of `wait:true` come back as the tool result after `wait_for_agents`. | Use cards (not `wait:false`) where the dashboard must show progress. |
| `vetta deploy create --agent --cron --budget-usd --window loose --prompt --on-idle` (4.1) | All flags exist (`@usenaive-sdk/cli/dist/index.js:49398-49449, 51776-51786`); also `--timezone`, `--agent-version`, `--identity`. SDK: `deployments.create({ agent_id, cron, input_template, budget_micro_usd, window, on_idle, timezone })`. | Provision crons from a script with the SDK. Set `timezone` explicitly. |
| Webhooks `session.idle`, `message.completed`, `budget.exceeded` "and others" (4.1) | Those three are the only *session* events delivered. Others delivered: media/browser/files/apps/wallet/card events + `webhook.test`. Tool/thread/stream events are accepted in `events` but never delivered. | Approvals and board changes cannot be pushed directly; poll `sessions.list({stop_reason})`, `digest.get()`, board cards. |
| Tools "each set to allow / ask / deny" (4.1) | Confirmed, per agent only (`tools.default_config` + `tools.configs`). Many tools are ask-by-default regardless of default (incl. `data_run`, `email.send`, MCP tools). | Explicitly `allow` everything a cron agent must run unattended. |
| "The vault injects credentials at the network boundary (live for MCP connectors)" (4.1); "Keep the AgentMail, Monid and Neon keys in the Naïve vault" (7) | Vault injection exists ONLY for MCP connectors (`static_bearer`, `mcp_oauth`, matched by exact `mcp_server_url`). `env_var` kind → `501 feature_not_configured`. | AgentMail/Monid keys only vault-able if used via their remote MCP servers with bearer auth (confirm with those researchers). Neon key cannot be used by agents from the vault: keep `DATABASE_URL` in Vercel env; expose DB reads/writes to agents via our Terragent MCP; vault that MCP's bearer token. |
| "connect AgentMail and Monid as MCP servers where possible" (7) | AgentMail MCP auth = `x-api-key` header (rejected inline by Naïve; not a documented vault kind); Monid MCP = OAuth 2.1 only (vault `mcp_oauth` has no refresh). Monid researcher's "vault injects bearer for api.monid.ai" fallback relies on `env_var`, which is 501. | Route AgentMail sends and Monid calls through our Terragent MCP gateway (keys in Vercel env); vault only `TERRAGENT_MCP_TOKEN`. Try AgentMail MCP direct only if it accepts `Authorization: Bearer`. |
| MCP config (docs example in capabilities/tools.md, not the spec): `{ "type": "url", "name", "url" }` | SDK `AgentSchema.mcp_servers` (d.ts:463-467), OpenAPI body and server zod (`cli/dist/index.js:28488`) are `{ name, url, headers? }` with no `type`; API version 2026-09-01+ refuses unknown body keys. | Omit `type` (expect 400 otherwise). |
| "Set up an approval policy for paid orders so the dashboard can show orders waiting on a human" (4.1) | Supported: `ask` permission → session idle `awaiting_approval` with `pending_actions[]`; list via `sessions.list({ stop_reason: "awaiting_approval" })` or `digest.get().waiting.awaiting_approval`; resolve via `sessions.confirmTool`. | Build the paid-order step as a dedicated MCP tool set to `ask`. Requires `pi`/`vetta` harness on that agent. |
| "One docs page says inbound messages don't yet wake an agent while another says they do" (4.1 caveat 2, 14) | Current docs (2026-11-07) consistently say inbound email/SMS **do** wake the owning agent. Only connection webhooks don't wake yet, and legacy inboxes need `--wake on`. | No change: we use AgentMail webhooks → card/session anyway. |
| "digest API, audit logs" (4.1) | Digest = one read of agents + waiting(approval/answer/budget) + failed + recent + channels (needs active plan). Audit log = control-plane trail with `actor`, `action` (incl. `tool.approved`, `policy.denied`), `request_id`. | Intervention log = audit rows by human principals + `tool.confirm.resolved` events + our own Neon log. |
| Budget field names "two styles" (4.1) | SDK/API: `budget: { cap_micro_usd, max_task_micro_usd, period }`; deployments `budget_micro_usd`; CLI flags `--budget-usd`, `--max-task-usd`. No camelCase fields in the SDK types. | Use snake_case micro-USD in code. (Owned by naive-core doc.) |

## 5. Answers to open questions (spec section 14)

| Question | Answer | Confidence | Source |
|---|---|---|---|
| Does incoming email wake Naïve agents? | Yes for Naïve-native identity inboxes/numbers (one session per message that passes guards, as the persona; `metadata.inbound_message_id`). Not for connection webhooks. Legacy inboxes need `wake: on`. Irrelevant for us: AgentMail mail reaches Naïve only via our webhook → `board.cards.create`/`sessions.create`. | high (docs), unverified live | https://usenaive.ai/docs/identity/inbound.md, /identity/email.md, /api/messaging.md |
| (implicit, 4.1) Can an external dashboard read/write the board? | Yes: REST `/v1/boards/{agt_or_brd}/cards` (+ comments), SDK `client.board.*`; scopes `agents:read`/`agents:write`. Comments are signed with our key's principal. | high | https://usenaive.ai/docs/api/board.md; SDK d.ts:5552-5700 |
| (implicit) Can crons be provisioned from a script? | Yes: `POST /v1/deployments` / `client.deployments.create`; list/patch/pause/resume/run/runs/delete all exist. | high | https://usenaive.ai/docs/api/deployments.md; OpenAPI |
| (implicit) How does a human approve a held paid order via API? | `POST /v1/sessions/{id}/tool_confirmations { tool_call_id, decision: "allow" or "deny", reason?, scope? }` → 202. | high | https://usenaive.ai/docs/api/sessions.md#respond-to-a-tool-confirmation; SDK d.ts:10420 |
| Other section-14 questions (Claude models, Neon extensions, imagery pricing, sponsor criteria, pitch logistics) | Out of this topic's scope (naive-core / database / imagery researchers). | — | — |

## 6. Credentials needed

| Env var | Service | Where to get it | Cost | Needed for |
|---|---|---|---|---|
| `NAIVE_API_KEY` (critic: standardise on this name. The docs, the CLI and the other platform docs use it, and the CLI reads `VETTA_API_KEY` only as a fallback. Snippets in this file that say `VETTA_API_KEY` mean the same key.) | Naïve Managed Agents API key `sk_live_…` | Naïve dashboard / `naive login` → `naive keys create --name <n> --scopes …` (founder creates) | Requires an org **plan** (Standard $20/mo incl. $20 credit, 7-day trial $10; Pro $200/mo) — "every route outside billing needs one"; hackathon credits $250 | Everything in this doc |
| `NAIVE_ADMIN_API_KEY` (suggested name) | Naïve key with `admin` scope | same | same | Vault create + credential writes (`admin` scope only), binding credentials to agents |
| `NAIVE_DASHBOARD_API_KEY` (suggested) | Naïve key scoped `agents:read agents:write sessions:read sessions:write audit:read` | same | same | Next.js dashboard: board read/write, approvals, digest, audit (separate key so human-vs-automation actions are distinguishable in audit) |
| `NAIVE_WEBHOOK_SECRET` (+ one per `on_idle` endpoint) | Webhook signing secret `whsec_…` | Returned once by `POST /v1/webhooks` or `POST /v1/webhooks/{id}/rotate` (needs `webhooks:*`) | free | Verifying `Vetta-Signature` in our webhook route |
| `TERRAGENT_MCP_TOKEN` (we mint it) | Our own bearer for the Terragent MCP on Vercel | Generate random secret; store in Vercel env AND in Naïve vault as `static_bearer` with `mcp_server_url` = exact MCP URL | free | Agents calling our MCP (Earth index, Neon writes, paid-order tool) |
| `AGENTMAIL_API_KEY`, `MONID_API_KEY` | AgentMail, Monid | Their consoles (founders) | see agentmail.md / monid.md | Store in **Vercel env** for the Terragent MCP gateway. Vault them (`static_bearer` on their MCP URL) only if their MCP accepts `Authorization: Bearer` (unverified; Monid MCP is OAuth-only) |
| `DATABASE_URL` (Neon) | Neon | Neon console | $250 credits | Vercel only — NOT vault-able for agents |

## 7. Gotchas & limits

**Rate limits / concurrency** (api/overview.md): 6000 req/min per org, 3000 req/min per API key (fixed 60 s window); 50 `running` sessions per org (extra sessions queue as `queued`); `429 rate_limited` + `Retry-After`; headers `RateLimit-Limit/Remaining/Reset`. Mutations get an auto `idempotency-key` from the SDK (keys are kept forever — never reuse one for a different operation).

**Board**
- Card list is sorted by column (todo, doing, blocked, done) *before* pagination; page size ≤100 → a single page can omit whole columns. Always page to the end (`has_more`/`next_cursor`) or use `board.get()` for counts.
- Title 1–200 chars, body/note/comment ≤20,000, `blocked_by` ≤50, `key` ≤128.
- `assignee` must be a live agent NAME at write time; renaming/deleting an agent later strands its cards.
- One `doing` card per assignee per board; max 3 board wakes per card; unfinished woken session → card parked `blocked`.
- Keyed creates wait for the once-a-minute clock; un-keyed creates with an assignee start immediately (`woken_session_id` in response).
- No board events/webhooks; no deletes.
- Spend for card-woken sessions is on each assignee's own budget; a member out of budget → wake refused → card parked.

**Delegation**: ≤20 roster agents; depth 1; concurrent teammates capped (number unpublished); `message` ≤20,000 chars; `wait:true` members share the coordinator session's ceiling ("a $1 coordinator fanning out to four members authorises $1 in total"); typed results only reliable on `pi`.

**Deployments**: cron fires ≥5 min apart (else 400); tz defaults to org tz; `budget_micro_usd` required and ≤ agent `cap_micro_usd`; a run parked on approval/question SKIPS later fires; `schedule_status: "unscheduled"` means it will never fire on its own; `on_idle` must be https and public.

**Webhooks**: 2xx within 10 s; 5 retries (30 s, 2 m, 10 m, 1 h, 6 h); auto-disable after 10 consecutive failures or 24 h failing; dedupe on `id`; verify raw bytes; ±300 s timestamp tolerance; per-endpoint secrets; rotation overlap ≤24 h; public https hosts only (tunnel for local dev).

**Policies/approvals**: `ask` requires harness `pi` or `vetta` (`claude_code`/`hermes` → `400` at session start, `param:"harness"`); ask-by-default list includes `data_run`, `email.send`, all MCP tools; "read people's data" flag forces ask on every send/MCP/`web_fetch`/`board_write` for the rest of that chat; held approvals cost nothing and never time out; `pending_actions` mixes `tool` and `question` rows — branch on `kind`.

**Vault/MCP**: ≤20 MCP servers/agent, ≤100 tools/server; URL must be public https, no userinfo; secret-named inline headers rejected; credential match is exact-URL (trailing slash/path differences will silently not inject — UNVERIFIED but implied by "equals"); no credential update — rotate by create+delete; binding a credential to an agent makes that agent admin-only to edit; MCP failure = `session.degraded` (`mcp_server_unavailable`), not an error.

**Digest/audit**: digest caps (100/100/100/100/50/50), top-level sessions only, needs active plan; audit `to` is exclusive; `action` is an open string.

**Pricing relevant here**: no separate charge found for boards, deployments, webhooks or vault in platform/pricing.md — costs are the sessions they start (inference per token by window tariff; `pi`/sandbox harness sessions hold a micro-VM billed per second while running; `vetta` isolate harness holds no machine). `data_run` = tool's listed price (median ~$0.0015, max ~$0.95); `web_search` $0.00166, `web_fetch` $0.00083.

**Events retention**: session events replayable ≥72 h by `seq`; boards/cards/sessions kept for org lifetime.

## 8. Unverified

Everything below needs a live API key (or a founder looking at the dashboard). How to confirm each:

1. **MCP `type` field** — docs example includes `"type": "url"`; SDK/OpenAPI don't. Confirm: `PATCH /v1/agents/{id}` with and without `type` and observe 400 vs 200.
2. **How `static_bearer` is presented to the MCP server** (assumed `Authorization: Bearer <value>`). Confirm: point a test agent at a request-logging MCP endpoint on Vercel and inspect headers.
3. **MCP transport compatibility** (Streamable HTTP vs legacy SSE; protocol revision the client speaks). Confirm by logging `initialize` from Naïve against our server; serve Streamable HTTP (`POST`) to be safe.
4. **Exact-URL credential matching edge cases** (trailing slash, query strings). Confirm by `last_injected_at` on `vaults.credentials.list` after a session.
5. ~~Whether AgentMail's MCP accepts `Authorization: Bearer <AGENTMAIL_API_KEY>`~~ **AgentMail: yes (critic-verified with dummy keys, see §3.8 cross-check).** Still open: whether Monid's MCP accepts any static key (docs: OAuth only). Confirm with `curl -X POST https://mcp.agentmail.to/mcp -H "Authorization: Bearer $AGENTMAIL_API_KEY" -d '{"jsonrpc":"2.0","id":1,"method":"initialize",…}'` once a key exists.
6. **End-to-end check that a delegated member's `ask` is confirmed on the coordinator session** (docs + server schema say so; not exercised live). Confirm with a 2-agent team where the member has an `ask` tool.
7. **Which agent version a card-woken crew session runs** (roster pin vs current). Confirm via `sessions.get(woken_session_id).agent_version`.
8. **Webhook `data` fields beyond the documented examples**: whether `session.idle` (non-deployment) carries `agent_id`/`deployment_id`/`pending_actions`, and whether `message.completed` carries `session_id`. Confirm with `webhooks.test` + a real session and log the body.
9. **`schedule_status` on our org** (`scheduled` vs `unscheduled`). Confirm with `deployments.get` right after create.
10. **Cron syntax extensions** (`@hourly`, 6-field). Confirm by a create attempt; expect 400.
11. **Vault + webhook management in the Naïve dashboard UI** (only API/CLI were documented in the pages read). Confirm by looking at Settings in the dashboard.
12. **Whether the hackathon org has an active plan** (digest and "every route outside billing" require one; OpenAPI also lists `POST /v1/hackathon/sessions`). Confirm with `GET /v1/digest` → not `subscription_required`.
13. **`reviews` has no SDK method** in 0.12.3 (grep found none) — call `POST /v1/reviews` via `fetch`. Confirm response shape live.
14. **Audit coverage of approvals**: `tool.approved` exists in the SDK action enum but not in the docs table; confirm it is emitted (and its `metadata`) after a `confirmTool`.
15. **Concurrent-teammate cap** number (deliberately unpublished; `list_agents` reports it to the model).
16. **Vercel Deployment Protection** blocking Naïve webhook deliveries / MCP calls on preview URLs (not a Naïve fact; check Vercel settings).

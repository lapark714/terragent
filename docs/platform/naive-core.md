# Naïve core SDK — verified platform reference (agents, sessions, events, models, budgets)

Status: COMPLETE (research pass 2026-11-07). Verified against npm registry, SDK `.d.ts`/`.js` (v0.12.3), docs at usenaive.ai/docs (raw .md + llms-full.txt), live OpenAPI, and unauthenticated live requests. Nothing was run with an API key.
Evidence dir (scratch, not in repo): `/private/tmp/claude-504/-Users-laurence-terragent/22c3e839-95bd-4a29-a8d4-0ec9c4c36ffd/scratchpad/research/naive-core/`
SDK file cited below as `MA.d.ts` = `node_modules/@usenaive-sdk/managed-agents/dist/index.d.ts` (v0.12.3), `MA.js` = `.../dist/index.js`.

## 1. TL;DR for builders
- `npm i @usenaive-sdk/managed-agents@0.12.3` (ESM-only, Node >= 20). `@usenaive-sdk/vetta` is deprecated (same API). CLI: `@usenaive-sdk/cli` (`naive`). Env var: `NAIVE_API_KEY`.
- `const naive = createClient({ apiKey: process.env.NAIVE_API_KEY! })` — base `https://api.vetta.sh`, header `authorization: Bearer sk_live_…`, SDK pins `vetta-version: 2026-09-30`.
- 1 `naive.agents.create({ name, model, harness: "pi", system, window, tools, mcp_servers, skills, budget: { cap_micro_usd, max_task_micro_usd, period }, output_schema, structured_output_required })`
- 2 `naive.sessions.create({ agent_id, message /*string*/, budget_micro_usd?, window?, output_schema?, metadata? })`
- 3 `for await (const ev of naive.stream(session.id, { afterSeq }))` — ends at first `session.idle`; read `ev.data.stop_reason`.
- 4 `naive.sessions.get(id)` → `status`, `stop_reason`, `structured_output`, `consumed_micro_usd`, `last_seq`.
- 5 `naive.sessions.send(id, { message })` → `{ accepted_seq }` (follow-up / "resume"); `naive.agents.update(id, { expected_version: agent.current_version, ... })`.
- Money is **integer micro-USD** everywhere (`5_000_000` = $5). `capUsd`/`maxTaskUsd` do not exist. `budget.period` is required.
- Trap: `loose`/`priority` only on `zai-org/GLM-5.2-FP8`, `moonshotai/Kimi-K2.6`, `google/gemma-4-31B-it`; `z-ai/glm-5.3-flash` is immediate-only → `400 window_unavailable`.
- Trap: never treat `idle` as success; branch on `stop_reason` (`end_turn` ok; `awaiting_approval`/`awaiting_answer`/`budget_paused`/`error` need action). `data_run` + MCP tools default to `ask` → unattended runs park unless set to `allow`.
- Trap: use `harness: "pi"` — `claude_code` has no approvals, no structured output, no Naïve built-ins, and does NOT use our Anthropic key (billed to Naïve credits). No Claude/vision model is documented; confirm live.


## 2. Install & setup

**The packages were renamed on 2026-11-05. The names in the master prompt are deprecated.**

| What | Use this (verified latest) | Deprecated name (spec) |
|---|---|---|
| SDK | `@usenaive-sdk/managed-agents@0.12.3` | `@usenaive-sdk/vetta@0.11.0` ("Renamed to @usenaive-sdk/managed-agents. Change the package name in your imports; the API is the same.") |
| CLI | `@usenaive-sdk/cli@1.0.3` (bins: `naive`, `vetta`) | `@usenaive-sdk/vetta-cli@0.11.0` ("Renamed to @usenaive-sdk/cli") |

Source: `npm view @usenaive-sdk/vetta deprecated` / `npm view @usenaive-sdk/vetta-cli deprecated` / `npm view @usenaive-sdk/managed-agents version` (run 2026-11-07); CLI `package.json` `"bin": {"vetta": ..., "naive": ...}`.

```bash
npm i @usenaive-sdk/managed-agents@0.12.3     # only runtime dep: zod ^4.4.3; Node >= 20
npm i -g @usenaive-sdk/cli@1.0.3              # `naive` / `vetta` commands
```

- ESM-only (`"type": "module"`, exports only `import`). In CJS use `await import("@usenaive-sdk/managed-agents")`. With tsc use `"module"/"moduleResolution": "node16"|"nodenext"`. Source: https://usenaive.ai/docs/sdk/typescript.md ; package.json `exports`.
- No Python SDK ("TypeScript only; there is no Python package"). Python must use raw REST. Source: https://usenaive.ai/docs/sdk/typescript.md
- API version pin sent on every call: header `vetta-version: 2026-09-30`. Source: `MA.js:348` (`var API_VERSION = "2026-09-30"`), `MA.js:5551`.
- Default base URL `https://api.vetta.sh` (a trailing `/v1` is trimmed). Source: `MA.d.ts` `DEFAULT_BASE_URL`, `MA.js:7846-7850`.

## 3. API reference

### 3.1 createClient
```ts
import { createClient, ApiError, ResponseParseError, withTool } from "@usenaive-sdk/managed-agents";
import type { VettaClient, AgentCreate, AgentPatch, SessionCreate, Session, StopReason, StreamOptions } from "@usenaive-sdk/managed-agents";

const naive = createClient({ apiKey: process.env.NAIVE_API_KEY! /*, baseUrl: "https://api.vetta.sh" */ });
```
`createClient(options: Partial<ClientConfig> & Pick<ClientConfig, "apiKey">)`; `ClientConfig = { baseUrl: string; apiKey: string; fetch: typeof fetch; idempotencyKey: () => string }`. Only `apiKey` is required in v0.12.3 (`baseUrl` defaults to `https://api.vetta.sh`; docs page still says baseUrl is required — harmless, pass it anyway). `idempotencyKey` defaults to `crypto.randomUUID()` per mutating call.
Source: `MA.d.ts` lines 21-28 (ClientConfig), ~3880-3886 (createClient doc comment + signature); `MA.js:7847-7853`.

`Agent` and `Event` types are NOT exported by name. Derive them:
```ts
type Agent = Awaited<ReturnType<VettaClient["agents"]["get"]>>;
type NaiveEvent = Awaited<ReturnType<VettaClient["sessions"]["events"]>>["data"][number];
```
Source: `export { ... }` list at end of `MA.d.ts` (has `Session`, `SessionCreate`, `AgentCreate`, `AgentPatch`, `StopReason`, `VettaClient`; no `Agent`, no `Event`).

### 3.2 REST auth + headers
Every request the SDK sends: `authorization: Bearer <apiKey>`, `vetta-version: 2026-09-30`, `accept`, `content-type: application/json` when there is a JSON body, and `idempotency-key: <uuid>` on mutating verbs (POST/PATCH/PUT/DELETE).
Source: `MA.js:5548-5560` (`headersFor`).

### 3.3 Errors
```ts
class ApiError extends Error { readonly type: string; readonly code: string; readonly status: number; readonly requestId: string; readonly param: string | undefined; }
class ResponseParseError extends ApiError { readonly method; readonly path; readonly issues: z.ZodError["issues"] }  // 2xx body the SDK couldn't parse (client/server drift)
```
Wire envelope: `{ "error": { "type": string, "code": string, "message": string, "request_id": string, "param"?: string } }`.
Fallback codes when body is unreadable: 400 validation_failed, 401 unauthorized, 403 forbidden (also "blocked before it reached the API... when a request body looks like SQL"), 404 not_found, 413/415/422 validation_failed, 429 rate_limited, 501 feature_not_configured, 502/503/504 provider_error, else internal_error.
SDK has NO retry policy and NO auto-pagination.
Source: `MA.d.ts:34-62`; `MA.js:5571-5600` (`CODE_BY_STATUS`, `apiErrorFrom`); https://usenaive.ai/docs/sdk/typescript.md ("No retry policy", "No pagination magic").

### 3.4 Agents

Methods (all on `naive.agents`; routes from the generated method index):
```ts
create(body: AgentCreate): Promise<Agent>                         // POST   /v1/agents        -> 201
list(query?: { limit?: number; after?: string }): Promise<{ data: Agent[]; has_more: boolean; next_cursor: string | null }>  // GET /v1/agents
get(id: string): Promise<Agent>                                   // GET    /v1/agents/{id}
update(id: string, body: AgentPatch): Promise<Agent>              // PATCH  /v1/agents/{id}   (new immutable version)
listVersions(id: string): Promise<{ data: AgentVersion[]; has_more: false; next_cursor: null }>  // GET /v1/agents/{id}/versions (NOT paginated; newest first)
getVersion(id: string, version: number): Promise<AgentVersion>    // GET    /v1/agents/{id}/versions/{n}
rollback(id: string, body: { to_version: number; expected_version?: number }): Promise<Agent>  // POST /v1/agents/{id}/rollback (mints a NEW version)
spend(id: string, query?: { by?: "component" }): Promise<{ agent_id: string; period: "day"|"week"|"month"; period_start: string; spent_micro_usd: number; by_component?: Record<string, number> }>  // GET /v1/agents/{id}/spend
computer(id: string): Promise<Computer | null>                    // GET    /v1/agents/{id}/computer
delete(id: string): Promise<{ id: string; object: string; deleted: boolean; ... }>  // DELETE /v1/agents/{id} — ALSO deletes every deployment (cron) running it
```
Source: `MA.d.ts:3888-4410`; https://usenaive.ai/docs/sdk/typescript.md (method index); https://usenaive.ai/docs/api/agents.md

Input types (exact, from SDK):
```ts
type AgentConfig = Omit<Agent, "id" | "object" | "harness" | "current_version" | "created_at" | "tools"> & { tools: ToolsetInput };
type AgentCreate = Pick<AgentConfig, "name" | "model" | "budget"> & Partial<AgentConfig> & Partial<Pick<Agent, "harness">>;
type AgentPatch  = Partial<AgentConfig> & Partial<Pick<Agent, "harness">> & { expected_version?: number };
```
Source: `MA.d.ts:2848-2859`.

Full agent object (`AgentSchema`, `MA.d.ts:437-523`) — field: type [create default per docs]:
```ts
{
  id: string;                      // "agt_..."
  object: "agent";
  name: string;                    // REQUIRED on create, 1–100 chars
  model: string;                   // REQUIRED. Any id from GET /v1/models, or "vetta/auto". Else 400 validation_failed param=model
  harness: "pi" | "claude_code" | "vetta" | "hermes";   // [default "pi"]; harness is NOT a config change on PATCH ("may be resent by apply and is ignored")
  window: "immediate" | "priority" | "loose";            // [default "immediate"]
  system: string;                  // <-- the system prompt field is `system`
  tools: { default_config: { permission: "allow"|"ask"|"deny" },
           configs: Record<string, { enabled?: boolean /*default true*/, permission: "allow"|"ask"|"deny", config?: Record<string, unknown> }> };
  mcp_servers: { name: string; url: string; headers?: Record<string, string> }[];  // <=20; name 1-64; public https URL (http allowed only without headers); NO `type` field; secret headers rejected -> use vault static_bearer/mcp_oauth
  skills: string[];                // live OpenAPI pattern ^(naive\/)?[a-z0-9][a-z0-9-]*(@\d+)?$ => SLUGS ("naive/" = platform catalogue), optional "@N" pin e.g. "refund-policy@3"; unpinned = latest at session start
  multiagent: boolean | null | { type: "coordinator";
                                  agents: (string | { type: "agent"; id: string; version?: number } | { type: "self" } | { type: "advisor"; model: string })[];  // 1–20 entries
                                  board?: boolean };   // [default false]; PATCH null clears roster
  handoffs?: boolean | "team" | string[];              // [default true = anyone in org]; "team" needs a multiagent roster; list = up to 50 agent NAMES
  model_selection?: { options: Record<string /*model id*/, string /*what for*/>; min_confidence?: number } | null;  // 2–16 options, `model` must be one
  budget: { cap_micro_usd: number; max_task_micro_usd: number; period: "day" | "week" | "month" };  // REQUIRED, all 3 fields required, integers
  notifications?: { email: string | null; approvals: boolean; questions: boolean; updates: boolean };  // email required if any toggle true
  output_schema: Record<string, unknown> | null;       // JSON Schema [default null]
  structured_output_required: boolean;                 // [default false]; needs output_schema
  description: string | null;
  metadata: Record<string, unknown>;
  current_version: number;
  created_at: string;              // ISO
}
```
Agent version object = same config fields + `version: number`, `created_at`, `created_by: { type: "user"|"key"|"system"; id: string }` (no `id`/`name`/`harness`). Source: `MA.d.ts:4149-4222`; https://usenaive.ai/docs/api/agents.md ("The agent-version object").

**Budget — RESOLVED:** the SDK and every docs example use `budget: { cap_micro_usd, max_task_micro_usd, period }` — **integer micro-USD** (1 USD = 1,000,000). `capUsd` / `maxTaskUsd` appear **nowhere** in the SDK (`grep -c` = 0 in `MA.d.ts`, `MA.js`, CLI `dist/index.js`) nor in the 1.6 MB `llms-full.txt`. Floats/strings are refused `validation_failed`. Rules: `max_task_micro_usd <= cap_micro_usd`; a cap of 0 only with a ceiling of 0. The CLI's `--budget-usd` / `--max-task-usd` take decimals and convert client-side.
Source: `MA.d.ts:491-499` (AgentSchema.budget); live OpenAPI `createAgent` body; https://usenaive.ai/docs/concepts/budgets.md ("Money is integer micro-USD on the wire"); https://usenaive.ai/docs/api/agents.md ("Create an agent").

**Versioning / `expected_version`:** every PATCH that changes config mints an immutable version; a no-op or name-only PATCH mints none. Pass `expected_version: agent.current_version`; mismatch → `409 { type:"conflict", code:"version_conflict", param:"expected_version" }` and nothing applied. Omit it for last-write-wins. Sessions pin `agent_version` at create (default `current_version`).
Source: https://usenaive.ai/docs/api/agents.md ("Update an agent", "Version conflict (409)").

**Tools helper** (safe single-tool edit without clobbering the map):
```ts
import { withTool } from "@usenaive-sdk/managed-agents";
const a = await naive.agents.get(id);
await naive.agents.update(id, { expected_version: a.current_version,
  tools: withTool(a.tools, "web_fetch", { permission: "allow", config: { allowed_domains: ["planetarycomputer.microsoft.com"] } }) });
```
`withTool(tools: Toolset, name: string, settings: { enabled?; permission?; config? }): Toolset` — name must be a built-in or `<namespace>.<tool>`. Typed configs: `WebToolConfig { allowed_domains?: string[]; blocked_domains?: string[]; max_content_tokens?: number /*default 4000*/ }` for `web_search`/`web_fetch`; `MediaToolConfig { models?: string[] }` for `generate_image`/`generate_video` (omit = low-cost models only).
Source: `MA.d.ts:3826-3876`.

### 3.5 Sessions

Methods (on `naive.sessions`):
```ts
create(body: SessionCreate, opts?: { idempotencyKey?: string }): Promise<Session>        // POST /v1/sessions -> 201 (creates AND starts; first turn runs immediately)
get(id: string): Promise<Session>                                                         // GET  /v1/sessions/{id}
list(query?: { limit?; after?; agent_id?; status?; stop_reason?: StopReason; deployment_id?; parent_session_id?; handoff_from?; handoff_key?; room? })  // GET /v1/sessions
send(id: string, body: { message: string; interrupt?: boolean; queue?: boolean; model?: string; mode?: "plan"|"build" }, opts?: { idempotencyKey?: string })
  : Promise<{ session_id: string; status: Session["status"]; accepted_seq: number; hint?: string }>   // POST /v1/sessions/{id}/messages -> 202
interrupt(id: string, body?: { message?: string | null }): Promise<Session>              // POST /v1/sessions/{id}/interrupt -> idle + stop_reason "interrupted"
cancel(id: string): Promise<Session>                                                      // POST /v1/sessions/{id}/cancel  -> terminal "cancelled" (no delete exists)
setBudget(id: string, capMicroUsd: number): Promise<Session>                              // PATCH /v1/sessions/{id}/budget  body { cap_micro_usd } (raise only)
confirmTool(id, { tool_call_id: string; decision: "allow"|"deny"; reason?: string; scope?: "call"|"session"; answers?; ... }): Promise<Session>  // POST .../tool_confirmations -> 202
answer(id, { tool_call_id: string; answers: Record<string, string | string[]> }): Promise<Session>   // POST .../answers -> 202
events(id, query?: { after_seq?: number; limit?: number; includeAccepted?: boolean }): Promise<{ data: Event[]; has_more; next_cursor }>  // GET .../events
threads(id, query?)  /* coordinator's delegated threads */   handoffs(id, { agents, message, handoff_key?, budget_micro_usd? })
setOutcome(id, { outcome: "ocm_..." })   plan(id)   writePlan(id, { markdown, base_version })   operatorPreview(id, toolCallId)
```
Source: `MA.d.ts:9998-10930`; method index in https://usenaive.ai/docs/sdk/typescript.md

**There is no `sessions.resume`.** "Resume" = (a) `send()` a new message to an `idle` session (any stop_reason incl. `error`), (b) `setBudget()` above consumed for `budget_paused` (auto-resumes), (c) raise the agent's `cap_micro_usd`/`max_task_micro_usd` (resumes sessions paused on it in last 7 days), (d) `confirmTool()`/`answer()` for `awaiting_approval`/`awaiting_answer`. Reconnecting a stream is `stream(id, { afterSeq })`.
Source: https://usenaive.ai/docs/concepts/budgets.md; https://usenaive.ai/docs/api/sessions.md.

`SessionCreate` (exact):
```ts
type SessionCreate = { agent_id: string; message: string }        // message REQUIRED, non-blank (else 400 validation_failed param=message)
  & Partial<Pick<Session, "agent_version" | "window" | "budget_micro_usd" | "deployment_id" | "output_schema" | "metadata" | "mode">>
  & { identity?: string /* idn_ id or persona name */; structured_output_required?: boolean; outcome?: string /* ocm_ id */ };
```
Input is a single **string** `message` — there is no structured-input field. Pass structured input as JSON text inside `message` (e.g. `JSON.stringify(spec)`), and use `metadata` for your own correlation ids. `budget_micro_usd` must be <= agent `cap_micro_usd`; default = agent `max_task_micro_usd`.
Source: `MA.d.ts:2860-2877`; https://usenaive.ai/docs/api/sessions.md ("Create a session").

Session object (`SessionSchema`, `MA.d.ts:241-380`):
```ts
{ id: string /*"ses_..."*/; object: "session"; agent_id; agent_version: number; deployment_id: string|null; identity_id: string|null;
  computer_id: string|null; parent_session_id: string|null; root_session_id: string|null; thread_role: "coordinator"|"member"|null;
  model: string|null; mode: "plan"|"build";
  status: "queued" | "running" | "idle" | "completed" | "failed" | "cancelled";
  stop_reason: null | "end_turn" | "awaiting_input" | "awaiting_approval" | "budget_paused" | "interrupted" | "max_iterations"
             | "error" | "context_exhausted" | "awaiting_delegation" | "awaiting_answer";
  stop_code?: string | null;      // error code of the failed turn (e.g. rate_limited, feature_not_configured, validation_failed, internal_error)
  window: "immediate"|"priority"|"loose"; budget_micro_usd: number; consumed_micro_usd: number;
  token_usage: { input: number; cache_write: number; cache_read: number; output: number; reasoning: number };
  pending_actions: { kind: "tool"|"question"; tool_call_id: string; name: string; args: Record<string, unknown>; question?: {...}; thread_id?; parked_seq? }[];
  output_schema: Record<string, unknown> | null;
  structured_output: Record<string, unknown> | null;   // <-- the typed result
  outcome_evaluations?: {...}[]; last_seq: number; metadata: Record<string, unknown>;
  started_at: string|null; ended_at: string|null; created_at: string }
```
Lifecycle: `idle` is resumable, `completed`/`failed`/`cancelled` are terminal. **Never treat `idle` as success — branch on `stop_reason`.** A failed turn leaves the session `idle` with `stop_reason:"error"` + `stop_code`.
Source: `MA.d.ts:241-380`; https://usenaive.ai/docs/api/sessions.md ("Lifecycle").

Send semantics: send to a `running` session without `interrupt`/`queue` → `409 session_running`. `interrupt:true` steers (aborts in-flight model call, billed for what it used); `queue:true` waits for current turn. Reply is an acceptance: wait for events with `seq > accepted_seq`, don't poll `status` immediately. `model` on send switches the session's model from that turn on (unknown → 400; window not served → `400 window_unavailable`). Interrupt on ended session → `409 session_terminal`. Cancel is idempotent; completed/failed can't be cancelled (409).
Source: https://usenaive.ai/docs/api/sessions.md ("Send input", "Interrupt a session", "Cancel a session").

### 3.6 Streaming & Events

```ts
naive.stream(sessionId: string, options?: StreamOptions): AsyncGenerator<Event>     // GET /v1/sessions/{id}/stream?after_seq=N  (SSE)
interface StreamOptions { afterSeq?: number /*exclusive, default 0*/; maxRetries?: number /*default 5*/; throughGrades?: boolean /*default true*/ }
naive.sessions.events(id, { after_seq?: number; limit?: number /*default 20, max 100*/; includeAccepted?: boolean })  // polling alternative
```
Event object: `{ id: string /*"evt_..."*/; seq: number; type: EventType; session_id: string; data: Record<string, unknown>; created_at: string }`.
Source: `MA.d.ts:526-593` (EventSchema), `MA.d.ts:3810-3824` (StreamOptions), `MA.d.ts:13325` (`stream: (sessionId: string, options?: StreamOptions) => AsyncGenerator<Event>`); https://usenaive.ai/docs/sdk/streaming.md

**SDK stream behaviour (read from `MA.js:7500-7551`, `settledAt` + `streamEvents`):**
- Returns (ends) right after yielding the first `session.idle` — unless `throughGrades` and an outcome grade is pending (`stop_reason: "awaiting_delegation"`).
- With `afterSeq > 0` it first calls `sessions.get`; if the session is settled (not running/queued) it returns once caught up to `last_seq` — even if that last event is not `session.idle`.
- Unknown event types (not in the SDK enum) are silently skipped (`EventSchema.safeParse` → `continue`).
- Reconnects on dropped connections with the same cursor; 4xx (except 429) throws `ApiError` immediately; after `maxRetries` consecutive failures **it returns silently** (no throw) → always re-read `sessions.get()` after the loop instead of assuming idle.
- Never call `stream` from a browser (key exposure). Proxy SSE from our server.

SSE wire format: each message `id: <seq>` + `data: <event JSON>`. `seq` starts at 1, gap-free, mirrored as `session.last_seq`. `after_seq` is **exclusive**. Events replayable >= 72 h. Order by `seq`, not `created_at`.
Source: https://usenaive.ai/docs/api/events.md ("Stream events (SSE)", "The event object").

Event types (exact enum, `MA.d.ts:529-590`): `message.delta`, `message.completed`, `message.accepted`, `handoff.sent`, `tool.started`, `tool.completed`, `tool.confirm`, `tool.confirm.resolved`, `tool.confirm.answered`, `session.running`, `session.usage`, `session.idle`, `session.retrying`, `session.mode`, `plan.updated`, `session.degraded`, `session.computer_replaced`, `budget.exceeded`, `span.model_request.start|end`, `span.transcript_load.start|end`, `span.harness_load.start|end`, `span.harness_build.start|end`, `span.box_resume.start|end`, `span.tools_resolve.start|end`, `span.model_gate.start|end`, `thread.created|running|idle|terminated`, `outcome.evaluation.started|progress|completed`, `browser.session.opened|closed`, `browser.context.saved|granted|revoked`, `media.job.queued|completed|failed`, `file.imported`, `app.db.migrated`, `app.storage.bucket.created|deleted`, `wallet.*`, `card.*`.

Payloads that matter (from docs table; `data` is `Record<string, unknown>` in the SDK, so cast):

| type | `data` fields |
|---|---|
| `message.delta` | `content` (text chunk) — only on harnesses with `streaming_deltas` (only `pi`) |
| `message.completed` | `content`, `role?` (`"user"` for our own message), `client_message_id?`, `from?` (`"platform"` = platform notice) |
| `tool.started` | `tool_call_id`, `name`, `args` |
| `tool.completed` | `tool_call_id`, `name`, `output` (text), `is_error` |
| `tool.confirm` | `tool_call_id`, `name`, `args` (→ answer with `sessions.confirmTool`) |
| `session.usage` | `token_usage`, `consumed_micro_usd` (running total), `active_seconds`, `tool_calls` |
| `session.idle` | `stop_reason`, `pending_actions?`, `structured_output`, `error?` (required schema not met), `code?` (error code on failure), `background?` |
| `session.retrying` | `attempt`, `in_ms`, `code` |
| `budget.exceeded` | `message`, `code` (`budget_exceeded`\|`insufficient_credits`), `param?` (`budget_micro_usd`\|`budget.cap_micro_usd`\|`budget.max_task_micro_usd`) |
| `span.model_request.end` | `model`, `window`, `token_usage`, `stop_reason`, `resolved_model`, `provider_ms`, `consumed_micro_usd` |

Source: https://usenaive.ai/docs/api/events.md ("Event types").

**Detecting done:** the turn is over at `session.idle` → read `data.stop_reason`. `end_turn` = finished normally. `awaiting_approval` / `awaiting_answer` = waiting on a human (**a question emits no event of its own — only the idle**). `budget_paused` = raise budget. `error` = failed turn (`data.code`). Terminal status (`completed`/`failed`/`cancelled`) comes from `sessions.get().status`. A cancel looks like `session.usage` + `session.idle{stop_reason:"interrupted"}` on the stream; distinguish via `status === "cancelled"`.
Source: https://usenaive.ai/docs/api/events.md; https://usenaive.ai/docs/api/sessions.md ("Cancel a session").

**Final message:** last `message.completed` whose `data.role !== "user"` (docs pattern). **Structured result:** `session.idle` `data.structured_output`, or `(await naive.sessions.get(id)).structured_output` (`Record<string, unknown> | null` — validate it yourself, e.g. with zod). The agent submits via an auto-added `submit_output` tool (visible as `tool.started` name `submit_output`); non-conforming calls are bounced back to the agent. `submit_output` ignores tool permissions.
Source: https://usenaive.ai/docs/sdk/streaming.md ("Reading the agent's answer"); https://usenaive.ai/docs/capabilities/structured-outputs.md ("How the agent submits it").

Follow-up turn without replay: `const { accepted_seq } = await naive.sessions.send(id, { message }); for await (const ev of naive.stream(id, { afterSeq: accepted_seq })) {...}`. Source: https://usenaive.ai/docs/sdk/streaming.md

### 3.7 Models, harnesses, proxy

**Models** (`naive.models`):
```ts
list(query?: { window?: string; search?: string; limit?: number /*1-100, default 20*/; after?: string }): Promise<{ data: Model[]; has_more: boolean; next_cursor: string | null }>  // GET /v1/models (paged, several hundred entries)
retrieve(id: string): Promise<Model>                // GET /v1/models/{id}  — id contains "/", SDK percent-encodes; 404 = id not servable
autoSelect(body: ModelSelectionRequest): Promise<{ object:"model_selection"; model: string; confidence: number|null; probabilities: Record<string,number>|null; defaulted: boolean; spent_micro_usd: number; usage: { input_tokens: number } }>  // POST /v1/models/auto_select
type Model = { object: "model"; id: string; context_window: number; max_output_tokens: number; supported_windows: ("immediate"|"priority"|"loose")[]; efforts: ("high"|"medium"|"low")[] };
```
- **No price and no vision/modality flag on the model object.** Catalogue is filtered to text-out, tool-calling, priced models. Ordered cheapest published input rate first. Any valid key, no scope.
- `vetta/auto` = router picks per request; `immediate` only; hard cap $5/M input, $25/M output; `resolved_model` on `span.model_request.end` / proxy reply.
- Model ids seen in docs (examples only — confirm live): `z-ai/glm-5.3-flash` (ctx 1,000,000; max_out 32,768; windows `["immediate"]` only; efforts low/medium/high), `zai-org/GLM-5.2-FP8` (ctx 1,048,576; all 3 windows), `moonshotai/Kimi-K2.6` (all 3 windows), `google/gemma-4-31B-it` (all 3 windows), `deepseek/deepseek-v4-flash-0731`, `openai/gpt-oss-120b`. **No Claude/Anthropic model id appears anywhere in the docs** (grep of llms-full.txt).
Source: `MA.d.ts:9698-9733`; https://usenaive.ai/docs/api/models.md; https://usenaive.ai/docs/concepts/model-router.md; https://usenaive.ai/docs/concepts/completion-window.md ("Which models serve which window").

**Completion window vs price:** same model, three tariffs: `immediate` (aggregated network, fastest provider, price can vary per call) > `priority` > `loose` (completion-window pool, reduced tariff). Only **3 models** serve `priority`/`loose` today: `zai-org/GLM-5.2-FP8`, `moonshotai/Kimi-K2.6`, `google/gemma-4-31B-it`. Any other model with priority/loose → `400 window_unavailable` (no silent downgrade). Precedence: session.window > agent.window > org default; default `immediate`. Check with `models.list({ window: "loose" })` or `supported_windows`. Docs' benchmark: tariff discount alone ≈ 0.69x–0.80x of immediate.
Source: https://usenaive.ai/docs/concepts/completion-window.md

**Harnesses** (`naive.harnesses.list()` → `GET /v1/harnesses`; `retrieve(base)` → `GET /v1/harnesses/{id}`):
```ts
{ base: string; label: string; location: "local"|"hosted"; billing: "usage"|"account"; status: "ga"|"preview";
  execution: "local"|"isolate"|"sandbox"; runnable: boolean;
  capabilities: { approvals: boolean; structured_output: boolean; streaming_deltas: boolean; injected_tools: boolean } }
```
Allowed `harness` values (SDK enum + live OpenAPI): **`"pi"` (default), `"claude_code"`, `"vetta"`, `"hermes"`** — both `pi` and `claude_code` confirmed.

| | pi | vetta | claude_code | hermes |
|---|---|---|---|---|
| status | ga | preview | preview | preview |
| execution | sandbox (micro-VM held while idle) | isolate (holds nothing) | sandbox | sandbox |
| runnable | always | only orgs opened to | needs an image per env | needs an image |
| approvals (`ask` tools, `ask_operator`) | yes | yes | **no** | no |
| structured_output (`structured_output_required`) | yes | declared but NOT served | **no** | no |
| streaming_deltas | yes | no | no | no |
| built-ins (web_search/fetch, generate_image, publish_file, managed browser, skills disclosure) | yes | yes | **no** (uses Claude Code's own tools) | no |
| MCP servers / team tools / connections | yes | yes | yes (via session-scoped endpoint) | yes |

All four: `location: "hosted"`, `billing: "usage"` (metered to Naïve credits). `harness` is **create-only** (PATCH ignores it). `claude_code` + an `ask` tool or `structured_output_required` → `400` at session start naming `harness`. Not runnable here → `501`.
Source: `MA.d.ts:9734-9769`; `MA.d.ts:513-518` (harness enum); https://usenaive.ai/docs/concepts/harness-capabilities.md ("The matrix", "Known gaps"); https://usenaive.ai/docs/concepts/harnesses.md; live `GET https://api.vetta.sh/v1/openapi.json` (`createAgent` body `harness.enum`).

**Model proxy** (`naive.proxy`):
```ts
messages(body: ProxyMessageCreate, window?: Window)     // POST /v1/proxy/anthropic/v1/messages  (window sent as `Vetta-Window` header)
completions(body: ProxyCompletionCreate, window?: Window) // POST /v1/proxy/openai/v1/chat/completions
calls(query?) / call(requestId)                         // GET /v1/proxy/calls[/{id}]  (needs audit:read)
```
Drop-in for stock clients: `ANTHROPIC_BASE_URL=https://api.vetta.sh/v1/proxy/anthropic`, `ANTHROPIC_AUTH_TOKEN=<Naïve key>` (Anthropic door also accepts `x-api-key`). OpenAI door: base `https://api.vetta.sh/v1/proxy/openai/v1`. **Billed to the Naïve org balance with a Naïve key; model must be a Naïve catalogue id ("Model ids from other providers' catalogues are not accepted").** Refused (400 validation_failed): `top_p`, `top_k`, `stop_sequences`, `service_tier`, `thinking` other than `{type:"disabled"}`, `tool_choice` other than auto, **image and document content blocks**, `response_format` (OpenAI door). `temperature` accepted but not forwarded. Scope `proxy:write` or `sessions:write`. No state between calls.
Source: `MA.d.ts:9770-9800`; https://usenaive.ai/docs/api/proxy.md; https://usenaive.ai/docs/concepts/model-router.md ("Calling the router directly").

### 3.8 Minimal end-to-end example (typechecks against v0.12.3)

Typechecked with `tsc --strict` (`module: nodenext`, `skipLibCheck: false`) against `@usenaive-sdk/managed-agents@0.12.3` — `TYPECHECK-OK`. The wire calls it makes were confirmed by running the SDK against a recording mock `fetch` (see §3.9). It was **not** run against the live API (no key).
```ts
// Minimal end-to-end: agent with budget -> session with output_schema -> stream to idle -> read structured output.
import { createClient, ApiError } from "@usenaive-sdk/managed-agents";
import type { VettaClient, SessionCreate } from "@usenaive-sdk/managed-agents";

type Agent = Awaited<ReturnType<VettaClient["agents"]["get"]>>;

const naive = createClient({ baseUrl: "https://api.vetta.sh", apiKey: process.env.NAIVE_API_KEY! });

const reportSchema = {
  type: "object",
  properties: {
    answer: { type: "string" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    sources: { type: "array", items: { type: "string" } },
  },
  required: ["answer", "confidence", "sources"],
  additionalProperties: false,
} as const;

async function main() {
  // 1. Agent with a REQUIRED budget (integer micro-USD) — $5/day cap, $0.50 per task.
  const agent: Agent = await naive.agents.create({
    name: "terragent-smoke",
    model: "z-ai/glm-5.3-flash",            // immediate-only model; confirm with naive.models.retrieve()
    harness: "pi",                          // pi = only harness that enforces structured_output_required
    window: "immediate",
    system: "You are Terragent's planner. Answer concisely and call submit_output with the result.",
    tools: { default_config: { permission: "allow" }, configs: {} },
    budget: { cap_micro_usd: 5_000_000, max_task_micro_usd: 500_000, period: "day" },
    output_schema: reportSchema,
    structured_output_required: true,
    metadata: { project: "terragent" },
  });

  // 2. Session — message is a plain string; put structured input in it as JSON.
  const input = { location: "37.7749,-122.4194", question: "Is there visible construction activity?" };
  const body: SessionCreate = {
    agent_id: agent.id,
    message: JSON.stringify(input),
    budget_micro_usd: 300_000,               // <= agent cap_micro_usd
    metadata: { request_id: "req-123" },
  };
  const session = await naive.sessions.create(body);

  // 3. Stream until the turn yields (generator returns after the first session.idle).
  let lastSeq = 0;
  let finalText = "";
  let idleStopReason: unknown = null;
  for await (const ev of naive.stream(session.id, { afterSeq: lastSeq })) {
    lastSeq = ev.seq;                        // persist this to resume after a crash
    switch (ev.type) {
      case "message.delta": break;           // ev.data.content = text chunk (pi only)
      case "message.completed":
        if (ev.data.role !== "user") finalText = String(ev.data.content);
        break;
      case "tool.started": console.log("tool", ev.data.name); break;
      case "budget.exceeded": console.warn("budget", ev.data.code, ev.data.param); break;
      case "session.idle": idleStopReason = ev.data.stop_reason; break;
    }
  }

  // 4. Re-read the session: the stream can also end on retries exhausted, without an idle.
  const done = await naive.sessions.get(session.id);
  if (done.status === "running" || done.status === "queued") throw new Error("stream ended early; resume with afterSeq=" + lastSeq);
  if (done.stop_reason !== "end_turn") {
    // awaiting_approval / awaiting_answer -> pending_actions; budget_paused -> setBudget; error -> stop_code
    throw new Error(`session ${done.id} idle: ${done.stop_reason} ${done.stop_code ?? ""} (stream said ${String(idleStopReason)})`);
  }
  const result = done.structured_output as { answer: string; confidence: "low" | "medium" | "high"; sources: string[] } | null;
  console.log({ finalText, result, consumed_usd: done.consumed_micro_usd / 1e6, last_seq: done.last_seq });

  // 5. Follow-up turn without replaying the first one.
  const { accepted_seq } = await naive.sessions.send(session.id, { message: "Now list one limitation." });
  for await (const ev of naive.stream(session.id, { afterSeq: accepted_seq })) {
    if (ev.type === "message.completed" && ev.data.role !== "user") console.log(String(ev.data.content));
  }

  // 6. Spend + tidy up.
  const spend = await naive.agents.spend(agent.id, { by: "component" });
  console.log(spend.spent_micro_usd, spend.by_component);
  await naive.sessions.cancel(session.id);   // terminal; there is no delete

  // Versioned update with optimistic concurrency.
  const fresh = await naive.agents.get(agent.id);
  await naive.agents.update(agent.id, { expected_version: fresh.current_version, system: fresh.system + "\nAlways cite sources." });
}

main().catch((e) => {
  if (e instanceof ApiError) console.error(e.status, e.type, e.code, e.param, e.requestId, e.message);
  else console.error(e);
  process.exit(1);
});
```
Requirements the example relies on: `output_schema` must be `{ type: "object", properties: {≥1 key} }` (SDK core `JsonSchemaDocument` refines exactly this — `MA.js:321-327`); `structured_output_required` needs `harness: "pi"` (only harness with `structured_output: true` that is served); `budget_micro_usd <= cap_micro_usd`.

### 3.9 Live / executed evidence (2026-11-07)

Unauthenticated live calls (trimmed):
```
GET https://api.vetta.sh/v1/models?limit=2      -> HTTP/2 401  x-request-id: req_mp288q9wm8gyew13vy2d2ny4kt
  {"error":{"type":"authentication","code":"unauthorized","message":"missing bearer API key","request_id":"req_mp288q9wm8gyew13vy2d2ny4kt"}}
GET https://api.vetta.sh/v1/harnesses           -> 401 (same envelope)
GET https://api.vetta.sh/v1/hackathon/status    -> 200 {"object":"hackathon_status","open":true}
GET https://api.vetta.sh/v1/openapi.json        -> 200, OpenAPI 3.1.0, info.version "2026-09-30", 410 paths, securitySchemes.apiKey = http bearer ("authorization: Bearer sk_…")
```
Live OpenAPI `createAgent` (`POST /v1/agents`, `x-vetta-scope: agents:write`) body: required `["name","model","budget"]`; `harness` enum `["pi","claude_code","vetta","hermes"]` default `"pi"`; `window` default `"immediate"`; `system` default `""`; `tools` default `{"default_config":{"permission":"allow"},"configs":{}}`; `budget` = `{cap_micro_usd: integer>=0, max_task_micro_usd: integer>=0, period: "day"|"week"|"month"}` all required; `notifications` default `{email:null, approvals:false, questions:false, updates:false}`; `output_schema` default `null`; `structured_output_required` default `false`. `POST /v1/sessions` body: required `["agent_id","message"]`, `message` pattern `\S`, plus `agent_version`, `window`, `budget_micro_usd`, `deployment_id`, `identity`, `output_schema`, `structured_output_required`, `metadata`, `mode`, `outcome`. `POST /v1/sessions/{id}/messages`: `message` (required), `interrupt`, `queue`, `model`, `mode`, `idempotency_key` (ignored).

SDK run against a recording mock `fetch` (`e2e/mock.mjs` in scratch): requests the SDK actually emitted —
```
POST  /v1/agents                       body {"name","model","budget":{"cap_micro_usd","max_task_micro_usd","period"}}  headers: Bearer, vetta-version 2026-09-30, idempotency-key
POST  /v1/sessions                     body {"agent_id","message","budget_micro_usd"}
GET   /v1/sessions/{id}/stream?after_seq=0   accept: text/event-stream (no idempotency-key)
POST  /v1/sessions/{id}/messages       body {"message","queue":true}
PATCH /v1/sessions/{id}/budget         body {"cap_micro_usd":900000}          <- setBudget(id, n) wire name
POST  /v1/sessions/{id}/interrupt      body {"message":"stop"}
PATCH /v1/agents/{id}                  body {"expected_version":1,"system":"s2"}
GET   /v1/models/z-ai%2Fglm-5.3-flash  (id percent-encoded by SDK)
```
Stream fed seqs 1 `session.running`, 2 `message.delta`, 3 unknown type, 4 `message.completed`, 5 `session.idle`, 6 `message.delta` → SDK yielded `1, 2, 4, 5` and stopped (unknown type skipped; nothing after idle). `stream(id, { afterSeq: 5 })` on a settled session issued `GET /v1/sessions/{id}` first and yielded nothing. A 404 envelope surfaced as `ApiError 404 not_found not_found req_x`. The SDK also validates response ids: an id must be `<prefix>_` + ≥26 Crockford-base32 chars (`MA.js:1-9`), else `ResponseParseError`.

## 4. Discrepancies with the master prompt

| # | Spec says | Reality (verified) | Impact on build |
|---|---|---|---|
| D1 | SDK `@usenaive-sdk/vetta`, CLI `@usenaive-sdk/vetta-cli` | Both **deprecated 2026-11-05**. Use `@usenaive-sdk/managed-agents@0.12.3` and `@usenaive-sdk/cli@1.0.3` (bins `naive`/`vetta`). "the API is the same". | `npm i @usenaive-sdk/managed-agents`; change import paths. Source: npm `deprecated` field. |
| D2 | `createClient({ baseUrl, apiKey: process.env.VETTA_API_KEY })` | Works; `baseUrl` now optional (default `https://api.vetta.sh`). Docs/CLI use **`NAIVE_API_KEY`** (CLI reads `VETTA_API_KEY` only if `NAIVE_API_KEY` unset). | Name our env var `NAIVE_API_KEY`. Source: `MA.d.ts` createClient doc comment; https://usenaive.ai/docs/cli/overview.md |
| D3 | Budget field names "in two styles" (`cap_micro_usd`/`max_task_micro_usd` vs `capUsd`/`maxTaskUsd`) | **Only** `budget: { cap_micro_usd, max_task_micro_usd, period }` exists — integer micro-USD, all three required. `capUsd`/`maxTaskUsd` occur nowhere in SDK, CLI bundle, live OpenAPI or llms-full.txt. CLI flags are `--budget-usd`, `--max-task-usd`, `--budget-period`. | Use micro-USD integers (`5_000_000` = $5). Floats → 400. Also `period` is required (spec omits it). |
| D4 | `agents.create({ name, model, system, budget, harness: "pi", skills, window })` | Correct field names. Harness enum: `pi` (default) / `claude_code` / `vetta` / `hermes`. | OK. `harness` is create-only. |
| D5 | "Use `loose` for overnight signal work" with cheap models like `z-ai/glm-5.3-flash` | `z-ai/glm-5.3-flash` serves **`immediate` only** (docs example `supported_windows: ["immediate"]`). Only `zai-org/GLM-5.2-FP8`, `moonshotai/Kimi-K2.6`, `google/gemma-4-31B-it` serve `priority`/`loose`; anything else → `400 window_unavailable`. `vetta/auto` is immediate-only. | Overnight agents on `loose` must use one of those 3 models (confirm live with `models.list({ window: "loose" })`). |
| D6 | Session: "send input, stream output, interrupt, resume" | No `resume` method. Resume = `sessions.send()` to an idle session / `setBudget()` / `confirmTool()` / `answer()`; stream reconnect = `stream(id, { afterSeq })`. | Don't look for `sessions.resume`. |
| D7 | `sessions.create({ agent_id, message })` | Correct. `message` is a **string only** (no structured input field). | Serialize structured inputs into `message` (JSON) + `metadata`. |
| D8 | Teams example `multiagent: { type: "coordinator", agents: [{ type: "agent", id, version }], board: true }`, `expected_version: coordinator.current_version` | Matches SDK `AgentSchema.multiagent` and AgentPatch exactly (1–20 entries; `{type:"self"}` also allowed; `advisor` parses but is refused at save). | OK. |
| D9 | Webhook names `session.idle`, `message.completed`, `budget.exceeded` | All three are real event types in the SDK enum. | OK (webhook delivery details: see webhooks doc, out of this topic). |
| D10 | "Check the harness docs: the `claude_code` harness or Messages-format model proxy may let us use our Claude key" | **Neither uses our own Anthropic key.** All harnesses are `billing: "usage"` (metered to Naïve credits); the proxy authenticates with a **Naïve** key, bills the Naïve balance, and only accepts Naïve catalogue model ids. No BYOK feature is documented. | Claude key can only be used outside Naïve (direct Anthropic API). Ask founders before doing so. |
| D11 | "Check `GET /v1/models` for Claude models and a vision-capable model" | Model object has **no modality/vision flag and no price**. Docs mention no Claude model id. Vision is via built-in `view_image` tool (PNG/JPEG/GIF/WebP `fil_` ids, ≤4 per call) on `pi`/`vetta` harnesses — needs a vision-capable model, which the API can't tell us. The model proxy **refuses image content blocks**. | Requires a live key: `models.list({ search: "claude" })`, `search: "vision"`/`"vl"`, then a test session calling `view_image`. |
| D12 | Vault "injects credentials at the network boundary (live for MCP connectors)"; keep AgentMail/Monid/Neon keys in the vault | Vault kinds that work: `static_bearer`, `mcp_oauth` (MCP servers only, matched by URL). **`env_var` → 501 `feature_not_configured`.** Inline secret headers on `mcp_servers` are rejected. | Neon DSN / raw API keys can't be vault-injected into the sandbox today; only MCP-server bearer tokens. |
| D13 | `claude_code` harness as an option | `claude_code`: preview, `approvals:false`, `structured_output:false`, `streaming_deltas:false`, no Naïve built-ins (web_search/fetch, publish_file, generate_image, view_image-family, browser). Any `ask` tool (incl. MCP tools, which default to `ask`) → 400 at session start. | Use `pi` for every agent that needs `output_schema` enforcement, approvals, or built-in web/data tools. |
| D14 | "Naïve's built-in web and data tools" for unattended agents | `data_run`, `generate_video`, `mobile`, `email.send`, `social.post`, … **ask by default even under `default_config.permission: "allow"`**; MCP tools default to `ask`. An unattended session parks `awaiting_approval`. | Explicitly set `configs.data_run = { permission: "allow" }` (and each MCP tool) on overnight agents. |

## 5. Answers to open questions (spec §14)

| Question | Answer | Confidence | Source |
|---|---|---|---|
| Which Claude models (and vision-capable models) does Naïve's router offer? | **Update from the builder's live check (NOTES.md, 2026-11-07, `GET /v1/models` with the org key; the critic did not re-run it):** `anthropic/claude-haiku-5.5`, `anthropic/claude-sonnet-5.5`, `anthropic/claude-opus-5.5` (plus `:batch` variants) are served; vision-named ids include `qwen/qwen3-vl-*` and `z-ai/glm-5v-turbo`; only `zai-org/GLM-5.2-FP8`, `google/gemma-4-31B-it`, `moonshotai/Kimi-K2.6` accept `loose`. Original pre-key text: Unknown without a key: catalogue is live (hundreds of models, filtered to text-out + tool-calling + priced). Docs list no Claude id and the model object has no vision flag. Confirm with `GET /v1/models?search=claude` / `naive models list --search claude`. Note proxy rejects foreign-catalogue ids. | medium (that it's undocumented); low (on what the live catalogue holds) | https://usenaive.ai/docs/api/models.md; https://usenaive.ai/docs/concepts/model-router.md; grep of llms-full.txt |
| Can our Claude API key be used through Naïve (`claude_code` harness or the model proxy)? | **No (documented).** `claude_code` runs Claude Code as a process billed `usage` to Naïve credits; the proxy uses a Naïve key + Naïve balance + Naïve catalogue ids. No BYOK option anywhere in docs/SDK/OpenAPI. The reverse works: point an Anthropic-SDK client at `ANTHROPIC_BASE_URL=https://api.vetta.sh/v1/proxy/anthropic` with the Naïve key. | high | https://usenaive.ai/docs/concepts/harness-capabilities.md ("All four are `location: hosted` and `billing: usage`"); https://usenaive.ai/docs/api/proxy.md |
| Does incoming email wake Naïve agents? | Runtime doc lists "an inbound email or text to an inbox or number the agent owns" as a wake trigger (identity inboxes). Not verified live; out of this topic's scope — we use AgentMail webhooks regardless. | low | https://usenaive.ai/docs/concepts/runtime.md line 17 |
| (Unlisted but relevant) Is the hackathon org active? | `GET https://api.vetta.sh/v1/hackathon/status` (no auth) returned `{"object":"hackathon_status","open":true}` on 2026-11-07. Every non-billing route needs an active plan (`402 subscription_required`) — hackathon credits presumably cover this; confirm with `naive whoami` / `credits.subscription()` once a key exists. | medium | live request (§3.9) |

## 6. Credentials needed

| env var | Service | Where to get it | Cost | Needed for |
|---|---|---|---|---|
| `NAIVE_API_KEY` | Naïve Managed Agents (`api.vetta.sh`) | A founder (human — account creation is theirs) signs in (`naive login --email … --password …` or the dashboard), runs `naive whoami`, starts/confirms the plan (`naive plan show`), then `naive keys create --name terragent --scopes agents:read,agents:write,sessions:read,sessions:write` (quickstart). Format `sk_live_…`, shown once. Scopes: give the server key `agents:write sessions:write` (+ `billing:read` for spend, `webhooks:*`, `files:read`) or `admin`. | Plan: Standard $20/mo (7-day trial, $10 trial credit) or Pro; hackathon gives $250 credits. Usage metered in micro-USD. | Every SDK/REST/CLI call. |
| (optional) `VETTA_API_BASE_URL` | CLI only | — | — | Override API origin for the CLI; SDK uses `baseUrl` option. |
| `ANTHROPIC_API_KEY` | Anthropic (direct, NOT via Naïve) | Founders already hold it | paid | Only if Naïve lacks something (spec §4.1); cannot be routed through Naïve. |

Source: https://usenaive.ai/docs/api/authentication.md ("Scopes", "sk_live_"); https://usenaive.ai/docs/cli/overview.md (env table); https://usenaive.ai/docs/platform/pricing.md ("Plans").

## 7. Gotchas & limits

**Rate limits / concurrency** (default org tier): 6000 req/min per org, 3000 req/min per API key, fixed 60 s window; **50 sessions `running` concurrently** (excess sit `queued`). 429 `rate_limited` + `Retry-After`; headers `RateLimit-Limit/Remaining/Reset`. Source: https://usenaive.ai/docs/api/overview.md ("Rate limits & concurrency").

**Errors to branch on** (`error.code`): `validation_failed` 400, `window_unavailable` 400, `unauthorized` 401, `budget_exceeded` 402, `insufficient_credits` 402, `subscription_required` 402, `forbidden` 403, `not_found` 404, `version_conflict` 409, `idempotency_conflict` 409, `session_running` 409, `session_terminal` 409, `job_not_ready` 409 (retry), `rate_limited` 429, `internal_error` 500, `provider_error` 502, `feature_not_configured` 501. Retry 429/5xx with backoff; 400/401/402/403/404 terminal; branch 409 on `code`. A non-JSON HTML 403 = edge WAF block ("request body looks like SQL"). Source: https://usenaive.ai/docs/api/errors.md; live 401 below.

**Idempotency:** SDK sends a fresh UUID `Idempotency-Key` per write. Same key + same body replays (`Idempotency-Replayed: true`); same key + different body → 409. Keys never expire — pass your own `opts.idempotencyKey` on `sessions.create/send` only for true retries. Source: https://usenaive.ai/docs/api/overview.md ("Idempotency").

**Budgets:**
- All money integer micro-USD. `max_task_micro_usd <= cap_micro_usd`. Session `budget_micro_usd <= agent cap_micro_usd`; default = `max_task_micro_usd`. `setBudget` raise-only, must exceed consumed.
- Pre-flight gate order: org balance → agent period cap → task ceiling → session budget. Breach → `budget.exceeded` event + `session.idle{stop_reason:"budget_paused"}`.
- **Web tools (`web_search` $0.00166/call, `web_fetch` $0.00083/page) and media are booked after the fact — `max_task_micro_usd` does not bound them**; agent cap + org balance are the real limits. `data_run` is admitted first at listed price (median ≈ $0.0015, max ≈ $0.95/run, 2-min limit).
- Agent spend > sum of session spend: computer time is billed to the agent (`computer` component). `by_component` keys: `model`, `computer`, `search`, `media` (absent = 0).
- Pre-flight reserves `input + max_output_tokens` at output rate → models with large `max_output_tokens` hold more credit per in-flight call.
Source: https://usenaive.ai/docs/concepts/budgets.md; https://usenaive.ai/docs/platform/pricing.md ("Priced tools"); https://usenaive.ai/docs/api/agents.md ("Spend"); https://usenaive.ai/docs/concepts/model-router.md ("max_output_tokens").

**Pricing:** no per-model rate card is published (model object has no price; ledger is truth). `immediate` routes to the fastest provider so two identical calls can cost differently. `vetta/auto` capped at $5/M in, $25/M out. Plans: Standard $20/mo incl. $20 credit (7-day trial, $10 credit), Pro $200/mo incl. $200. Source: https://usenaive.ai/docs/platform/pricing.md; https://usenaive.ai/docs/concepts/model-router.md.

**Sizes / durations:**
- `name` 1–100 chars; `mcp_servers` ≤ 20 (name 1–64 chars; `https` URL with optional non-secret `headers` ≤4096 chars each, or `http` with no headers; no localhost/private IPs); MCP server ≤ 100 tools; every declared MCP server must be referenced by ≥1 enabled `configs["<server>.<tool>"]` entry; `multiagent.agents` 1–20; `handoffs` list ≤ 50; `model_selection.options` 2–16. Source: live OpenAPI `createAgent` schema; https://usenaive.ai/docs/capabilities/tools.md ("MCP connector").
- `skills[]` entries must match `^(naive\/)?[a-z0-9][a-z0-9-]*(@\d+)?$` (live OpenAPI) — i.e. **slugs**, optional `naive/` (platform catalogue) and `@N` pin. Docs say "slug or id", but `skl_…` ids contain `_`, which this pattern rejects → use slugs. Unresolvable → `404 not_found param=skills`.
- `message`: must contain a non-whitespace char; **no documented max length** (bounded by model `context_window`; transcripts auto-compact). Plan markdown ≤ 20,000 chars. Events page `limit` ≤ 100.
- No documented max session duration: sessions are durable, idle costs storage only (but `pi`/`claude_code`/`hermes` idle sessions hold a micro-VM). `max_iterations` stop_reason = per-turn step cap; send another message to continue. Events replayable ≥ 72 h; sessions/events never deleted.
- Tool config changes apply to **new** sessions only (running sessions keep their config).
Source: https://usenaive.ai/docs/api/sessions.md; https://usenaive.ai/docs/concepts/sessions.md; https://usenaive.ai/docs/capabilities/tools.md ("The tools config").

- `output_schema` must be a JSON Schema with `"type": "object"` and **at least one property** — the SDK's core `JsonSchemaDocument` refines exactly this (`MA.js:321-327`); presumably the server uses the same core schema (not confirmed live).
- A `pi`/`claude_code`/`hermes` session runs on **the agent's computer** (one per agent, shared by all its sessions). A computer has a **12-hour max lifetime (wall-clock, create→destroy)** and is auto-destroyed; the session continues on a fresh computer (`session.computer_replaced`, files since last archive lost). (critic-verified, reconciles this doc with naive-compute.md: api/computers.md "An agent's computer" says "The machine under it can change: the files are kept", and api/events.md says `session.computer_replaced` `reason: "expired"` means "rebuilt from its newest archive … Files changed since the newest archive are gone". So an agent's files survive the 12 h cap via archive-restore, but recent writes can be lost and the archive cadence is unpublished. Make the pipeline bootstrap idempotent (check a VERSION file, re-install if missing) and `publish_file` outputs as soon as they exist.) Agent computer ≈ $0.0666/h while running. Persist outputs with `publish_file` / Files. Source: https://usenaive.ai/docs/computer/limits-and-billing.md ("Limits"); https://usenaive.ai/docs/api/sessions.md (`computer_id`); https://usenaive.ai/docs/platform/pricing.md.
- Each turn runs in a bounded "slice" (step + wall-clock + spend budgets); hitting a bound checkpoints and reschedules. Numeric slice limits are not published. Source: https://usenaive.ai/docs/concepts/runtime.md ("Bounded slices").

**SDK quirks:**
- ESM-only; no retries; no auto-pagination; no `Agent`/`Event` type exports.
- `structured_output` typed `Record<string, unknown> | null` → validate with zod.
- `stream()` returns silently after `maxRetries` drops → always confirm with `sessions.get()`.
- `stream()` ends at first `session.idle`; for the next turn use `afterSeq: accepted_seq` from `send()`.
- `sessions.send()` to a running session → 409 `session_running` unless `interrupt` or `queue`.
- Docs show `mcp_servers: [{ "type": "url", name, url }]`; the SDK type and live OpenAPI have **no `type` field** (`{ name, url, headers? }`). Follow the SDK.
- Deleting an agent deletes its deployments (cron) without asking.
- `message.delta` only on `pi`; on other harnesses use `message.completed`.
- An `idle` session with `stop_reason: "awaiting_answer"` emits no special event — only `session.idle`.

## 8. Unverified

Everything below needs an API key (`NAIVE_API_KEY`) to confirm. Suggested one-shot check: `naive whoami && naive plan show && naive credits show && naive models list --search claude && naive models list --window loose && naive models get z-ai/glm-5.3-flash`, plus `curl -s https://api.vetta.sh/v1/harnesses -H "authorization: Bearer $NAIVE_API_KEY"` (no CLI command for harnesses exists in `@usenaive-sdk/cli@1.0.3`; SDK: `naive.harnesses.list()`).

1. **Which models exist live** — Claude ids (`models.list({ search: "claude" })`, `search: "anthropic"`), vision-capable ids (no flag exists; test by giving a `pi` session a PNG `fil_` and calling `view_image`), and current `supported_windows` for `z-ai/glm-5.3-flash`, `zai-org/GLM-5.2-FP8`, `moonshotai/Kimi-K2.6`, `google/gemma-4-31B-it`. Docs examples may be stale (the catalogue is live).
2. **Per-model prices / window discount** — not published anywhere; only measurable from `session.consumed_micro_usd`, `span.model_request.end.data.consumed_micro_usd`, and `agents.spend(id, { by: "component" })` after a real run.
3. **`GET /v1/harnesses` live values** — especially `runnable` for `claude_code` and `vetta` on our org (docs: claude_code "needs an image"; vetta "only orgs it is opened to").
4. **Plan / credits state** of the hackathon org: `credits.subscription()` status and `credits.show()` balance; whether hackathon credits remove the `402 subscription_required` gate.
5. **Effective rate limits** — read `RateLimit-*` headers on any authed call (docs default: 6000/min org, 3000/min key, 50 running sessions).
6. **Server-side `output_schema` rule** (`type: "object"` + ≥1 property) — SDK-side confirmed; server behaviour assumed identical.
7. **`skills[]` accepting `skl_` ids** — docs say "slug or id", live OpenAPI pattern only admits slugs; try `agents.create({ ..., skills: ["skl_..."] })` once and see if it 400s.
8. **`mcp_servers[].type`** — docs example sends `"type": "url"`; SDK/OpenAPI omit it. Whether the server rejects or ignores it is unknown; don't send it.
9. **Vault credential injection for MCP servers** — whether the session needs an `identity` for an identity-scoped vault's `static_bearer` to be injected ("A vault maps to an identity and is referenced per session"). Test with a throwaway MCP server.
10. **Exact `message.completed.data.content` type** — docs and SDK show it as text (`String(ev.data.content)` pattern); the SDK types `data` as `Record<string, unknown>`. Confirm it is a plain string (not content blocks) on `pi`.
11. **No documented max `message` length or max session duration** — only per-model `context_window`, automatic compaction, and the 12 h computer lifetime. Large JSON inputs should be tested.
12. **Inbound email waking agents** (spec §14) — runtime doc says inbound email/text to an identity inbox is a wake trigger; not tested (we use AgentMail webhooks regardless).
13. `agents.list` response in docs carries `"object": "list"` (models list) — SDK strips unknown keys, harmless; not live-confirmed.

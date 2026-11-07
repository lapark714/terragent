# Monid platform reference (verified)

Status: COMPLETE (pending key-gated checks in section 8). Research date: 2026-11-07. Evidence: live fetches of https://monid.ai/SKILL.md (v0.1.9), https://monid.ai/openapi.json (Monid API 0.1.0), https://monid.ai/docs/llms.txt and the pages it links, unauthenticated live calls to `https://api.monid.ai/public/v1/*`. No Monid API key was available, so nothing under `/v1/*` was called.

## 1. TL;DR for builders
- No SDK package exists. Call the REST API with `fetch`: base `https://api.monid.ai`, header `Authorization: Bearer $MONID_API_KEY` (key format `monid_live_...`). Contract: https://monid.ai/openapi.json.
- A tool is identified by **`provider` + `endpoint`** (e.g. `akta` + `/v1/news`). Inputs go in `input: { body?, queryParams?, pathParams? }`, exactly matching the JSON Schemas from inspect.
- The 5 calls: `POST /v1/discover/endpoints {q, limit, category}` (free) -> `POST /v1/inspect {provider, endpoint}` (free, gives input schema + price) -> `POST /v1/run {provider, endpoint, input}` (billed) -> `GET /v1/runs/{runId}` (poll when run returned 202) -> `GET /v1/wallet/balance`.
- Sync/async is decided by the endpoint: 200 = finished (`COMPLETED` or `BLOCKED`), 202 = poll. A provider error is mirrored as the provider's HTTP status with a full run body (not billed). 402 = our wallet is empty. 408 = `TIMED_OUT` (not billed). Status strings are UPPERCASE.
- Cost is in `run.cost.value` (GET run, dollars) or `billing.reportedCost` (run response, int + unit). Compare these, not the price card.
- **No per-call max-price parameter** (`RunRequest` has `additionalProperties: false`). Workspace budgets/run caps exist but the API can only list/patch them, not create them. Enforce caps in our own wrapper (allowlist + max price per endpoint + spend ledger in Neon).
- The MCP server `https://mcp.monid.ai/v1` (Streamable HTTP) is **OAuth 2.1 only** (Clerk, DCR + PKCE), so a human must log in once. For headless Naïve agents use REST tools with the vault injecting the bearer header for `api.monid.ai` (+ `sfs.monid.ai`), or the CLI in the sandbox. **(critic-verified against Naïve identity/vault.md + api/vaults.md) Neither of those works in Naïve today.**
  - Host-bound header injection is the vault's `env_var` kind, which answers `501 feature_not_configured`.
  - A key passed into the sandbox for the CLI lands in the 30-day, unredacted command history and in model context.
  - A vault `mcp_oauth` credential holding a Monid OAuth access token is possible, but "There is no refresh".

  So route Monid through our **Terragent MCP gateway on Vercel** (`MONID_API_KEY` in Vercel env), exposing narrow `monid_discover` / `monid_inspect` / `monid_run` tools with an allow-list and a max price per call.
- Picks for $20 (live prices): news/events `akta /v1/news` ($0.005 + $0.0005/article); company resolve `akta /v1/company/search` ($0); people `apollo /mixed_people/api_search` ($0, no emails) then `hunterio /email-finder` ($0.0245, $0 if not found); property `zillow /get_zestimate` ($0.03); weather `api.kadec0.xyz /v1/weather` ($0.01); geocode `api.kadec0.xyz /v1/geocode` ($0.02).
- Traps: catalog category `geo` means AI-answer SEO, not geospatial. No tool advertises cloud cover. No satellite or imagery tools at all (confirmed). The legacy `/v1/discover` takes `query`, the new route takes `q`. PATCH control amounts are `{value:int, unit}`, but GET returns them as float dollars.

## 2. Install & setup

There is **no Monid TypeScript/Python SDK package**. Verified on npm 2026-11-07: `@monid-ai/sdk`, `@monid-ai/client`, `@monid-ai/mcp`, `@monid-ai/monid`, `monid`, `monid-sdk`, `@monid/sdk` all return E404. Integration options:

| Option | What | Verified version / URL |
|---|---|---|
| HTTP API (recommended for our Next.js code + Naïve tools) | plain `fetch` to `https://api.monid.ai` with `Authorization: Bearer $MONID_API_KEY` | OpenAPI `info.version` 0.1.0 at https://monid.ai/openapi.json |
| CLI (for a Naïve sandbox computer / skill) | `npm install -g @monid-ai/cli@0.1.9` -> `monid` binary, Node >= 20 | `npm view @monid-ai/cli` -> `version 0.1.9`, dist-tags `latest: 0.1.9`, `dev: 0.1.9-dev.20261103054005`, modified 2026-11-03. Published tarball is one bundled `dist/index.js` (no `.d.ts`). |
| Skill | `https://monid.ai/SKILL.md` (frontmatter `name: monid`, `version: 0.1.9`; skill and CLI versions must match) | fetched 2026-11-07, 38,349 bytes |
| MCP server | `https://mcp.monid.ai/v1`, Streamable HTTP, **OAuth 2.1 (Clerk) only** — see 3.9 | probed live 2026-11-07 |

Typed client: the CLI source (MIT, https://github.com/monid-ai/cli, `src/api/types.ts`, `src/api/client.ts`) is the closest thing to SDK types; the OpenAPI spec is the authoritative contract. Generate types with e.g. `npx openapi-typescript https://monid.ai/openapi.json -o src/lib/monid/openapi.d.ts` (not run here; it would write into the repo).

CLI non-interactive setup inside a sandbox (the CLI reads **no** API-key env var; keys live in `$XDG_CONFIG_HOME/monid/credentials.json` or `~/.config/monid/credentials.json`, mode 0600). **(critic-verified in the published 0.1.9 bundle, `src/config/manager.ts`: `new Conf({ configName: "credentials", fileExtension: "yaml", configFileMode: 384 })`.) So the file is `credentials.yaml`, not `.json`, matching NOTES.md.**
```bash
npm install -g @monid-ai/cli@0.1.9
monid setup --client naive            # optional telemetry; needs no key
monid keys add -k "$MONID_API_KEY" -l main   # first key auto-activates
export NO_COLOR=1                     # plain output for agents
monid discover -q "company news" -j
```
CLI env vars actually read (from published bundle `dist/index.js`): `MONID_API_BASE_URL` (default `https://api.monid.ai`), `MONID_WEB_BASE_URL`, `MONID_SETUP_CLIENT`, `MONID_SETUP_EMAIL`, `XDG_CONFIG_HOME`. The CLI sends header `X-Monid-Client: cli@<version>`.
Source: `npm view @monid-ai/cli`; scratch install `node_modules/@monid-ai/cli/dist/index.js` (grep `process.env.*`); https://github.com/monid-ai/cli `src/config/constants.ts`, `src/config/paths.ts`, `src/config/manager.ts` (Conf `configName: 'credentials'`, `configFileMode: 0o600`), `src/utils/keys.ts`, `src/api/client.ts` L131-135; SKILL.md "Setup".

Minimal TypeScript client (our code; mirrors the OpenAPI contract):
```ts
// src/lib/monid.ts
const MONID = "https://api.monid.ai";
async function monid<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(MONID + path, {
    method,
    headers: { Authorization: `Bearer ${process.env.MONID_API_KEY!}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json()) as T;          // run bodies are returned even on provider non-2xx / 408 / 502
  return { status: res.status, data };
}
export const discover = (q: string, limit = 5, category?: string) =>
  monid<{ items: any[]; total: number }>("POST", "/v1/discover/endpoints", { q, limit, category });
export const inspect = (provider: string, endpoint: string) => monid<any>("POST", "/v1/inspect", { provider, endpoint });
export const run = (provider: string, endpoint: string, input: { body?: object; queryParams?: object; pathParams?: object }) =>
  monid<any>("POST", "/v1/run", { provider, endpoint, input });
export const getRun = (runId: string) => monid<any>("GET", `/v1/runs/${runId}`);
export const balance = () => monid<{ balance: { value: number; currency: string }; held: { value: number; currency: string } }>("GET", "/v1/wallet/balance");

// run + poll helper: 200 = done (COMPLETED|BLOCKED), 202 = poll
export async function runAndWait(provider: string, endpoint: string, input: object, timeoutMs = 120_000) {
  const r = await run(provider, endpoint, input as any);
  if (r.status !== 202) return r.data;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((s) => setTimeout(s, 5000));
    const g = await getRun(r.data.runId);
    if (["COMPLETED", "FAILED", "BLOCKED", "STOPPED", "TIMED_OUT"].includes(g.data.status)) return g.data;
  }
  throw new Error(`monid run ${r.data.runId} still running`);
}
```
Source: shape from openapi.json `/v1/run` responses; header pattern from https://monid.ai/docs/integrations/direct/setup.md (uses `process.env.MONID_API_KEY`).


## 3. API reference

Base URL: `https://api.monid.ai` (OpenAPI `servers[0]`, "Production").
Auth: every `/v1/*` route takes `Authorization: Bearer <monid api key>`; `/public/v1/*` routes need no auth. Key format `monid_<stage>_<secret>`, e.g. `monid_live_...`. With an API key the workspace is bound to the key; no `x-workspace-id` header needed (that header is only for OAuth/JWT tokens without an org context).
Errors: body is `{ code: number, message: string, hints?: {...}, errorCode?: ApiErrorCode }`.
Source: https://monid.ai/openapi.json (`info.description`, `servers`, `components.securitySchemes.Bearer`, `components.schemas.Error`); https://monid.ai/docs/integrations/direct/setup.md; https://monid.ai/SKILL.md "Key Management".

### 3.1 The flow: discover -> inspect -> run -> (poll) -> balance
A tool ("endpoint") is identified by the pair **`provider` (slug) + `endpoint` (path within provider)**, e.g. `provider: "apify", endpoint: "/apidojo/tweet-scraper"`. There is no single tool id string. Inputs are passed as a composite object split by HTTP location: `input.body`, `input.queryParams`, `input.pathParams` (mirrors the `input` JSON Schemas returned by inspect).
Source: openapi.json `components.schemas.RunRequest`, `EndpointInput`; SKILL.md "When to Use Monid" step 3.

### 3.2 `POST /v1/discover/endpoints` (current semantic search)
```ts
// request (components.schemas.DiscoverEndpointsRequest)
type DiscoverEndpointsRequest = {
  q: string;                 // 1..1000 chars, natural language, e.g. "company news"
  limit?: number;            // default 5, capped at 200
  category?: string;         // category node id from GET /public/v1/categories, e.g. "weather"
  minScore?: number;         // 0..2 post-rerank floor
  includeUnavailable?: boolean; // default false (outage endpoints hidden)
  supportsX402?: boolean;
  x402Network?: string;      // CAIP-2, e.g. "eip155:8453"
  readonly?: boolean;        // true = cannot create/modify/delete workspace resources
  effects?: ("creates" | "updates" | "deletes")[];
};
// response (DiscoverEndpointsResponse)
type DiscoverEndpointsResponse = { items: DiscoverEndpointCard[]; total: number };
type DiscoverEndpointCard = PublicEndpointInfo & {
  metrics?: { status: "healthy"|"stable"|"degraded"|"outage"|"unknown"; runTimeMs?: { p50?: number; p95?: number } };
  score: number;             // opaque rerank score
};
type PublicEndpointInfo = {
  provider: string; providerDisplayName: string; providerDisplayDescription?: string;
  endpoint: string; displayName: string; displayDescription: string;
  price: PublicPrice; tags: string[]; categories: string[];   // live values are flat ids, e.g. ["weather","weather-underground"] (OpenAPI text says depth-2 paths like "social-media/twitter")
  promotion?: {...}; supportedX402Networks: string[];
};
```
Source: openapi.json `paths./v1/discover/endpoints.post`, schemas `DiscoverEndpointsRequest`, `DiscoverEndpointsResponse`, `DiscoverEndpointCard`, `PublicEndpointInfo`.

Legacy `POST /v1/discover` (deprecated, still used by CLI/MCP): body `{ query: string; limit?: number /*default 5*/; minScore?; includeUnavailable?; supportsX402?; x402Network?; readonly?; effects? }` -> `{ results: DiscoverResult[]; query: string; count: number }`, where `DiscoverResult = { provider, providerName?, endpoint, description, price: DiscoverPrice, score, tags, promotion?, metrics?, hints? }`. NOTE the field-name difference: legacy uses `query`, new uses `q`. The quickstart docs still show the legacy `{"query": ...}` form.
Source: openapi.json `DiscoverRequest`, `DiscoverResponse`, `DiscoverResult`; https://monid.ai/docs/guide/quickstart-api.md.

Also: `POST /v1/discover/categories` and `POST /v1/discover/providers` (same search, grouped), `POST /v1/discover/resources` (rentable resources), `GET /v1/endpoints` (browse catalog, `category` filter, cursor pagination).

### 3.3 `POST /v1/inspect`
```ts
type InspectRequest = { provider: string; endpoint: string };   // e.g. { provider: "akta", endpoint: "/v1/news" }
type InspectResponse = {
  provider: string; providerName?: string; endpoint: string;
  description: string; summary?: string;
  method?: "GET"|"POST"|"PUT"|"DELETE"|"PATCH";
  price?: Price; docUrl?: string; notes?: string[];      // notes = operator-curated quirks for agents
  promotion?: {...}; tags: string[]; categories: string[];
  metrics?: {...}; hints?: Record<string, string | Hint>;
  input?: {                                              // EndpointInput: JSON Schema per location
    pathParams?: Record<string, any>; queryParams?: Record<string, any>;
    body?: Record<string, any>; bodyType?: "json"|"form"|"multipart";
  };
};
```
There is NO output schema in InspectResponse; output shape is only learnable from a real run (or the provider's `docUrl`).
Source: openapi.json schemas `InspectRequest`, `InspectResponse`, `EndpointInput`.

### 3.4 `POST /v1/run` (scope `runs:create`)
```ts
type RunRequest = {
  provider: string;          // e.g. "akta"
  endpoint: string;          // e.g. "/v1/news"   -> input: { queryParams: { company: "https://canva.com", limit: 5 } }
  input?: { body?: Record<string, any>; queryParams?: Record<string, any>; pathParams?: Record<string, any> };
};
```
Sync vs async is decided **by the endpoint, not by the caller** (no `async`/`wait` flag in RunRequest):
| HTTP | Meaning | Body |
|---|---|---|
| 200 | sync run finished: `status: "COMPLETED"` (provider answered) or `status: "BLOCKED"` (workspace control) | `RunCompleted \| RunBlocked` |
| provider's non-2xx | sync run COMPLETED but provider errored; Monid mirrors the provider status | same `RunCompleted` body, provider error in `output`/`providerResponse` |
| 202 | async endpoint accepted; poll `GET /v1/runs/{runId}` | `RunAccepted { runId, provider, endpoint, status, price, createdAt, hints? }` |
| 400 | input failed validation (`message` names the field) | `Error` |
| 401 | key missing/invalid/expired/revoked | `Error` |
| 402 | **wallet balance too low** (always about your wallet); `errorCode: "WALLET_INSUFFICIENT_FUNDS"` | `Error` |
| 403 | key lacks scope (`INSUFFICIENT_SCOPE`) or no workspace | `Error` |
| 404 | endpoint not found for provider | `Error` |
| 408 | run exceeded its time budget, status `TIMED_OUT`, **not charged** | full run |
| 429 | rate limited; honour `Retry-After`; `RateLimit-Limit/-Remaining/-Reset` headers | `Error` (`errorCode: "RATE_LIMITED"`) |
| 502 | provider itself returned 402 (provider's account problem, not your wallet) | full COMPLETED run |
```ts
type RunStatus = "READY"|"RUNNING"|"STOPPING"|"COMPLETED"|"FAILED"|"BLOCKED"|"STOPPED"|"TIMED_OUT"; // UPPERCASE, case-sensitive
type RunCompleted = {
  runId: string; provider: string; endpoint: string; status: RunStatus;
  output?: any;                          // provider payload (terminal runs only; may be null). Files appear as { download_link, content_type, link_expires_at, file_expires_at? }
  providerResponse: { httpStatus?: number; error?: any };
  price: Price;                          // user-facing price card (markup applied)
  billing?: { reportedCost: { currency: "USD"; value: number /*int*/; unit: "MICRO_DOLLAR"|"CENT"|"DOLLAR" } };
  resultCount?: number; billedUnits?: number;
  resources?: { action: "PROVISIONED"|"PROVISION_FAILED"|"RELEASED"|"RELEASE_FAILED"; resourceId: string; resourceType: string; identifier: string }[];
  stopRequestedAt?: string; createdAt: string; completedAt?: string; hints?: {...};
};
type RunBlocked = {
  runId: string; status: "BLOCKED"; provider: string; endpoint: string; reason: string; price: Price;
  controls: { controlId: string; controlType: string; requiredAmount?: number /*dollars*/; snapshot: Record<string, any> }[];
  createdAt: string; completedAt: string; hints?: {...};
};
```
Source: openapi.json `paths./v1/run.post` (description + responses 200/202/400/401/402/403/404/408/429/500/502), schemas `RunRequest`, `RunAccepted`, `RunCompleted`, `RunBlocked`, `ProviderResponse`, `RunBilling`, `Error`.

### 3.5 `GET /v1/runs/{runId}` (poll), `GET /v1/runs`, `POST /v1/runs/{runId}/stop`, `GET /v1/runs/{runId}/controls`
```ts
type Run = {
  runId: string;                 // ULID
  caller: string;                // "API_KEY#<fp>" | "X402#<addr>" | "RESOURCE#<id>" | "USER#<id>"
  owner?: string; provider: string; providerName?: string; endpoint: string;
  status: RunStatus; stoppable?: boolean; reason?: string; controls?: Record<string, any>[];
  input: { body?; queryParams?; pathParams? };
  output?: any; providerResponse?: { httpStatus?: number; error?: any };
  price: Price;
  cost?: { value: number; currency: "USD" };   // what you were charged (dollars, float)
  resultCount?: number; billedUnits?: number; resources?: [...];
  createdAt: string; startedAt?: string; completedAt?: string; hints?: {...};
};
```
`GET /v1/runs` lists newest first, cursor pagination, `status` filter (scope `runs:list`). Stop only when `stoppable === true`; stop is async (poll until `STOPPED`); a stopped run is not charged; stopping a non-stoppable run returns 409 conflict. Poll every 5-10 s; runs typically take 1-120 s.
Source: openapi.json schema `Run`, `paths./v1/runs*`; SKILL.md "Run Statuses", "Polling Best Practices"; https://monid.ai/docs/api-reference/runs/stop-a-run.md (llms.txt summary).

### 3.6 Price card (`Price` / `PublicPrice` / `DiscoverPrice`)
```ts
type Money = { value: number; currency: "USD" };       // dollars, float
type PriceLeaf =
  | { type: "PER_CALL"; amount: Money }
  | { type: "PER_RESULT"; amount: Money; flatFee?: Money }
  | { type: "METERED"; amount: Money; per: { unit: "MINUTE"|"DAY"|"MONTH"; count: number } }
  | { type: "PER_UNIT"; amount: Money; per: number; unit: "token"|"character"|"second"|"image"|"credit"|"result"|"gb-month"|"step"|"byte"|"url"|"page" };
type Price = {
  type: string; amount: Money; flatFee?: Money; period?: {...}; per?: {...} | number; unit?: string;
  default?: PriceLeaf;
  selectors?: { label: string; key: string; in: "body"|"queryParam"|"pathParam"|"output"; offset?: number }[];
  variants?: { when: Record<string, string|number|boolean>; price: PriceLeaf; label?: string }[];   // input-dependent price
  tiers?: { label: string; when?: Record<string, ...>; selector?: {...}; price: PriceLeaf }[];       // add-ons on top of base
  notes?: string[];
};
```
Reading rules (SKILL.md): the base always applies; a tier line `+ <tier>: <price> when k=v` is added when input matches; a `+` line without `when` always applies and is metered by quantity (e.g. "Results above 10: $0.001 / result"). "Not available" = no price card; do not assume free.
Source: openapi.json schema `Price`/`DiscoverPrice`; SKILL.md "Cost & Budget Warning".

### 3.7 Wallet, budgets, run caps
```ts
// GET /v1/wallet/balance  (scope wallet:read) — live, never cached
type WalletBalanceResponse = { balance: { value: number; currency: string }; held: { value: number; currency: string }; topup: TopupHints };
// balance = live amount minus held, never below 0; held = reserved for in-flight runs

// GET /v1/controls/workspace/budgets            (controls:read)  -> paginated WorkspaceBudget[]
// GET/PATCH /v1/controls/workspace/budgets/{budgetControlId}       (PATCH needs controls:update)
type WorkspaceBudget = {
  budgetControlId: string; workspaceId: string; period: "HOUR"|"DAY"|"WEEK"|"MONTH";
  limitAmount: number; spentAmount: number; heldAmount: number; availableAmount: number;  // DOLLARS (float)
  currency: "USD"; windowStart: string; status: "ACTIVE"|"PAUSED"; createdAt: string; updatedAt: string;
};
// GET /v1/controls/workspace/run-caps ; GET/PATCH /v1/controls/workspace/run-caps/{runCapControlId}
type WorkspaceRunCap = { runCapControlId: string; workspaceId: string; limitAmount: number /*per-run cap, dollars*/; currency: "USD"; status: "ACTIVE"|"PAUSED"; createdAt: string; updatedAt: string };
// PATCH body for both (at least one field). NOTE: limitAmount here is an integer + unit, NOT dollars-float:
type ControlPatch = { limitAmount?: { currency: "USD"; value: number /*int >=0*/; unit: "MICRO_DOLLAR"|"CENT"|"DOLLAR" }; status?: "ACTIVE"|"PAUSED" };
// e.g. cap each run at $0.25:  { limitAmount: { currency: "USD", value: 25, unit: "CENT" } }
```
There is **no POST (create) route** for budgets or run caps in the OpenAPI spec: only list/get/patch. Controls are created elsewhere (dashboard, or pre-provisioned per workspace) — see Unverified.
Source: openapi.json `paths./v1/wallet/balance.get`, `paths./v1/controls/workspace/*`, schemas `WalletBalanceResponse`, `WorkspaceBudget`, `WorkspaceBudgetPatchRequest`, `WorkspaceRunCap`, `WorkspaceRunCapPatchRequest`; llms.txt summaries for "Get the live wallet balance", "Update a workspace budget control".

Top-up: `POST /v1/wallet/topup/sessions` (scope `topups:create`) body `{ amount: number /*dollars*/; currency: "USD"; success_redirect?; cancel_redirect?; autoReload?: boolean }` -> `{ paymentProcessor: "STRIPE"; sessionId; url }`. An agent cannot pay; it hands `url` to a human. Minimum top-up currently $5. `GET /v1/wallet/topup` returns fees/min/max/promotion.
Source: openapi.json `WalletTopupRequest`, `WalletTopupSessionResponse`; SKILL.md `monid topup` row.

### 3.8 Public registry (no auth) — usable for catalog browsing without a key
- `GET /public/v1/stats` -> `{ endpointCount, providerCount }`
- `GET /public/v1/categories` -> flat category list with live counts (ids usable as `category`)
- `GET /public/v1/endpoints?limit=&cursor=&category=&provider=&q=` -> `{ items: PublicEndpointInfo[], cursor? , total? }` (cursor pagination)
- `GET /public/v1/providers?limit=&cursor=&q=`
- `GET /public/v1/providers/{provider}/endpoints/{endpoint}` -> one card (endpoint may contain slashes)
- `GET /public/v1/resources`, `GET /public/v1/rankings`, `GET /public/v1/rankings/{board}`
Source: openapi.json `paths./public/v1/*` (security: none).

### 3.9 MCP server (for connecting a Naïve agent)
- URL: `https://mcp.monid.ai/v1`, transport **Streamable HTTP** (registry entry `ai.monid/monid` v1.2.0: `remotes: [{ type: "streamable-http", url: "https://mcp.monid.ai/v1" }]`).
- Auth: **OAuth 2.1 with Dynamic Client Registration + PKCE (S256)**, authorization server is Clerk at `https://clerk.app.monid.ai`. Live probe (no credentials) of `POST https://mcp.monid.ai/v1` -> `401 {"error":"Unauthorized"}` with `www-authenticate: Bearer resource_metadata="https://mcp.monid.ai/.well-known/oauth-protected-resource/v1"`. Protected-resource metadata: `authorization_servers: ["https://clerk.app.monid.ai"]`, `scopes_supported: ["openid","profile","email","offline_access","user:org:read"]`, `bearer_methods_supported: ["header"]`. AS metadata: `authorization_endpoint https://clerk.app.monid.ai/oauth/authorize`, `token_endpoint .../oauth/token`, `registration_endpoint .../oauth/register`, grants `authorization_code`, `refresh_token`, `urn:ietf:params:oauth:grant-type:device_code`.
- Monid's own plugin README: "It authenticates with OAuth 2.1 (Dynamic Client Registration, PKCE), so there is no API key to paste". Every documented client setup (Claude.ai, Claude Code `claude mcp add --transport http monid https://mcp.monid.ai/v1`, Codex, OpenCode, ChatGPT) completes an interactive browser login.
- Whether the MCP server also accepts a static `Authorization: Bearer monid_live_...` API key is **unverified** (a well-formed fake key got the same generic 401 as no key; docs never mention it). See section 8.
- MCP tools (13): `monid_discover`, `monid_inspect`, `monid_run`, `monid_get_run`, `monid_stop_run`, `monid_list_runs`, `monid_balance`, `monid_list_workspaces`, `monid_list_resources`, `monid_get_resource`, `monid_get_resource_external`, `monid_list_resource_events`, `monid_release_resource`. `monid_run` takes the same composite `input` ({ body, queryParams, pathParams }) as REST. There are no MCP tools for budgets/run caps/topup.
- Naïve config sketch (field names must be checked against the Naïve SDK types; this is the Monid side only):
```ts
// Monid side of the connection. Naïve MCP server entry needs: url + transport + OAuth support.
const monidMcp = { name: "monid", url: "https://mcp.monid.ai/v1", transport: "streamable-http" /* auth: OAuth 2.1 DCR+PKCE via clerk.app.monid.ai */ };
```
- Fallback if Naïve's MCP connector cannot do an OAuth login: (a) give agents HTTP tools that call `https://api.monid.ai/v1/*` with the vault injecting `Authorization: Bearer <MONID_API_KEY>` for hosts `api.monid.ai` and `sfs.monid.ai` (this is exactly Monid's documented "Claude Tag" pattern: custom header `Authorization`, prefix `Bearer`, allowed websites `api.monid.ai`, `sfs.monid.ai`); or (b) install `@monid-ai/cli` in the Naïve sandbox computer and use the skill.
  - **(critic-verified) Naïve answers to these points.** Naïve's MCP connector takes only a pre-obtained token: `mcp_oauth` "The access token is the `value` … There is no refresh" (identity/vault.md). It does not run an OAuth login.
  - (a) is not available: host-bound injection = `env_var` → `501`.
  - (b) exposes the key in command history.
  - Working path: a Terragent MCP gateway tool on Vercel calls the REST API with `MONID_API_KEY` from Vercel env, and the vault holds only `TERRAGENT_MCP_TOKEN` for that gateway.
Source: live probes of `https://mcp.monid.ai/v1`, `https://mcp.monid.ai/.well-known/oauth-protected-resource/v1`, `https://clerk.app.monid.ai/.well-known/oauth-authorization-server` (2026-11-07); https://monid.ai/docs/guide/quickstart-mcp.md; https://monid.ai/docs/guide/quickstart-claude-tag.md; https://github.com/monid-ai/plugins `server.json`, `README.md` L55-57, `plugins/monid/skills/monid/SKILL.md` L40-72; https://github.com/monid-ai/cursor-plugin `README.md` L20-28, `mcp.json`.

### 3.10 Listing a new tool as a provider (Terragent answer API as a Monid tool)
Monid is open source at the connector layer: https://github.com/monid-ai/monid (MIT, "Copyright (c) 2026 Monid Inc", Deno 2.x, latest commit 2026-10-22). The hosted platform (api.monid.ai, billing, discover ranking) is NOT in the repo. Process (README "Writing a connector"):
1. Add `connectors/<name>/provider.ts` (`defineProvider`) and `connectors/<name>/endpoints/<endpoint>/endpoint.ts` (`defineEndpoint`), input zod schemas in `schema/inputs.ts`, replay test `endpoint.test.ts`, trimmed `fixtures/*.json` (record with `deno task record`). Endpoint id is inferred as `"<provider>#<endpoint>"`.
2. `deno task check && deno task test` must pass with no network.
3. Open a PR, then email support@monid.ai with the PR link, your API docs link and company name. "We review every connector by hand."
4. Vendor credentials are injected by the hosted transport; locally each field reads `<PROVIDER>_CREDENTIALS_<FIELD>` (e.g. `TERRAGENT_CREDENTIALS_API_KEY`).
Reference shape (verbatim structure from README; `connectors/exa/` is the reference implementation):
```ts
// connectors/terragent/provider.ts  (draft)
export default defineProvider({
  name: "terragent",
  meta: { displayName: "Terragent", summary: "Earth-observation answers for a location + question.", homepageUrl: "https://<our-app>.vercel.app", categories: ["maps"] },  // NOT "geo" (= AI-answer SEO). Category ids live in connectors/categories.ts; no Earth-observation category exists, so propose one in the PR
  auth: { inject: presets.auth.header("X-API-Key") },
  usage: { model: { kind: UsageModelKind.PER_CALL } },   // kinds: FREE | PER_CALL | PER_UNIT | COMPOSITE (shared/core/schema/usage/model/mod.ts)
});
// connectors/terragent/endpoints/answer/endpoint.ts  (draft)
export default defineEndpoint({
  meta: { displayName: "Terragent Answer", summary: "Ask a question about a place; get a satellite-derived answer.", description: "...", docsUrl: "https://<our-app>/docs", categories: ["maps"] },
  endpoint: "/answer",
  request: { method: "POST", path: "/answer", baseUrl: "https://<our-app>.vercel.app/api" },
  input: { schema: { body: zTerragentAnswerBody } },
  timeouts: { requestMs: 15_000, runMs: 20_000 },
});
```
Constraints that matter for us:
- The connector declares the usage **quantity model** (`UsageModelKind`: `FREE`, `PER_CALL`, `PER_UNIT`, `COMPOSITE`) and a `usage.consolidate` settle function. **Monid's broker sets the dollar price** ("this repo reports, the broker prices", DEVELOPMENT.md "Resources"), so our PR cannot set our price.
- Runs have timeouts (README example `timeouts: { requestMs: 15_000, runMs: 20_000 }`; platform runs "1-120 s"). The engine has `start/poll/stop` lifecycle functions ("Temporal-activity-shaped"), so an async connector is possible. The simplest shape for a 2-minute satellite job is still to return a fast Earth-index answer, or to offer submit + get-result endpoints.
- Publishing happens when Monid pushes a `catalog-v<semver>` tag (DEVELOPMENT.md "Publishing the catalog"). Only Monid maintainers can do that, so a merged PR is not live until they release.
- Alternative intake: the "List your tool" form at https://forms.gle/NLPchCCwnTP6zQhV8 (linked from https://monid.ai/llms.txt). No self-serve provider portal or revenue-share terms were found in public docs (see section 8).
Source: https://github.com/monid-ai/monid `README.md` ("Writing a connector", "Quickstart", "How it runs"), `DEVELOPMENT.md` ("Engine", "Usage & billing", "Resources", "Publishing the catalog"), `shared/core/schema/usage/model/mod.ts` L61-66, `LICENSE`; https://github.com/monid-ai/monid/commits/main.atom (updated 2026-10-22T06:04:53Z).

### 3.11 Catalog: concrete tools for Terragent
Catalog size (live `GET /public/v1/stats`, 2026-11-07): `{"endpointCount":2985,"providerCount":97}`. Prices below are the live public price cards (`GET /public/v1/endpoints?provider=...` / `?category=...`, markup applied). Identifier = `provider` + `endpoint` exactly as returned by the catalog (these are the values `POST /v1/run` takes). "Inputs verified" means the input schema was read from the open-source connector in https://github.com/monid-ai/monid (`connectors/<p>/endpoints/<e>/schema/inputs.ts`); everything else needs `POST /v1/inspect` with a key.

How inputs map: Akta, Hunter `email-finder`, Apollo search/match/enrich take **`input.queryParams`**; Hunter `domain-search` and ContactOut search take **`input.body`**; path templates like `/people/{id}` take **`input.pathParams`**. Always confirm with inspect (`input.queryParams` / `input.body` / `input.pathParams` JSON Schemas).

#### A. Company news & business-event signals
| provider | endpoint | price (live) | inputs | output |
|---|---|---|---|---|
| `akta` | `/v1/news` "Track Business Events" | PER_RESULT $0.0005/article + flat $0.005 | **verified** queryParams: `company` (website like `https://canva.com` or Akta uuid; bare names NOT accepted), `query`, `title`, `industry[]`, `start_date`/`end_date` (YYYY-MM-DD; non-enterprise 6-month lookback), **`limit` (required by Monid binding, 1-1000)**, `offset`, `group_articles`, `news_score_list[]` (High/Medium/Low/all), `countries[]` (ISO), `blacklisted[]`, `type_list[]` (event codes, https://playground.akta.pro/news-tags.csv), `sentiment_list[]` (positive/negative/neutral/all), `entity_person_list[]`, `entity_location_list[]`, `entity_product_list[]`, `entity_event_list[]`, `naics_code_list[]`, `sic_code_list[]`, `iptc_code_list[]`, `iab_code_list[]`. Arrays are joined to comma-separated on the wire. | **verified from recorded fixture**: `{ count, data[], limit, offset, total }` (Monid strips `credits_consumed`); each article: `id, title, url, publisher, published_date, sentiment, sentiment_score, ai_summary, word_count, original_language, author, countries[], industries[{name,code,is_primary}], tags[{name,code,is_primary}]` (event type e.g. "Product Launches & Enhancements"/`SD01`), `company_mentions[{uuid,name,website,is_primary}], article_type{code,label}, is_press_release, is_opinion, is_breaking, iptc_codes[], iab_categories[], naics_codes[], sic_codes[], entities{person[],location[],product[],event[]}, newsworthiness_score, group_id, full_text` |
| `akta` | `/v1/news/by-id` | PER_RESULT $0.0005 + flat $0.005 | article ids (schema not read) | full article records (unverified) |
| `context.dev` | `/news/search` "Search Company News" | PER_UNIT $0.002 / credit | by name, domain, ticker or ISIN (schema not checked) | unverified |
| `apollo` | `/news_articles/search` | PER_CALL $0.026 | by organization, category, date | unverified |
| `api.kadec0.xyz` | `/v1/permits` | PER_CALL $0.03 | building permits for Chicago, NYC, Seattle, SF (type, status, address, cost, issue date) | unverified (relevant to the construction playbook) |
| `api.kadec0.xyz` | `/v1/usgs-quakes` | PER_CALL $0.01 | USGS feed filterable by magnitude/time/radius | unverified. Note: the USGS feed itself is free (spec 5.1); prefer it directly. |
Cheapest useful news call: `limit: 5` -> $0.005 + 5 x $0.0005 = **$0.0075**.
Source: live `GET /public/v1/endpoints?category=company-news` and `?provider=akta`; repo `connectors/akta/endpoints/news/endpoint.ts`, `schema/inputs.ts`, `fixtures/happy.json`, `connectors/akta/provider.ts` (consolidate strips `$.credits_consumed`), `connectors/akta/schema/common.ts` (`zCompany`).

#### B. Company search & enrichment
| provider | endpoint | price (live) | notes |
|---|---|---|---|
| `akta` | `/v1/company/search` "Resolve Name to ID" | **$0** | **verified** queryParams `{ query: string }`; returns `uuid, name, website, product_category, company_status`. Use first: other Akta endpoints need website or uuid. |
| `akta` | `/v1/company/enrichment` | PER_RESULT $0.025 (the "result" unit is likely one profile section; unverified) | pick profile sections; by domain or uuid |
| `akta` | `/v1/company/enrichment/concise` | PER_CALL $0.15 | all-section condensed profile |
| `akta` | `/v1/list/generate/companies` | PER_RESULT $0.01 + flat $0.075 | screen companies by industry/location/funding (filter keys free via `/v1/filters/list`, `/v1/filters/options`) |
| `akta` | `/v1/industry/search` | $0 | free text -> industry codes (feeds `industry[]` in news) |
| `apollo` | `/organizations/enrich` | PER_CALL $0.026 | **verified** queryParams one of `domain` / `linkedin_url` / `name` / `website` |
| `apollo` | `/mixed_companies/search` | PER_CALL $0.026 | headcount, location, revenue, funding, keywords, technology |
| `hunterio` | `/companies/find` | PER_CALL $0.0049 | company profile from domain |
| `hunterio` | `/discover` | $0 | B2B company search with structured filters |
| `hunterio` | `/domain-finder` | $0 | company name -> domain |
| `pdl` | `/v5/company/enrich` | PER_CALL $0.10 | name, website, LinkedIn or ticker |
| `datalegion` | `/company/enrich/base` | PER_CALL $0.013 | name, domain, industry, size, type, founding year |
| `the-companies-api` | `/enrich_company_from_domain`, `/search_companies` | PER_CALL $0.01 | 80+ data points (schema unverified) |
Source: live `GET /public/v1/endpoints?provider=akta|apollo|hunterio|pdl|datalegion|the-companies-api`; repo `connectors/akta/endpoints/company-search/{endpoint.ts,schema/inputs.ts}`, `connectors/apollo/endpoints/organizations-enrich/endpoint.ts`.

#### C. B2B people search with verified emails
| provider | endpoint | price (live) | notes |
|---|---|---|---|
| `apollo` | `/mixed_people/api_search` | **$0** | **verified** queryParams: `person_titles[]`, `include_similar_titles`, `q_keywords`, `q_person_name`, `person_locations[]`, `person_seniorities[]`, `organization_locations[]`, `q_organization_domains_list[]`, `contact_email_status[]`, `organization_ids[]`, `organization_num_employees_ranges[]`, `revenue_range[min]`/`[max]`, technology filters, job-posting filters, `page`, `per_page` (1-100). **Returns previews only: obfuscated last name, NO email or phone**, plus Apollo person id. |
| `apollo` | `/people/match` | TIERED: default PER_CALL $0.026; tier "Personal emails" +$0.026 `when {reveal_personal_emails:"true"}`; tier "Mobile phone" +$0.208 `when {reveal_phone_number:"true"}` (metered by output selector `phone_units`) | **verified** queryParams (any of): `first_name`, `last_name`, `name`, `email`, `hashed_email`, `organization_name`, `domain`, `id`, `linkedin_url`, `run_waterfall_email`, `run_waterfall_phone`, `reveal_personal_emails`, `reveal_phone_number`, `webhook_url`, `poll_only`. Per the connector description it returns a verified work email, job title, seniority, department and employment history, plus `match_confidence` (none = not enriched); output schema itself not checked. **Do not set `reveal_phone_number`/`reveal_personal_emails`** (tier add-ons; also outside our work-contacts-only rule). |
| `contactout` | `/v1/people/search/work-email` | TIERED: default PER_RESULT $0.02; "Work email found" +$0.10 per unit of output selector `work_email_units`; "Phone found" +$0.18 per `phone_units` | **verified** POST `input.body`: search filters + paging (`page_size` required, max 25) + `data_types: ("work_email"\|"phone")[]`, `reveal_info: boolean` (true returns actual work emails/phones). Free sizing via `/v1/people/count` ($0). |
| `contactout` | `/v1/people/decision-makers/work-email` | TIERED same as above | decision makers at a company |
| `context.dev` | `/people/search` | 10 credits = $0.02 per page | natural-language people search (schema unverified) |
| `pdl` | `/v5/person/search` | PER_RESULT $0.28 | Elasticsearch/SQL query; expensive |
Recommended pipeline for $20: Apollo `/mixed_people/api_search` ($0) -> pick 1-2 decision makers -> Hunter `/email-finder` ($0.0245, $0 on no-find) or Apollo `/people/match` ($0.026). Avoid ContactOut `reveal_info` with phones ($0.18+/hit).
Source: live `GET /public/v1/endpoints?provider=apollo|contactout|pdl|context.dev`; repo `connectors/apollo/endpoints/mixed-people-api-search/{endpoint.ts,schema/inputs.ts}`, `connectors/apollo/endpoints/people-match/{endpoint.ts,schema/inputs.ts}`, `connectors/contactout/endpoints/people-search-work-email/{endpoint.ts,schema/inputs.ts}`.

#### D. Professional email finder / verifier
| provider | endpoint | price (live) | notes |
|---|---|---|---|
| `hunterio` | `/email-finder` | PER_RESULT $0.0245 | **verified** GET queryParams: `domain` or `company`, plus `first_name`+`last_name` or `full_name` or `linkedin_handle`; `max_duration` 3-20 s. Per connector description it returns email, 0-100 confidence score, title, company, LinkedIn/Twitter handles, phone when known, up to 20 source URLs, auto verification (`valid`/`accept_all`/`unknown`). **No-find returns `email: null` and costs nothing.** |
| `hunterio` | `/domain-search` | PER_RESULT $0.0245 per email | **verified** POST body: `domain`/`company`, `limit` (1-100), `offset`, `type` (`personal`\|`generic`), `seniority`, `department`, `decision_maker`, `required_field`, `verification_status`, `job_titles`, `location`, `aggregations`. Set a small `limit` — billed per result. |
| `hunterio` | `/email-count` | $0 | counts by type/department/seniority (free pre-check) |
| `hunterio` | `/email-verifier` | PER_RESULT $0.01225 | SMTP-level deliverability |
| `contactout` | `/v1/email/verify` | PER_RESULT $0.01 | deliverability verdict |
| `api.kadec0.xyz` | `/v1/email-validate` | PER_CALL $0.03 | syntax + MX + disposable checks |
Source: live `GET /public/v1/endpoints?provider=hunterio|contactout|api.kadec0.xyz`; repo `connectors/hunterio/endpoints/email-finder/{endpoint.ts,schema/inputs.ts}`, `connectors/hunterio/endpoints/domain-search/{endpoint.ts,schema/inputs.ts}`.

#### E. Property listings & valuations
All `GET`, PER_CALL, tags `verified,no-markup`; input/output schemas NOT in the open-source repo (wrappers documented at parse.bot, whose docs pages return 404) -> inspect with a key.
| provider | endpoint | price |
|---|---|---|
| `zillow` | `/get_zestimate` (Zestimate valuation) | $0.03 |
| `zillow` | `/get_property_details` | $0.01 |
| `zillow` | `/search_homes_for_sale` | $0.05 |
| `zillow` | `/search_recently_sold` | $0.05 |
| `zillow` | `/search_homes_for_rent`, `/get_rental_details`, `/get_open_houses` | $0.03 each |
| `zillow` | `/search_agents`, `/get_agent_profile` | $0.01 each |
| `homes.com` | `/search_properties_for_sale` $0.01, `/search_properties_for_rent` $0.02, `/get_property_details` $0.03, `/search_agents` $0.02 | |
| `loopnet` (commercial) | `/search_listings` $0.05, `/get_listing_detail` $0.05, `/search_brokers` $0.01, `/get_broker_profile` $0.03 | |
| `serpapi` | `/zillow/search` | $0.015 |
| `anyapi` | `/property_records.enformion` (US public property records for one address) | $0.1536 |
| `anyapi` | `/zillow.search`, `/zillow.property`, `/realtor.search` | PER_UNIT_MATRIX from $0.0008 (variant-priced by upstream route) |
Source: live `GET /public/v1/endpoints?category=real-estate` (25 items); `GET /public/v1/providers/zillow/endpoints/get_zestimate` (method GET, docUrl https://parse.bot/marketplace/zillow-com-api).

#### F. Weather forecast & history (cloud cover)
| provider | endpoint | price | notes |
|---|---|---|---|
| `weather-underground` | `/get_forecast` | $0.02 | multi-day forecast; matched by keyword search "precipitation" and "latitude" (so it takes coordinates) |
| `weather-underground` | `/get_pws_hourly_history` | $0.01 | station hourly history |
| `weather-underground` | `/get_historical_airport`, `/get_historical_airport_temperature_series`, `/get_historical_airport_daily_maxima`, `/get_monthly_observations` | $0.01 each | airport history |
| `weather-underground` | `/get_current_weather`, `/search`, `/search_nearby_stations`, `/get_airport_temperature_updates_batch` | $0.01 each | |
| `accuweather` | `/get_weather` (current + forecast) $0.05; `/search_locations`, `/list_cities` $0.01 | | |
| `api.kadec0.xyz` | `/v1/weather` | $0.01 | "current conditions plus a 16-day daily weather forecast ... Daily forecast resolution. Keyless, via Open-Meteo." **Upstream schema verified** (x402 header): queryParams `lat` (-90..90), **`lng`** (note: geocode uses `lon`), `forecast_days` ("1"-"16", default "7"), strings. Output example: `{ "count": 1, "items": [{ "type": "weather", "current": { "temperature": 23.2, "condition": "Overcast" }, "airQuality": { "usAqi": 34 }, "forecast": [{ "date": "2026-06-21", "tempMax": 26, "condition": "Clear sky" }] }] }` — a text `condition`, no numeric cloud cover in the example. |
| `iqair` | `/get_city_air_quality`, `/get_map_data`, ... | $0.01 | air quality |
**No endpoint advertises cloud cover.** Keyword search `q=cloud cover` -> `total: 0`. Whether WU/AccuWeather outputs include a cloud-cover field is unverified (no output schemas public). For scene selection we do not need Monid weather at all: Sentinel-2 STAC items carry `eo:cloud_cover` and the SCL band, and Open-Meteo (which kadec0 wraps) is free and keyless directly.
Source: live `GET /public/v1/endpoints?category=weather` (17 items); live `GET https://api.kadec0.xyz/v1/weather` and `/v1/geocode` -> HTTP 402, base64 `payment-required` header decoded (`accepts[0].amount` "10000"/"20000" atomic USDC = $0.01/$0.02, `extensions.bazaar.schema`); keyword searches `q=cloud%20cover`, `q=precipitation`, `q=latitude`; `GET /public/v1/providers/api.kadec0.xyz/endpoints/v1/weather` (summary).

#### G. Maps & places / geocoding
| provider | endpoint | price | notes |
|---|---|---|---|
| `api.kadec0.xyz` | `/v1/geocode` | $0.02, GET | "Geocoding and reverse geocoding." Tags `no-markup` (NOT `verified`). **Upstream schema verified** from the provider's own x402 `payment-required` header (live GET, no payment): queryParams `q` (address, forward) OR `lat`+`lon` (reverse), `maxItems` (string, default "5"); all values are strings. Output example: `{ "count": 1, "items": [{ "type": "geocode", "displayName": "Googleplex, Mountain View, CA, USA", "lat": 37.422, "lon": -122.0841, "address": { "city": "Mountain View", "country": "United States" } }] }`. Via Monid: `input: { queryParams: { q: "..." } }` (confirm with inspect). |
| `api.strale.io` | `/x402/v2/address-geocode` | $0.0216, GET | address -> lat/lon + structured address + bounding box "via OpenStreetMap Nominatim" (not `verified`) |
| `litescrape` | `/google/maps` | $0.00015 | Google Maps places in a viewport (`@lat,lon,zoom`) or one place by id; returns `local_results` (title, rating, address, hours, phone, place_id ...) |
| `serpapi` | `/google/maps` | $0.015 | returns `gps_coordinates`, place_id, address, phone, website; `type=search` with `q` + `ll`, or `type=place` |
| `serpapi` | `/google/maps-directions` | $0.015 | directions, distances, durations |
| `serpapi` | `/locations` | $0 | place name -> search-engine location string (NOT a geocoder) |
| `dataforseo` | `/business/listings` | PER_RESULT $0.00036 + flat $0.012 | Google Maps business DB by category/area |
| `anyapi` | `/maps.search`, `/maps.place`, `/maps.search_nearby` | from $0.0013-0.00175 | |
Trap: the catalog category `geo` means **generative-engine optimisation** ("GEO": visibility in AI answers; repo `connectors/categories.ts` L327-331), not geospatial. Use category `maps` ("Maps & Local").
Free alternative: Nominatim/Open-Meteo geocoding directly (no key) — Monid adds a markup-free wrapper only.
Source: live `GET /public/v1/endpoints?category=maps` (55 items), `?category=geo` (35 items, all AI/SEO), keyword searches `q=geocode` (3 results), `q=reverse%20geocode` (0); cards via `GET /public/v1/providers/{p}/endpoints/{e}`.

#### H. Satellite / imagery tools: NONE (confirmed)
Live keyword searches on the public catalog returned `total: 0` for each of: `satellite`, `satellite imagery`, `aerial`, `earth observation`, `sentinel`, `landsat`, `ndvi`, `street view`, `elevation`, `wildfire`, `flood`, `cloud cover`. No category for imagery/EO exists in `GET /public/v1/categories`. This confirms the spec's claim and the pitch angle ("Terragent is the Earth intelligence tool every Monid agent is missing").
Source: live `GET /public/v1/endpoints?limit=8&q=<term>` (2026-11-07), `GET /public/v1/categories`.

## 4. Discrepancies with the master prompt
| # | Spec says | Reality (verified) | Impact on build |
|---|---|---|---|
| 1 | 4.3: "give an agent `set up https://monid.ai/SKILL.md`, or use the MCP server or CLI" | SKILL.md is a CLI skill (`npm i -g @monid-ai/cli`, `monid keys add -k <key>`); a human must create the account and the API key at app.monid.ai. The MCP server authenticates only through an interactive OAuth 2.1 login (Clerk). No step can be done fully headless without a human-made key. | Founder creates the account and key (one intervention). Agents use REST, or the CLI in the sandbox. MCP needs one human OAuth login, and only works if Naïve's MCP connector supports OAuth. |
| 2 | 7: "Keep the ... Monid keys in the Naïve vault, and connect AgentMail and Monid as MCP servers where possible" | MCP does not take the API key (docs: "no API key to paste"). The vault-injected key only works against `api.monid.ai` REST. | Default to REST tools with vault header injection (same pattern as Monid's documented "Claude Tag" setup). Treat MCP as optional. |
| 3 | 4.3: agents "call `discover` ... then `run` them" | Three verbs: discover -> **inspect** -> run. Inspect is the only source of the input schema, and both are free. There is no output schema anywhere, so output shape is only known from a real run. | Always inspect before the first run of an endpoint, and cache it. Record one real output per endpoint we use, then write the parser. |
| 4 | 4.3: "paying per call from one balance" | Price types: `PER_CALL`, `PER_RESULT` (+ optional `flatFee`), `PER_UNIT` (credit/result/token...), `METERED`, plus `tiers` (add-ons when input matches, e.g. Apollo "Mobile phone" $0.208) and `variants`. Estimated cost is **held** during the run, then settled. Apify-style limits apply per query, not per call. | Estimate cost from the price card before running. Keep `limit`/`page_size` small. Never set phone/personal-email reveal flags. |
| 5 | 1.1: "Cap contact-enrichment calls" | No per-call max-price field (`RunRequest.additionalProperties: false`). Budget controls (`HOUR/DAY/WEEK/MONTH`) and per-run caps exist, but the OpenAPI has only list/get/patch routes (no create). A key minted from a dashboard session without explicit scopes gets every resource except `controls`. | Build our own guard: an allowlist of `provider+endpoint`, a max price per call, and a daily Monid spend ledger in Neon. A founder sets the workspace budget/run cap in the dashboard (if available), and handles BLOCKED runs. |
| 6 | 4.3: "Monid is open source and accepts new tool providers" | Only the **connector layer** is open source (https://github.com/monid-ai/monid, MIT, Deno). The hosted gateway, billing and discover ranking are not. Listing = connector PR + email to support@monid.ai, reviewed by hand. There is also a "List your tool" Google Form (https://forms.gle/NLPchCCwnTP6zQhV8). | The stretch goal is a draft connector PR (provider.ts + endpoint.ts + fixture). Do not expect it to go live this weekend. Our 2-minute report job should be exposed as submit + poll endpoints, or answered from the Earth index. |
| 7 | 4.3: "weather (forecasts and history)" for Brain 1 cloud cover | No endpoint advertises cloud cover (`q=cloud cover` -> 0). The Monid site's llms.txt lists OpenWeather, but the live catalog has **no OpenWeather provider** (`provider=openweather` -> total 0). Weather providers: `weather-underground` (10), `accuweather` (3), `iqair` (4), `api.kadec0.xyz /v1/weather` (Open-Meteo wrapper; its example returns a text `condition`). | Take scene cloud cover from STAC `eo:cloud_cover` and the SCL band (free). Use Monid weather only for narrative context or forecasting a clear day. |
| 8 | 4.3: "maps and places" for geocoding | Geocoding exists only through two x402 wrapper providers that are **not** tagged `verified`: `api.kadec0.xyz /v1/geocode` ($0.02) and `api.strale.io /x402/v2/address-geocode` ($0.0216, Nominatim). Google/Apple/Bing place search exists (litescrape $0.00015, serpapi $0.015). Category `geo` = generative-engine optimisation. | Use kadec0 geocode via Monid for the Monid-track story, with free Nominatim as the fallback. |
| 9 | 4.3: "B2B people search with verified emails" | Apollo people search is $0 but returns **no emails** (previews with an obfuscated last name). Emails cost per enrichment: Apollo `/people/match` $0.026, Hunter `/email-finder` $0.0245 ($0 on no-find), ContactOut `/v1/people/search/work-email` +$0.10 per work email found. | Two-step pipeline: free search, then paid enrichment for only the top 1-2 contacts per prospect. |
| 10 | 4.3: "The catalog has no satellite or imagery tools" | Confirmed (0 hits for satellite, imagery, aerial, earth observation, sentinel, landsat, ndvi, elevation, flood, wildfire). | The pitch angle holds. |
| 11 | 4.2: one email system (AgentMail) | Monid itself resells AgentMail (`agentmail` provider, 35 endpoints, `agentic-email` category). | Don't create inboxes through Monid. Use AgentMail directly as the spec says. |
| 12 | (docs internal) | The quickstart shows `POST /v1/discover {"query": ...}`, which OpenAPI marks **deprecated**. The current route is `POST /v1/discover/endpoints {"q": ...}` with response `items` (not `results`). The x402 doc example uses `"endpoint": "person/enrich"`, but the catalog id is `/v5/person/enrich`. | Use `/v1/discover/endpoints` and `q`. Always pass `endpoint` exactly as the catalog/discover returns it (leading slash). |
Sources: per-row citations in section 3; https://monid.ai/llms.txt ("Demographics and weather: ... (CensusData, OpenWeather)", "List your tool"); live `GET /public/v1/providers` (97 providers, none named openweather); `GET /public/v1/endpoints?provider=openweather` -> `{"total":0}`; openapi.json `AuthCredential.defaultScopes` description ("a session gets every resource except `controls`").

## 5. Answers to open questions (spec section 14)
| Question | Answer | Source | Confidence |
|---|---|---|---|
| "What does each sponsor count as 'best use'? Do they give credits?" (Monid part) | Credits: every Monid account "starts with free credit, no card required" (amount not stated). The signup credit is promo code `MONID-SIGNUP` (one per workspace, redeemable with an API key via `POST /v1/wallet/promo-codes/redeem` or `monid wallet promo-codes redeem -c MONID-SIGNUP`). Any other code (e.g. the hackathon's $20) must be redeemed **in the dashboard** by a human. Best-use criteria are not published anywhere in Monid's docs or site: ask the Monid sponsor. | https://monid.ai/llms.txt "Pricing"; SKILL.md `monid wallet promo-codes redeem` row; llms.txt summary of "Redeem a promo code" | credits: high; criteria: unknown |
| (4.3) Can a Naïve agent use Monid via MCP with a vault key? | Docs and probes point to no: MCP is OAuth 2.1 (DCR + PKCE) through `clerk.app.monid.ai`. A static API key is not documented for MCP. The REST API takes the key as Bearer. | live probes in 3.9; cursor-plugin README | medium (API-key-on-MCP not tested with a real key) |
| (4.3) Is the catalog free of satellite/imagery tools? | Yes. | 3.11 H | high |
| (4.3) Is Monid open source / does it accept providers? | Connector layer only (MIT). Providers join through PR + email, or the "List your tool" form, with manual review. | 3.10 | high |
| (1.1) Can we cap Monid spend per agent? | Not per agent or per call on Monid's side. Monid has workspace-level budgets (per HOUR/DAY/WEEK/MONTH) and a per-run cap, which the API can view and patch but not create. Separate API keys per agent with narrow scopes are possible (`POST /v1/api-keys {label, scopes, expiresAt}`), but budgets are per workspace, not per key. | openapi.json `/v1/controls/workspace/*`, `CreateApiKeyRequest` | high (API surface), unknown (dashboard UI) |

## 6. Credentials needed
| env var | service | where to get it | cost | needed for |
|---|---|---|---|---|
| `MONID_API_KEY` (format `monid_live_<secret>`; our convention, same name Monid's own examples use) | Monid REST API + CLI | Human signs up at https://app.monid.ai, then creates a key at https://app.monid.ai/access/api-keys (shown once). Store it in the Naïve vault and `.env`. (critic) A Naïve vault can't usefully hold it: the vault injects only into MCP URLs, and Monid's MCP is OAuth-only. Put it in `.env` + Vercel env for the Terragent MCP gateway instead. | Key is free; runs draw from the wallet (hackathon $20 promo + free signup credit) | All `/v1/*` calls: discover, inspect, run, runs, balance. CLI: `monid keys add -k "$MONID_API_KEY" -l main`. |
| (no env var) Monid account OAuth login | Monid MCP server | Human completes the browser OAuth flow when the MCP client connects | free | Only if we connect `https://mcp.monid.ai/v1` as an MCP server |
| (none) vendor keys (Akta, Apollo, Hunter, ...) | upstream providers | not needed: Monid injects vendor credentials | n/a | n/a |
| `TERRAGENT_CREDENTIALS_API_KEY` (pattern `<PROVIDER>_CREDENTIALS_<FIELD>`) | local Monid connector tests | our own Terragent API key | free | Only for the stretch goal: live-testing a Terragent connector locally with `deno task engine:run` |
Recommended key scopes for agents (if the dashboard allows choosing): `runs:create`, `runs:get`, `runs:list`, `wallet:read`. Discover/inspect need no extra scope. Leave out `topups:create`, `controls:*`, `api_keys:*` and `resources:*`, so a confused agent cannot mint keys, change caps or rent resources. Scope enum: `* | runs:* | resources:* | wallet:* | topups:* | controls:* | api_keys:* | runs:create | runs:get | runs:list | runs:update | resources:read | resources:create | resources:update | resources:delete | wallet:read | wallet:update | topups:create | controls:read | controls:create | controls:update | controls:delete | api_keys:read | api_keys:create | api_keys:update | api_keys:revoke`.
Source: openapi.json `CreateApiKeyRequest.scopes`, per-route `security` scopes; https://monid.ai/docs/guide/quickstart-api.md; https://github.com/monid-ai/activegraph-monid `.env.example` (`MONID_API_KEY=monid_live_xxx...`); repo README ("Each credential field has its own variable, `<PROVIDER>_CREDENTIALS_<FIELD>`").

## 7. Gotchas & limits
- **Free vs billed:** discover and inspect are free; run is billed. Not billed: provider errors (COMPLETED with non-2xx `providerResponse.httpStatus`), FAILED, TIMED_OUT (408) and STOPPED runs. Billed: a 2xx that returns useless data. For those, file a dispute (`monid dispute`, CLI uses `POST /v1/dispute`, which is not in the OpenAPI).
- **Held funds:** the estimated cost is reserved (`held`) while a run is in flight, so `balance` can dip below what you expect during parallel runs. Akta news holds against the `limit` you pass.
- **Out of money:** `POST /v1/run` returns **402** `WALLET_INSUFFICIENT_FUNDS`, or a run ends **BLOCKED** with a `controls[]` entry of `controlType` `WORKSPACE_WALLET_BALANCE` / `WORKSPACE_BUDGET` / `WORKSPACE_RUN_CAP` (both are documented). BLOCKED is terminal, so don't poll it. Top-up needs a human: `POST /v1/wallet/topup/sessions {amount, currency:"USD"}` returns a Stripe `url`. Minimum top-up is currently $5. `GET /v1/wallet/topup` returns `processingFee` (schema example: 5%), min/max and the auto-reload settings.
- **Rate limits:** HTTP 429 with `errorCode: "RATE_LIMITED"`, `Retry-After`, `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`. The numeric limits are not published. A 429 on discover/inspect/run means nothing ran. A 429 while polling means the run exists, so check `GET /v1/runs` before retrying to avoid paying twice. Promotion endpoints (`/promo/...`) carry `promotion.limits {perMinute, perHour, perDay}`.
- **Network retry:** if `POST /v1/run` drops, the run may exist. List runs before re-running. There is no idempotency key on `RunRequest`.
- **Timeouts:** runs typically take 1-120 s. Per-connector budgets exist, e.g. Akta `timeouts: { requestMs: 60_000, runMs: 60_000 }`, TinyFish `runMs: 20_000`. SKILL.md: `--wait` blocks 1-120 s (`-w 30` sets a cap). Inside a Naïve tool, fire and poll every 5-10 s.
- **Status casing:** compare `"COMPLETED"`, never `"completed"`. `COMPLETED` does not mean success: check `providerResponse.httpStatus`.
- **Output files:** file outputs are objects `{ download_link, content_type, link_expires_at, file_expires_at? }`, and the signed links expire. Re-fetch the run for a fresh link.
- **Results volume:** limits like `maxItems` are often per query. 3 search terms x `maxItems: 10` can return 30 billed results. Pass one term per call.
- **Field-name traps:** legacy discover `query`/`results` vs new `q`/`items`. kadec0 geocode uses `lon`, kadec0 weather uses `lng`. kadec0 params are strings. Akta `company` must be a website or uuid, not a name. Apollo array params use bracket keys (`person_titles[]`). ContactOut `page_size` max 25.
- **Health:** `metrics.status` is one of `healthy|stable|degraded|outage|unknown`. Outage endpoints are hidden unless `includeUnavailable: true`. `unknown` is common and not a warning.
- **x402 alternative** (`POST https://x402.monid.ai/v1/run`, USDC on Base `eip155:8453` / Monad `eip155:143`) exists, with a minimum price of $0.01 and no metered endpoints. Not relevant for us (crypto wallet). Discover/inspect still need an API key.
- **Public registry caching:** `/public/v1/*` responses carry `cache-control: public, max-age=300`, so counts may lag up to 5 minutes.
- **Payload size limits:** none documented. Discover `q` max 1000 chars. Feedback/dispute text 1-4000 chars. Dispute takes up to 100 run ids.
Source: SKILL.md ("Run Statuses", "Troubleshooting", "Cost & Budget Warning", "Disputes"); openapi.json `/v1/run` responses, `Error.errorCode`, `RunCompleted.output` description, `WalletTopupConfigResponse`, `DiscoverEndpointsRequest.q`; https://monid.ai/llms.txt "Held funds"; https://monid.ai/docs/guide/pay-with-x402.md; `stats.h` response headers; repo `connectors/akta/provider.ts`; CLI `src/api/client.ts` L292-301.

## 8. Unverified
Nothing under `/v1/*` was called with a real key. Each item below says how to confirm it once `MONID_API_KEY` exists.
1. **Input schemas and output fields for non-open-source providers**: `zillow`, `homes.com`, `loopnet`, `weather-underground`, `accuweather`, `iqair`, `serpapi`, `anyapi`, `api.strale.io`, `context.dev /news/search` (contextdev is in the repo but was not read), `apollo /news_articles/search`. Confirm: `POST /v1/inspect {provider, endpoint}` and save `input`. Then run one cheap call and save `output`.
2. **Whether any weather endpoint returns numeric cloud cover** (WU `/get_forecast`, `/get_pws_hourly_history`, AccuWeather `/get_weather`). Confirm: one $0.01-0.05 run each, then grep the output for `cloud`.
3. **Whether Monid passes kadec0 params through unchanged** (`input.queryParams.q` / `lat`,`lng`). Upstream schema is verified, the Monid binding is not. Confirm: inspect `api.kadec0.xyz /v1/geocode`.
4. **Whether `https://mcp.monid.ai/v1` accepts `Authorization: Bearer monid_live_...`** instead of OAuth. Confirm: `curl -X POST https://mcp.monid.ai/v1 -H "Authorization: Bearer $MONID_API_KEY" -H 'Accept: application/json, text/event-stream' -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}'`. A 200 means it works.
5. **Whether Naïve's MCP connector can do an OAuth 2.1 DCR + PKCE login** (Naïve-side question for the Naïve reference doc).
6. **How budgets and run caps get created** (no POST route; `controls:create` exists in the scope enum). Also whether a new workspace has any default controls. Confirm: `GET /v1/controls/workspace/budgets` and `/run-caps` with a key that has `controls:read`, and check the dashboard UI.
7. **Rate-limit numbers** (requests/min per workspace). Confirm: read the `RateLimit-*` headers on any authed response.
8. **Amount of the free signup credit, and how the hackathon's $20 is delivered** (promo code vs direct credit). Confirm: `GET /v1/wallet/balance`, `GET /v1/wallet/promo-codes` after signup, or ask the Monid sponsor.
9. **Sync vs async per endpoint** (which ones return 202). The API decides, and there is no flag in the catalog cards. Confirm: the first run of each endpoint.
10. **Whether runs accept an `endpoint` without the leading slash** (x402 doc example `person/enrich`). Confirm: inspect both forms.
11. **The exact `discover` results for our queries** (the authed semantic search may rank differently from the public keyword `q`). Confirm: `POST /v1/discover/endpoints {"q":"company news business events","limit":10}` etc.
12. **Default scopes on a dashboard-created key**, and whether the dashboard lets you choose scopes. Confirm: `GET /v1/auth/whoami` returns `credential.scopes`.
13. **Provider-listing commercial terms** (revenue share, payout, review time, whether a Monid-listed Terragent endpoint needs its own pricing model in `usage`). Not found in public docs. Ask support@monid.ai or Discord.
14. **Per-endpoint output reshaping:** the Akta output fields come from a recorded vendor fixture. Monid's `output.fromResponse` only strips `credits_consumed` for Akta, but other providers may reshape output. Confirm: one real run.

# Terragent architecture (build contract)

Spec: [terragent-master-prompt.md](../terragent-master-prompt.md). Verified platform facts: [docs/platform/](platform/).
Decisions log: [NOTES.md](../NOTES.md). This file is how the pieces fit; if you change a seam, update it here.

## 1. Shape of the system

```
                    ┌──────────────── Naïve (api.vetta.sh) ─────────────────┐
 customer ─ email ─▶│  AgentMail ──webhook──▶                                │
 portal / API  ────▶│        Next.js on Vercel (this repo)                   │
                    │   • /api/mcp  Terragent MCP gateway  ◀── agents call ──┤  12 agents, one team
                    │   • webhooks  (AgentMail, Naïve)                       │  coordinator + board
                    │   • portal, /answer API, dashboard, report pages       │  cron deployments
                    │          │                                             │  Analytics computer
                    │          ▼                                             │  (Python pipeline)
                    │   Neon Postgres  (requests, events, decisions, index…) │
                    └────────────────────────────────────────────────────────┘
```

- **Agents never hold third-party keys.** Naïve's vault can only inject a bearer into an MCP connection
  (`env_var` injection returns 501), AgentMail's MCP wants `x-api-key` (forbidden inline) and Monid's MCP is
  OAuth-only. So our **Terragent MCP server is the single gateway**: it holds `DATABASE_URL`,
  `AGENTMAIL_API_KEY`, `MONID_API_KEY` in Vercel env and exposes narrow tools ([catalog](../src/lib/mcp/catalog.ts)).
- **One bearer token per agent.** Provisioning mints a token per agent, stores its sha256 in `mcp_tokens`, and
  vaults the raw token as a `static_bearer` credential **bound to that agent** (`agent_id`) for the exact MCP URL.
  The server maps token → agent and refuses tools the catalog doesn't grant that agent.
- **Agents need a public URL.** Naïve refuses localhost/private MCP and webhook URLs, so end-to-end agent runs
  start after the first deploy (founder approval required). Everything else is testable locally.

## 2. Two lanes

| Lane | Used for | Mechanism | Why |
|---|---|---|---|
| **inbound** (`priority='inbound'`) | portal, email, API, live demo | `handoff` starts the next agent's session directly (`sessions.create`) and **mirrors** a board card with status `doing` and **no assignee**, owner named in the title (visible, wakes nobody; an assigned `doing` card would make the agent busy) | Board runs one card per assignee at a time; a judge's request must not queue behind overnight samples. Target: ~2 min end to end. |
| **background** (`priority='background'`) | signal-engine free samples, monitors, follow-ups | `handoff` creates one `todo` card **with assignee** per handoff, keyed `req:<id>:<n>:<to>` (the previous card is closed `done`) on the coordinator's board → Naïve wakes the agent | Naïve-native team + board; serialisation is fine overnight. |

Both lanes write the same `requests.status/owner_agent/stage`, `events`, and board card, so the dashboard
and the Naïve board show the same truth.

## 3. Inbound flow (spec §3.2)

| # | Agent | Reads | Writes (MCP tools) | Next |
|---|---|---|---|---|
| 0 | — (portal / webhook / API) | | `startInboundRequest()` → request `received` | comms-customer |
| 1 | **comms-customer** (Comms 2) | `get_request`, `get_thread` | `record_screening` (refusals logged as `screening` decisions); `send_customer_message` if unclear | planner (or stop) |
| 2 | **planner** (Brain 1) | `geocode`, `earth_index_lookup`, `search_free_scenes` | `save_data_spec` | acquisition |
| 3 | **acquisition** (Orchestrator) | `search_free_scenes`, `list_providers`, SkyWatch MCP pricing | `log_decision` (source_selection, free_vs_paid), `save_acquisition_plan` with the comparison the quote's options need (free source, best paid archive, tasking where relevant); `request_supplier_quote` only when the one paid source that answers has no public price | pricing |
| 4 | **pricing** | `price_options` (server prices 1–3 options bottom-up, [pricing-engine.ts](../src/lib/pipeline/pricing-engine.ts)), `list_providers` | `create_quote` (server re-prices each option and refuses edited data items or prices; 7-day validity, accept token; status `quoted`) | comms-customer (handed by `create_quote`; no founder review) |
| 4b | **comms-customer** | `get_request`, `get_thread` | `send_quote` (options email + accept link); on the customer's reply `accept_quote` (option named, or the recommended one on a plain yes). The accept link (`/quote/<token>`, `POST /api/quotes/accept`) and API clients (`GET /api/answer/{id}` → `quote.accept`) use the same service ([acceptance.ts](../src/lib/pipeline/acceptance.ts)) | free-data option → analytics (or interpreter for an Earth-index answer); paid option → held order per paid item + coordinator card; a founder buys by hand and marks it delivered (dashboard) → analytics |
| 5 | **analytics** | `get_analysis_job` | runs pipeline in its computer; `publish_file`; `save_analysis` (→ Earth index) | interpreter |
| 6 | **interpreter** (Brain 2) | `get_analysis`, `earth_index_lookup`, `view_image` | `save_report_draft`, `check_report_rules` | verifier |
| 7 | **verifier** | `get_report`, `get_analysis`, `check_report_rules`, `view_image` | `save_verdict` (fail → interpreter, max 2 revisions) | comms-customer |
| 8 | **comms-customer** | `get_report` | `deliver_report` (same thread, images + link); `create_monitor` only once the customer accepted the monthly price (their words as evidence) | done |

Pricing v2 (NOTES 2026-11-08): steps 1–4 are the free investigation and their output is the quote. Steps 5–8 run only
once the customer accepted an option: `handoff` to analytics, interpreter or verifier (or to a work stage),
`get_analysis_job`, `save_report_draft`, `save_verdict`, `deliver_report` and `create_monitor` all call
`assertPriceCleared` ([gates.ts](../src/lib/pipeline/gates.ts)), and paid orders can be prepared, approved or marked
delivered only for a provider in the accepted option (`paidDataBlockedReason`, [orders.ts](../src/lib/pipeline/orders.ts)).

Free samples (signal engine) enter at step 2 with `is_free_sample=true`, skip screening/quote, and step 8
becomes **comms-outreach**. They are the one exception to "nothing runs before acceptance" (our marketing cost), along
with the system's own monitor on a verified free sample.

## 4. Outbound flow (spec §3.3) and outreach channels

1. **sourcing** on cron (`loose` window): `poll_signals` per playbook → match affected businesses (Naïve data
   tools + `monid_run`, allowlisted, capped) → `create_prospect` (fit × urgency × ability × reach) →
   `request_free_sample` for the top N weighted by `get_allocation`.
2. Pipeline steps 2–7 on the background lane.
3. **comms-outreach**: `get_outreach_context` picks the channel (NOTES "Outbound channel"):
   - `contact_form` (cold, default): the business's own website contact form via the Naïve `browser` tool
     (`solve_captchas: false`, `stealth: false`), reply-to hello@ → `record_contact_form_touch`.
   - `email_warm`: `send_outreach_email` to people who wrote to us / attendees.
   - `email_direct`: only when `OUTREACH_DIRECT_EMAIL_APPROVED=true`.
   Every touch: their asset's image + one finding, next step + price, sender identity, **AI disclosure**,
   opt-out link. Sends are blocked until a founder approves the template and arms the inbox.
4. Replies arrive at hello@ (AgentMail webhook) → matched to the prospect → comms-customer quotes and sells.
5. **coordinator** on cron: `get_metrics` → `set_playbook_allocation` (logged as a decision with metrics).
6. **analytics** on cron: `list_due_monitors` → re-check → `record_monitor_check` → follow-up with new info.

## 5. Safety rules enforced in code (not only prompts)

| Rule (spec) | Where |
|---|---|
| First outbound email needs a founder | `settings.email.inbox_armed[inbox]` false → `sendEmail` blocks (except `TEAM_EMAILS`) |
| Outreach template approved first | `templates.status='approved'` required for `kind='outreach'` |
| Never buy data without a founder | `place_paid_order` is Naïve `ask`; even when allowed it only records approval — a founder buys by hand |
| No free answers; nothing runs before the customer accepts an option (pricing v2) | `assertPriceCleared` (quote `status='accepted'`) in `handoff` to work agents/stages, the analysis job, report, verdict, delivery and `create_monitor`; no price clears itself (`PRICING.autoApproveCapUsd` is display-only) |
| Paid data only for an accepted option | `paidDataBlockedReason` in `prepare_paid_order`, `place_paid_order`, the dashboard's order approve and mark-delivered |
| Agents can't set prices | `create_quote` re-prices every option server-side and refuses data items that don't match the server's options (provider, archive/tasking/free, dates, area ≥ 95 %, kind) or prices more than 5 % off |
| Opt-outs | `suppression` checked before every send; `/unsubscribe?t=<token>` + "stop" replies |
| Misuse | `record_screening` refusals; refused requests can't advance (`handoff` rejects) |
| No CAPTCHA solving | outreach agent browser config `solve_captchas:false`, `stealth:false` |
| Derived results only | Earth index stores metrics; paid imagery never stored or emailed |
| Spend caps | Naïve budgets per agent (`src/lib/config.ts`), per-session `budget_micro_usd`, Monid caps in our wrapper |
| Deployed key can't charge the card | app refuses a Naïve key whose `/v1/me` scopes include `admin` or `billing:write` when `VERCEL_ENV` is set |

## 6. Module ownership (parallel build)

| Module | Owner | Files |
|---|---|---|
| Imagery pipeline | imagery | `pipeline/**` (Python), `src/lib/imagery/**` |
| Signals, geocoding, Monid | signals | `src/lib/signals/**`, `src/lib/geo/geocode.ts`, `src/lib/monid/**` |
| Naïve platform + agents | naive | `naive/**`, `src/lib/naive/**`, `scripts/provision-naive.ts`, `scripts/naive-*.ts` |
| Core pipeline + MCP | core | `src/lib/pipeline/**`, `src/lib/mcp/server.ts`, `src/lib/mcp/tools/{core,planning,acquisition,suppliers,pricing,analysis,reports,customer}.ts`, `src/app/api/mcp/**`, `db/seeds/**` |
| Outbound services + MCP | outbound | `src/lib/outbound/**`, `src/lib/mcp/tools/{signals,prospects,outreach,coordinator,monitoring,market}.ts` |
| Email | email | `src/lib/email/**`, `src/lib/agentmail/**`, `src/app/api/webhooks/agentmail/**`, `src/app/unsubscribe/**`, `scripts/provision-agentmail*.ts` |
| Web | web | `src/app/**` except the routes above, `src/components/**`, `src/lib/dashboard/**`, `src/lib/api-keys/**` |

Shared, already written (change only with care, keep backwards compatible): `src/lib/domain.ts`,
`src/lib/mcp/catalog.ts`, `src/lib/db/*`, `src/lib/events.ts`, `src/lib/settings.ts`, `src/lib/config.ts`,
`src/lib/env.ts`, `src/lib/geo/h3.ts`, `src/lib/ids.ts`, `db/migrations/00{1,2}_*.sql`.
New tables/columns → a new migration file named `0NN_<module>_<what>.sql` (pick a unique number per module:
imagery 010, signals 020, naive 030, core 040, outbound 050, email 060, web 070).

**Stubs:** files under `src/lib/{imagery,geo,signals,monid,email,naive,pipeline}` contain typed stubs that
throw "not implemented yet". The owner replaces the body; **keep the exported signatures** (adding optional
fields is fine). Other modules import them freely.

## 7. MCP tool implementation contract

- `src/lib/mcp/server.ts` (core) exports `registerTool(name, { inputSchema: z.object(...) }, handler)`
  helpers; each `src/lib/mcp/tools/<group>.ts` exports `register(server)` and implements **exactly** the
  catalog names of its group. A test asserts every catalog tool is registered exactly once.
- Handlers receive `ctx = { agent: AgentName, sessionId?: string }` from the auth layer; record
  `actor = ctx.agent` on every event/decision.
- Return compact JSON text. Inputs validated with zod (reuse `src/lib/domain.ts` schemas).
- Tool errors are returned as `{ error: "<reason>" }` results the model can act on, not thrown 500s.

## 8. Naïve specifics builders must respect (from docs/platform)

- SDK `@usenaive-sdk/managed-agents@0.12.3` (ESM). Money = integer micro-USD. `budget.period` required.
- `harness: "pi"` (structured output, approvals, built-ins). Not `claude_code`.
- MCP tools default to `ask`: every catalog tool must be listed in `tools.configs` as
  `"terragent.<name>": { permission }`. `data_run` must be `allow` for sourcing or cron runs park and skip.
- `mcp_servers: [{ name, url }]` — no `type`, no secret headers.
- Each agent has ONE computer (12 h max life, then replaced blank) → Analytics bootstraps the pipeline from a
  Naïve File every run (idempotent).
- Skills are a single `SKILL.md` text; no scripts. Playbooks: disasters, deforestation, mining, inbound.
- Webhooks: `Vetta-Signature`/`Vetta-Timestamp` HMAC, 2xx within 10 s, dedupe on envelope `id`.
- Approvals surface as `session.idle` with `stop_reason: "awaiting_approval"`; list with
  `sessions.list({ stop_reason: "awaiting_approval" })`, decide with `sessions.confirmTool`.

## 9. Local development

- `npm run db:migrate` / `npm run db:status` — Neon if `DATABASE_URL` is set, else PGlite.
- Tests: `npm test` (no network, no keys). Live tests are `*.live.test.ts`, run with `npm run test:live`.
- Before deploy, agents can't reach the MCP server; scripts can still drive Naïve directly (create agents,
  run a session, run the pipeline in a computer).

## 10. Pipeline CLI contract (core ↔ imagery ↔ Analytics agent)

The Analytics agent runs, inside its Naïve computer:

```bash
# get_analysis_job returns bundle_file_id + these commands; the agent fetch_file()s the bundle to ~/bundle.tgz
mkdir -p ~/tg && tar -xzf ~/bundle.tgz -C ~/tg && bash ~/tg/pipeline/bootstrap.sh     # idempotent; prints "ready"
flock ~/tg.lock ~/tg/pipeline/.venv/bin/python -m terragent_pipeline.run --job ~/jobs/<request_id>.json --out ~/out/<request_id>
```

- `~/jobs/<request_id>.json` (one file per request, so concurrent sessions on the shared computer can't mix jobs; written by the agent from `get_analysis_job.job`; `get_analysis_job({monitor_id})` returns a monitor re-check job that keeps the baseline):
  `{ request_id, recipe, bbox: [minLon,minLat,maxLon,maxLat], before_window: {start,end}|null,
     after_window: {start,end}, before_scene: SceneRef|null, after_scene: SceneRef|null,
     max_cloud_pct, h3_res, collection: "sentinel-2-l2a" }`
  Scenes may be null → the pipeline searches itself.
- stdout: one line of JSON = `AnalysisResult` (src/lib/domain.ts), also written to `<out>/result.json`.
  Image paths in it are relative to `<out>`; the agent `publish_file`s each and passes
  `{ "<path>": "fil_…" }` to `save_analysis`.
- Exit code 0 on success (even "no clear scene" — then `warnings` explains and indices may be empty);
  non-zero only for crashes. Must finish a 2×2 km before/after job in < 60 s on 1 vCPU. A wall-clock deadline (default 75 s;
  `--deadline-s` / `TERRAGENT_PIPELINE_DEADLINE_S`, 0 = none) returns an empty result with a warning instead of hanging.
- `bootstrap.sh` finds/installs Python ≥ 3.12 (uses `uv` if the system Python is older), creates
  `pipeline/.venv`, installs `requirements.txt`, and is safe to re-run (12 h computer lifetime).
- Locally: `npm run pipeline -- --job job.json --out tmp/out` (wraps the same CLI) for tests and the simulator.

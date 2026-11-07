# Terragent — build notes

Running log of decisions, open questions, spend, and things a human must do.
Newest entries at the top of each section. Spec: [terragent-master-prompt.md](terragent-master-prompt.md).
Verified platform reference: [docs/platform/](docs/platform/README.md).

---

## Needs a human (founders)

| # | What | Who's best placed | Blocks |
|---|---|---|---|
| H1 | ~~Create Naïve API key~~ **Done 2026-11-07**: key for org "Terragent" (live) is in `.env` and verified via `GET /v1/me`. | — | — |
| H1b | **Issue a second Naïve key with more scopes.** The current key only has `agents:read/write` and `sessions:read/write`. Also needed: `computers:write` (Analytics sandbox), `files:read` + `files:write` (report files), `webhooks:*` (session.idle / budget.exceeded webhooks), `billing:read` (spend vs revenue dashboard, spend log), `audit:read` (intervention log). Leave out `billing:write` (it can charge a card) and `admin`. Then replace `VETTA_API_KEY` in `.env`. | whoever owns the Naïve org | step 3 (sandbox), step 7 (spend dashboard), webhooks |
| H2 | Create AgentMail API key → `AGENTMAIL_API_KEY` | anyone | step 2 (inboxes, email in/out) |
| H3 | ~~Create Monid key~~ **Done 2026-11-07**: `MONID_API_KEY` is in `.env`, verified with `monid whoami` (Aiden's workspace). | — | — |
| H3b | **Load the $20 Monid credits.** The wallet shows **$1.00**, not $20. Redeem the hackathon credit at https://app.monid.ai (only the signup code can be redeemed with an API key; other codes must go through the dashboard). | Aiden (workspace owner) | step 6 contact lookup at any volume |
| H3c | **Set a Monid workspace budget and per-run cap** in the dashboard (e.g. $18 budget, $0.50 per run) so agents can't drain it. Over-limit runs come back `BLOCKED` and aren't charged. | Aiden | before agents get Monid access |
| H4 | Create Neon project → pooled `DATABASE_URL` | anyone | deploy; local dev uses PGlite without it |
| H5 | NASA FIRMS free MAP_KEY → `FIRMS_MAP_KEY` | anyone (1 min, email only) | fire signals |
| H6 | Global Forest Watch free account + API key → `GFW_API_KEY` | anyone | forest-loss signals |
| H7 | Vercel account linked to GitHub | Laurence (repo owner) | step 7 deploy (first public deploy needs your OK) |
| H8 | Approve first outbound email template | any founder, in dashboard | step 6 outreach |
| H9 | Stripe Payment Link (optional) → `PAYMENT_LINK_URL` | whoever holds the Stripe account | quotes show a pay link |

_This table is refreshed after platform research; see docs/platform/README.md for the verified list._

---

## Decisions

- **2026-11-07 — Naïve models (verified live with `GET /v1/models`).** Claude runs through Naïve's router (`anthropic/claude-haiku-5.5`, `anthropic/claude-sonnet-5.5`, `anthropic/claude-opus-5.5`, plus `:batch` variants), so cost tracking stays inside Naïve and we don't need the Claude API key for agents. **Only 3 models accept the `loose` window:** `zai-org/GLM-5.2-FP8`, `google/gemma-4-31B-it`, `moonshotai/Kimi-K2.6`. The docs' example `z-ai/glm-5.3-flash` is `immediate`-only, so the overnight signal engine must use one of those three if it runs on `loose`. Plan: Brain 1, Brain 2, Verifier on a Claude Sonnet/Opus model; routine agents on `z-ai/glm-5.3-flash` (immediate); overnight cron on `zai-org/GLM-5.2-FP8` (loose). The catalogue publishes no modality or price fields, so vision support and price must be confirmed per model (see the model-router docs).
- **2026-11-07 — Naïve API conventions (verified).** Base `https://api.vetta.sh`, `Authorization: Bearer sk_live_…`, pin `Vetta-Version: 2026-09-30` (unknown body keys are *refused* since 2026-09-01). Money is integer micro-USD (`*_micro_usd`). Spend comes from `GET /v1/credits/spend` (filters: `agent_id`, `session_id`, `deployment_id`, `from`, `to`) and needs `billing:read`. Deployments (cron) and skills need only `agents:write`.
- **2026-11-07 — Monid conventions (verified live, CLI 0.1.9).** API `https://api.monid.ai`, `Authorization: Bearer monid_live_…`. The CLI reads its key from `$XDG_CONFIG_HOME/monid/credentials.yaml`, not from an env var; for scripts, set `XDG_CONFIG_HOME` to a private dir or call the REST API with `MONID_API_KEY`. `whoami`, `balance`, `discover` and `inspect` are free; only `run` charges, and failed or blocked runs aren't billed. Prices are per call (geocoding about $0.02/call, e.g. `api.kadec0.xyz /v1/geocode`). **Decision:** geocode with free US Census / Nominatim first, and spend Monid on what's distinctive (business signals, verified work emails).
- **2026-11-07 — Repo layout.** One Next.js 16 app (`src/`) for landing, portal, dashboard, public API, webhooks and the Terragent MCP server; `pipeline/` Python imagery pipeline (runs in the Naïve computer and locally); `naive/` agent definitions, playbook skills and output schemas; `db/migrations/` plain SQL; `scripts/` provisioning. Kept as one package so the other founders can find things.
- **2026-11-07 — Database.** Plain-SQL migrations run on both Neon (prod) and PGlite (local dev + tests, no Docker needed). H3 cells computed in app code and stored as `text`, so nothing depends on Postgres extensions.
- **2026-11-07 — IDs.** App-generated prefixed ids (`req_…`, `rpt_…`, `qte_…`) so agents and humans can read them in logs and email.
- **2026-11-07 — Next.js 16.4.** Its bundled `AGENTS.md` warns APIs differ from older versions; read `node_modules/next/dist/docs/` before writing Next code.

---

## Open questions (spec §14) — status

| Question | Status |
|---|---|
| Which Claude / vision models does Naïve's router offer; can our Claude key be used via Naïve? | **Answered (models):** Claude Haiku/Sonnet/Opus 4.5–5.5 and Fable 5/5.1 are in the catalogue, so no Claude key is needed for agents. Vision-named models include `qwen/qwen3-vl-*` and `z-ai/glm-5v-turbo`; the catalogue has no modality field, so confirm image input with a test call. Still open: whether *our own* Claude key can be used. The docs index describes the model proxy as "your API key, your organization's balance" (i.e. the Naïve key and balance); the `claude_code` harness page is not yet read. |
| Does inbound email wake Naïve agents? | researching (we use AgentMail webhooks regardless) |
| Does Neon support PostGIS / h3 on our plan? | researching (not required: H3 computed in app) |
| Paid imagery prices & license terms | researching |
| What each sponsor counts as "best use"; credits? | ask organizers at the event |
| Stage pitch length; how table judging works | ask organizers at the event |

---

## Spend log (estimates until spend API is wired)

| When | Service | Amount | Running total | Note |
|---|---|---|---|---|
| — | Naïve | $0 | $0 / $250 | no agents created yet |
| 2026-11-07 | Monid | $0 | $0 spent; **wallet $1.00** (expected $20, see H3b) | key check: whoami, balance, 1 discover (all free) |
| — | Neon | $0 | $0 / $250 | |

---

## Intervention log (mirror of the dashboard table)

_None yet._

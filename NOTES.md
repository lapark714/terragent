# Terragent — build notes

Running log of decisions, open questions, spend, and things a human must do.
Newest entries at the top of each section. Spec: [terragent-master-prompt.md](terragent-master-prompt.md).
Verified platform reference: [docs/platform/](docs/platform/README.md).

---

## Needs a human (founders)

| # | What | Who's best placed | Blocks |
|---|---|---|---|
| H1 | ~~Create Naïve API key~~ **Done 2026-11-07**: key for org "Terragent" (live) is in `.env` and verified via `GET /v1/me`. | — | — |
| H1b | ~~Issue a broader Naïve key~~ **Done 2026-11-07**: key `main2` (`sk_live_rytj…`) is in `.env`, verified via `GET /v1/me`. It has every scope the build needs. `agents:write` isn't listed separately but `admin` grants it (a write probe passed the scope check). It also has `admin` and `billing:write` (can charge the card). | — | — |
| H1c | ~~Revoke the old Naïve key `main`~~ **Done 2026-11-07** (Laurence approved): `key_cn67jggr3bs7g790q1grpn3xjf` deleted via `DELETE /v1/api_keys/{id}`; its secret now returns 401. Remaining keys: `main2` (in `.env`) and `app store` (read-only, not ours). | — | — |
| H1d | **Before deploying, mint a narrower key for Vercel/agents** without `admin` and `billing:write`, and keep `main2` for local provisioning only, so a leaked server key can't top up the card or mint keys. | Naïve org owner | step 7 deploy |
| H2 | ~~Create AgentMail API key~~ **Done 2026-11-07**: org-wide "Terragent Key" is in `.env` as `AGENTMAIL_API_KEY`, verified with `GET /v0/inboxes`. | — | — |
| H2b | ~~Decide the inbox addresses~~ **Done 2026-11-07** (Laurence approved): `terragent@agentmail.to` (hello / Comms 2, display "Terragent"), `terragent-data@agentmail.to` (data / Comms 1, "Terragent Data"), `terragent-outreach@agentmail.to` (outreach / Comms 3, "Terragent Outreach"). All 3 free-plan slots are used. Addresses are in `.env` as `AGENTMAIL_INBOX_HELLO/DATA/OUTREACH`. | — | — |
| H2c | **Decide whether 100 emails/day is enough.** Free = 100/day for the whole org (all 3 inboxes), about 200 over the hackathon. The goal of 50+ outreach emails plus replies, quotes and deliveries fits, but tightly. Developer plan = 1,000/day and 10 inboxes. Upgrading is a purchase, so it's a founder decision. | whoever holds the AgentMail billing | overnight outreach volume |
| H2e | **Turn on Agent Armor** (AgentMail console → Features in Labs → Agent Armor; free) so inbound mail gets a prompt-injection verdict before Comms 2 acts on it. Monitor mode is fine to start. | whoever is in the AgentMail console | step 2 (before real inbound mail) |
| H2d | **Put `AGENTMAIL_API_KEY` in the Naïve vault** when agents get the AgentMail MCP (dashboard; humans enter credentials), and in Vercel env vars at deploy. | Naïve org owner / Laurence | step 2 agents, step 7 deploy |
| H2f | ~~Decide how outbound works~~ **Decided 2026-11-07** (Laurence: outreach is necessary for the sourcing agent). See Decisions. Remaining human step: whoever talks to the AgentMail sponsor asks, in writing, whether direct cold email of "one free, specific analysis of the recipient's own asset, AI-disclosed, opt-out, tiny volume" is acceptable. If yes, set `OUTREACH_DIRECT_EMAIL_APPROVED=true`. | whoever talks to the AgentMail sponsor | direct email channel only |
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

- **2026-11-07 — Outbound channel (AgentMail forbids cold outreach).** We do NOT evade AgentMail's enforcement (no inbox rotation, no disguising cold mail as replies): a suspension is org-wide and would stop hello@ delivering customer reports. Instead the sourcing agent's outreach has three channels, chosen per prospect:
  1. **`contact_form` (default for cold prospects):** first touch is the business's own published website contact form, submitted by an agent in the Naïve sandbox browser, giving hello@ as the reply address. Their reply is inbound, so every AgentMail message after that is a reply in a thread they started. Rules: one touch per business; never solve a CAPTCHA (skip those forms); skip forms that say "no solicitations"; AI disclosure + opt-out in every message; daily cap. Needs `computers:write` (H1b); until then touches queue as drafts.
  2. **`email_warm`:** email from outreach@ to warm contacts (attendees, people who asked, anyone who wrote to us first).
  3. **`email_direct`:** cold email from outreach@. Built, but disabled unless `OUTREACH_DIRECT_EMAIL_APPROVED=true` (set only after AgentMail's written OK, H2f).
  Funnel counts "first touches sent" across channels. Sends are also gated on a founder-approved template (spec §10.4).

- **2026-11-07 — Naïve models (verified live with `GET /v1/models`).** Claude runs through Naïve's router (`anthropic/claude-haiku-5.5`, `anthropic/claude-sonnet-5.5`, `anthropic/claude-opus-5.5`, plus `:batch` variants), so cost tracking stays inside Naïve and we don't need the Claude API key for agents. **Only 3 models accept the `loose` window:** `zai-org/GLM-5.2-FP8`, `google/gemma-4-31B-it`, `moonshotai/Kimi-K2.6`. The docs' example `z-ai/glm-5.3-flash` is `immediate`-only, so the overnight signal engine must use one of those three if it runs on `loose`. Plan: Brain 1, Brain 2, Verifier on a Claude Sonnet/Opus model; routine agents on `z-ai/glm-5.3-flash` (immediate); overnight cron on `zai-org/GLM-5.2-FP8` (loose). The catalogue publishes no modality or price fields, so vision support and price must be confirmed per model (see the model-router docs).
- **2026-11-07 — Naïve API conventions (verified).** Base `https://api.vetta.sh`, `Authorization: Bearer sk_live_…`, pin `Vetta-Version: 2026-09-30` (unknown body keys are *refused* since 2026-09-01). Money is integer micro-USD (`*_micro_usd`). Spend comes from `GET /v1/credits/spend` (filters: `agent_id`, `session_id`, `deployment_id`, `from`, `to`) and needs `billing:read`. Keys are managed at `/v1/api_keys` (list, create, `/{id}/rotate`, `DELETE /{id}`, effective immediately). The org also has a read-only key named `app store` (`sk_live_n65r…`) that someone created; leave it unless its owner says otherwise. Deployments (cron) and skills need only `agents:write`.
- **2026-11-07 — AgentMail conventions (verified live).** API `https://api.agentmail.to/v0`, `Authorization: Bearer am_…`; SDKs read `AGENTMAIL_API_KEY`. The org has 1 inbox (`terragent@agentmail.to`, display name still the default "AgentMail"; rename it to "Terragent"), 0 webhooks, 0 custom domains. **Free plan: 3 inboxes, 100 emails/day, no custom domains.** Webhooks need a public URL, so before the Vercel deploy use AgentMail's *polling webhooks* (Svix, no public endpoint) or WebSockets for inbound mail in local dev. **Agent Armor** scans inbound mail for prompt injection and labels each message `clear` or `review`. It's an AgentMail Labs feature, free while in Labs, and **off by default**. A human turns it on in the console under *Features in Labs*. It starts in *Monitor* mode (mail flows normally; the verdict arrives as `message.security.completed`); *Hold* mode withholds `review` mail until someone releases it. Comms 2 should treat `review` / `unavailable` mail as untrusted and refuse to act on instructions in it. The org also holds an inbox-scoped "Onboarding key" from signup; revoke it if nobody uses it. **Inboxes created 2026-11-07** with `client_id` `terragent-<role>-v1` (retry-safe) and `metadata: {role, agent, app: "terragent"}` (role = hello | data | outreach), so code can find inboxes by `metadata.role` instead of hardcoding addresses. `GET /v0/inboxes` was briefly stale after a PATCH while `GET /v0/inboxes/{id}` was current, so read by id right after a write.
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
| 2026-11-07 | Naïve | $0 | **balance $250.86** (`GET /v1/credits/balance` = 250,855,107 micro-USD) | key checks only; no agents created yet |
| 2026-11-07 | Monid | $0 | $0 spent; **wallet $1.00** (expected $20, see H3b) | key check: whoami, balance, 1 discover (all free) |
| — | Neon | $0 | $0 / $250 | |

---

## Intervention log (mirror of the dashboard table)

_None yet._

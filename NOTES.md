# Terragent — build notes

Running log of decisions, open questions, spend, and things a human must do.
Newest entries at the top of each section. Spec: [terragent-master-prompt.md](terragent-master-prompt.md).
Verified platform reference: [docs/platform/](docs/platform/README.md).

---

## Needs a human (founders)

| # | What | Who's best placed | Blocks |
|---|---|---|---|
| H1 | Create Naïve API key → `VETTA_API_KEY` in `.env` | whoever registered the team | build step 1 (agents), everything agentic |
| H2 | Create AgentMail API key → `AGENTMAIL_API_KEY` | anyone | step 2 (inboxes, email in/out) |
| H3 | Create Monid account + key ($20 credits) → `MONID_API_KEY` | anyone | step 6 (signal engine contacts) |
| H4 | Create Neon project → pooled `DATABASE_URL` | anyone | deploy; local dev uses PGlite without it |
| H5 | NASA FIRMS free MAP_KEY → `FIRMS_MAP_KEY` | anyone (1 min, email only) | fire signals |
| H6 | Global Forest Watch free account + API key → `GFW_API_KEY` | anyone | forest-loss signals |
| H7 | Vercel account linked to GitHub | Laurence (repo owner) | step 7 deploy (first public deploy needs your OK) |
| H8 | Approve first outbound email template | any founder, in dashboard | step 6 outreach |
| H9 | Stripe Payment Link (optional) → `PAYMENT_LINK_URL` | whoever holds the Stripe account | quotes show a pay link |

_This table is refreshed after platform research; see docs/platform/README.md for the verified list._

---

## Decisions

- **2026-11-07 — Repo layout.** One Next.js 16 app (`src/`) for landing, portal, dashboard, public API, webhooks and the Terragent MCP server; `pipeline/` Python imagery pipeline (runs in the Naïve computer and locally); `naive/` agent definitions, playbook skills and output schemas; `db/migrations/` plain SQL; `scripts/` provisioning. Kept as one package so the other founders can find things.
- **2026-11-07 — Database.** Plain-SQL migrations run on both Neon (prod) and PGlite (local dev + tests, no Docker needed). H3 cells computed in app code and stored as `text`, so nothing depends on Postgres extensions.
- **2026-11-07 — IDs.** App-generated prefixed ids (`req_…`, `rpt_…`, `qte_…`) so agents and humans can read them in logs and email.
- **2026-11-07 — Next.js 16.4.** Its bundled `AGENTS.md` warns APIs differ from older versions; read `node_modules/next/dist/docs/` before writing Next code.

---

## Open questions (spec §14) — status

| Question | Status |
|---|---|
| Which Claude / vision models does Naïve's router offer; can our Claude key be used via Naïve? | researching |
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
| — | Monid | $0 | $0 / $20 | |
| — | Neon | $0 | $0 / $250 | |

---

## Intervention log (mirror of the dashboard table)

_None yet._

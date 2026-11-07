@AGENTS.md

# Terragent — rules for coding agents

Terragent is an agent-run Earth intelligence company built for the Naïve Autonomous Company Hackathon.
The spec is [terragent-master-prompt.md](terragent-master-prompt.md). Running decisions live in [NOTES.md](NOTES.md).

## Hard rules (from spec §0 — never break these)

- **Verify, don't assume.** Code against [docs/platform/](docs/platform/README.md) (verified SDK types, docs, live calls). If something isn't covered there, check the installed package's `.d.ts` before using it. Where the spec and the platform disagree, the platform wins — note the difference in NOTES.md.
- **Humans create accounts and credentials.** Never sign up for services or enter passwords or payment details.
- **Ask a founder before:** the first real outbound email to anyone outside the team, the first public deploy, and **every** purchase of data. Code paths that send email or spend money must be gated (approved template, approval state in the DB), not just prompted.
- **Never put secrets in code or git.** Read them from env (`.env` is gitignored; `.env.example` lists names only) or the Naïve vault.
- **Out of scope (spec §12):** satellite operations, supplier marketplace, user logins / multi-tenant accounts, any investment / token / securities feature (not even mockups), AI phone calls, native mobile apps, a general GIS platform.

## Conventions

- **Contract:** `src/lib/domain.ts` holds the zod schemas for every hand-off (DataSpec, AcquisitionPlan, Quote, AnalysisResult, ReportDraft, Verdict, signals, prospects). Import from it; don't redefine shapes. `outputSchema(schema)` turns one into a Naïve `output_schema`.
- **Database:** `getDb()` from `src/lib/db/client.ts` — Neon when `DATABASE_URL` is set, PGlite otherwise. Always parameterized (`db.query("… where id = $1", [id])`). Schema changes go in a new `db/migrations/NNN_name.sql` file; never edit an applied migration.
- **IDs:** `newId("request")` → `req_…` from `src/lib/ids.ts`.
- **ESM everywhere** (`"type": "module"`); scripts in `scripts/*.ts` run with `tsx` and may use top-level `await`.
- **Naïve SDK** is `@usenaive-sdk/managed-agents` (the `@usenaive-sdk/vetta` name in the spec is deprecated).
- **Next.js 16** — APIs differ from older versions; read `node_modules/next/dist/docs/` before writing Next code (see AGENTS.md).
- **Tests:** vitest, colocated as `*.test.ts`. Tests must not need network or keys unless named `*.live.test.ts` (skipped by default). Use `createDb({ memory: true })` for DB tests.
- **Checks before you say done:** `npm run typecheck`, `npm test`, `npm run lint`.

## Working in a shared repo

- Other founders edit this repo too. Run `git status` before starting; don't overwrite changes you didn't make.
- Stage files **by path** (`git add src/lib/foo.ts`), never `git add -A` / `git add .` — parallel agents may have work in progress elsewhere.
- Commit small, with clear messages.

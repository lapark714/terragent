# Naïve platform reference: computer sandbox, files, skills, graders, spend, data tools, apps

Status: COMPLETE (research pass 2026-11-07). Verified date: 2026-11-07.
Evidence rule: every identifier below comes from (a) official docs (raw .md pages listed in https://usenaive.ai/docs/llms.txt — the pages themselves now say the canonical index is https://vetta.sh/docs/llms.txt), (b) the published SDK source/types in `@usenaive-sdk/managed-agents@0.12.3` (`dist/index.js` zod schemas + `dist/index.d.ts`), or (c) a live unauthenticated request. Anything else is in section 8.
SDK line refs below are to `node_modules/@usenaive-sdk/managed-agents/dist/index.js` (v0.12.3) unless stated.

## 1. TL;DR for builders

- `import { createClient } from "@usenaive-sdk/managed-agents"` (pin `0.12.3`; `@usenaive-sdk/vetta` is **deprecated**, same API). ESM-only, Node ≥ 20. `createClient({ apiKey: process.env.NAIVE_API_KEY! })` — baseUrl defaults to `https://api.vetta.sh`.
- **Each agent owns ONE auto-provisioned computer (1 vCPU / 1 GiB, $0.0666/h running, $0 paused)** shared by all its sessions; you cannot attach a computer to an agent/session. `GET /v1/agents/{id}/computer` finds it. Standalone boxes: `computers.create()` + `exec`/`fs` from our backend (10-min billing blocks, 12 h max life).
- The 5 calls: `computers.exec(id, cmd, timeoutMs≤600000)` · `computers.fs(id, "read"|"write", {path, content, encoding:"base64"})` (≤4 MiB, home dir only) · `files.upload(FormData)` / `files.url(id)` (7-day keyless link) · `sessions.create({ agent_id, message, output_schema, outcome, metadata })` · `agents.spend(id, { by: "component" })`.
- Agent side: `bash` (no cwd/env fields), `fetch_file` (Files→disk), `publish_file` (disk→Files, ≤5 GiB), `view_image`, `submit_output` (auto with output_schema), `data_search/describe/run`, `web_search/fetch`.
- Skills = ONE `SKILL.md` text (frontmatter + markdown), never executed — no scripts/folders. Ship code separately.
- Structured output + approvals work only on `harness: "pi"` (the default). Built-in data/web tools don't reach `claude_code`.
- Outcomes/graders only attach to agents with `handoffs: false` and no roster; the grader has no tools (can't open images) and sees only the final answer + file ids.
- Traps: `data_run` is ask-by-default (set `allow` or every run waits for a human); no inbound ports; no secrets into the sandbox (vault egress injection "coming soon"); a chat that read email/contacts loses `bash`; wallet, cards and outbound SMS all return `501 feature_not_configured`; a Naïve plan ($20/mo Standard) is required for every non-billing route.
- Python version / pip availability in the VM is undocumented — run the probe in §8 on the first key.
- Dashboard: Vercel. Naïve "mini apps" are template-only; Naïve "apps" hosting is undocumented re frameworks.

## 2. Install & setup

Verified with `npm view` on 2026-11-07:
| Package | Version | Notes |
|---|---|---|
| `@usenaive-sdk/managed-agents` | **0.12.3** (published 2026-11-07T16:28Z; 0.12.0→0.12.3 in 2 days) | TS client. `type: module`, deps `zod ^4.4.3`, `engines.node >=20`. Exports `createClient`, `ApiError`, `ResponseParseError`, `withTool`, `DEFAULT_BASE_URL="https://api.vetta.sh"`, types `ComputerCreate`, `FsOp`, `OutcomeCreate`, `SessionCreate`, `SkillContent`, `DataRunRequest`, … |
| `@usenaive-sdk/vetta` | 0.11.0 | **DEPRECATED**: "Renamed to @usenaive-sdk/managed-agents. Change the package name in your imports; the API is the same." |
| `@usenaive-sdk/cli` | **1.0.3** | bins `naive` and `vetta`. Key from `--api-key`, else `NAIVE_API_KEY`, else `VETTA_API_KEY`, else `naive login` profile; base URL override `VETTA_API_BASE_URL`. |
| `@usenaive-sdk/vetta-cli` | 0.11.0 | **DEPRECATED** → `@usenaive-sdk/cli`. |
| `@usenaive-sdk/app` | 0.2.0 | Only for apps hosted ON Naïve (`enter`, `viewer`, `signInUrl`, `naive(env)`). |
| `@usenaive-sdk/blueprints` | 0.18.0 | Engine behind `naive up` (declarative project config). Optional. |
| Python SDK | none | PyPI `usenaive`, `naive-managed-agents`, `vetta`, `usenaive-sdk`, `naive-sdk` all 404. Python in the sandbox should not call the API; if ever needed, use plain HTTPS. |

```bash
npm i @usenaive-sdk/managed-agents@0.12.3     # in the Next.js / worker package
npm i -D @usenaive-sdk/cli@1.0.3              # npx naive …
export NAIVE_API_KEY=sk_live_…                # from the Naïve dashboard (humans create it)
```
```ts
import { createClient, ApiError } from "@usenaive-sdk/managed-agents";
export const naive = createClient({ apiKey: process.env.NAIVE_API_KEY! }); // optional: baseUrl, fetch, idempotencyKey
try { await naive.computers.get("cmp_x"); } catch (e) { if (e instanceof ApiError) console.log(e.status, e.code, e.requestId, e.param); }
```
Errors: envelope `{ error: { type, code, message, request_id, param? } }` (live: `GET /v1/models` without key → `401 {"error":{"type":"authentication","code":"unauthorized","message":"missing bearer API key","request_id":"req_…"}}`). Every write gets an auto `idempotency-key` UUID from the SDK.
Live public endpoints (no key): `GET https://api.vetta.sh/healthz` → `{"status":"ok"}`; `GET https://api.vetta.sh/v1/openapi.json` → OpenAPI 3.1, `info.version "2026-09-30"`, 410 paths, request bodies + `x-vetta-scope` per route (response bodies not described). Use it as the request-body source of truth.
Scopes seen on our routes (`x-vetta-scope`): `computers:write` (all computer routes incl. inspect/commands), `files:read`/`files:write`, `agents:read`/`agents:write` (skills, outcomes, apps), `sessions:write` (sessions, `data/runs`), `billing:read` (credits).

## 3. API reference

### 3.1 Computer (Linux micro-VM sandbox)

**Model of ownership (most important fact):** each agent has exactly ONE computer, auto-provisioned the first time any session of that agent uses a shell/filesystem tool. All sessions of that agent share it (same files). You do NOT create a computer and attach it to an agent — that is "coming soon" (`computer` on session create / `--computer` on agent are not accepted). Computers you create with `POST /v1/computers` are standalone boxes you drive from your own code via exec/fs.
- `GET /v1/agents/{id}/computer` → the agent's `Computer` or `null` (before first use). SDK: `client.agents.computer(id)` (index.js:6709). Machine under it can change; files kept; re-read rather than caching the `cmp_` id.
- Session object carries `computer_id: string | null` (the computer it last worked on).
- An agent's computer is listed in `GET /v1/computers` with name `agent {id}` and `agent_id` set.
- Auto-paused after a few idle minutes (3 idle minutes after an explicit resume); can't be deleted (409 `computer_unavailable`) — removed when the agent is deleted. Ending/cancelling a session destroys nothing.
- A session's (agent's) computer is **1 vCPU / 1 GiB**, billed per running second ($0.0666/h; pricing page: "On an agent's computer ($0.0666 an hour)"). No field exists to resize an agent's computer (agent config schema has no computer field: index.js:2046-2066).
Source: https://usenaive.ai/docs/api/computers.md ("An agent's computer"), https://usenaive.ai/docs/api/sessions.md (`computer_id`), https://usenaive.ai/docs/concepts/sessions.md (computer override "coming soon"), https://usenaive.ai/docs/computer/limits-and-billing.md, https://usenaive.ai/docs/cli/agents.md (`--computer` "Not available yet").

**Agent-side tools (built-in, names verbatim from SDK `BUILTIN_TOOLS`, index.js:1734):** `bash`, `read`, `write`, `edit`, `ls`, `find`, `publish_file`, `fetch_file`, `browser`, `view_image`, `find_files`, `read_skill`, `web_search`, `web_fetch`, `generate_image`, `data_search`, `data_describe`, `data_run`, `session_spend`, … (full list in 3.8). There is deliberately no `grep` tool (use `bash`). A session with no computer is not offered the six sandbox tools (`bash`,`read`,`write`,`edit`,`ls`,`find`).
Source: https://usenaive.ai/docs/capabilities/tools.md

**Standalone computer — create** `POST /v1/computers` → `202`, `status:"creating"`; poll `GET /v1/computers/{id}` until `running` (no lifecycle event exists).
```ts
import { createClient } from "@usenaive-sdk/managed-agents";
const naive = createClient({ apiKey: process.env.NAIVE_API_KEY! }); // baseUrl defaults to https://api.vetta.sh
const box = await naive.computers.create({ name: "imagery", vcpu: 2, memory_mb: 4096, disk_gb: 20 }); // all optional
// body fields accepted: name, vcpu (1–16, default 2), memory_mb (128–65536, default 4096), disk_gb (≤100, API default 5),
// browser (object|null, default null; `{}` = open web; `true` refused), snapshot_id ("snp_…").
// Any other field (allow_outbound, env, metadata, volume) → 400.
```
`Computer` object (SDK `ComputerSchema`, index.js:1280): `{ id:"cmp_…", object:"computer", name, vcpu, memory_mb, disk_gb, status, browser: BrowserOptions|null, volume: null, snapshot_id: "snp_…"|null, agent_id: "agt_…"|null, created_at }`.
`status` enum (index.js:1274): `"creating" | "running" | "paused" | "failed" | "destroyed"`.
Source: https://usenaive.ai/docs/api/computers.md, https://usenaive.ai/docs/computer/sandbox.md

**SDK methods on `client.computers`** (index.js:7579-7646): `create(body)`, `list(query?)`, `get(id)`, `exec(id, command, timeoutMs?)`, `execStream(id, command, { timeoutMs? })`, `commands(id, query?)`, `inspect(id)`, `update(id, { name })`, `listDir(id, path)`, `fs(id, op, body)` with `op ∈ "read"|"write"|"list"|"mkdir"|"remove"`, `pause(id)`, `resume(id)`, `takeOver(id)`, `handBack(id)`, `snapshot(id)`, `listSnapshots(query?)`, `deleteSnapshot(snpId)`, `delete(id)`, `build3d(id, body)`, `browser(id)`.

**Exec** `POST /v1/computers/{id}/exec` body `{ command: string, timeout_ms?: int }` (default 30000, max 600000). Runs `bash -c <command>`, non-login shell, NO `cwd`/`env` fields (cd/export inside the command). Response (SDK `ExecResultSchema`, index.js:7554): `{ stdout, stderr, exit_code, duration_ms?, timed_out?, truncated? }`. stdout/stderr each capped at 262,144 chars. Timeout → `exit_code:124`, `timed_out:true`; all child processes killed except ones detached with `setsid`.
```ts
const r = await naive.computers.exec(box.id, "cd ~/pipeline && python3 run.py --lat 37.77 --lon -122.42 > out/result.json 2> out/err.log; echo $?", 600_000);
```
**Stream** `POST /v1/computers/{id}/exec/stream` (SSE). Frames (SDK `ExecStreamFrameSchema`, index.js:1338): `{stdout}` | `{stderr}` | `{exit:{exit_code, timed_out, truncated?, duration_ms, command_id:"cmd_…"}}`. SDK throws ApiError 502 if the stream ends without an exit frame ("check GET …/commands before re-running").
```ts
for await (const f of naive.computers.execStream(box.id, "python3 -u run.py", { timeoutMs: 600_000 })) {
  if ("stdout" in f) process.stdout.write(f.stdout); else if ("exit" in f) console.log(f.exit.exit_code);
}
```
**Command history** `GET /v1/computers/{id}/commands` (scope `computers:write`), rows keep first 65,536 chars; retained 30 days, unredacted (never print secrets). Commands the agent runs inside a session are NOT here — they're in the session event stream.
Source: https://usenaive.ai/docs/computer/shell.md, https://usenaive.ai/docs/api/computers.md

**Filesystem** `POST /v1/computers/{id}/fs/{read|write|list|mkdir|remove}`; body `{ path, content?, encoding?: "text"|"base64" }`. Absolute paths only, confined to the home dir (`/home/naive`, read it from `inspect().home`); outside home → `403 forbidden` (use exec for /tmp etc.). **4 MiB per read/write call**; no separate upload/download channel. `list` → `{ entries: [{ name, path, type: "file"|"directory"|"symlink"|"other", size_bytes, mode, modified_at|null }] }` (immediate children only). `remove` is `rm -rf`, refuses `/` and home.
```ts
await naive.computers.fs(box.id, "write", { path: "/home/naive/pipeline/run.py", content: src });            // text
await naive.computers.fs(box.id, "write", { path: "/home/naive/in.tif", content: buf.toString("base64"), encoding: "base64" });
const { content } = await naive.computers.fs(box.id, "read", { path: "/home/naive/pipeline/out/after.png", encoding: "base64" }) as { content: string };
const entries = await naive.computers.listDir(box.id, "/home/naive/pipeline/out");
```
Note: `fs()` response is passed through untyped (`RawSchema`); `listDir` is the typed variant.
Source: https://usenaive.ai/docs/computer/filesystem.md, https://usenaive.ai/docs/api/computers.md, index.js:7603 (listDir), 7637 (fs)

**Inspect** `GET /v1/computers/{id}/inspect` (scope `computers:write`; runs a billed probe, never wakes a paused box) → `{ object:"computer_inspect", id, status, last_active_at, home, probe: { sampled_at, uptime_seconds, processes, load_1m, memory_used_mb, memory_total_mb, disk_used_gb, disk_total_gb } | null }`.

**Lifecycle / persistence:** `POST …/pause`, `POST …/resume`, `POST …/snapshot` → `201 { snapshot_id:"snp_…", computer_id, created_at }`; `GET /v1/snapshots`; `DELETE /v1/snapshots/{id}`; restore = `create({ snapshot_id })` (field is `snapshot_id`, not `snapshot`). Persistent volumes: NOT available (`volume` refused 400). Paused computer keeps disk and bills nothing; exec/fs on a paused computer auto-resumes it (and it stays running/billed). **Max lifetime 12 h wall-clock from create, then auto-destroyed (irreversible)** — for standalone computers; snapshot or `publish_file` anything you need. Unfunded → paused, not destroyed.
On an agent's computer: `pause` → 409 while in use; `takeover`/`DELETE …/takeover` lets a human hold it (sessions wait; auto-hand-back after 1 h); `DELETE` → 409.
Source: https://usenaive.ai/docs/computer/snapshots-and-volumes.md, https://usenaive.ai/docs/computer/sandbox.md

**Network egress:** outbound open by default from `bash`/tools to the public internet ("install packages, call APIs, fetch data without extra configuration"). Blocked: `169.254.0.0/16`, `10.0.0.0/8`, `172.16.0.0/12`. No per-host shell allow-list and no switch to disable shell egress. **No inbound: no port exposure** (`POST /v1/computers/{id}/expose` → 404). Vault secret injection into sandbox egress is "coming soon" (live only for MCP connectors) → there is no supported way to put a secret into the sandbox except passing it inside a command string (which is stored in command history for 30 days — avoid).
Implication for us: planetarycomputer.microsoft.com and *.blob.core.windows.net are public internet → reachable per docs (not live-tested; needs a key).
Source: https://usenaive.ai/docs/computer/networking.md

**Browser (optional):** `browser: {}` on create, or the agent `browser` tool. Options (SDK `BrowserOptionsSchema`, index.js:531; docs): `allowed_domains` (default `["*"]`, `[]` refused), `timeout_minutes` 1–360 (default 15), `region` `us-west|us-east|eu-central|ap-southeast`, `keep_alive`, `viewport {width,height}`, `os`, `block_ads`, `solve_captchas` (default true), `stealth`, `allow_writes` (default false), `allow_extract`, `context_name`, `persist_context`, `human_login`, `proxy` (needs bounded allow-list), tool-only `ask_actions` (default `["signup"]`). Billed per session-minute on a `browser` ledger line plus per model-driven action. We don't need it.
**(critic-verified, capabilities/tools.md "The `browser` tool" + computer/browser.md "Configuration reference") If the `contact_form` outreach channel in NOTES.md goes ahead**, three defaults matter:
- `solve_captchas` **defaults to `true`** ("Attempt automated CAPTCHA solving on supported challenges"). The team's rule is never to solve a CAPTCHA, so set `solve_captchas: false` explicitly and keep `stealth: false` (the default).
- `allow_writes` defaults to `false`. Without it, any `act`/`click`/`type` that looks like "a form submission on a non-search form" is refused (`403 forbidden`, `param: allow_writes`). Submitting a contact form needs `allow_writes: true`.
- `ask_actions` defaults to `["signup"]`, so creating an account on a third-party site always pauses for a human. Keep it.

Also, a flagged "read people's data" chat asks a human on every "browser that moves or writes", so don't feed inbound mail to the outreach agent. Cost: $0.10/h plus $0.01 per `act`/`extract`/`observe` (platform/pricing.md).
Source: https://usenaive.ai/docs/api/computers.md, https://usenaive.ai/docs/capabilities/tools.md

**Isolate mode:** `mode: "isolate"` (V8 isolate) is "coming soon" on every computer page; today every computer is a micro-VM. Don't pass `mode`.


### 3.2 Files (org object storage + asset library)

Two storages: the **computer disk** (scratch, `/home/naive`) and **Files** (`fil_…`, org-scoped, durable). Bytes cross the boundary only via the agent tools `publish_file` (disk → Files) and `fetch_file` (Files → disk), or via your own code (exec/fs + Files API). A session takes **no `files[]`** — to give an agent an input, upload it and put its `fil_` id in the first `message`; the agent calls `fetch_file`.

`File` object (SDK `FileSchema`, index.js:1494 + docs): `{ id:"fil_…", object:"file", name, content_type, size_bytes, scope:"session"|"published", session_id, sha256, created_at, kind:"image"|"video"|"audio"|"document"|"model"|"other", title, description, tags[], folder, source:{type,job_id,url}|null, agent_id?, width, height, duration_seconds, thumbnail_file_id }`.

| Op | Route | SDK (`client.files.*`, index.js:7694) | Limit |
|---|---|---|---|
| Upload (multipart: `file` + `scope`(default `published`), `session_id`, `name`, `title`, `description`, `tags` (comma-sep string), `folder`) | `POST /v1/files` → 201 | `upload(form: FormData)` | **25 MiB** body |
| Upload via one-shot link | `POST /v1/files/uploads` `{name, content_type, size_bytes, folder?}` → `{object:"file_upload", file_id, upload_url, expires_at}`, then keyless `PUT upload_url` with exact Content-Type/Content-Length within 15 min | `createUpload(body)` | **60 MiB** |
| Import from public URL (server-side fetch; needs `Idempotency-Key`) | `POST /v1/files/imports` `{url, name?, title?, description?, tags?: string[], folder?}` | `import(body)` | 25 MiB, ≤3 redirects, public hosts only |
| Metadata | `GET /v1/files/{id}` | `get(id)` | |
| Download bytes | `GET /v1/files/{id}?download=true` (ETag=sha256, Range supported) | `downloadBytes(id)` → `Uint8Array`; `download(id)` → UTF-8 text (mangles binary) | |
| **Keyless signed URL** | `POST /v1/files/{id}/url` (scope `files:read`) → `{object:"file_url", url, expires_at}` | `url(id)` | **valid 7 days**, not extendable; deleting the file revokes it |
| List / filter | `GET /v1/files?scope=&session_id=&kind=&exclude_kind=&agent_id=&ids=&source=&tag=&search=&order=&folder=&limit=&after=` | `list(query)` | cursor-paginated |
| Edit metadata | `PATCH /v1/files/{id}` `{title?, description?, tags?, folder?}` | `update(id, body)` | |
| Promote session→published | `POST /v1/files/{id}/publish` (idempotent) | `publish(id)` | |
| Move to folder | `POST /v1/files/move` `{ids? | from?, folder}` | `move(body)` | 100 ids |
| Delete | `DELETE /v1/files/{id}`; bulk `POST /v1/files/delete {ids}` | `delete(id)`, `deleteMany({ids})` | 100 ids |
| Folders | `GET /v1/files/folders` | `folders()` | flat, 1–64 chars, no `/` |
Source: https://usenaive.ai/docs/api/files.md, https://usenaive.ai/docs/capabilities/files.md

Agent tools (args from docs):
- `publish_file(path, name?, content_type?, title?, tags?, folder?)` → new **published** file id, name, size. `path` absolute (`<workdir>/…`, workdir = what `pwd` prints). Up to **5 GiB**. Every call mints a NEW id (names aren't unique) — key off the id.
- `fetch_file(file_ids[≤8], dir?)` → writes into `<workdir>/<dir>/`, returns `{ files:[{file_id, path, bytes, content_type}] }`. Unpriced; needs a computer.
- `find_files(query?, kind?, tag?, folder?, limit?)` → ids + metadata, never bytes.
- `view_image(file_ids[≤4])` → the model sees PNG/JPEG/GIF/WebP (only those). Unpriced but costs context. Use this for the Verifier/Brain 2 to "look at" our before/after PNGs (requires a vision-capable model).
Source: https://usenaive.ai/docs/capabilities/tools.md

Linking from a report / email: mint `POST /v1/files/{id}/url` from our backend (7-day keyless link, served `inline` with its stored content type, filename in the path) and put it in the HTML report or the AgentMail message; or `downloadBytes(id)` and pass the bytes to AgentMail as an attachment. Naïve has no "public forever" URL for Files (re-mint links on demand; for durable public images host them in our app/Vercel or Neon). Naïve's own identity email cannot carry files: `POST /v1/identities/{id}/emails/{eid}/send` accepts only `{ to: string[1..50], subject, text }` (OpenAPI `sendEmail`) — we use AgentMail instead.

### 3.3 Skills

**Format: ONE `SKILL.md` text document per skill** — YAML frontmatter (`name`, `description` shown in docs) + Markdown body. "Skill bodies are text, not code — they are instructions and reference material, never executed." There is **no folder layout, no bundled scripts, no reference files, no assets**: the API/SDK/CLI push a single `content` string (SDK type `SkillContent = { content: string; description?: string; sha256?: string }`, index.d.ts:3156). For our playbooks: put the signals/buyers/recipe/report format/outreach/price in the SKILL.md; ship pipeline code separately (computer fs/exec or `fetch_file` of an uploaded tarball — see 3.11).
```markdown
---
name: playbook-disasters
description: Disasters & property playbook — signals, buyers, data recipe, report format, outreach copy, price.
---
# Disasters & property
## Signals ...
## Data recipe ...  (e.g. "run `python3 ~/pipeline/run.py --recipe flood ...`")
```
Push / version (`POST /v1/skills` = create-or-new-version by slug; 201 new slug, 200 new version of existing; identical bytes = no-op):
```ts
const v = await naive.skills.push({ slug: "playbook-disasters", content: readFileSync("skills/playbook-disasters/SKILL.md","utf8"), description: "Disasters playbook" });
// -> { id:"skl_…", slug, version, sha256, size_bytes, created_at }
await naive.skills.pushVersion("playbook-disasters", { content });   // 404 if skill doesn't exist
await naive.skills.list(); await naive.skills.get(slug); await naive.skills.listVersions(slug);
await naive.skills.getVersion(slug, 2);   // includes `content`
await naive.skills.delete(slug);          // 409 state_conflict while any agent/deployment references it
await naive.skills.catalog.list({ tag, search }); // platform skills, referenced as "naive/<slug>[@N]"
```
CLI: `naive skill push --slug <slug> --file ./SKILL.md [--description ..]`, `naive skill push-version <id|slug> --file ..`, `naive skill list|show|versions|version <slug> <n>|rm|catalog`.
Attach: agent `skills: string[]`, each matching regex `^(naive\/)?[a-z0-9][a-z0-9-]*(@\d+)?$` (SDK `SkillRefSchema`, index.js:1989): `"slug"` floats to latest at **session start**, `"slug@3"` pins. Changing the array mints a new agent version. Unresolvable ref → agent write fails `404 not_found param:"skills"`.
Runtime: tier 1 = name + truncated description always in context; tier 2 = the agent calls built-in `read_skill` to load the body. `Skill` object: `{ id:"skl_…", object:"skill", name, description, latest_version, created_at }`.
Size limit for org skills: not documented (templates cap skills at 16 KiB — `TEMPLATE_SKILL_MAX_BYTES`, index.js:2716; keep each SKILL.md < 16 KiB to be safe).
Source: https://usenaive.ai/docs/capabilities/skills.md, https://usenaive.ai/docs/api/skills.md, https://usenaive.ai/docs/cli/skills.md, index.js:7647-7690

### 3.4 Structured outputs (`output_schema`)

- Set on the agent (`output_schema`, default for all sessions) or per session (`sessions.create({ output_schema })`, wins). `structured_output_required: boolean` (agent config field; default false) makes it a hard contract → session idles with `stop_reason:"error"` if not produced.
- Mechanism: the agent gets an extra tool `submit_output` whose parameters ARE your schema; non-conforming calls are rejected back to the agent; permissions don't apply to it.
- Result: `session.structured_output` (object|null) on `GET /v1/sessions/{id}` and in the `session.idle` webhook `data.structured_output`.
- **Only the `pi` harness serves structured output** (`vetta` declared-not-served; `claude_code`/`hermes` no). Use `harness: "pi"` for every agent that returns JSON.
- Schema validation in SDK (`JsonSchemaDocument`, index.js:322): top level must be `"type": "object"` with ≥1 entry in `properties`. No other subset/limits are documented (no mention of `$ref`, `oneOf`, depth, size). Keep schemas flat: object/array/string/number/integer/boolean/enum/required.
```ts
const s = await naive.sessions.create({ agent_id, message, output_schema: {
  type: "object",
  properties: { answer: { type: "string" }, confidence: { type: "string", enum: ["low","medium","high"] },
                file_ids: { type: "array", items: { type: "string" } }, metrics: { type: "object" } },
  required: ["answer","confidence","file_ids"] } });
```
Source: https://usenaive.ai/docs/capabilities/structured-outputs.md, https://usenaive.ai/docs/concepts/harness-capabilities.md

### 3.5 Outcomes & graders (Verifier)

Outcome = `{ name (1–200), description (≤4000), rubric (Markdown ≤100,000 chars) XOR rubric_file ("fil_…"), max_iterations (1–20, default 3) }` (SDK `CreateOutcomeSchema`, index.js:771-780). Immutable, no delete; id prefix `ocm_`.
```ts
const oc = await naive.outcomes.create({ name: "report-quality-v1", description: "A report a paying customer can act on.",
  rubric: "# Rubric\n- States the answer in one sentence\n- Includes before AND after image file ids\n- Gives NDWI/NDVI numbers with dates\n- Confidence level + limitations (clouds, resolution)\n- Cites data sources with acquisition dates\n", max_iterations: 3 });
const s = await naive.sessions.create({ agent_id: brain2.id, message, outcome: oc.id });      // at create
await naive.sessions.setOutcome(s.id, { outcome: oc.id });   // or mid-session while idle → returns OutcomeEvaluation(result:"pending")
const got = await naive.sessions.get(s.id);
got.outcome_evaluations?.at(-1); // { object:"outcome_evaluation", session_id, outcome_id, result, iteration, explanation, attached_at }
```
`result` enum (index.js:764): `"satisfied" | "needs_revision" | "max_iterations_reached" | "failed" | "interrupted"`, plus `"pending"` on the session field before the first grade.
Grader loop: after each finished turn a child **grader session on the same model with no tools** returns a verdict (`result`, `explanation`, per-criterion met). It sees ONLY the rubric + the session's structured output or last reply + ids of files the session published — not the transcript, and it **cannot open the files/images** (no tools). `needs_revision` → notes become the agent's next message. While grading, session is `idle` with `stop_reason:"awaiting_delegation"`. Grade tokens are billed against the graded session's budget.
Events (session stream / webhooks): `outcome.evaluation.started` {outcome_id, iteration, thread_id}, `outcome.evaluation.progress`, `outcome.evaluation.completed` {outcome_id, iteration, thread_id, result, explanation, criteria[], token_usage, consumed_micro_usd}. The events list endpoint returns them only with `include_accepted=true`.
REST: `POST /v1/outcomes` (agents:write), `GET /v1/outcomes`, `GET /v1/outcomes/{id}`, `POST /v1/sessions/{id}/outcome` {outcome} (sessions:write).
**HARD CONSTRAINT: outcomes only attach to an agent with `handoffs: false` AND no `multiagent` roster** (else `400 validation_failed`; checked against the session's pinned agent version). So: the coordinator and any agent that delegates cannot be graded; teammates reached via `send_to_agent` can't get an outcome either (its documented args are `wait`, `budget_micro_usd`, `handoff_key` — no outcome). Gate delivery from OUR backend: create the Brain-2/report session ourselves with `outcome`, wait for `session.idle`, read `outcome_evaluations.at(-1).result === "satisfied"` before Comms delivers. For image-level checks, make the Verifier a normal `pi` agent (vision model + `view_image` + `output_schema {pass, failures[]}`) instead of / in addition to the grader.
(critic) **This conflicts with a board-driven pipeline (naive-orchestration.md §3.2).** Card-woken sessions are started by the board clock, not by us, so nothing can pass `outcome` at create. `sessions.setOutcome` attaches only to an idle session, and an outcome also needs the agent to have `handoffs: false` and no roster. Pick one per path:
- **(a) Outcome-graded Brain 2.** Our backend creates the Brain 2 session directly with `outcome`. Simplest for the inbound/demo path.
- **(b) Verifier as its own `pi` agent on the board.** Its card is `blocked_by` Brain 2's card, and its `output_schema` verdict gates delivery. Use this for the overnight board flow.

Source: capabilities/outcomes.md ("Outcomes grade agents that work alone … `handoffs: false` and no `multiagent` roster"), api/board.md (clock-started sessions).
Source: https://usenaive.ai/docs/capabilities/outcomes.md, index.js:764-806,7158-7163,6838

### 3.6 Observability & spend

**Agent spend** `GET /v1/agents/{id}/spend?by=component` (SDK `client.agents.spend(id, { by: "component" })`; schema `AgentSpendSchema`, index.js:6672):
```ts
type AgentSpend = { agent_id: string; period: "day"|"week"|"month"; period_start: string; spent_micro_usd: number;
                    by_component?: Record<string, number> };   // only with by=component
// documented example: { "agent_id":"agt_01H8XK...", "period":"month", "spent_micro_usd":12418700,
//   "by_component": { "model":11902000, "computer":481000, "search":6474, "media":390000 } }
```
Component keys: `model` (5 token tiers summed), `computer`, `search` (web_search/web_fetch/**data_run**), `media` (generation), `other`; absent when zero; sums to `spent_micro_usd`. Covers only the **current budget period** of the agent. Computer time is billed to the agent and to NO session, so agent spend > Σ sessions' `consumed_micro_usd`; the difference is `computer`. CLI: `naive agent spend <agt> --by component`.
Source: https://usenaive.ai/docs/api/agents.md#spend, https://usenaive.ai/docs/sdk/agents.md, https://usenaive.ai/docs/concepts/budgets.md

**Per session** (`GET /v1/sessions/{id}`, SDK `SessionSchema` index.js:1157): `consumed_micro_usd`, `budget_micro_usd`, `token_usage: { input, cache_write, cache_read, output, reasoning }`, `window`, `stop_reason`, `agent_version`, `deployment_id`, `metadata`, `started_at`, `ended_at`, `last_seq`, `computer_id`, `structured_output`, `outcome_evaluations?`.
Event `session.usage` precedes every idle: `data: { consumed_micro_usd, token_usage{…5 tiers}, active_seconds, tool_calls }`. Span events: `span.model_request.start/.end` (`.end`: `model, window, token_usage, stop_reason, resolved_model, provider_ms, consumed_micro_usd`), `span.box_resume.*` etc; tools are `tool.started`/`tool.completed`. OTLP export: coming soon.
Agent-side: built-in `session_spend` tool (read-only, unpriced) lets an agent read its own session cost.
Source: https://usenaive.ai/docs/capabilities/observability.md

**Org ledger** `GET /v1/credits/ledger?type=&session_id=&agent_id=&deployment_id=&from=&to=&limit=&after=` (SDK `client.credits.ledger(q)`) → entries `{ id:"led_…", type:"debit"|"credit", amount_micro_usd (signed), balance_after_micro_usd, actor{type,id}, session_id, agent_id, deployment_id, resource_id ("cmp_…"/"brw_…"/"mob_…"), line_items:[{tier, amount_micro_usd}], created_at }`. Line tiers (SDK `LINE_ITEM_TIERS`, index.js:332): `input, cache_write, cache_read, output, reasoning, computer, search, media, social, browser, storage, email, voice, mobile`.
**Server-summed spend** `GET /v1/credits/spend?session_id=&agent_id=&deployment_id=&from=&to=` (SDK `client.credits.spend(q)`) → `{ spent_micro_usd, by_tier{}, by_agent:[{agent_id, spent_micro_usd}], by_session:[{session_id, spent_micro_usd}] }` (top 50 each); `?days=1..90[&timezone=]` → adds `by_day` (whole company only). Balance: `GET /v1/credits/balance` → `{ object:"credit_balance", balance_micro_usd, mode:"live"|"test" }`.
Source: https://usenaive.ai/docs/api/credits.md, index.js:5804-5818

**Cost per request recipe (Terragent):** tag every session we start with `metadata: { request_id }` (session create accepts `metadata`), store each `ses_` id against the request in Neon, then `cost = Σ credits.spend({ session_id }).spent_micro_usd` (or Σ `consumed_micro_usd`) over that request's sessions, + the Analytics agent's computer share: ledger entries with `agent_id = analytics` and tier `computer` between the request's start/end (computer debits carry no `session_id`). Delegated teammate threads are child sessions (`parent_session_id`/`root_session_id` set) — `GET /v1/sessions?parent_session_id=<root>` lists them. 1 USD = 1,000,000 micro-USD everywhere.

### 3.7 Pricing (rates that matter to us)

| Item | Price | Source |
|---|---|---|
| Plan (required for every non-billing route) | Standard $20/mo incl. $20 credit (7-day trial, card required, $10 trial credit); Pro $200/mo incl. $200 | platform/pricing.md |
| Agent/session computer (1 vCPU / 1 GiB) | $0.000014/vCPU-s + $0.0000045/GiB-s → **$0.0666/h**, per running second; paused = $0 | computer/limits-and-billing.md |
| Standalone computer | same rates, but billed **ahead in 10-min blocks** (clock-aligned); 2 vCPU/4 GiB default = $0.1656/h ≈ $0.0276 per 10-min block | same |
| `web_search` | $0.00166/query (≤10 results), `search` component | platform/pricing.md |
| `web_fetch` | $0.00083/page | same |
| `data_run` | the tool's listed price (median ≈ $0.0015, 70% ≤ $0.01, max ≈ $0.95); search/describe free | same |
| `generate_image` | what the model reported; no price table; `media` component | same |
| Browser | $0.10/h session + $0.01 per `act`/`extract`/`observe` | same |
| Email via Naïve identity | $0.0008/send | same |
| Model tokens | per model per window (`immediate` > `priority` > `loose`), 5 tiers; see `GET /v1/models` | same |
Web/media spend is booked AFTER the call, so `max_task_micro_usd` does not bound it (data_run is the exception: admitted/held first).

### 3.8 Built-in tools: data (18 domains), web search/fetch, image generation

**How an agent gets them:** they are built-ins, ON by default for every `pi`/`vetta` harness agent (NOT delivered to `claude_code`/`hermes` — "Managed Agents' own built-ins … reach `pi` and `vetta` only"). Control them in the agent's `tools.configs` map by tool name. `data_run`, `generate_video`, `mobile`, `email.send` etc. are **ask-by-default** (session parks in `requires_action`/`awaiting_approval` until a human approves) — for unattended agents set them explicitly:
```ts
tools: { default_config: { permission: "allow" }, configs: {
  data_search: { enabled: true, permission: "allow" }, data_describe: { enabled: true, permission: "allow" },
  data_run:    { enabled: true, permission: "allow" },             // otherwise every paid run waits for a human
  web_search:  { enabled: true, permission: "allow", config: { blocked_domains: [] } },
  web_fetch:   { enabled: true, permission: "allow", config: { allowed_domains: [], max_content_tokens: 4000 } },
  generate_image: { enabled: false, permission: "deny" },          // we don't need it
  browser: { enabled: false, permission: "deny" }, mobile: { enabled: false, permission: "deny" } } }
```
Permission enum `"allow"|"ask"|"deny"` (index.js:1733); `deny` = not offered to the model at all. Under an `allow`/`ask` default an unlisted ask-by-default tool still resolves to `ask` — so `data_run` must be listed. SDK helper `withTool(tools, name, { enabled?, permission?, config? })` validates the name (index.js:7824).
Ask-by-default set (SDK `ASK_BY_DEFAULT_TOOLS`, index.js:1874): `mobile, data_run, generate_video, edit_video, create_character, build_media_skill, list_as_template, pay_out_earnings, social.post, social.cancel, email.send, phone.send, legal.*(verify/resend_link/form/submit), wallet.pay, wallet.transfer, card.issue, card.credentials, card.cancel, company.set_timezone/set_logo/set_brand, apps.request_access, payments_request, vault.request_secret, operator.request, trading.*writes`.
Source: https://usenaive.ai/docs/capabilities/tools.md, https://usenaive.ai/docs/concepts/harness-capabilities.md

**Data catalogue** (~1,900 read-only endpoints from 51 sources). Domain enum, exact wire values (SDK `DATA_DOMAINS`, index.js:3394): `social, search, people, companies, compliance, funding, seo, finance, crypto, news, legal, weather, jobs, real_estate, reviews, trade, shopping, travel`. (Note: it's `real_estate`, not "property"; `trade` = customs shipment records; `legal` = US Code + CFR; `weather` = current + forecasts.)
Agent tools: `data_search { query, domain?, platform?, limit? }` (free) → tools with price; `data_describe { tool_id }` (free) → input schema; `data_run { tool_id, path?, query?, body? }` → JSON, waits ≤2 min, ≤25 results, held against the session budget first, failed runs normally not charged. Tool ids are opaque — always discover via search, never hard-code.
REST/SDK (`client.data.*`, index.js:7339):
```ts
const { data: tools } = await naive.data.searchTools({ query: "customs import shipments coffee", domain: "trade", limit: 5 }); // GET /v1/data/tools (limit 1–20, default 8)
// DataTool: { object:"data_tool", id, name, description, domains[], platforms[], price:{ basis:"per_call"|"per_result"|"varies", micro_usd, text } }
const tool = await naive.data.getTool(tools[0].id);  // + input:{path?,query?,body?}, notes[]
const run = await naive.data.run({ tool_id: tool.id, query: { /* fields tool.input names */ } }); // POST /v1/data/runs (scope sessions:write)
// DataRun: { object:"data_run", tool_id, status:"succeeded"|"failed", data, error, cost_micro_usd, created_at }
```
Price: the tool's listed `price.micro_usd` (median ≈ $0.0015; max ≈ $0.95); booked on the `search` spend component. `501 feature_not_configured` = data not enabled on that deployment. CLI: `naive data search "<q>" --domain <d>`, `naive data describe <id>`, `naive data run <id> --query k=v --body '{..}'`.
Source: https://usenaive.ai/docs/capabilities/data.md, https://usenaive.ai/docs/platform/pricing.md, OpenAPI `POST /v1/data/runs` (live, https://api.vetta.sh/v1/openapi.json)

**(critic-verified, capabilities/tools.md "Web tools") `web_fetch` is the wrong tool for signal feeds.** It "read[s] one web page as text". `max_content_tokens` (default 4000) caps how much enters the context, and "the rest is truncated". So the 1.8 MB NWS `/alerts/active` JSON or a FIRMS CSV would come back cut off, and POST bodies such as GFW `/download/json` aren't covered. Poll feeds with `bash` (`curl` / Python in the agent's computer; all signals.md feeds are keyless) or with a Terragent MCP tool that runs the fetch on Vercel, and have that tool write to Neon.
**Web tools:** `web_search` ($0.00166/query, ≤10 results) and `web_fetch` ($0.00083/page; `max_content_tokens` default 4000). Config per tool: `allowed_domains` (non-empty = closed list; covers subdomains), `blocked_domains` (always wins), `max_content_tokens` (fetch). Billed after the call on component `search`.

**Image generation:** `generate_image` (args from docs: description/prompt, `image_urls` ≤3 refs as `fil_` ids or public URLs, `n` ≤4, `style`, `character`, `character_strength`, `seed`, `folder`); answers in the same call with a `fil_` id in Files (nothing written to the computer disk). Docs table says "Asks by default: the card shows the price and the model" but the SDK's `ASK_BY_DEFAULT_TOOLS` does not include it — set the permission explicitly. Priced per finished job (no price table; `GET /v1/media/models?kind=image` lists models). Not needed for satellite imagery; don't use it for reports (would look fabricated).
Source: https://usenaive.ai/docs/capabilities/tools.md#generation-tools

**Full built-in tool list** (SDK `BUILTIN_TOOLS`, index.js:1734): `bash, read, write, edit, ls, find, browser, mobile, read_skill, publish_file, web_search, web_fetch, generate_image, generate_video, clip_video, build_media_skill, list_as_template, pay_out_earnings, generate_3d_model, build_3d, create_character, get_character, list_characters, update_character, delete_character, apps, send_to_agent, wait_for_agents, list_agents, post_to_channel, board_read, board_write, ask_operator, request_tools, project_context, transcribe_audio, generate_speech, generate_sound_effect, generate_music, find_files, view_image, fetch_file, find_stock_photo, data_search, data_describe, data_run, session_spend, show, open_panel, compose, write_plan, propose_plan` (+ `submit_output` injected when an output_schema is set; `edit_video` follows `generate_video`). Platform-namespaced tools (index.js:1812): `email.*`, `phone.numbers|read|send`, `crm.*`, `social.*`, `connections.*`, `legal.*`, `wallet.balance|transactions|receipts|quote|pay|transfer`, `card.list|show|quote|transactions|spend|issue|credentials|cancel`, `company.*`, `apps.request_access`, `payments`, `payments_request`, `vault.request_secret`, `operator.request`, `trading.*`.

### 3.9 Apps & mini apps (hosting a dashboard)

**Mini apps** (`GET /v1/mini-apps`, `GET /v1/mini-apps/{slug}?page=`; SDK `client.miniApps.list()/get(slug, page?)`) are dashboard pages **declared by a marketplace template** out of platform blocks (board, spend, schedule, posts…). "A company with no template has none." They are read-only views, not custom code → **not usable for our mission-control dashboard.**
Source: https://usenaive.ai/docs/api/mini-apps.md

**Apps** = org-level hosted web apps (`app_…`). Create: `POST /v1/apps { name (DNS label ≤63), description?, type?: "frontend_only"(default)|"fullstack", mcp?: "/path" (fullstack only) }` — idempotent on `name`. OpenAPI also lists an undocumented third type `"bundle"` and fields `project`, `adopt`. `status`: `provisioning|active|error`; `url` = live URL. `fullstack` adds a managed Postgres (`DATABASE_*` env auto-injected), object storage, a REST/SQL layer (`/v1/apps/{id}/db/query|tables|rest|migrations`), and can serve an MCP endpoint whose tools every agent gets as `<app-name>.<tool>` (bearer `VETTA_MCP_TOKEN` injected server-side).
Deploy: `POST /v1/apps/{id}/deployments { files: { "<path>": "<base64>" }, content_hash? } | { from_deployment }` → `app_deployment { id:"apd_…", status: queued|building|ready|error, url, error, content_hash }`; "the build runs asynchronously", poll `GET /v1/apps/{id}/deployments`. CLI: `naive app create <name> --type frontend_only|fullstack`, `naive app deploy <app-id> <dir>` (skips `node_modules`, `.git`, `dist`, `.wrangler`, `.open-next`, `.env*`, `.dev.vars*`, gitignored), `naive app deployments <id>`. Secrets: `POST /v1/apps/{id}/secrets {name, value}` (write-only env vars). Access gate: if the app declares `DASHBOARD_PASSWORD`/`DASHBOARD_TOKEN` it's password/ticket-protected; `@usenaive-sdk/app@0.2.0` exposes `enter(request, env)`, `viewer(request, env)`, `signInUrl(env)`, `naive(env)` (server-side API client with an owner-approved key; framework-free Fetch API, "process.env, a Worker's env").
SDK (`client.apps.*`, index.js:5890): `create, list({name?}), get, update, delete, deploy(id, files-map), redeploy, deployments, deploymentFiles, setSecret, secrets, deleteSecret, entry, permissions, access, rotateAccess, connectDomain, domains, disconnectDomain, installs…` (+ `query(id, sql)` for the fullstack DB per https://usenaive.ai/docs/sdk/apps.md).
Source: https://usenaive.ai/docs/api/apps.md, https://usenaive.ai/docs/cli/apps.md, OpenAPI `createApp`/`createAppDeployment`, `node_modules/@usenaive-sdk/app/dist/index.d.ts`

**Verdict for Terragent:** host the Next.js mission-control dashboard + `POST /answer` API on **Vercel** (as the spec's default). Reasons: (1) the docs never state which frameworks/runtimes the app build supports, the max deployment size, or the app URL domain — every one of those is unverified and a Next.js App Router build with server routes, a globe library and a Neon driver is the riskiest case; (2) deploy is "files map of base64" with no documented build command/Node version; (3) the skip-list (`.wrangler`, `.open-next`) and "a Worker's env" suggest a Cloudflare-Workers-style runtime (inference only), where Node-only deps (e.g. `pg`, h3-js wasm) may not run. Optional "Best Use of Naïve" add-on, time-boxed: a `frontend_only` static status page (`next build && next export`-style static HTML/JS that fetches our Vercel API) deployed with `naive app deploy`, or a `fullstack` app whose MCP endpoint exposes `terragent.earth_index_lookup` to our agents.

### 3.10 Identity, wallet, cards, SMS — and our paid-order approval policy

- **Wallet: NOT available** ("Coming soon · not available yet (Phase 5)… expect `501 feature_not_configured`"). Planned: USDC on Base, per-tx cap (default $0.50) + daily cap, `wallet.pay`/`wallet.transfer` ask-by-default. Source: https://usenaive.ai/docs/identity/wallet.md
- **Cards: NOT available** ("card issuing is not configured on the hosted service yet… `501 feature_not_configured`"). Planned: prepaid $1–$150 virtual cards bought from org credits; `card.issue`/`card.credentials`/`card.cancel` ask. Source: https://usenaive.ai/docs/identity/cards.md
- **SMS: outbound NOT available to anyone** — "a text has no price, so every send (the API, CLI and SDK send, and the agent's `phone.send` tool) is refused `501 feature_not_configured`" (before that, `compliance_pending` until the A2P campaign is approved). Inbound SMS works and wakes the number's owning agent. Source: https://usenaive.ai/docs/identity/phone.md, https://usenaive.ai/docs/api/messaging.md, https://usenaive.ai/docs/capabilities/tools.md#coming-soon
- Identity email (`email.send`, plain text, $0.0008/send, needs a verified domain) exists but we use AgentMail (spec 4.2).

**Approval policy for paid orders (implementable today):** Naïve's approval primitive is the per-tool `ask` permission. Expose order placement as a tool on our side — e.g. a `fullstack` app MCP endpoint or an MCP server URL in `mcp_servers` (`terragent.place_paid_order`) — and set it `ask` in the Orchestrator's `tools.configs` (MCP tools default to `ask` anyway). When the agent calls it the runtime emits `tool.confirm`, the session idles with `stop_reason: "awaiting_approval"` and the call sits in `session.pending_actions`. Dashboard "orders waiting on a human" = `client.sessions.list({ stop_reason: "awaiting_approval" })`. Founder approves with `client.sessions.confirmTool(sessionId, { tool_call_id, decision: "allow"|"deny", reason?, scope?: "call"|"session" })` (`POST /v1/sessions/{id}/tool_confirmations`; CLI `naive session confirm --session $SID --tool-call $CALL_ID --allow|--deny --reason ".."`). The approver (user/key id) is recorded on the event + audit log → feeds our intervention log. A held tool costs nothing while waiting. Simpler alternative: keep orders as `awaiting_approval` rows in Neon and never give agents a purchase tool at all.
Source: https://usenaive.ai/docs/concepts/policies.md, index.js:6823-6834 (`confirmTool`), index.js:977 (`StopReasonSchema`)

### 3.11 End-to-end pattern: agent runs our Python pipeline in its computer, returns JSON + PNGs

Facts this relies on: agent computer auto-provisions on first shell/fs tool use and keeps files across sessions; outbound internet open; `bash` returns buffered output (≤262,144 chars), timeout ≤600,000 ms; `publish_file` → Files; `output_schema` → `structured_output`. Unverified: Python/pip presence and version (see §8) — the bootstrap step below installs deps and fails loudly if python3 is missing.

**Step 0 (once per pipeline version, from our backend):** package `pipeline/` as `pipeline-<ver>.tgz` and upload to Files.
```ts
const form = new FormData();
form.append("file", new Blob([await fs.readFile("dist/pipeline-v3.tgz")], { type: "application/gzip" }), "pipeline-v3.tgz");
form.append("tags", "pipeline,v3"); form.append("folder", "infra");
const pipe = await naive.files.upload(form);   // ≤25 MiB; use files.createUpload() for ≤60 MiB
```
(Alternatives: agent runs `git clone`/`curl` from a public URL; or our backend writes files straight into the agent's computer via `naive.computers.fs((await naive.agents.computer(analytics.id))!.id, "write", {...})` once the computer exists — 4 MiB per call.)

**Step 1: Analytics agent** (`harness: "pi"`, `handoffs: false` so an outcome can be attached, vision model if it must look at PNGs):
```ts
const analytics = await naive.agents.create({
  name: "analytics", harness: "pi", model: MODEL_ID /* from GET /v1/models */, window: "priority",
  budget: { cap_micro_usd: 15_000_000, max_task_micro_usd: 500_000, period: "day" },
  handoffs: false,
  system: "You run Terragent's imagery pipeline in your computer. Never invent numbers; only report what run.py printed.",
  tools: { default_config: { permission: "deny" }, configs: {
    bash: { enabled: true, permission: "allow" }, read: { enabled: true, permission: "allow" }, ls: { enabled: true, permission: "allow" },
    fetch_file: { enabled: true, permission: "allow" }, publish_file: { enabled: true, permission: "allow" },
    view_image: { enabled: true, permission: "allow" } } },
  output_schema: { type: "object", required: ["status", "result", "file_ids"], properties: {
    status: { type: "string", enum: ["ok", "error"] }, result: { type: "object" },
    file_ids: { type: "array", items: { type: "string" } }, error: { type: "string" } } },
  structured_output_required: true,
});
```
**Step 2: per request** (our backend → session; message carries the exact commands):
```ts
const s = await naive.sessions.create({ agent_id: analytics.id, metadata: { request_id: req.id },
  message: [
    `If ~/pipeline/VERSION is not "v3": call fetch_file with file_ids ["${pipe.id}"] and dir "bootstrap", then run:`,
    `  cd ~ && rm -rf pipeline && tar xzf <the path fetch_file returned> && python3 -m pip install --user -q -r pipeline/requirements.txt && echo v3 > pipeline/VERSION`,
    `Then run with timeout_ms 600000:`,
    `  mkdir -p ~/out/${req.id} && cd ~/pipeline && python3 run.py --lat ${lat} --lon ${lon} --out ~/out/${req.id} > ~/out/${req.id}/result.json 2> ~/out/${req.id}/err.log; echo EXIT=$?`,
    `Read ~/out/${req.id}/result.json. publish_file each PNG in ~/out/${req.id} with tags ["${req.id}"].`,
    `Submit status, result (the parsed JSON) and the published file ids.`].join("\n") });
// on session.idle webhook (or poll):
const done = await naive.sessions.get(s.id);
const out = done.structured_output as { status: string; result: any; file_ids: string[] } | null;
for (const id of out?.file_ids ?? []) { const { url } = await naive.files.url(id); /* 7-day keyless link for report/email */ }
```
Notes: if the image's Python is "externally managed" (PEP 668, typical on Debian/Ubuntu) `pip install --user` fails — fall back to `python3 -m venv ~/venv && ~/venv/bin/pip install -r …` and call `~/venv/bin/python` (whether `venv`/`pip` exist is unverified, §8). A run >10 min must be detached (`setsid nohup python3 run.py … > log 2>&1 &`) and polled in later turns; keep AOIs small (agent computer = 1 vCPU / 1 GiB RAM) — windowed COG reads, not full Sentinel-2 tiles. `result.json` printed to stdout must stay < 262,144 chars, so write big outputs to files.

**Alternative (deterministic, no LLM tokens): backend-driven standalone computer.**
```ts
const box = await naive.computers.create({ name: "imagery-worker", vcpu: 2, memory_mb: 4096, disk_gb: 20 });
while ((await naive.computers.get(box.id)).status === "creating") await sleep(1000);
await naive.computers.fs(box.id, "write", { path: "/home/naive/pipeline.tgz", encoding: "base64", content: tgz.toString("base64") }); // ≤4 MiB/call
await naive.computers.exec(box.id, "cd ~ && tar xzf pipeline.tgz && python3 -m pip install --user -q -r pipeline/requirements.txt", 600_000);
const r = await naive.computers.exec(box.id, `cd ~/pipeline && python3 run.py --lat ${lat} --lon ${lon} --out ~/out/${id}`, 600_000);
const json = JSON.parse(((await naive.computers.fs(box.id, "read", { path: `/home/naive/out/${id}/result.json` })) as any).content);
const png = Buffer.from(((await naive.computers.fs(box.id, "read", { path: `/home/naive/out/${id}/after.png`, encoding: "base64" })) as any).content, "base64");
await naive.computers.snapshot(box.id);  // after setup: create({ snapshot_id }) later boots in ~3 s with deps installed
```
Billing: 10-min blocks at 2 vCPU/4 GiB ≈ $0.0276 per block; pause between jobs; recreate (from snapshot) before the 12 h lifetime cap.


## 4. Discrepancies with the master prompt

| # | Spec says | Reality (source) | Impact on build |
|---|---|---|---|
| D1 | SDK `@usenaive-sdk/vetta`, CLI `@usenaive-sdk/vetta-cli`, key `VETTA_API_KEY` (§4.1) | Both packages deprecated → `@usenaive-sdk/managed-agents@0.12.3` and `@usenaive-sdk/cli@1.0.3`; docs/CLI use `NAIVE_API_KEY` (CLI still falls back to `VETTA_API_KEY`) (npm view; CLI dist) | Import from `managed-agents`; name the env var `NAIVE_API_KEY`. |
| D2 | "Computer (Linux micro-VM…)" as a thing we create and give agents; Analytics "runs the imagery processing in the Naïve sandbox computer" | Each agent has exactly one platform-managed computer (1 vCPU / 1 GiB), auto-created on first shell/fs use; attaching a chosen computer to an agent/session is "coming soon"/"not available yet" (api/computers.md, concepts/sessions.md, cli/agents.md) | Analytics agent gets a small box; keep AOIs small. For heavy jobs, our backend drives a standalone `computers.create({vcpu, memory_mb})` box via exec/fs instead of the agent's tools. |
| D3 | Each playbook is a Naïve skill "defining its signals, target buyers, data recipe, report format, outreach message and price" | A skill is one `SKILL.md` text doc; "text, not code… never executed"; no folders/scripts/resources (capabilities/skills.md, API `content: string`) | Playbook skills hold prose/config only; the data recipe must reference code shipped separately (pipeline tarball in Files or git). |
| D4 | Verifier "grades every report… (Naïve outcomes and graders)… sends failures back to Brain 2" | Outcome attaches only to a session whose agent has `handoffs:false` and no roster; grader runs inside the graded session (same model, no tools), sees only final answer/structured output + published file ids; on `needs_revision` the SAME agent revises (capabilities/outcomes.md) | Attach the outcome to Brain 2's (Interpreter's) session created by our backend, not to a separate Verifier agent; Brain 2 must not delegate (handoffs:false) in that session. If the Verifier must look at images, make it a separate `pi` agent with `view_image` + output_schema verdict. |
| D5 | Data tools "18 domains including companies, people, property, news, trade and jobs" | Exact enum: `social, search, people, companies, compliance, funding, seo, finance, crypto, news, legal, weather, jobs, real_estate, reviews, trade, shopping, travel` (SDK `DATA_DOMAINS`). `data_run` asks a human by default. | Use `real_estate` (not "property"). Set `data_run: allow` on Sourcing/Brain 1 or overnight runs stall. |
| D6 | "Known caveat: SMS can be sent from the API and CLI but not by an agent" | Outbound SMS refused `501 feature_not_configured` for API, CLI, SDK AND agent `phone.send` ("a text has no price"); inbound SMS works and wakes agents (identity/phone.md, api/messaging.md) | Don't plan any SMS sends. |
| D7 | Identities "can carry a spend-limited wallet and prepaid virtual cards" | Wallet: "Coming soon · not available yet (Phase 5)"; Cards: "Not available yet… 501 feature_not_configured" (identity/wallet.md, identity/cards.md) | Paid orders cannot be paid through Naïve anyway; implement "awaiting approval" as an `ask`-permission tool or a Neon status (§3.10). |
| D8 | "mini apps" listed as a usable piece; "If Naïve's apps or mini apps can host the dashboard cleanly, consider that" | Mini apps are template-declared block pages (none for a company without a template). Apps host static or fullstack sites from a base64 file map, but supported frameworks/runtime/limits/URL are undocumented (api/mini-apps.md, api/apps.md) | Dashboard + `/answer` API on Vercel. Optional small Naïve app only as a time-boxed extra. |
| D9 | "report files in Naïve Files" + deliver "with the report attached" | Files give 7-day signed keyless URLs (no permanent public URL); Naïve's own email send is `{to, subject, text}` only — no attachments, no HTML (api/files.md; OpenAPI `sendEmail`) | Comms agents send via AgentMail; attach bytes from `files.downloadBytes(id)` (backend) or link a fresh `files.url(id)`. Re-mint links older than 7 days. |
| D10 | Spend tracking via `GET /v1/agents/{id}/spend?by=component`; "Show real cost vs. price per request" | Correct route/shape, but it covers only the agent's current budget period, and computer time is billed to the agent, never to a session, so Σ session `consumed_micro_usd` < real cost (api/agents.md#spend) | Per-request cost = Σ `credits.spend({session_id})` over the request's sessions + Analytics computer ledger lines (`agent_id`, tier `computer`) in the request window. Tag sessions with `metadata.request_id`. |
| D11 | Vault "injects credentials at the network boundary (live for MCP connectors), so agents never see raw keys"; "imagery processing in the sandbox computer" | Sandbox egress secret substitution is "coming soon"; no env vars can be baked into a computer; command history stores stdout 30 days unredacted (computer/networking.md, computer/shell.md, api/computers.md) | The Python pipeline must use only keyless sources (MPC STAC + anonymous SAS signing, NASA/USGS public feeds). Anything keyed (e.g. GFW key) is fetched by our backend or an MCP tool, not by `bash`. |
| D12 | $250 Naïve credits is "the main budget" | Every non-billing route needs an org plan: Standard $20/mo (includes $20 credit; 7-day trial needs a card, $10 trial credit) (platform/pricing.md) | Confirm with organisers that the hackathon org already has a plan; otherwise a founder must start one (human action, paid). |
| D13 | Isolate mode "coming soon; use the default micro-VM" | Consistent for computers. Note the `vetta` *harness* runs `execution: "isolate"` (preview, only for orgs it's opened to) and does NOT serve structured output (concepts/harness-capabilities.md) | Use `harness: "pi"` everywhere. |
| D14 | Docs at usenaive.ai/docs | Pages now name `https://vetta.sh/docs/llms.txt` as the canonical index (both serve the same content today) | None; cite either. |

## 5. Answers to open questions (spec section 14 + topic questions)

| Question | Answer | Confidence | Source |
|---|---|---|---|
| How do we create/attach a computer to an agent or session? | You don't attach. The agent's own computer appears on first shell/fs tool use; `GET /v1/agents/{id}/computer` returns it (or null). Session `computer_id` names it. Standalone `POST /v1/computers` boxes are only driven by our code. | high | api/computers.md, concepts/sessions.md |
| Shell exec from agent and SDK? | Agent: `bash` tool (`command`, `timeout_ms`). SDK: `computers.exec(id, command, timeoutMs)` / `execStream(id, command, {timeoutMs})`; REST `POST /v1/computers/{id}/exec {command, timeout_ms}`. | high | computer/shell.md, OpenAPI `execCommand`, index.js:7616 |
| Upload our code? | Files upload (≤25 MiB multipart / ≤60 MiB link) + agent `fetch_file`, or backend `fs write` (≤4 MiB per call, base64), or `git clone`/`curl` from a public URL inside `bash`. No mount/sync channel. | high | capabilities/files.md, computer/filesystem.md |
| Egress to planetarycomputer.microsoft.com / *.blob.core.windows.net? | Docs: public internet open from `bash` with no host filter; only metadata/10.x/172.16.x blocked. Not live-tested. | medium | computer/networking.md |
| Python version / pip? | Not documented anywhere. `build_3d` runs "a clean Python process on the agent's computer" (so Python exists in some form for that toolchain), but version/pip/apt unknown. | low | capabilities/3d.md |
| Persistence between sessions? | Agent computer: files persist across all the agent's sessions, survive machine changes and pauses; removed only when the agent is deleted. Standalone: disk kept while paused; destroyed at 12 h wall-clock or on DELETE; snapshots (`snp_`) outlive it. No persistent volumes. | high (agent: medium on 12 h interaction) | api/computers.md, computer/snapshots-and-volumes.md |
| Cost per minute? | Agent computer 1 vCPU/1 GiB: $0.00111/min ($0.0666/h) per running second; standalone 2 vCPU/4 GiB: $0.00276/min billed in clock-aligned 10-min blocks ($0.0276/block). Paused: $0. | high | computer/limits-and-billing.md |
| Optional browser? | `browser: {}` on create or the agent `browser` tool; $0.10/h + $0.01 per model-driven action. | high | platform/pricing.md |
| Isolate mode? | `mode: "isolate"` "coming soon" on all computer pages. | high | computer/sandbox.md |
| Agent runs `python pipeline/run.py --lat .. --lon ..` and returns JSON + PNG? | Yes — pattern in §3.11 (bash → result.json → publish_file PNGs → submit_output). | high for mechanism, low for Python availability | §3.11 sources |
| Files: signed/public URLs, limits, email attachment? | Keyless signed URL valid 7 days (`POST /v1/files/{id}/url`); no permanent public URL. Upload 25 MiB, link-upload 60 MiB, import 25 MiB, publish/fetch 5 GiB. Naïve email has no attachments → AgentMail. | high | api/files.md, OpenAPI `sendEmail` |
| Skill format / contents / versioning? | Single SKILL.md (frontmatter + markdown); immutable content-addressed versions; `slug` floats, `slug@N` pins; `naive/<slug>` = platform catalogue. No scripts/references. | high | capabilities/skills.md, api/skills.md |
| output_schema subset? | Must be `type: "object"` with ≥1 property (SDK). Nothing else documented. Only `pi` harness serves it. | medium | index.js:322, concepts/harness-capabilities.md |
| Graders: define, attach, read, gate? | `outcomes.create` → `sessions.create({outcome})` or `sessions.setOutcome` → read `outcome_evaluations.at(-1).result`; gate on `"satisfied"`. Constraints in D4. | high | capabilities/outcomes.md |
| `GET /v1/agents/{id}/spend?by=component` shape? | `{ agent_id, period, period_start, spent_micro_usd, by_component?: { model, computer, search, media, other } }` | high | api/agents.md, AgentSpendSchema |
| Data tools: names, enabling, price? | `data_search`/`data_describe`/`data_run`, on by default for `pi`; `data_run` asks unless `allow`; price = tool's listed `price.micro_usd` (median ≈ $0.0015, max ≈ $0.95). | high | capabilities/data.md |
| Host the dashboard on Naïve? | Possible for static/fullstack sites but under-documented; use Vercel for Next.js. | medium | api/apps.md |
| Spec §14: vision-capable models? | `GET /v1/models` rows have only `id, context_window, max_output_tokens, supported_windows, efforts` — no modality flag, so vision support can't be read from the catalogue; test `view_image` with the chosen model. | medium | SDK `ModelSchema` (index.js:6679) |
| Spec §14: does inbound email wake agents? | For Naïve identity inboxes: yes ("Inbound email and SMS wake the agent that owns the inbox"), with SPF/DKIM/DMARC guards; older inboxes need `--wake on`. Not relevant to AgentMail mail. | high | identity/inbound.md |

## 6. Credentials needed

| Env var | Service | Where to get it | Cost | Needed for |
|---|---|---|---|---|
| `NAIVE_API_KEY` (`sk_live_…`) | Naïve Managed Agents | Naïve dashboard → API keys (a founder creates it; never in git). Scopes needed by our backend: `agents:read/write`, `sessions:read/write`, `computers:write`, `files:read/write`, `billing:read`. | Requires an org plan (Standard $20/mo incl. $20 credit, or hackathon-provided credits) | Everything in this doc. |
| (none) | Microsoft Planetary Computer from the sandbox | Anonymous STAC + `planetary-computer` SAS signing — confirm in the imagery reference | free | Pipeline inside the computer (sandbox cannot receive vault secrets). |
| AgentMail key (see agentmail doc) | AgentMail | — | — | Attaching report files to emails (Naïve email can't attach). |
No separate credential is needed for computers, Files, skills, outcomes, data tools, web tools or image generation — all billed to the Naïve org balance.

## 7. Gotchas & limits

Computer
- Agent computer fixed at 1 vCPU / 1 GiB; no resize field. Standalone: vCPU 1–16, memory 128–65536 MiB, disk ≤100 GiB (API default disk 5 GiB; docs elsewhere say "service default").
- `exec` timeout default 30 s, max 600 s; stdout/stderr 262,144 chars each (then `truncated: true`); exit 124 on timeout; children killed unless `setsid`.
- No `cwd`/`env` on exec (filesystem doc's mention of `cwd` contradicts shell doc + OpenAPI; trust OpenAPI: only `command`, `timeout_ms`).
- `fs/*` only under home (`/home/naive`; read `inspect().home`), 4 MiB per call, `list` non-recursive. Use exec for `/tmp`.
- Standalone billing is ahead in 10-min blocks; create/resume need a balance ≥ one block else `402 insufficient_credits`; exec/fs on a paused box auto-resumes it (billing restarts). Max lifetime 12 h wall-clock → auto-destroyed (irreversible). Unfunded → paused.
- No inbound ports (`/expose` 404). No egress allow-list for bash. No secret injection into the sandbox yet. Command history keeps stdout 30 days unredacted.
- `POST /v1/computers` → 202 `creating`; poll; there is no computer lifecycle event. Unknown body fields → 400.
- An agent's computer: `pause` 409 while in use, `DELETE` 409; `takeover` lets a human drive it (sessions wait; auto-return after 1 h).
- A chat that has read people's data (mail, contacts, messages, a connected app) loses `bash`, `build_3d`, and (if it holds bash) `write`/`edit`/`fetch_file`; sends/`data_run`/`web_fetch`/MCP tools ask every time. Keep inbox-reading agents and the Analytics agent separate.
- Docs: boot ~2 s cold, ~3 s from snapshot, ~2 s resume.

Files
- Multipart upload 25 MiB; link upload 60 MiB (PUT within 15 min, exact Content-Type/Length, once); import 25 MiB, ≤3 redirects, public hosts only; `publish_file`/`fetch_file` 5 GiB; `fetch_file` 8 ids/call; `view_image` 4 ids/call, PNG/JPEG/GIF/WebP only.
- Signed URL lifetime 7 days, fixed; deleting the file revokes links. `download()` returns UTF-8 text and corrupts binary — use `downloadBytes()`.
- Names aren't unique; every `publish_file` mints a new id. Tags ≤32 × 64 chars. Folders flat, 1–64 chars, no `/`.

Skills / outputs / outcomes
- Skill content is a single string; floating refs resolve at session START (running sessions don't pick up a new push). Deleting a referenced skill → 409.
- `output_schema` needs top-level `type:"object"` + ≥1 property; `structured_output_required:true` turns a miss into `stop_reason:"error"`. `pi` only.
- One active outcome per session; outcomes immutable, never deletable; rubric ≤100k chars; description ≤4000; max_iterations ≤20 (default 3). Grade tokens are charged to the graded session's budget; budget exhaustion → `interrupted`.

Spend / pricing
- Money is integer micro-USD everywhere. Web/media spend is booked after the call — `max_task_micro_usd` doesn't bound it; `data_run` is held first.
- `agents.spend` = current budget period only; `credits.spend` = server-summed totals (use it for charts, not page sums of the ledger).
- `web_search` $0.00166, `web_fetch` $0.00083, `data_run` listed price (≤25 results, ≤2 min, failed runs free), browser $0.10/h + $0.01/action, email $0.0008/send.

Data tools
- Tool ids are opaque; field names differ per tool — always `data_describe` first. `data_search` limit 1–20 (default 8), query ≤200 chars. `501 feature_not_configured` = data disabled on that deployment. Respect source terms for `people` data (spec §8: work contacts only).

SDK
- ESM-only package (`"type": "module"`, `exports.import` only) — no `require()`. Node ≥ 20. 3 releases on 2026-11-07 alone: pin the exact version.
- 2xx bodies are zod-parsed; client/server drift surfaces as `ResponseParseError` (subclass of `ApiError`, carries `issues`).
- `execStream` throws a synthetic 502 if the stream ends without an exit frame — check `computers.commands(id)` before re-running (avoid double-running paid work).

## 8. Unverified

Everything below could not be confirmed without an API key (no account was created). How to confirm once `NAIVE_API_KEY` exists:
1. **Sandbox image: OS, Python version, pip, apt, GDAL/rasterio wheels, disk free on an agent computer.** Docs are silent. (critic, indirect docs evidence only) capabilities/3d.md: `build_3d` "runs a script in a clean Python process on the agent's computer", and its toolchain "installs on first use (about 20 seconds and 1.9 GB of disk; an agent's computer has room for it)". So some Python, package installs, outbound egress and ≥2 GB of free disk exist on agent computers. Version and pip/venv layout are still unknown. Fallback if rasterio can't install: run the free-data path with no Python at all through the Planetary Computer data API (imagery.md §3.8/§3.14, plain `fetch` from Vercel or an MCP tool). Confirm: create a throwaway standalone box and run
   `naive computer exec <cmp> --timeout-ms 120000 --command 'cat /etc/os-release; python3 --version; python3 -m pip --version; which python pip apt-get sudo; df -h ~; nproc; free -m; echo $HOME; pwd'`,
   then `--command 'python3 -m pip install --user -q pystac-client planetary-computer rasterio numpy pillow && python3 -c "import rasterio; print(rasterio.__version__)"'`. Repeat inside an agent session (agent computer may differ: 1 vCPU/1 GiB).
2. **Egress to Microsoft Planetary Computer and Azure blob storage.** Confirm: `--command 'curl -sS -o /dev/null -w "%{http_code}\n" https://planetarycomputer.microsoft.com/api/stac/v1/collections/sentinel-2-l2a && curl -sS -o /dev/null -w "%{http_code}\n" https://planetarycomputer.microsoft.com/api/sas/v1/token/sentinel-2-l2a'` and one signed COG range read from `*.blob.core.windows.net`.
3. **Agent computer vs the 12 h max runtime.** Docs say the agent's files are kept when "the machine under it can change"; not confirmed that the 12 h auto-destroy is transparent for agent computers. (critic-verified, docs only) api/events.md: `session.computer_replaced` with `reason: "expired"` = "the machine was lost and rebuilt from its newest archive … Files changed since the newest archive are gone". So it is mostly transparent. Writes since the last archive can vanish, and the archive cadence is not published. Keep the §3.11 VERSION-check bootstrap. Confirm: note `agents.computer(id).id` and `created_at` across a >12 h overnight run, then `ls ~/pipeline`.
4. **`fetch_file`/`publish_file` workdir == `/home/naive`?** Docs say `<workdir>` = what `pwd` prints; fs routes are rooted at `home`. Confirm with one agent session: `pwd` + a `fetch_file` and compare paths.
5. **Agent `bash` tool honours `timeout_ms` up to 600000.** Docs describe the field on the shell page; confirm with `sleep 120` in a session.
6. **output_schema JSON-Schema subset** (`$ref`, `oneOf`, `enum`, nested objects, size limits) — undocumented beyond "type: object + ≥1 property". Confirm by creating a session with a nested schema and checking `submit_output` acceptance.
7. **Grader behaviour on images**: docs say the grader sees "ids of files the session published" and has no tools; confirm it cannot see image content (expect yes).
8. **`generate_image` permission default**: docs table says "Asks by default", SDK `ASK_BY_DEFAULT_TOOLS` omits it. Confirm via `GET /v1/agents/{id}` of an agent created without a `generate_image` entry, or set it explicitly (recommended).
9. **Exact Naïve-MCP tool name for minting a file URL** (route `POST /v1/files/{id}/url`, operationId `mintFileUrl`; MCP names are `resource_verb`). Confirm with `tools/list` on `https://api.vetta.sh/v1/mcp` (declaring server name `vetta` needs an `admin`-scope key).
10. **Naïve app hosting**: supported frameworks, build command, Node/Workers runtime, max deployment size, URL domain, whether an app without `DASHBOARD_PASSWORD` is public. Inference (not fact): Cloudflare-Workers-style runtime (CLI skips `.wrangler`/`.open-next`; `@usenaive-sdk/app` mentions "a Worker's env"). Confirm: `naive app create tg-probe --type frontend_only && naive app deploy <id> ./static-hello` and open `naive app show <id>` URL in a private window. OpenAPI also lists an undocumented `type: "bundle"`.
11. **Org skill size limit** (only the 16 KiB template limit is known) and whether frontmatter `name` must equal the slug.
12. **Plan status of the hackathon org** (whether the $250 credits come with an active plan) — check `naive plan` / `GET /v1/credits/subscription` and `GET /v1/credits/balance`.
13. **Data catalogue coverage for our needs** (e.g. `trade` import records for coffee/cocoa, `real_estate` listings by address, `companies` news) and real prices — free to check: `naive data search "<q>" --domain trade` (search/describe are free).
14. **Model ids with vision** for `view_image` — the catalogue has no modality field; test a `view_image` call per candidate model.
15. The doc examples' response bodies (e.g. agent spend sample numbers) are documentation examples, not live responses; only `/healthz`, `/v1/openapi.json` and the 401 envelope were live-fetched.

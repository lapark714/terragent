# Naïve: live findings (naive builder, 2026-11-07)

Status: verified live on 2026-11-07, 23:00–23:40 UTC, with the org key in `.env` (key `main2`) and the
throwaway agent `tg-smoke`; board limits and config round trips re-checked on 2026-11-08 with `tg-smoke`
plus two throwaway members `tg-smoke-a`/`tg-smoke-b` (`--only roundtrip,board-limits`). Scripts:
`scripts/naive-smoke.ts`, `naive/smoke-board.ts`, `scripts/research/naive-probe-computer.ts`,
`src/lib/naive/naive.live.test.ts`. Raw outputs were kept in the session scratchpad, not in the repo.
Where this file disagrees with naive-core.md, naive-orchestration.md or naive-compute.md, this file wins
for the points it covers.

## 1. TL;DR for builders

- **Session budgets have a floor per model.** `sessions.create` returns **`402 budget_exceeded`: "the
  remaining budget for this task is below the pre-flight quote"** when the session budget (or the agent's
  `max_task_micro_usd`) can't cover one model call's reservation. With a 6–8k-token context, the smallest
  accepted budget was: Claude Sonnet 5.5 **$0.40** (refused at $0.30), GLM-5.2-FP8 **$0.30** (refused at
  $0.20), Claude Haiku 5.5 **$0.05**. A running session pauses (`budget_paused`) once its remaining budget
  drops under the next call's quote. So give each session at least about 2× the floor. Today's
  `config.ts` is too tight for planner ($0.60), verifier ($0.50) and coordinator ($0.50). See §4.
- **Save-time validation is weaker than the docs say.** PATCH accepted an unknown MCP tool name, an
  `mcp_servers[].type` field (silently dropped), a declared server with no enabled tool, and a server URL
  with no MCP behind it. What it does enforce: integer budgets, no secret inline headers, `handoffs:"team"`
  needs a roster, and skills must exist. Upshot: **agents can be saved pointing at the future
  `https://<prod>/api/mcp` before the deploy exists**, and a typo in a tool name will NOT be caught at save.
  Our unit tests guard tool names against the catalog instead.
- **The agent computer:** Ubuntu 24.04.5, x86_64, 1 vCPU, ~958 MB RAM, 9.8 GB disk (6.8 GB free).
  `python3` is **3.12.3 from `/opt/venv`** (a venv first on PATH, pip 24.0). The system Python is
  PEP-668 externally managed. **`uv`/`uvx` are preinstalled** at `/usr/local/bin`; git, curl, wget and gcc
  are present; GDAL is not. `sudo -n` works. **`HOME=/home/tenki`, user `tenki`**, not `/home/naive` as the
  docs say. Use `$HOME`/`~`, never a hard-coded path. Egress is open: the Planetary Computer STAC and SAS
  endpoints, PyPI, GitHub and astral.sh all answered. rasterio 1.5.2 is on the PyPI index for this Python.
- **Vision works.** `view_image` delivers pixels to Claude Sonnet 5.5: with a neutral file name, it
  correctly named a green|yellow split image. Its text result lists only
  `fil_… — name (WxH)` and `[image] fil_… image/png <signed url>`, though. Asked whether it saw pixels,
  **Sonnet wrongly said it had not** (unreliable introspection), so prompts tell agents the picture is
  attached. **A malformed PNG fails the whole turn** (`stop_reason: error`, `stop_code: validation_failed`,
  "the model could not accept this request"), so the pipeline must publish valid PNGs.
- **Board mirror semantics confirmed.** A keyed card created with `status: "doing"` and an assignee does
  **not** wake anyone (`woken_session_id: null`). A keyed replay returns the same card id and ignores the
  new title, body and status. A PATCH to `done` with a note works.
- **But a `doing` card with an assignee makes that agent busy.** While it exists, the board will not wake
  that agent for any `todo` card (not in-request, not on the next tick); closing the mirror lets the todo
  card wake on the next tick. An **unassigned** `doing` card blocks nobody. So inbound mirror cards are now
  unassigned, with the agent named in the title (`src/lib/naive/board.ts`). See §7.
- **A card is started at most 3 times, and re-assigning does not reset `wake_count`.** The 4th PATCH that
  writes `assignee` (to a different agent or the same one) returns the card already `blocked`, with no
  session, and the board comments: "This card has been started 3 times and none of those sessions finished
  it. Parked for the board's owner rather than started again. Reassigning it will not restart it: create a
  new card…". A background sample needs about 6 wakes, so `upsertCard` continues on a fresh card keyed
  `<key>#<n>` once `wake_count` reaches 3 (generation stored in `naive_card_generations`). A fresh keyed card
  was woken on the next board tick. See §7.
- **Saved configs read back unchanged.** All 12 real agent configs (with a placeholder https MCP URL, skills
  dropped), the smoke config and a `multiagent` roster were saved and read back with `changedFields() == []`
  and an equal roster, so a second provisioning run is a no-op against the real API too.
- **The org already holds a "shop" template team** that none of us created through this repo: `CEO`,
  `store-manager`, `merchandiser`, `marketer` and `analyst` (created 19:41Z), with 4 cron deployments on
  `anthropic/claude-sonnet-5`. See §8: a founder should decide whether to delete it.

## 2. Key, org, models, harnesses

- `GET /v1/me` (plain fetch): principal `{type: "key"}`, org "Terragent" (`mode: live`). Scopes:
  `sessions:read, sessions:write, agents:read, admin, audit:read, webhooks:*, billing:read, billing:write,
  files:read, files:write, computers:write, proxy:write`. Because of `admin` and `billing:write`, the
  deployed app refuses this key (`ensureSafeRuntimeKey` in `src/lib/naive/client.ts`, NOTES H1d).
- The SDK's `auth.me()` parses scopes against a closed enum, so a new scope would throw. The guard
  therefore uses plain fetch.
- Balance before testing: 250,855,107 micro-USD.
- `models.list({ window: "loose" })` → exactly `zai-org/GLM-5.2-FP8`, `google/gemma-4-31B-it` and
  `moonshotai/Kimi-K2.6`. `anthropic/claude-sonnet-5.5` and `claude-haiku-5.5` → `["immediate"]` only,
  context 1,000,000, max output 32,768.
- Cheapest first in the catalogue: `zai-org/GLM-5.2-FP8`. Its router resolves it to `z-ai/glm-5.2`.
- `GET /v1/harnesses`: `pi` is ga and runnable (approvals, structured output, deltas, injected tools).
  `vetta` is preview and runnable (isolate). `claude_code` and `hermes` are preview and **not runnable** here.

## 3. Agent config save probes (PATCH /v1/agents/{id})

| Probe | Result |
|---|---|
| Our full shape: `harness: pi`, `default_config: deny`, 25 tool configs (deny list incl. `email.send`, `wallet.pay`, `card.issue`, `phone.send`, `social.post`, `mobile`; SkyWatch tools; `web_*`; `data_*`; `browser` with `{solve_captchas:false, stealth:false, allow_writes:true, block_ads:true, timeout_minutes:10, ask_actions:["signup","login"]}`; `bash`; `view_image`), `mcp_servers: [{name:"skywatch", url}]`, `handoffs:false`, zod draft-7 `output_schema` (with `$schema`) | **accepted** on create and update. Browser options stored as written. |
| Unknown MCP tool name `skywatch.no_such_tool` | **accepted** (no live tools/list check at save) |
| `mcp_servers[].type: "url"` | **accepted**, `type` silently dropped |
| Declared server `spare` with no enabled tool | **accepted** |
| Server URL with no MCP behind it (`https://example.com/mcp`) + a tool for it | **accepted** |
| Float budget `cap_micro_usd: 500000.5` | refused: `400 validation_failed param=budget.cap_micro_usd: … expected int, received number` |
| Inline `Authorization` header | refused: `400 validation_failed param=mcp_servers.0.headers.Authorization: … credentials belong in a vault-bound MCP credential, not agent config` |
| Non-secret header `x-terragent-agent` | accepted and stored |
| `output_schema` = `outputSchema(ReportDraft)` (nested, nullable, `$schema`) | accepted |
| `handoffs: "team"` without a roster | refused: ``400 validation_failed param=handoffs: `handoffs: "team"` needs a `multiagent` roster to name the team`` |
| `skills: ["playbook-does-not-exist"]` | refused: `400 validation_failed param=skills: no such skill: playbook-does-not-exist` |

Provisioning consequence: the team step sets `multiagent` and `handoffs: "team"` together, after the members exist.

## 4. Sessions and the pre-flight budget floor

The session budget was raised step by step until `sessions.create` accepted it. Refused creates cost $0.

| Session | Model | Refused at | Accepted at | Result | Cost |
|---|---|---|---|---|---|
| bash + SkyWatch MCP + `submit_output` | GLM-5.2-FP8 (immediate) | $0.05 / 0.10 / 0.15 / 0.20 | **$0.30** | `end_turn`. Tools `bash`, `skywatch.get_offerings`, `submit_output`. `structured_output` matched RunSummary. 3 model calls ($0.0086, $0.0027, $0.0020); prompt caching active from call 2. | $0.0133 |
| view_image (malformed PNG, my encoder bug) | Sonnet 5.5 | $0.20 / 0.30 | **$0.40** | `error` / `validation_failed` "the model could not accept this request" | $0.0211 |
| view_image (same malformed PNG) | Haiku 5.5 | (none) | **$0.05** | same error | $0.0011 |
| view_image (valid PNG, colours in file name) | Sonnet 5.5 | up to $0.30 | $0.40 | `end_turn`, red/blue, but the file name gave the answer away | $0.0260 |
| view_image (valid 256×128 PNG, neutral name) | Sonnet 5.5 | up to $0.30 | $0.40 | `end_turn`, **green/yellow (correct)**, `structured_output_required: true` honoured | $0.0281 |

- Error at create, verbatim: `402 budget_exceeded: the remaining budget for this task is below the pre-flight quote`.
- The agent's `max_task_micro_usd` is checked too, so it must also clear the floor. The smoke agent used cap = max task = $0.50.
- A per-session `output_schema` plus `structured_output_required: true` overrides the agent-level schema, and it works.
- `agents.spend(id, { by: "component" })` → `{ period: "day", spent_micro_usd, by_component: { model } }`.
  No computer line appeared within minutes of the run.
- **Recommendation (config.ts, shared):** Sonnet agents `maxTaskUsd` ≥ $1.00 (planner $0.60 → $1.00,
  verifier $0.50 → $1.00). Coordinator (GLM) `maxTaskUsd` $0.50 → $0.80, and `capUsdPerDay` $6 → $8 so that
  8 reviews a day still fit in the 70% of the cap kept for scheduled fires ($0.70/run; the other 30% is for
  board digests). `provision-naive.ts` prints these as `! budget:` lines (`budgetWarnings()` in
  `naive/index.ts`) and **refuses to apply** while any remain, unless `--force-budgets` is passed.

## 5. Agent computer (computers.exec on tg-smoke's computer)

```
os         Ubuntu 24.04.5 LTS (Noble), Linux 6.18.60 x86_64
python     Python 3.12.3; python3 → /opt/venv/bin/python3; also /usr/bin/python3.12
pip/venv   pip 24.0 (/opt/venv); `python3 -m venv` ok; /usr/lib/python3.12/EXTERNALLY-MANAGED present
tools      uv, uvx (/usr/local/bin), pip, pip3 (/opt/venv/bin), curl, wget, git, tar, gzip, gcc, apt-get; gdal-config missing
resources  nproc 1; Mem total 958 MB (751 available); / 9.8G size, 2.6G used, 6.8G avail; HOME=/home/tenki; user tenki; sudo -n ok
egress     planetarycomputer.microsoft.com/api/stac/v1 200 (0.52 s); …/api/sas/v1/token/sentinel-2-l2a 200 (0.48 s);
           pypi.org/simple/rasterio 200; github.com 200; astral.sh/uv/install.sh 301; api.weather.gov 400 (bad test param, but reachable)
pip index  rasterio 1.5.2 available
```

The computer is created by the first session that uses `bash`. `agents.computer(id)` was null before.
`computers.exec` works on it from our backend, and `computers.pause` afterwards was accepted or ignored.
The listed computer was 1 vCPU, 1024 MB, 10 GB.

For the imagery builder's `bootstrap.sh`: Python ≥ 3.12 is already there, so no install is needed. Either
`python3 -m venv ~/tg/pipeline/.venv` (inheriting from /opt/venv is fine) or `uv venv` works. Binary
rasterio and numpy wheels exist for cp312 manylinux x86_64. Never assume `/home/naive`.

## 6. SkyWatch public MCP (`https://mcp.skywatch.com/mcp`, no auth)

- `initialize` → 200 `application/json`, `protocolVersion "2025-03-26"`, `serverInfo skywatch-mcp-server 1.0.0`,
  and **no `mcp-session-id` header**. `notifications/initialized` → 202.
- `tools/list` → 5 tools:
  - `search_archive_imagery(location_query, radius_km, coordinates, bbox, geojson, start_date, end_date, max_cloud_cover, min_coverage, resolution_preference, data_type, order_by, limit, mode, interval)`
  - `calculate_pricing(location_query, coordinates, bbox, start_date, end_date, resolution, tasking, interval)`
  - `get_satellites(filter_by_resolution, filter_by_type, include_details)`
  - `get_offerings(category, partner_filter, product_name, limit)`
  - `get_started(in_organization)`
- Configured on `acquisition` as `skywatch.<tool>`: four tools allow, `get_started` deny.
- Called for real through Naïve: `skywatch.get_offerings {category:"archive", limit:3}` returned Nearmap
  Vertical Hyper-Res (3 cm, $67/km²) and Eagleview Ultra-Res HD Plus (3 cm, $70/km²).

## 7. Board (on tg-smoke's own board)

- `board.create(agentId)` works for an agent without a roster (`brd_y95prqkmg6qgh7j701vky3kykw`).
- `cards.create({ key, status: "doing", assignee: "tg-smoke" })` → `woken_session_id: null`, so a mirror card wakes nobody.
- Replaying the same key → same `crd_` id; the new title, body and status are ignored.
- `cards.update(…, { status: "done", note })` → done.

Board limits (`naive/smoke-board.ts`, owner `tg-smoke` with roster `tg-smoke-a`, `tg-smoke-b`, Haiku 5.5;
every woken session was cancelled at once: 10 member sessions over the two runs at $0–$0.0005 each, 5 owner digest sessions
at ≈ $0.0006 each). Run twice, same results:

| Probe | Result |
|---|---|
| keyed `doing` card, **assignee null**, then an un-keyed `todo` card for member a | todo woken **in the same request** (`wake_count` 1) |
| keyed `doing` card **assigned to member b**, then an un-keyed `todo` card for b | **not woken** in-request, nor after 75 s; woken on the next tick after the doing card was closed `done` |
| un-keyed todo → a (woken), PATCH `{status: todo, assignee: b}` (woken), PATCH → a (woken) | `wake_count` 1, 2, 3; each PATCH that writes `assignee` starts a session in the request |
| 4th PATCH → b, 5th → a, then the same assignee again | each returns `status: blocked`, `woken_session_id: null`, `wake_count` 3; still blocked after a tick; one system comment per refused PATCH (quoted in §1) |
| fresh keyed card `…#1`, todo + assignee b | not woken in-request (keyed = seed), **woken on the next tick** (`wake_count` 1) |
| the parked card, PATCH `{status: done, note}` | done |

- Owner digests: the owner got one short session per tick in which cards became done or blocked.
- `multiagent` roster `{type: "coordinator", agents: [{type: "agent", id, version}], board: true}` read back equal.

## 8. What remains in the org after the smoke test, and other observations

- **Deleted:** all four `tg-smoke` agents (one per run, the first of which stopped at the 402 above; deleting
  an agent also deletes its computer and deployments) and all three uploaded PNGs.
- **Remaining (no delete API exists):** 5 sessions (`ses_g5drwnfgcy5be90tpm7fz0ny5s`,
  `ses_5zzy2eqjd6xsvspb0sstzaem89`, `ses_dkae8mpayy64mt4re7mpwt96p9`, `ses_1756t61xzw7y46zd47hbkrjxaa`,
  `ses_bad82ccgatzvnj8exe0r0v2xf9`) and board `brd_y95prqkmg6qgh7j701vky3kykw` with one `done` card.
- **Spend for all of the above:** $0.0933. Balance went from 250,855,107 to 250,761,809 micro-USD.
- **2026-11-08 re-checks** (round trips + two board-limit runs): $0.0041 more (≈ $0.0974 in total). Deleted:
  `tg-smoke`, `tg-smoke-a`, `tg-smoke-b` (both runs). Remaining (no delete API): their sessions (all
  cancelled or idle) and two boards whose cards were all closed `done`.
- **Pre-existing "shop" template team (not ours):**
  - Agents: `CEO` (`z-ai/glm-5.3-flash`, cap $50/month, roster of 4, board) and four agents on
    `anthropic/claude-sonnet-5`: `store-manager` ($30/day), `marketer` ($30/day), `merchandiser`
    ($15/day) and `analyst` ($6/day). Metadata reads `{template: "shop", blueprint: "store", project: "terragent"}`.
  - Deployments: `store-manager` runs at 9:00 and 17:00 daily; the others run weekly or twice a week.
  - Their sessions sit at `awaiting_answer`, which holds their schedules. They have spent $0.145 so far.
  - A company `CEO` owns the company board, which seats every agent automatically. Our members use
    `handoffs: false` and our coordinator's own board, so ours are unaffected, but the caps add up to
    about $81/day of exposure.
  - **A founder should decide whether to delete these agents and their deployments.** Their names don't
    collide with ours.
- Vault `Orchestrator control plane` (1 credential) also exists. It is not ours; leave it.

## 9. Still unverified (needs the public deploy)

- How a vault `static_bearer` reaches our MCP server (assumed `Authorization: Bearer <token>`), and
  `last_injected_at`.
- Naïve calling `tools/list` on our server at session start, and what happens when the server is
  down (docs: `session.degraded`).
- Real webhook deliveries: the `Vetta-Signature`/`Vetta-Timestamp` format against `verifyNaiveSignature`,
  the fields of a `session.idle` envelope, and on_idle endpoints and their secrets.
- `schedule_status` of our deployments (expected `scheduled`; the shop team's are `scheduled`).
- An `ask` approval end to end (`terragent.place_paid_order` → `awaiting_approval` → `confirmTool`).
- A browser `ask_actions` park (contact-form `click`/`type`/`act` before OUTREACH_CONTACT_FORM_APPROVED): the
  `pending_actions` row is assumed to be `{name: "browser", args: {action, …}}`; `isApprovable` in
  `src/lib/naive/sessions.ts` refuses to allow `signup`/`login` by `args.action`.
- Haiku 5.5 vision with a valid image (only the malformed-PNG run was made).
- The pre-flight floor at larger contexts and on the `loose` window (measured only at 6–8k tokens, immediate window).

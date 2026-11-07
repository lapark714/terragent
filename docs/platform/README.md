# Terragent platform reference: index and cross-doc consolidation

Status: COMPLETE (completeness-critic pass, 2026-11-07 ~23:00Z).

All nine expected docs are present and complete; none is truncated, and each ends with its §8 "Unverified".

This README covers what the topic docs don't:
- the seams between docs (§2)
- the consolidated tables (§3–§5)
- the §14 answers (§6)
- the remaining key-gated checks (§7)

Marking conventions:
- **(critic-verified)** means the critic checked the claim against a primary source or a live call on 2026-11-07. The same marker appears inline in the topic docs wherever the critic edited them.
- **(NOTES)** means the builder checked the fact live with the org's keys and recorded it in `/NOTES.md`. The critic did not re-run those checks: no credentials were used in this pass.

Where a topic doc and this README disagree, this README is the later, reconciled view.

Scratch evidence for this pass: `/private/tmp/claude-504/-Users-laurence-terragent/22c3e839-95bd-4a29-a8d4-0ec9c4c36ffd/scratchpad/research/critic/`.

## 1. Index

| Doc | One line |
|---|---|
| [naive-core.md](naive-core.md) | Naïve SDK `@usenaive-sdk/managed-agents@0.12.3`: client, agents, sessions, streaming, events, models, windows, harnesses, model proxy, budgets in integer micro-USD. Includes a typechecked end-to-end example. |
| [naive-orchestration.md](naive-orchestration.md) | Teams, the shared board, delegation and handoffs, deployments (cron), outbound webhooks with HMAC verification, allow/ask/deny policies and approvals, the vault, MCP servers, audit, digest and reviews. |
| [naive-compute.md](naive-compute.md) | The agent's computer and standalone computers (exec/fs), Files and signed URLs, skills (one `SKILL.md`), `output_schema`, outcomes and graders, spend and ledger, data tools, apps and mini apps, the pattern for running our Python pipeline in the sandbox. |
| [agentmail.md](agentmail.md) | AgentMail TS SDK `agentmail@0.5.53`: inboxes, send and reply in thread, attachments, Svix-signed webhooks (with a typechecked Next.js route), polling and WebSockets, block lists for opt-out, the hosted MCP server, plans, and the cold-outreach ToS conflict. |
| [monid.md](monid.md) | Monid REST API (no SDK): discover → inspect → run → poll, price cards, wallet and caps, the OAuth-only MCP, the connector-PR route for listing Terragent, and a priced catalogue for news, companies, people, email, property, weather and geocoding. No imagery tools. |
| [database.md](database.md) | Neon (`@neondatabase/serverless@1.2.0`, pooled vs direct, HTTP vs Pool), the PGlite local test DB, a portable SQL migration, the `lib/db.ts` layer, H3 in JS (`h3-js`) and Python (`h3`). Recommends app-side H3 stored as text. |
| [imagery.md](imagery.md) | Anonymous Planetary Computer STAC, SAS and COG reads for Sentinel-2 L2A and Landsat C2 L2, the BOA offset, SCL masking, index formulas, a seed pipeline measured end to end at 7–31 s, and the no-Python TiTiler data-API fallback. |
| [signals.md](signals.md) | Free signal feeds, all keyless today: NWS, USGS quakes, NOAA NWPS and riv_gauges, FIRMS, NIFC, OpenFEMA, GFW `/download`, MRDS, BLM Hub claims, Socrata permits. Also the Census and Nominatim geocoders and cross-feed join keys. |
| [web-and-providers.md](web-and-providers.md) | Next 16 notes, Vercel Hobby limits, the globe (`react-globe.gl` hexbin), our MCP route (`mcp-handler@2.3.1`), the rate-limited `POST /answer`, Stripe Payment Links, and paid-imagery pricing and licences (SkyWatch public MCP, UP42, Arlula, Planet). |

## 2. Build-critical seams

These questions sit between docs, and no single doc answered them.

### 2.1 AgentMail inbound email → a Naïve session or card (build step 2)

1. **Route:** `app/api/agentmail/webhook/route.ts` (agentmail.md §3.5).
   - Verify Svix on the raw body. svix 2.x `verify()` returns `undefined`, so `JSON.parse` the body yourself.
   - Insert `event_id` into Neon with `ON CONFLICT DO NOTHING` to dedupe.
   - Map `message.inbox_id` to its role: hello → Comms 2, data → Comms 1, outreach replies → Comms 2.
2. **Start the work.** Either call works inside AgentMail's 15 s ack window:
   - `naive.board.cards.create(COORD_AGT_ID, { title, body, assignee: "<agent name>" })` **without** `key`. The assignee starts in the same request and `woken_session_id` comes back in the response.
   - Or `naive.sessions.create({ agent_id, message, metadata: { request_id } })`. It returns `201` with `status: "queued"` and does not wait for the first turn (critic-verified, api/sessions.md).
3. **If you use a card `key`:** a keyed create is a "seed" left to the board clock, which sweeps once a minute, so the start can lag up to about 60 s (critic-verified, api/board.md + team/board.md). Keys are 1–128 chars, so use `am:` + `sha256(message_id)` truncated, never the raw Message-ID.
4. **Put the email text in the card body or session message** (≤20,000 chars), and include `inbox_id`, `message_id` and `thread_id` so the agent can reply. Don't let the agent read mail through a tool. Reading mail or contacts flags the chat; a flagged chat loses `bash`, and every send, MCP call and `board_write` then asks a human each time. That would park the unattended path (critic-verified, capabilities/tools.md "Once a chat has read people's data"). Whether MCP-tool reads count as "reading mail" isn't stated, so avoid the question.
5. **Loop guards are ours to build.** Naïve's native inbound guards (per-sender rates, auto-reply detection, a 10-turns-per-day cap) do not apply on this path (naive-orchestration.md §3.9).
6. **Local dev with no public URL:** use AgentMail polling webhooks or WebSockets (agentmail.md §3.6).

### 2.2 How a Naïve agent calls our own tools (every step from 2 on)

- **Mechanism.** The only supported way is an MCP server. Our Next.js route `src/app/api/mcp/route.ts` uses `mcp-handler@2.3.1` with `withMcpAuth` (web-and-providers.md §3.4).
  - On the agent: `mcp_servers: [{ name: "terragent", url: "https://<prod>.vercel.app/api/mcp" }]`, with no `type` field and no inline `Authorization` header. Naïve rejects secret headers inline (critic-verified, capabilities/tools.md).
  - Auth: `TERRAGENT_MCP_TOKEN` as a vault `static_bearer` whose `mcp_server_url` is that exact string. Creating it needs an `admin`-scope key.
- **Tool permissions.** Every tool must be listed in `tools.configs` as `"terragent.<tool>": { permission: "allow" }`, because MCP tools default to `ask`. Use `"ask"` only for `place_paid_order`. Tool names must not contain dots.
- **Telling agents apart.** A non-secret header such as `x-terragent-agent: sourcing` is allowed. Alternatively, bind one credential per agent with `agent_id`, though that makes the agent admin-only to edit.
- **What the gateway holds.** `DATABASE_URL`, `AGENTMAIL_API_KEY` and `MONID_API_KEY` stay in Vercel env. The vault cannot inject secrets into the sandbox or into REST calls: the `env_var` kind answers `501` (naive-orchestration.md §3.7).
- **Public URL needed.** It must be https on a public host; localhost and private IPs are refused. A connection failure doesn't error the session; it emits `session.degraded` (`mcp_server_unavailable`). **So agents can use our tools only after a public deploy.** See §2.11.

### 2.3 Agent → email out

Two options:
- **(a) AgentMail's own MCP**, `https://mcp.agentmail.to/mcp`. It accepts `Authorization: Bearer am_…` exactly as it accepts `x-api-key` (critic-verified with dummy keys: initialize 200, tools/list 54 tools, tools/call forwarded to the API). A vault `static_bearer` holding `AGENTMAIL_API_KEY` therefore works, provided Naïve sends it as `Authorization: Bearer` (unverified). Its `send_message` and `reply_to_message` take no idempotency key, so an agent retry can double-send.
- **(b) A gateway tool on our MCP**, e.g. `email_reply({ inbox_id, message_id, body_md, attachment_file_ids })`. It sets `Idempotency-Key`, checks the block list and daily caps, and appends the AI disclosure.

**Use (b) for every send that leaves the building, and (a) at most for reads.** Attachments:
- Reports come from Naïve Files: mint a 7-day URL with `files.url(id)` and pass it as an AgentMail `url` attachment (~30 MB).
- Or use `downloadBytes` and inline base64, but the whole request must stay ≤6 MB.
- Don't proxy the bytes through Vercel (4.5 MB body cap).

### 2.4 Agent → Monid

- **What doesn't work in Naïve today** (critic-verified, identity/vault.md):
  - Monid's MCP is OAuth 2.1 only.
  - Naïve's `mcp_oauth` stores a pre-obtained token and "There is no refresh".
  - Header injection for `api.monid.ai` is `env_var` → `501`.
  - A key passed into the sandbox CLI lands in the 30-day command history.
- **Do this:** expose gateway tools `monid_discover`, `monid_inspect` and `monid_run` on our MCP, with an allow-list of `provider+endpoint`, a max price per call and a spend ledger in Neon. Monid's `RunRequest` has no price cap.
- **Founder setting:** Aiden sets the workspace budget and run cap in the Monid dashboard (NOTES H3c).
- **Pitch:** this still reads as "the Sourcing agent pays for signals through Monid".

### 2.5 Agent → Neon and the Earth index

Agents never hold `DATABASE_URL`. They write in one of two ways:
- **(a) MCP tools**, such as `earth_index_write`, `log_decision`, `upsert_signal` and `update_request`. Our server validates H3 cells (`isValidCell`, lowercase) and writes.
- **(b) `structured_output`.** It arrives in the `session.idle` webhook as `data.structured_output`, and our webhook writes it.

Use (a) for anything the dashboard should show live, such as the decision log, funnel counts and playbook allocation. Store H3 as text at res 8 by default; the spec allows 7–9, and `h3_res` is stored with each row (database.md §3.11). Render res-4 to res-6 parents on the globe (web-and-providers.md §3.3).

### 2.6 Getting our Python pipeline into the Naïve computer (step 3)

**The pattern** (naive-compute.md §3.11):
1. Upload `pipeline-<ver>.tgz` to Files (≤25 MiB).
2. In the Analytics session, run `fetch_file`, then `tar` and `pip install` (fall back to a venv if pip is "externally managed"), then `python3 run.py … > result.json`.
3. Publish the PNGs with `publish_file`.
4. Return through `output_schema`.

Alternatively, our backend drives a standalone `computers.create({ vcpu: 2, memory_mb: 4096 })` box with `exec`/`fs`, which costs no LLM tokens.

**Constraints:**
- The agent's computer is 1 vCPU / 1 GiB.
- `bash` times out at 600 s at most.
- stdout is capped at 262,144 chars, so write JSON to a file.
- Outbound internet is open and inbound ports are closed.
- No secrets, which is fine because the Planetary Computer is anonymous (re-verified by the critic at ~23:00Z: an anonymous SAS token, 45-minute expiry).
- The 12 h computer lifetime is mostly transparent: files are restored from the newest archive, but writes since that archive can be lost. Keep the bootstrap idempotent (critic-verified, api/events.md).

**Unknown:** the Python version. There is indirect evidence that Python, package installs and ≥2 GB of disk exist (critic, capabilities/3d.md). rasterio 1.5 needs Python ≥3.12; older Python falls back to rasterio 1.4.4.

**First action at step 3:** run the probe in naive-compute.md §8.1.

**No-Python fallback:** the Planetary Computer data API (TiTiler). It returns cropped true-colour and NDVI PNGs in about 1.2 s and zonal statistics in about 0.8 s from a plain `fetch` on Vercel or in an MCP tool (imagery.md §3.8/§3.14). Expressions must handle the −1000 BOA offset.

### 2.7 Signal feeds on cron (step 6)

- Don't use `web_fetch`. It returns page text truncated at 4000 tokens by default and doesn't send POST bodies (critic-verified, capabilities/tools.md).
- Use a Naïve deployment (cron, `loose` window, one of the three loose models) whose prompt calls an MCP tool such as `signals_poll({ playbook })`. That tool fetches, normalises and upserts on Vercel within the 300 s limit, and returns a short summary.
- Alternative: `curl`/Python in the agent's computer, with the rows passed to an MCP write tool.
- Set `data_run` and every MCP tool to `allow`. A cron run parked on approval skips later fires.
- Set `timezone` explicitly; it defaults to the org's timezone.
- Check `schedule_status` right after the first `deployments.create`.

### 2.8 What the dashboard reads, all server-side with the Naïve key

| Panel | Source |
|---|---|
| Board | `board.cards.list(coordAgt)`. Page to the end, because cards are column-sorted before pagination, then call `board.get()` for counts. There is no board webhook, so poll every few seconds. |
| Orders waiting on a human | `sessions.list({ stop_reason: "awaiting_approval" })` → `pending_actions[]`, or `digest.get().waiting`. Approve with `sessions.confirmTool`. |
| Spend | `credits.spend({ session_id })` (needs `billing:read`). Per request, sum the request's sessions and add the Analytics computer ledger lines, because computer time is billed to the agent, never to a session. For card-woken sessions, map card → `woken_session_id`, since those sessions carry `metadata.board`, not our `request_id`. |
| Interventions | `auditLogs.list({ from })` rows with `actor.type: "user"`, plus `tool.confirm.resolved` events, plus our own Neon log. Use a separate Naïve key for the dashboard (NOTES H1d). |
| Decisions, funnel, playbook allocation, revenue | Our own Neon tables, written by MCP tools (§2.5). |

### 2.9 Verifier: outcomes vs the board

- Outcomes attach only to sessions whose agent has `handoffs: false` and no roster.
- They must be passed at `sessions.create` or `setOutcome`. Card-woken sessions are started by the board, so neither is possible for them (critic, naive-compute.md §3.5).
- The grader uses the same model with no tools and cannot see images.

So:
- **Inbound and demo path:** our backend creates the Brain 2 session with `outcome` and gates delivery on `"satisfied"`.
- **Overnight board path:** the Verifier is its own `pi` agent with a vision model, `view_image` and an `output_schema` verdict, on a card `blocked_by` Brain 2's card.

### 2.10 Paid orders held for approval (step 8)

- Put a `place_paid_order` MCP tool at `ask` on the Orchestrator (`pi` harness). The session parks in `awaiting_approval`; the dashboard lists it; a founder runs `confirmTool`, which is recorded as `tool.confirm.resolved` and in the audit log.
- Price comparison runs through the public SkyWatch MCP (`https://mcp.skywatch.com/mcp`, no account; initialize re-checked by the critic at ~23:00Z) plus UP42 docs prices. Arlula has no public prices: email hello@arlula.com.
- Naïve wallets and cards answer `501`, so nothing can be bought through Naïve anyway.

### 2.11 Build-order impact: a public URL is needed at step 2, not step 7

All three of these need a public https host:
- Naïve agents calling our MCP tools (§2.2)
- Naïve webhooks and deployment `on_idle`
- AgentMail push webhooks

Use the production domain: Vercel Deployment Protection walls preview URLs.

The spec puts deploy at step 7, and the first public deploy needs a founder's OK (§0). So either:
- **(a)** ask for that OK before step 2 and deploy a minimal app (MCP route + webhook routes) early; or
- **(b)** run steps 2–6 with a local worker that polls AgentMail (polling webhook) and Naïve (`sessions.get` and the event stream), with agents returning `structured_output` instead of calling tools.

(a) is much simpler.

### 2.12 Contact-form outreach (the NOTES.md decision)

Settings for the browser tool (critic-verified, computer/browser.md + capabilities/tools.md):

| Setting | Default | Use |
|---|---|---|
| `solve_captchas` | `true` | Set `false` explicitly. The team's rule is never to solve a CAPTCHA. |
| `stealth` | `false` | Keep `false`. |
| `allow_writes` | `false` | Set `true`. Without it, submitting a form is refused with `403`. |
| `ask_actions` | `["signup"]` | Keep. Creating an account on a third-party site pauses for a human. |

Cost: $0.10/h plus $0.01 per model-driven action. Never give the outreach agent inbound mail to read (§2.1.4).

## 3. Discrepancies with the master prompt (consolidated)

| # | Spec § | Spec says | Reality (verified) | Do this | Detail |
|---|---|---|---|---|---|
| 1 | 4.1 | SDK `@usenaive-sdk/vetta`, CLI `vetta-cli`, `VETTA_API_KEY` | Both deprecated on 2026-11-05. Use `@usenaive-sdk/managed-agents@0.12.3` (ESM, Node ≥20) and `@usenaive-sdk/cli@1.0.3` (bins `naive`, `vetta`). | Use the new names and the env var `NAIVE_API_KEY`. | naive-core D1–D2 |
| 2 | 4.1 | Budget fields come in "two styles" | Only `budget: { cap_micro_usd, max_task_micro_usd, period }`: integer micro-USD, all three required. | `5_000_000` = $5. Floats give `400`. | naive-core D3 |
| 3 | 1.1, 4.1 | Use `loose` overnight with cheap models | Only `zai-org/GLM-5.2-FP8`, `moonshotai/Kimi-K2.6` and `google/gemma-4-31B-it` serve `loose`/`priority`. Anything else gives `400 window_unavailable`. | Overnight agents use one of those three (NOTES). | naive-core D5 |
| 4 | 4.1, 14 | `claude_code` or the proxy may let us use our Claude key | Neither uses our key; both bill Naïve credits. Claude models are in the Naïve router (NOTES). | No Anthropic key needed. | naive-core D10 |
| 5 | 4.1 | Check `/v1/models` for vision | Models carry no modality flag. Vision works only through the `view_image` tool in a session; the proxy refuses image blocks. | Test `view_image` per candidate model. | naive-core D11 |
| 6 | 4.1 | Session "resume"; structured input | No `resume` method: send a message to an idle session, or `setBudget`/`confirmTool`. `message` is a string only. | Put JSON in `message` and ids in `metadata`. | naive-core D6–D7 |
| 7 | 4.1, 7 | The vault injects credentials at the network boundary; keep the AgentMail, Monid and Neon keys in it | Injection works **only into MCP connections** (`static_bearer`/`mcp_oauth`, exact-URL match). `env_var` answers `501`. | Vault the `TERRAGENT_MCP_TOKEN` and (optionally) `AGENTMAIL_API_KEY` for AgentMail's MCP. Keep Monid and Neon keys in Vercel env behind our MCP. | §2.2–2.4 |
| 8 | 7 | Connect AgentMail and Monid as MCP servers | AgentMail MCP accepts `Bearer am_…` (critic-verified). Monid MCP is OAuth only and Naïve can't refresh the token. | AgentMail MCP for reads only, if at all. Monid through our gateway. | §2.3–2.4 |
| 9 | 4.1 | Tools set to allow/ask/deny | `data_run`, `email.send`, every MCP tool and more ask by default, whatever the default policy. A cron run parked on `ask` skips later fires. | Set an explicit `allow` per tool on unattended agents. | naive-orchestration §3.6 |
| 10 | 4.1 | Webhooks `session.idle`, `message.completed`, `budget.exceeded` "and others" | Those are the only session events delivered. `tool.confirm`, `thread.*` and board changes are never delivered. | Poll board and approvals; push only for idle. | naive-orchestration §3.5 |
| 11 | 4.1 | Assigning a card starts the teammate | True, with limits: a keyed create waits up to about 60 s for the clock; one in-flight card per assignee per board; at most 3 wakes per card; the session runs on the assignee's own budget. | Use un-keyed creates on the demo path and budget every member. | §2.1 |
| 12 | 4.1, 14 | Inbound messages may not wake agents | The current docs agree that mail to Naïve identity inboxes does wake agents (a native inbox needs a verified domain). | Irrelevant: use AgentMail webhooks. | naive-orchestration §3.9 |
| 13 | 4.1 | SMS works from the API/CLI, not from agents; identities carry a wallet and cards | Outbound SMS, wallets and cards all answer `501 feature_not_configured`. | Plan no SMS. Paid orders are held as an `ask` tool or a Neon status. | naive-compute D6–D7 |
| 14 | 2 | Playbook skills define the data recipe | A skill is one `SKILL.md` text and is never executed. | Ship pipeline code separately (Files tarball). | naive-compute D3 |
| 15 | 3.1 | The Verifier uses Naïve outcomes and graders | Outcomes require `handoffs: false` and no roster, are attached at session create, use a grader with no tools and no images, and are revised by the same agent. | See §2.9. | naive-compute D4 |
| 16 | 3.1, 7 | Analytics runs in "the sandbox computer" | Each agent gets one auto-provisioned 1 vCPU / 1 GiB computer; you can't attach a chosen one. The Python version is unknown. | Use the §2.6 pattern, or a standalone box, or the TiTiler fallback. | naive-compute D2 |
| 17 | 1.1, 6 | `GET /v1/agents/{id}/spend` gives the cost per request | It covers the current period only, and computer time is never billed to a session. | Use `credits.spend({ session_id })` plus the computer ledger. | naive-compute D10 |
| 18 | 4.1 | Data domains include "property" | The enum value is `real_estate`. | — | naive-compute D5 |
| 19 | 4.1, 7 | Naïve apps or mini apps might host the dashboard | Mini apps are template-only; apps hosting is under-documented. | Host on Vercel. | naive-compute D8 |
| 20 | 4.2 | Inboxes `hello@`, `data@`, `outreach@` on the default domain | Usernames on `agentmail.to` are global. The actual inboxes are `terragent@`, `terragent-data@` and `terragent-outreach@agentmail.to` (NOTES H2b). | Read addresses from `AGENTMAIL_INBOX_*`. | agentmail #2 |
| 21 | 3.3, 8, 11 | Cold outreach from `outreach@` | AgentMail does not support cold outreach. A suspension is org-wide and would also stop `hello@` from sending. | NOTES decision: contact form, warm email, and direct email gated on written OK (H2f). | agentmail #1 |
| 22 | 11 | 50+ outbound reports plus replies | The Free plan allows 100/day across the whole org and 3,000/month, and may ramp new recipients 3/5/10. | Test the ramp immediately; Developer plan ($20) is a founder decision (H2c). | agentmail #3 |
| 23 | 8 | Opt-out link in every email | AgentMail has no built-in unsubscribe page or event. `List-Unsubscribe` is added automatically on the shared domain. | Build our own `/unsubscribe` page that writes `lists.create("send","block")`. | agentmail #7 |
| 24 | 4.2 | `pip install agentmail`; webhooks | Use TS `AgentMailClient` (`agentmail@0.5.53`); messages live under `inboxes.messages`. svix 2.x `verify()` returns void, and `parseOrThrow` is strict. | Use the route in agentmail.md §3.5. | agentmail #4–5 |
| 25 | 4.2 | Reply in thread with the report attached | Inline attachments are capped at 6 MB per request; `url` attachments go to about 30 MB. Reply has no `subject` field. | Pass a Files signed URL. | agentmail #6 |
| 26 | 4.3 | Agents call `discover`, then `run` | The flow is discover → **inspect** → run. Output schemas aren't published. | Inspect, cache the schema, and record one real output per endpoint. | monid #3 |
| 27 | 1.1 | Cap contact enrichment | There's no per-call max-price field. Workspace budgets and run caps can only be created in the dashboard. | Build our own allow-list and price cap; Aiden sets the caps (H3c). | monid #5 |
| 28 | 1.1 | Monid has $20 of credits | The wallet showed **$1.00**. The hackathon credit must be redeemed in the dashboard (NOTES H3b). | Aiden redeems it. | monid §5 |
| 29 | 3.1, 4.3 | Monid weather for cloud cover; maps for geocoding | No endpoint reports cloud cover. Geocoding wrappers exist but aren't tagged "verified". | Get cloud cover from STAC `eo:cloud_cover` and SCL. Geocode with Census (free, 0.45 s); use Monid for non-US places. | monid #7–8, signals #7 |
| 30 | 4.3 | B2B people search with verified emails | Apollo search costs $0 but returns no emails. Emails cost $0.0245–0.026 per lookup (Hunter, Apollo match). | Search free, then enrich the top 1–2 contacts. | monid #9 |
| 31 | 4.3 | Monid accepts new tool providers | Listing is a connector PR plus an email, reviewed by hand. It won't be live this weekend. | Draft the PR as a stretch goal. | monid #6 |
| 32 | 3.4, 14 | Check Neon for PostGIS and h3 | Supported on all plans: PG18 has postgis 3.6.4 and h3/h3_postgis 4.2.3. PGlite has no h3. | Compute H3 in app code and store it as text (already decided). | database #1 |
| 33 | 3.4 | "the `h3` library" | On npm the package is `h3-js`; npm `h3` is an unrelated HTTP framework. On PyPI it is `h3`. | — | database #2 |
| 34 | 1.1 | $250 of Neon credits | The Free plan is hard-capped: 100 CU-h/month, scale to zero after 5 min, and compute is suspended when the hours run out. How the credits apply is unknown. | Cap autoscaling at 0.25–1 CU; confirm the plan (H4). | database #3 |
| 35 | 5.1 | Planetary Computer or Copernicus | PC is fully anonymous (re-verified). CDSE downloads need an account (401) and use JP2 files. | Use PC only. | imagery §4 |
| 36 | 5.1, 5.3 | pystac plus planetary-computer; SCL | Works, but pystac 1.16 renames `proj:epsg` to `proj:code`, the −1000 BOA offset is not applied for processing baseline ≥04.00, and `eo:cloud_cover` is per tile. | Use the seed script's `epsg_of`/`boa_offset` and screen the AOI with SCL. | imagery §4 |
| 37 | 5.1 | USGS water and flood gauges | waterservices shuts down on 2027-02-22, and neither USGS API carries flood stages. | Use the NOAA NWPS and riv_gauges MapServer. | signals #1 |
| 38 | 5.1 | GFW "may need a key"; FIRMS; BLM MLRS; MRDS | GFW `/download/json` works without a key (re-verified ~23:00Z, 200 in 2.6 s). FIRMS 24h CSVs need no key. MLRS has no API; use the BLM Hub FeatureServer (`Created` date). MRDS hasn't been updated since 2011. | Use the keyless paths; keys are optional. | signals #2–5 |
| 39 | 5.1 | NWS alerts | 388 of 403 active alerts had no geometry. | Fetch and cache zone polygons. | signals #8 |
| 40 | 5.2 | Compare SkyWatch, UP42 and Arlula price lists | SkyWatch runs a public no-login MCP with live $/km². UP42 publishes prices in its docs; estimates need auth. Arlula pivoted and has no prices. | Give the Orchestrator the SkyWatch MCP. | web #4 |
| 41 | 5.2, 9 | Deliver only derived results | UP42's EULA: crops of paid imagery can't go to customers. | Paid-data reports carry maps and measurements, not pixels. | web #4 |
| 42 | 7 | Vercel's free subdomain is fine | Hobby is for non-commercial use, and taking payment on the site counts as commercial. Preview URLs are walled. | Keep the Stripe link in emails; use the production domain for webhooks. | web #4 |
| 43 | 3.4, 7 | Render H3 res 7–9 on the globe | Those cells are invisible from orbit. | Store at res 8; render res 4–6 parents. | web #4 |
| 44 | 10 | Deploy at step 7 | Agent tools and both webhook systems need a public URL from step 2. | Get the first-deploy OK early (§2.11). | critic |
| 45 | 4.1 | "Naïve's built-in web tools" for feeds | `web_fetch` truncates at 4000 tokens and is GET page text only. | Use the §2.7 pattern. | critic |
| 46 | 13 | A 60-second version for table judging | Table judging is a live demo of 2–4 minutes to a small panel; the top 8–10 teams demo again on the main stage (critic-verified, usenaive.ai/hackathon). | Rehearse a 2–4 minute live demo. | §6 |

**Contradictions between topic docs, now reconciled in place:**
- `VETTA_API_KEY` vs `NAIVE_API_KEY`: use `NAIVE_API_KEY`.
- AgentMail MCP auth: x-api-key vs "Bearer unverified". Bearer works (critic-verified).
- Monid "vault injects the REST header" vs vault `env_var` → 501: use the gateway.
- web-and-providers' inline `Authorization` header for Naïve vs Naïve rejecting it: use a vault `static_bearer`.
- database.md "DATABASE_URL in the Naïve vault": not possible.
- naive-core "12 h kills computer files" vs naive-compute "files persist": restored from the newest archive, with recent writes at risk.
- Outcome-graded sessions vs a board-driven pipeline: choose per path (§2.9).
- Earth-index storage at res 7 (web-and-providers table) vs res 8 (database.md): res 8.
- Monid CLI `credentials.json` vs `credentials.yaml`: `.yaml` (critic-verified in the CLI 0.1.9 bundle).
- naive-core "no Claude model documented": superseded by the NOTES live catalogue.

## 4. Credentials and accounts the founders must create

Status comes from `/NOTES.md` as of 2026-11-07. Step numbers follow spec §10.

| Env var / item | Service | Where | Who | Cost | Blocks | Status |
|---|---|---|---|---|---|---|
| `NAIVE_API_KEY` (key `main2`: admin, billing:write) | Naïve | dashboard, or `naive keys create` | Laurence | plan + $250 credits (balance $250.86) | 1 | **Done** (H1b). Keep for local provisioning only. |
| Narrower Naïve server key for Vercel (e.g. `NAIVE_SERVER_API_KEY`), no `admin` or `billing:write` | Naïve | `POST /v1/api_keys`. Scopes: `agents:read/write`, `sessions:read/write`, `files:read/write`, `computers:write`, `billing:read`, `audit:read`, `webhooks:*` | Laurence | free | first public deploy (step 2, see §2.11) | Open (H1d) |
| Separate dashboard key (optional) | Naïve | same | Laurence | free | 7 (intervention log attribution) | Open |
| `NAIVE_WEBHOOK_SECRET`, plus one per `on_idle` endpoint | Naïve | returned once by `webhooks.create` / `rotate` | builder script | free | 2 / 5 / 9 | Not created (needs a public URL) |
| `TERRAGENT_MCP_TOKEN` | our MCP | `openssl rand -hex 32`, then Vercel env plus a Naïve vault `static_bearer` on the exact MCP URL (vault writes need `admin`) | builder generates; Laurence writes it to the vault | free | 2 (first agent tool call) | Not created |
| `AGENTMAIL_API_KEY` | AgentMail | console | — | Free plan | 2 | **Done** (H2). Also: Vercel env, and optionally a vault `static_bearer` on `https://mcp.agentmail.to/mcp` (H2d; mechanism critic-verified). |
| `AGENTMAIL_WEBHOOK_SECRET` | AgentMail | `secret` returned by `webhooks.create`. For local dev, a polling `sub.token` instead. | builder script | free | 2 | Not created (needs a public URL) |
| `AGENTMAIL_INBOX_HELLO/DATA/OUTREACH` | config | — | — | — | — | **Done** (H2b) |
| AgentMail plan upgrade decision | AgentMail | console billing | AgentMail billing holder | $20/mo | 6 volume | Open (H2c) |
| Agent Armor toggle | AgentMail | console → Labs | anyone in the console | free | 2 | Open (H2e) |
| Written OK for direct cold email → `OUTREACH_DIRECT_EMAIL_APPROVED` | AgentMail sponsor | on site | whoever talks to sponsors | — | 6 (direct-email channel only) | Open (H2f) |
| `MONID_API_KEY` | Monid | app.monid.ai | — | — | 6 | **Done** (H3). Goes in Vercel env for the gateway, not the vault. |
| Redeem the $20 Monid credit | Monid | dashboard (codes other than the signup code are dashboard-only) | Aiden | — | 6 (at any volume) | Open (H3b): wallet shows $1.00 |
| Monid workspace budget and run cap | Monid | dashboard | Aiden | — | before agents get Monid access | Open (H3c) |
| `DATABASE_URL` (pooled), `DATABASE_URL_UNPOOLED` | Neon | console (create the project on **PG18**) or the Vercel Marketplace | anyone | Free / $250 credits; confirm which plan | 4 on prod; first deploy | Open (H4) |
| Vercel account and project | Vercel | vercel.com Hobby, linked to `lapark714` | Laurence | free (non-commercial ToS) | first public deploy, step 2 or 7 (§2.11) | Open (H7) |
| First public deploy approval | — | — | any founder | — | §2.11 | Ask before step 2 |
| First outbound email template approval | — | dashboard | any founder | — | 6 | Open (H8) |
| `NWS_USER_AGENT` (not a secret) | NWS | our string, with an ops contact | builder | free | 6 | — |
| `FIRMS_MAP_KEY` (optional) | NASA FIRMS | email form | anyone (1 min) | free | none (the 24h CSVs need no key) | Open (H5) |
| `GFW_API_KEY` (optional) | GFW | account → `/auth/apikey` with `domains` | anyone | free | none (`/download` needs no key) | Open (H6) |
| `USGS_WATERDATA_API_KEY`, `SOCRATA_APP_TOKEN` (optional) | api.data.gov, Socrata | signup pages | anyone | free | none | — |
| `PAYMENT_LINK_URL`; optionally `STRIPE_WEBHOOK_SECRET` | Stripe | Dashboard → Payment Links / Webhooks | Stripe account holder | Stripe fees | 4 (quotes show a link); auto paid-detection | Open (H9) |
| `notifications.email` on agents (optional) | Naïve | agent config | any founder's email | free | — | approval and question alerts overnight |
| `SKYWATCH_API_KEY` | SkyWatch | explore.skywatch.com | founder | free account; orders charged to a card | 8, only if a purchase is approved | Not needed: pricing uses the public MCP |
| UP42 / Arlula / Planet / CDSE accounts | — | — | — | — | — | Not needed this weekend; quote requests go by email from `data@` |
| `ANTHROPIC_API_KEY` | — | — | — | — | — | Not needed: Claude is served by the Naïve router |

## 5. Where each build step stands

| Step | Docs | What gates it |
|---|---|---|
| 1. Skeleton, Naïve client, one agent end to end | naive-core §3.8 | nothing (key done) |
| 2. AgentMail inboxes + webhook → Comms 2 | agentmail §3.5, §2.1 here | a public URL (H7 + deploy OK) or the polling fallback; webhook secrets |
| 3. Brain 1 + free-data Orchestrator + Analytics + Brain 2 | imagery §3.12, naive-compute §3.11, signals §3.9 | sandbox Python probe; the TiTiler fallback is ready |
| 4. Verifier, Pricing, Earth index | database §3.6–3.7, naive-compute §3.5, §2.9 here | H4 for prod; the outcome-vs-board choice |
| 5. Team, coordinator, board | naive-orchestration §3.1–3.3 | budgets on every member |
| 6. Signal engine + Monid + Comms 3 | signals, monid §3.11, §2.4/§2.7 here | H3b, H3c, H8, H2f; the gateway tools |
| 7. Dashboard + landing + deploy | web-and-providers §3.2–3.5, §2.8 here | H7, H1d |
| 8. Paid decisions, quote requests, held orders | web-and-providers §3.7, §2.10 here | first outbound email to vendors needs founder OK |
| 9. Monitoring cron, reallocation | naive-orchestration §3.4 | check `schedule_status` |

## 6. Answers to spec §14 open questions

1. **Claude and vision models; can our Claude key go through Naïve?**
   - Models (NOTES, live): `anthropic/claude-haiku-5.5`, `anthropic/claude-sonnet-5.5` and `anthropic/claude-opus-5.5` (plus `:batch` variants) are in the router. So is Fable.
   - Loose window: only the three models in §3 row 3 serve it, so Claude runs `immediate`.
   - Vision: candidates by name include `qwen/qwen3-vl-*` and `z-ai/glm-5v-turbo`. No modality flag exists, so confirm with a `view_image` test.
   - Our key: no. `claude_code` bills Naïve credits, and the proxy takes a Naïve key and Naïve catalogue ids. No bring-your-own-key option is documented. Not needed anyway. (naive-core §5)
2. **Does incoming email wake Naïve agents?** Yes, for Naïve identity inboxes; a native inbox needs a verified domain. Irrelevant to us: AgentMail webhook → our route → board card or session (§2.1).
3. **Neon PostGIS and h3 on our plan?**
   - Yes, on every plan including Free: PG18 has postgis/postgis_raster 3.6.4 and h3/h3_postgis 4.2.3. The h3-pg 4.2.3 functions are named `h3_latlng_to_cell`.
   - Not used: H3 is computed in app code and stored as text, so PGlite tests work. (database §5)
4. **Paid imagery prices and licences.**
   - VHR optical archive costs about $10–25/km² on SkyWatch: Vantor 30 cm $19, Pléiades Neo $22.50 with a 5 km² billable minimum, SkySat $10 with a 25 km² minimum. UP42 charges €6.80–18/km².
   - VHR tasking costs $12–35/km² with 25–100 km² minimums.
   - SAR costs about $190–414/km², or €285–845 per scene.
   - A live SkyWatch quote for a 1 km² archive AOI in Houston came to $12–25 across VHR products.
   - Licences (UP42 EULA): imagery is licensed, not sold; no resale; customers can't access our orders; only derivative products are usually shareable.
   - SkyWatch says "restrictions apply", with per-provider licences behind login. (web-and-providers §5)
5. **What does each sponsor count as "best use", and do they give credits?**
   - Naïve: the $250 is loaded (balance $250.86, NOTES). Its public criterion is "how much of the company runs without you".
   - AgentMail: publishes no criteria. It offers early-stage startups a free month of the Startup tier (application form).
   - Monid: every account starts with free credit (code `MONID-SIGNUP`); the hackathon $20 is redeemed in the dashboard. No published criteria.
   - Ask each sponsor on site.
6. **How long is the stage pitch, and how does table judging work?** (critic-verified, https://usenaive.ai/hackathon)
   - Judging is live demos of two to four minutes to a small panel, scored on how much of the company runs without you.
   - The top eight to ten teams demo again on the main stage, and winners are announced in the room.
   - Main-stage length isn't stated beyond that. The spec's 3–4 minute outline fits.
   - The 60-second "table" version is probably too short: tables are 2–4 minute demos.

## 7. Still unverified (needs a key)

Keys for Naïve, AgentMail and Monid already exist in `.env` (NOTES). The critic did not use them, by rule. The builder can run these checks; all are free reads unless marked, and they are ordered by build step.

1. **Naïve, step 1:**
   - `naive models list --window loose`, `naive models get anthropic/claude-sonnet-5.5`, and `curl -H "authorization: Bearer $NAIVE_API_KEY" https://api.vetta.sh/v1/harnesses` (check `runnable`).
   - `GET /v1/digest` to confirm the plan gate.
   - A `view_image` test session per candidate vision model (costs cents).
2. **Naïve sandbox, step 3:** the Python/pip/OS probe and the Planetary Computer egress check in naive-compute.md §8.1–8.2. Then run `python -I terragent_imagery.py 34.05 -118.25 …` inside the agent computer.
3. **Naïve → our MCP, step 2:**
   - Point a test agent at `/api/mcp` and log the request headers. This confirms that `static_bearer` arrives as `Authorization: Bearer`, the protocol version Naïve negotiates, and that it sends `Accept: application/json, text/event-stream` (mcp-handler v2 returns 406 without it).
   - Check `last_injected_at` on the vault credential after a session.
   - Confirm whether sending `mcp_servers[].type` returns 400 (don't send it).
4. **AgentMail with the real key, step 2:**
   - A `tools/call get_inbox` over `Authorization: Bearer $AGENTMAIL_API_KEY` succeeds.
   - Capture one real `message.received` payload (`from` string vs `from_`, extra keys).
   - Test the new-recipient ramp with 4 external addresses in hour 1.
   - Check whether the "Sent via AgentMail" footer is added to replies, and that `Idempotency-Key` works on reply.
5. **Naïve webhooks, step 2:** log a real `session.idle` envelope from a non-deployment session. Does it carry `agent_id`, `metadata` and `pending_actions`? Also check `message.completed` for `session_id`.
6. **Naïve board and team, step 5:**
   - `sessions.get(woken_session_id).agent_version` (roster pin vs current).
   - That a delegated member's `ask` is confirmed on the coordinator session.
   - That a session fed email text in its card body is **not** flagged as having read people's data (bash still works).
7. **Neon, step 4:** run `node scripts/migrate.ts` against the live database; query `pg_available_extensions`; compare driver type parsing with PGlite; find out which plan the $250 credits apply to.
8. **Outcomes, step 4:** the grader's verdict on a real report; confirm it can't see images.
9. **Monid, step 6:**
   - `POST /v1/inspect` for every endpoint we plan to use, and one real run each (costs cents).
   - Which endpoints return 202 (async).
   - Read `GET /v1/controls/workspace/budgets` and `/run-caps`.
   - Whether `https://mcp.monid.ai/v1` accepts `Authorization: Bearer $MONID_API_KEY` (curl in monid.md §8.4).
10. **Deployments, step 6/9:** `deployments.get` right after create → `schedule_status` should be `scheduled`, not `unscheduled`. Whether `@hourly`-style cron macros are accepted (assume not).
11. **Vercel, step 2/7:** that production `/api/mcp` and the webhook routes are reachable without Deployment Protection; that Fluid compute is on (300 s).
12. **Providers, step 8, no purchase:** SkyWatch licence text (needs a free account); UP42 `POST /v2/orders/estimate` (needs an account); Arlula pricing by email.

Re-verified live by the critic this pass, no key needed:
- AgentMail MCP bearer handling
- Planetary Computer anonymous SAS
- GFW keyless `/download/json` via `/latest` with redirects followed
- SkyWatch public MCP `initialize`
- the hackathon page's judging format

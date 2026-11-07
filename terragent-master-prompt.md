# Terragent — Master Build Prompt

You are helping three founders (Aiden, Aarush and Laurence) build **Terragent**, an agent-run Earth intelligence company, during a 22-hour hackathon. Your job is to help us ship an MVP that is **actually deployed, actually running on its own, and demo-able**, and that tries to get **real customers, or at least real replies and quotes**.

Read this whole document before writing code. Then read the platform docs linked below, because several APIs here are summarized from docs and **must be verified against the real SDKs before you rely on them.**

---

## 0. Working rules for you (the coding agent)

- **Verify, don't assume.** Before using any Naïve, AgentMail, Monid or Mobilerun API, check the current docs or SDK types. Where this document and the docs disagree, the docs win; tell us about the difference.
- **Humans do account creation and credentials.** Don't sign up for services or enter passwords or payment details. Tell us what account or key you need, and we'll create it and put the key in `.env` or the Naïve vault.
- **Ask before anything leaves the building for the first time:** the first real outbound email to someone outside the team and the first public deploy. **Always ask before spending any real money on data, every single time.** After we approve a flow (other than data purchases), the agents may run it on their own within the caps we set.
- **Naïve first.** Naïve is the main track, so build everything Naïve can do natively in Naïve: agents, team and board, skills, cron, webhooks, the sandbox computer, files, structured outputs, graders, policies, the vault, spend tracking. Use outside services only where section 1.1 says so.
- **Watch the credits.** Section 1.1 lists our budget. Set Naïve budgets on every agent and keep a running spend estimate in NOTES.md.
- **Prefer the smallest thing that works.** This is a 22-hour build. Time-box the geospatial work. Don't build anything listed as out of scope (section 12).
- **Keep a running `NOTES.md`** of decisions, open questions and anything we need to do by hand.
- **Never put secrets in code or git.** Use `.env` (gitignored) and the Naïve vault.

---

## 1. Hackathon context

- **Event:** Naïve Autonomous Company Hackathon at the YC office, San Francisco. Hacking runs from **Sat Nov 7, 1:00pm to Sun Nov 8, 11:00am**. Judging starts at 11am Sunday and final presentations are at 1pm.
- **Rule:** every team must build its company with the **Naïve SDK**.
- **What judges score, quoting the event page:** *"how much of the company runs without you."* At demo time teams show the company operating: what the agents actually delivered, what decisions they made, and where humans had to step in.
- **Main prizes:** 1st, 2nd and 3rd overall (1st includes a guaranteed YC interview). Categories: Most Autonomous Company, Most Likely to Become a Unicorn, Best Use of Naïve, People's Choice, Best Design.
- **Sponsor tracks we're targeting:** Best Use of **AgentMail**, Best Use of **Monid**, and possibly Best Use of **Mobilerun** (stretch goal).
- **Team and how we build:** three founders (Aiden, Aarush, Laurence), but **you (Claude Code, running on one machine) do essentially all of the building**, in this one codebase. Work through the build order in section 10 one step at a time, and get each step working end to end before moving on.
  - The founders handle the human side: creating accounts and API keys, approving first sends and deploys, testing, collecting real requests from attendees, talking to judges and sponsors, and preparing the pitch.
  - The other two founders may make small edits to the code. Keep the code simple and well organized, commit often with clear messages, and check `git status` before starting new work so you don't overwrite their changes.
  - When a step needs a person, say exactly what to do and who would be best placed to do it, then carry on with anything that doesn't depend on it.

### 1.1 Resources and budget
| Resource | Amount | Use it for |
|---|---|---|
| **Naïve credits** | $250 | All agents, sessions, cron jobs, the sandbox computer, and Naïve's built-in web and data tools. This is the main budget. |
| **Neon credits** | $250 | Postgres database: Earth index, requests, events, metrics, intervention log. |
| **Monid credits** | $20 | Business signals and contact lookup for the Sourcing agent (and the Monid track). Small, so cap it. |
| **Claude API key** | — | Only where Naïve can't do the job (see 4.1). Don't route agents around Naïve without asking us. |

- **Avoid buying paid imagery.** We could fund a purchase, but ideally we won't. Free public data is how we deliver, for demos and for prospects alike. When a job would need paid data, agents still make the full decision (compare providers, estimate cost from public price lists, send real quote requests where useful, prepare the order) and give the customer an estimate. The order stops at "awaiting approval." **Only buy when a real customer has agreed to pay and the answer truly needs paid data**, and only after a founder approves that specific purchase. This rule is for the weekend only; the real business buys through bulk contracts with providers (section 6).
- **No custom domain.** Use AgentMail's default addresses and a free hosting subdomain.
- **Suggested split of the $250 Naïve budget:** about $40 for building and testing, about $120 for the overnight run (signal engine on cheap models and the `loose` window), about $50 for inbound requests and the live demo, and about $40 as a buffer. Set per-agent caps to match, and check `GET /v1/agents/{id}/spend?by=component` regularly.
- **Monid's $20:** use it for signals and contact lookup where it's distinctive. Cap contact-enrichment calls, since verified email lookups may cost more than basic calls. Fall back to Naïve's own data tools if Monid credits run low.

---

## 2. The company

**Terragent is an agent-run Earth intelligence agency.** Agents turn questions about any place on Earth into answers. They choose the right data from many satellite and other providers, decide whether paying for data is worth it, buy it, analyze it and deliver the answer. They also **watch the world for events that create a need** (disasters, forest-loss alerts, permits, mining claims), work out who is affected, and send those businesses a free analysis of *their own* asset before anyone asks.

- **One-liner:** *"Ask about any place on Earth, or we'll come to you with the answer."*
- **The problem:** answers about the physical world (did this property flood, is this supplier's land deforested, is this mine expanding) are locked behind dozens of providers, accounts, minimum orders, licenses, analysts and site visits. They take days to weeks and cost hundreds to thousands of dollars.
- **Our value:** one request, answered in hours for a fraction of the cost. The agents choose the source, decide free vs. paid, buy, analyze and follow up, and they find customers themselves.
- **Why now:** earlier satellite analytics companies needed human analysts and enterprise sales, so only large contracts made sense. Agents make a single custom answer cheap enough to sell to anyone.
- **Honest positioning:** imagery marketplaces and aggregators already exist (SkyWatch, UP42, Arlula). Never claim nobody has done this. Say: *"The infrastructure exists. We're the first company that runs on it autonomously."*
- **Long-term vision (pitch only, nothing to build):** own the entire stack. **"We start in the cloud, move to the land, and end in space."** See section 3.5.

### Playbooks (markets): one engine, many playbooks
Each playbook is a **Naïve skill** defining its signals, target buyers, data recipe, report format, outreach message and price.

| Playbook | Signals | Buyers | Deliverable |
|---|---|---|---|
| **Disasters and property** | NWS alerts, hurricane tracks, USGS earthquakes and flood gauges, NASA FIRMS fires, FEMA declarations | Property managers, landlords, HOAs, lenders, small insurers (B2B outbound); homeowners through inbound only | Before/after damage check, flood and burn extent, property status |
| **Deforestation compliance** | Global Forest Watch forest-loss alerts, trade and import data, companies hiring compliance roles, EU deforestation regulation news | Importers of coffee, cocoa, palm oil, soy, wood, beef and rubber | Forest-loss check of supply regions or farm plots, with a compliance summary |
| **Mining** | New claims and exploration licenses, small miners announcing raises, drilling news, permits | Small miners, prospectors, investors, landowners, governments | Prospecting indicators, site monitoring (expansion, waste dams), illegal mining flags |
| **Inbound (anything)** | n/a | Anyone, including other AI agents through an API | A custom answer about any place |

---

## 3. Architecture

This comes from our whiteboard, plus fixes we agreed on afterward.

### 3.1 Agent roster (one Naïve team with a coordinator and a shared board)

| Agent | Role |
|---|---|
| **Coordinator** (team owner) | Owns the shared board and the state of every request. Assigns cards, enforces budgets, and **shifts outreach effort between playbooks based on results** (reply rate, cost per report, value). |
| **Comms Agent 2: Customer** | Owns the `hello@` inbox (AgentMail). Takes inbound requests from the portal or email, clarifies them, screens customers for misuse, sends quotes, receives confirmations, delivers answers in the same email thread with the report attached. |
| **Brain Agent 1: Planner** | Turns an abstract request into a concrete **data spec: area(s) of interest, time(s), resolution and sensor type, and analysis recipe.** Uses Monid (maps and places for geocoding, weather for cloud cover). **Checks the Earth index first** for existing results. |
| **Orchestrator: Acquisition** | Gets the data. **Always tries free sources first**, and justifies in writing whenever paid data would be needed (why free isn't enough). Compares providers on price, resolution, recency and clouds using public price lists and real quote requests, and returns price and preview availability to Pricing. After confirmation it fetches free data, or **prepares a paid order that stops at "awaiting approval"** (we only buy for a real paying customer, with founder approval). Talks to suppliers through Comms Agent 1. |
| **Comms Agent 1: Suppliers** | Owns the `data@` inbox (AgentMail). Requests quotes from imagery providers and ground or drone suppliers, one thread per order. |
| **Pricing Agent** | Quote = data cost + analysis cost (estimated by Analytics) + margin. Small quotes under a cap are auto-approved; larger ones need human approval. Produces a structured quote. |
| **Brain Agent 2: Interpreter** | Turns the data into an answer, calling the Analytics agent when heavy computation is needed. Writes the report: answer, source images, measurements, a **confidence level** and limitations. |
| **Analytics Agent** (only when needed) | Runs the imagery processing in the Naïve sandbox computer (Python). |
| **Verifier** | Grades every report against a checklist (Naïve outcomes and graders) before delivery and sends failures back to Brain 2. |
| **Sourcing Agent: Signal engine** | Cron-driven. Watches signal feeds, matches events to affected businesses (Monid for company, people and property data), scores prospects, and **sends each top prospect into the pipeline as a free sample request** (Brain 1 → Orchestrator → Brain 2 → Verifier) **before outreach**. |
| **Comms Agent 3: Outreach** | Owns the `outreach@` inbox (AgentMail, kept separate to protect the main address's reputation). Sends personalized messages with the free report, and follows up **when there's new information** ("a new clear image just came in"), not with "just checking in." Replies get routed to Comms Agent 2. |
| **Market researcher** | Builds a table of what today's alternatives cost (site visits, inspections, compliance checks) from public sources, with citations, for the pitch's demand slide. |

You may merge agents if it simplifies the build: Comms 2 and 3 can share logic, and Verifier and Pricing are candidates too. **Keep the planner/interpreter split, the free-vs-paid decision, and the signal engine feeding the pipeline.**

### 3.2 Inbound flow
Customer → portal form or email `hello@` → **Comms 2** → abstract request → **Brain 1** (data spec, Earth index check) → **Orchestrator** (free first, compare paid, preview and price) → **Pricing** (+ analysis cost) → quote → **Comms 2** → customer confirms and pays (or auto-approval under the cap) → purchase order → **Orchestrator** fetches free data (paid orders are prepared and held for approval) → data → **Brain 2** (+ Analytics) → **Verifier** → **Comms 2** delivers the answer → results saved to the **Earth index** → optional **monitoring** cron job.

### 3.3 Outbound flow (signal engine)
Signal feeds (cron) → **Sourcing** creates a signal card → matches affected businesses (Monid) → scores them (fit × urgency × ability to pay × reachability) → top prospects become **free sample requests** through the pipeline → **Verifier** → **Comms 3** sends a personalized email with the report → replies → **Comms 2** quotes and sells → monitoring and follow-ups → results feed the **Coordinator's** decisions about which playbooks get more effort.

### 3.4 Earth index (the moat)
- Grid the planet with **H3** (the `h3` library), at about resolution 7–9 depending on the use case.
- Store **derived results only** (measurements, scores, change flags, report references), keyed by cell, date, metric and source. **Never store or resell raw purchased imagery**, because licenses usually forbid it.
- Lives in **Neon Postgres**. Check whether Neon supports the PostGIS and h3 extensions; if not, compute H3 cells in application code and store cell IDs as text.
- Brain 1 checks it before fetching or buying anything. The dashboard globe renders it.

### 3.5 How Terragent scales (pitch only, except the registry below)
**More kinds of data open bigger markets.** Each new type of data opens higher-value buyers:
- high-resolution optical imagery,
- radar, which sees through clouds and at night and measures ground movement,
- thermal,
- especially **hyperspectral**, which identifies materials and minerals, crop stress and methane.

**Build implication:** adding a data type should be configuration, not new architecture. Keep a **provider and data-type registry** in Neon (provider, data type, resolution, revisit time, coverage, pricing model, license terms, how to access it), and make Brain 1's data spec name the data type. The Orchestrator chooses from the registry.

**Three stages: the cloud, then the land, then space.**
1. **The cloud (now):** request in, answer out. Buy data on demand at first, then move to bulk contracts with providers as demand grows. Run signal-driven outreach and sell monitoring subscriptions.
2. **The land:** analyze the Earth proactively without waiting for requests, find promising land and assets (mineral potential, upcoming development, undervalued property), and act on them: royalties and rights, compliant syndication of deals to investors, and eventually buying land ourselves. Investment decisions use only our own research, never customer requests.
3. **Space:** buy and operate our own satellites, starting with hosted payloads and the data types our demand shows are missing, so we own the supply too. Endgame: a vertically integrated, autonomous space agency that owns the whole stack.

---

## 4. Platform reference (verify everything against the docs)

### 4.1 Naïve (required)
- **Docs:** https://usenaive.ai/docs (index: https://usenaive.ai/docs/llms.txt). The API, SDK and CLI identifiers say **`vetta`**: `api.vetta.sh`, `@usenaive-sdk/vetta`, `@usenaive-sdk/vetta-cli`, and the `vetta` command (a `naive` command alias also exists). It's the same product.
- **Core objects:** Agent (versioned config: model, harness, system prompt, tools, MCP servers, skills, **required budget**, completion window, output schema), Session (one run; send input, stream output, interrupt, resume), Events (resumable stream keyed by sequence number), Computer (Linux micro-VM sandbox with shell, filesystem and optional browser), Skills, Files.
- **TypeScript quickstart shape:**
  ```ts
  import { createClient } from "@usenaive-sdk/vetta";
  const vetta = createClient({ baseUrl: "https://api.vetta.sh", apiKey: process.env.VETTA_API_KEY! });
  const agent = await vetta.agents.create({ name, model, system, budget: {...}, harness: "pi", skills: [...], window: "immediate" });
  const session = await vetta.sessions.create({ agent_id: agent.id, message: "..." });
  for await (const ev of vetta.stream(session.id)) { /* ... */ }
  ```
  **Budget field names appear in two styles in the docs** (`cap_micro_usd` / `max_task_micro_usd` vs. `capUsd` / `maxTaskUsd`). Check the SDK types.
- **Models:** the catalog is live (`GET /v1/models`). The docs' example is `z-ai/glm-5.3-flash`. Use cheap models for routine agents and stronger ones for Brain 1, Brain 2 and the Verifier.
- **Completion windows:** `immediate` / `priority` / `loose`: the same model at different prices. Use `loose` for overnight signal work.
- **Teams:** add a roster to the coordinator agent's config:
  ```ts
  await vetta.agents.update(coordinator.id, {
    expected_version: coordinator.current_version,
    multiagent: { type: "coordinator", agents: [{ type: "agent", id: "agt_…", version: 4 }, ...], board: true },
  });
  ```
  Two ways to coordinate: **delegation** (bounded work, answer comes back) and the **shared board** (cards; assigning a card starts the teammate). `send_to_agent` with `wait: false` is a handoff. Roster members are pinned to a version.
- **Deployments and cron:** `vetta deploy create --agent <id> --cron "<expr>" --budget-usd <n> --window loose --prompt "..." --on-idle <webhook>`.
- **Webhooks:** `session.idle`, `message.completed`, `budget.exceeded` and others.
- **Tools and policies:** built-in tools, connection tools and **MCP servers**, each set to allow / ask / deny. The **vault** injects credentials at the network boundary (live for MCP connectors), so agents never see raw keys.
- **Other useful pieces:** structured outputs (`output_schema`), outcomes and graders (rubric scoring), observability (per-session cost; `GET /v1/agents/{id}/spend?by=component`), digest API, audit logs, data tools (18 domains including companies, people, property, news, trade and jobs, priced per run), social data, web search and fetch, image generation, paid ads, CRM, files, mini apps.
- **Identity, wallet and cards:** identities can hold domains, email, phone and a vault, and can carry a spend-limited wallet and prepaid virtual cards. **We're not using a custom domain and ideally won't buy data**, so skip domains, and only set up a wallet or card if a founder approves a real purchase. Set up an approval policy for paid orders so the dashboard can show orders waiting on a human.
- **Models and the Claude API key:** prefer models served through Naïve's router, so cost tracking and observability stay inside Naïve (that matters for Best Use of Naïve). Check `GET /v1/models` for Claude models and for a vision-capable model that can read imagery. Check the harness docs: the `claude_code` harness or Naïve's Messages-format model proxy may let us use our Claude key. Use the Claude key directly only if Naïve lacks something we need, or to stretch credits, and tell us first.
- **Known caveats:** (1) **SMS can be sent from the API and CLI but not by an agent.** (2) One docs page says inbound messages **don't yet wake an agent** while another says they do. We use AgentMail webhooks for inbound email instead. (3) The isolate mode for computers is coming soon; use the default micro-VM.

### 4.2 AgentMail (all email goes through this)
- **Docs:** https://docs.agentmail.to/llms.txt, plus the onboarding guide at https://docs.agentmail.to/agent-onboarding.md. SDK: `pip install agentmail` (TypeScript also available), and there's an MCP server.
- **Basics:** `client.inboxes.create()`, send and receive messages, **threads**, attachments, **webhooks/events for incoming mail**, permissions per inbox, "pods" for separating workspaces.
- **Our use:** three inboxes on AgentMail's default domain (no custom domain), called `hello` (Comms 2, customers), `data` (Comms 1, suppliers) and `outreach` (Comms 3) in this doc. Incoming mail triggers a webhook that starts a Naïve session or creates a board card. Answers go back in the same thread with a PDF or HTML report attached.
- **Don't run Naïve identity email alongside it.** Use one email system.

### 4.3 Monid (tools for the Sourcing agent and Brain 1)
- **Site:** https://monid.ai. Setup: give an agent `set up https://monid.ai/SKILL.md`, or use the MCP server or CLI. Agents call `discover` to find and compare tools, then `run` them, paying per call from one balance with no per-tool signup.
- **Relevant tools (confirm in the catalog):** company news and business-event signals, company search and enrichment, B2B people search with verified emails, professional email finder, property listings and valuations, weather (forecasts and history), maps and places. **The catalog has no satellite or imagery tools.**
- **Pitch angle:** Monid does for tools what our Orchestrator does for Earth data. Terragent is the Earth intelligence tool every Monid agent is missing. Stretch goal: draft Terragent's answer API as a Monid tool (Monid is open source and accepts new tool providers).

### 4.4 Mobilerun (stretch goal only)
- **Site:** https://mobilerun.ai. Cloud Android phones (iPhones on request) that agents drive through REST, Python, TypeScript or MCP (`pip install mobilerun`). Optional receive-only phone number and inbox, configurable apparent location, live view. Outbound SMS is enterprise-only.
- **Only use if the core is stable:** ground-level dispatch. When satellites can't answer, an agent uses a local-services app on a phone set to the right city to request quotes from local drone pilots or photographers. **Caveats:** possible conflict with the app's terms; a human creates the app account; weekend replies are unlikely. Don't use it as an SMS intake channel (no way to reply).

---

## 5. Data sources and analysis

### 5.1 Free data (works without anyone answering an email)
- **Imagery:** Sentinel-2 (about 10 m, multispectral, revisit every few days) and Landsat (about 30 m), through the **Microsoft Planetary Computer STAC API** (`pystac-client` plus the `planetary-computer` signing package) or Copernicus. Sentinel-1 radar sees through clouds but is harder to interpret; use it only if needed.
- **Disasters:** NWS alerts (`api.weather.gov/alerts`), USGS earthquake feeds, USGS water and flood gauges, NASA FIRMS active fires, OpenFEMA disaster declarations.
- **Forests:** Global Forest Watch alert datasets (may need an API key).
- **Mining:** USGS mineral resource data (for example MRDS) and geologic maps; BLM mining claim records (MLRS).
- **Construction:** city building-permit open data portals (many cities use Socrata).

### 5.2 Paid data (estimate and quote; buy only when justified)
- **Default: don't buy.** Demos and prospect reports use free public data. When paid data would add value, the report says so and **gives an estimate** of what it would show and what it would cost, based on public price lists.
- Agents still do the real work: compare providers (candidates: **SkyWatch, UP42, Arlula**) on public price lists, minimum orders, delivery times and license terms, and **send real quote requests** from the `data` inbox when a specific job needs high resolution or new captures. Real supplier quotes are good evidence for the pitch.
- Each paid order is prepared in full and held at "awaiting approval." **Buy only if a real customer has agreed to pay and the answer genuinely requires paid data**, and only after a founder approves that specific purchase.
- Only ever deliver derived results (reports, measurements), never raw licensed imagery.

### 5.3 Analysis recipes (keep simple and established)
- Cloud masking (Sentinel-2's SCL band), and pick the most recent clear scene.
- **Vegetation:** NDVI. **Water and flooding:** NDWI or MNDWI, before vs. after. **Burn scars:** NBR and dNBR. **Forest loss:** NDVI drop plus GFW alerts. **Mining:** iron-oxide and clay band-ratio indicators (label clearly as indicators, never as "deposits").
- Every report includes before and after images, the measurements, a confidence level, the data sources with dates, and limitations (resolution, clouds).
- **Time-box the pipeline to about 4 hours.** The minimum version: location → latest clear image + a comparison image → one or two indices → report.

---

## 6. Business model and pricing
- **Per report:** cheap for answers from free data, higher when paid data is involved. **Monitoring subscriptions:** monthly per site. **API:** per request, for software products and AI agents.
- **Quote formula:** data cost + compute cost (from Naïve's spend tracking) + margin. Show real cost vs. price per request in the dashboard.
- **Supply contracts:** start with on-demand purchases, then move to **bulk or volume contracts with providers** (prepaid credits, volume pricing tiers, reseller agreements) as demand grows. Combining many customers' demand is what earns better prices and priority access, and it's a main margin lever.
- **Payment:** a payment link that a human sets up (Stripe Payment Links, for example). Free sample reports for outbound prospects.
- **Spending caps:** Naïve budgets on every agent and session. Paid data orders always wait for founder approval, and that waiting state appears on the dashboard. An approval counts in the intervention log only if a human actually acts on it.
- **Market size:** **never claim a $1T market.** Use bottom-up math per playbook (number of buyers × how often they need it × what they pay today), built from the market researcher's cited public prices.

---

## 7. Surfaces to build
1. **Landing page and portal:** what Terragent does, a request form (address or area, question, email), a link to `hello@`, an "AI-run company" disclosure, terms and an acceptable-use statement.
2. **Mission-control dashboard** (the demo screen and our Best Design entry):
   - **A globe** (globe.gl, deck.gl or Cesium; pick the fastest to ship) showing H3 cells colored by layer: disasters, forest, mining, inbound.
   - **Signal funnel:** signals detected → prospects matched → reports made → emails sent → replies → quotes → paid.
   - **A live board view** with each request's status and owner agent.
   - **A decision log:** source chosen, free vs. paid, and why.
   - **Spend vs. revenue** overall and per request.
   - **Intervention log:** every human action, with time and reason.
   - **Playbook allocation over time:** the coordinator's shifts in effort.
3. **A public API endpoint** (`POST /answer` with a location and question) for other agents. Secured with a key, rate-limited.

**Stack** (change it only if something is clearly faster):
- **Naïve:** all agents, the team and board, playbook skills, cron deployments, webhooks, imagery processing in the sandbox computer (Python), report files in Naïve Files, structured outputs, graders, spend tracking. Keep the AgentMail, Monid and Neon keys in the Naïve vault, and connect AgentMail and Monid as MCP servers where possible.
- **Neon Postgres:** Earth index, requests, events, metrics, intervention log.
- **Web:** Next.js for the landing page, dashboard and API, on a free hosting tier (Vercel's free subdomain is fine). If Naïve's apps or mini apps can host the dashboard cleanly, consider that for the Best Use of Naïve story, but don't fight it.
- Webhooks from Naïve and AgentMail keep the database current.

---

## 8. Outreach rules (signal engine)
- **Businesses for outbound; consumers through inbound only.** Don't scrape or cold-email individual homeowners. Use work contacts only.
- **Every outbound email** contains a real, specific analysis of *their* asset (an image plus one finding), a clear next step and price, the sender's identity, **disclosure that it's an AI**, and an opt-out link. Keep volume modest and personalization high, which also helps keep it out of spam.
- **After disasters, be helpful, not fear-based.** Only contact people when the imagery actually shows something. We are not insurance adjusters or contractors and don't act like them.
- **Comply with email law** (US CAN-SPAM; for EU recipients, B2B relevance and an easy opt-out).
- **Follow-ups bring new information** (new imagery, a change detected), not reminders.
- Track replies and conversions by playbook, signal type and message version. The coordinator reallocates effort, and the dashboard shows it.

---

## 9. Risk and safety rules (build them in)
- **Misuse screening:** Comms 2 screens requests and refuses stalking, surveillance of individuals, or targeting. Log refusals.
- **Licensing:** store and deliver only derived results from paid imagery.
- **No securities or investment features.** No token sales, no investment pages, no pledges, not even mockups.
- **Accuracy:** source images plus a confidence level on every report. The Verifier blocks weak reports. High-stakes uses get a "human review recommended" note.
- **Spending:** hard caps, approval above the threshold, a budget for each Naïve agent.

---

## 10. Definition of done for the MVP
1. A request submitted through the portal or `hello@` gets a quote and then a verified report back **without human help** (free-data path), and appears in the Earth index and on the globe.
2. At least one request where the Orchestrator **compares paid sources, sends a real quote request and prepares the order** (held for approval) with the reasoning logged, plus requests where it chose free data and explained why.
3. The signal engine runs on cron for **at least two playbooks** (disasters plus forests or mining) and produces matched prospects with free sample reports.
4. Outbound emails send from `outreach@` after we approve the template. Replies route to Comms 2.
5. At least one monitoring job re-checks a site on a schedule and follows up when something changes.
6. The coordinator shifts effort between playbooks based on measured results.
7. The dashboard shows the globe, funnel, board, decisions, spend vs. revenue and the intervention log, deployed at a public URL.
8. The market researcher produces a cited pricing table for today's alternatives.

**Build order:** (1) skeleton repo, env, Naïve client, one agent end to end → (2) AgentMail inboxes plus webhook → Comms 2 → (3) Brain 1 + free-data Orchestrator + Analytics + Brain 2 → report → (4) Verifier, Pricing, the Earth index → (5) team, coordinator and board wiring → (6) signal engine with Monid, plus Comms 3 → (7) dashboard and landing page, then deploy → (8) paid-data decisions, quote requests and held orders → (9) monitoring cron, effort reallocation → (10) stretch goals: Monid tool listing, Mobilerun dispatch. **Turn the agents on by Saturday evening** so there's an overnight record.

---

## 11. Weekend goals for the running company (aim high, report honestly)
- 15+ real inbound requests across 4+ types (from attendees, friends and family; judges live during the demo)
- A real recent event run through the signal engine, with 50+ personalized free reports sent to businesses
- Paid-data decisions with real supplier quote requests sent (orders held unless a paying customer justifies one), plus logged cases of choosing free data instead
- **Demonstrated demand is the goal, not completed transactions:** replies, requests for a full report, accepted quotes, stated willingness to pay, and inbound requests all count. Real paying customers are a bonus, not a requirement. Count everything honestly and never inflate it.
- Fewer than 10 logged human interventions

---

## 12. Out of scope (don't build)
Satellite operations or collision avoidance; a supplier marketplace; user logins or multi-tenant accounts; any investment, token or securities feature; outbound AI phone calls; native mobile apps; polish beyond the dashboard; a general GIS platform.

---

## 13. Demo and pitch (for when the build is done)
- **Live moment:** a judge gives an address, and within about 2 minutes Terragent returns a satellite report (free or archive data) while the board shows other work in progress. **Rehearse it until it can't fail; record a backup video.**
- **Pitch outline (about 3–4 minutes):** live start → problem → what we do (the one-liner plus the stack in one picture) → **proof** (the globe and funnel filling in overnight, numbers, one paid-vs-free decision, one failure the agents recovered from, one shift in playbook effort, the intervention log) → business (cost vs. price) → why now and moat (cheap answers, the signal engine, the compounding Earth index) → vision: more data types open bigger markets, then "the cloud, then the land, then space" → close with the judge's finished report. Also prepare a **60-second version** for judging tables.
- **Be honest about paid data:** "This weekend our agents priced and prepared N paid orders and got real supplier quotes. In the real business those orders run through volume contracts with providers. We haven't signed those yet, so we held the orders and delivered from free data."
- **Sponsors in context:** "Customers email Terragent through AgentMail; our sourcing agent pays for business signals through Monid."
- **Prepared answers:** who pays today, why earlier satellite analytics companies struggled, why not just use UP42, trusting AI reports, misuse, how much we stepped in, Zillow's failed home-buying program (for the land stage), securities compliance, why own satellites when buying data is cheaper (our demand data shows exactly which gaps to fill, and owning supply gives margin and priority access).

---

## 14. Open questions (put them in NOTES.md and confirm early)
- Which Claude models (and vision-capable models) does Naïve's router offer, and can our Claude API key be used through Naïve (the `claude_code` harness or the model proxy)?
- Does incoming email wake Naïve agents? (We use AgentMail webhooks regardless.)
- Does Neon support the PostGIS and h3 extensions on our plan?
- What do paid imagery providers charge, and on what license terms? (For quotes and the pitch, not purchases.)
- What does each sponsor count as "best use"? Do they give credits?
- How long is the stage pitch, and how does judging at tables work?

**Start by:** reading the Naïve, AgentMail and Monid docs, proposing a repo structure and a concrete plan for the first two build steps, and listing exactly which accounts and API keys you need from us.

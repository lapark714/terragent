<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-white.png">
    <img src="docs/assets/logo-ink.png" alt="Terragent" width="420">
  </picture>
</p>

# Terragent

**Ask about any place on Earth, or we'll come to you with the answer.**

An Earth intelligence company run by AI agents. Built at the Naïve Autonomous Company Hackathon at YC (November 7 to 8, 2026).

> **Demo video:** https://www.youtube.com/watch?v=qCh-7TWc7S0
>
> **Live:** https://terragent.vercel.app
>
> **Mission control:** https://terragent.vercel.app/dashboard

## The problem

Satellites photograph the whole planet every few days, and most of the world's physical questions could be answered from that data. Did this property flood? Is this supplier's land deforested? Is this mine expanding?

Those answers sit behind dozens of providers, accounts, minimum orders, licenses, analysts and site visits. One answer takes days to weeks and costs hundreds to thousands of dollars. Earlier satellite analytics companies needed human analysts and enterprise sales, so only large contracts ever made sense.

## The idea

Agents make a single custom answer cheap enough to sell to anyone.

Terragent turns a question about any place on Earth into a verified answer. Its agents choose the right data from free and commercial satellite sources, weigh whether paid data is worth it, price the job, run the analysis, check the result and deliver it.

It also works in the other direction. The agents watch the world for events that create a need, work out who is affected, and send those businesses an analysis of their own asset before anyone asks.

Imagery marketplaces such as SkyWatch, UP42 and Arlula already exist. They sell pixels to people who know what to do with them. Terragent sits on top of that layer and sells the answer.

## The company

Twelve agents work as one team on a shared board, each with its own budget, tools and job.

| Function | Agents | What they do |
|---|---|---|
| **Leadership** | Coordinator | Owns the board, unsticks work, and moves effort between markets based on measured results |
| **Customers** | Customer comms | Takes requests by portal, email or API, screens for misuse, sends quotes, delivers answers |
| **Thinking** | Planner, Interpreter | Turns a question into a data spec; turns measurements into a written answer |
| **Data** | Acquisition, Supplier comms, Analytics | Tries free sources first, compares paid providers, requests supplier quotes, runs the imagery pipeline |
| **Money** | Pricing | Builds one to three priced options for every job |
| **Quality** | Verifier | Grades every report and sends weak ones back |
| **Growth** | Sourcing, Outreach, Market researcher | Finds customers, reaches out, and tracks what today's alternatives cost |

```
 portal / email / API ──────────▶ screen → plan → compare data → quote
                                                                    │
 public feeds ─▶ sourcing ─▶ free analysis ─┐              customer accepts
                                            ▼                       ▼
                                  analyze → write report → verify or revise
                                            │                       │
                         outreach ◀─────────┘                   delivered
                                                                    │
                                                              Earth index
```

Agents hold no database, email or data-provider keys. They work through 56 narrow tools on our own MCP gateway, each agent with its own token, so prices, send limits and access rules are enforced by server code that a confused model can't talk its way past.

## The sourcing engine

The sourcing engine is how Terragent finds demand. It runs on a schedule, sweeping each market every hour:

1. **Watch.** It polls public feeds for events a satellite can see.
2. **Filter.** It keeps events whose effect shows up at 10 m resolution, such as flood extent, burn scars, forest loss and mine expansion.
3. **Match.** It finds the businesses with assets inside or next to the event, using Naïve's data tools, Monid and web search.
4. **Score.** It ranks each prospect on fit, urgency, ability to pay and reachability, and confirms there is a real way to contact them.
5. **Prove.** The best prospects go through the full analysis pipeline as free samples, so the first thing a business sees is a verified finding about its own asset.

| Market | Signals | Buyers |
|---|---|---|
| **Disasters and property** | NWS alerts, NOAA river gauges, NASA FIRMS fires, USGS earthquakes, FEMA declarations | Property managers, landlords, HOAs, lenders, small insurers |
| **Deforestation compliance** | Global Forest Watch alerts, NASA FIRMS | Importers of coffee, cocoa, palm oil, soy, wood, beef and rubber |
| **Mining** | BLM claims, USGS mineral data, company news through Monid | Small miners, prospectors, landowners, governments |

Each market is a playbook: a Naïve skill that defines its signals, buyers, data recipe, report format, message and price. One engine runs them all, and the coordinator shifts effort toward whichever market responds.

## Cold outreach

Naïve agents do their own outreach. Once a free analysis passes verification, the outreach agent decides whether the imagery shows something that matters to that business, writes one specific message, and sends it through one of two channels:

- **Email from a Naïve inbox.** The agent's Naïve identity sends cold email. AgentMail doesn't allow cold outreach and Naïve does, so each platform handles the traffic it permits.
- **The business's own contact form.** The agent opens the website in Naïve's sandbox browser, fills in the form as Terragent, and submits it once.

Every message carries the finding, a clear next step, an AI disclosure and an opt-out. Outreach goes to businesses only, once per business, and a follow-up goes out only when a later clear image shows a change over the threshold. Replies flow back to the customer agent, and reply rates by market feed the coordinator's decisions.

## Tech stack

### Sponsors

**[Naïve](https://usenaive.ai)** is the operating system of the company.

- All twelve agents, plus the team and shared board that coordinate them
- Scheduled deployments for sourcing, reviews, monitoring, follow-ups and research
- Playbook skills for each market
- A sandbox computer that runs the Python imagery pipeline
- The browser tool for contact forms and identity inboxes for cold email
- Data tools for company, property, trade and news lookups
- Per-agent budgets, spend tracking and a model router serving Claude Sonnet 5.5, Claude Haiku 5.5 and GLM-5.2

**[AgentMail](https://agentmail.to)** handles customer and supplier conversations.

- A customer inbox, where requests, quotes and delivered reports share one thread
- A supplier inbox for quote requests to imagery providers, one thread per order
- Webhooks that turn each incoming email into agent work
- Agent Armor, which scans inbound mail for prompt injection

**[Monid](https://monid.ai)** gives the sourcing agent its business intelligence.

- Company news and business-event signals
- Company and contact lookup for matching events to the right people
- Pay-per-call access, with allowlists and spending caps in our gateway

### Everything else

| Layer | What we use |
|---|---|
| Web and dashboard | Next.js 16, React 19, TypeScript, Tailwind 4, react-globe.gl, Three.js, on Vercel |
| Agent tools | MCP gateway built on `mcp-handler`, Zod contracts for every hand-off |
| Database | Neon Postgres in production, PGlite locally |
| Earth index | H3 hexagonal grid, computed with `h3-js` and stored in Postgres |
| Imagery pipeline | Python, NumPy, rasterio, Pillow |
| Free imagery | Sentinel-2 and Landsat through Microsoft Planetary Computer |
| Commercial imagery | Registry of 15 paid sources, with live pricing from SkyWatch's MCP server |
| Signal feeds | NWS, NOAA NWPS, NASA FIRMS, USGS, OpenFEMA, Global Forest Watch, BLM |
| Film | Remotion |

## Run it

Terragent needs no accounts to look around: the local mode uses an in-process database with demo data and calls no
outside service.

```bash
npm install
npm run dev:local        # http://localhost:3000, with seeded requests, reports and a dashboard
```

Checks:

```bash
npm run typecheck && npm test && npm run lint
npm run test:pipeline    # the Python imagery pipeline (creates pipeline/.venv)
```

Running it for real needs Naïve, AgentMail, Neon and Vercel credentials; `.env.example` lists every variable and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how the pieces fit.

## The potential

The framework already runs one engine across several markets. Each step below extends it without changing its shape.

- **Answers at software margins.** A report costs about $1.50 in agent time and starts at $29, against the hundreds to thousands of dollars a site visit, inspection or analyst charges today.
- **Any market is a playbook away.** Insurance, agriculture, construction, carbon, supply chains and infrastructure all ask the same kind of question. A new market needs signals, buyers and a recipe.
- **More data opens bigger buyers.** Radar sees through clouds and at night. Thermal and hyperspectral identify materials, crop stress and methane. These sources already sit in our provider registry, so adding one is configuration.
- **A compounding asset.** Every analysis adds derived measurements to the Earth index, keyed by place, date and metric. Each answer makes the next one cheaper, and over time the index becomes a record of how the planet is changing.
- **Recurring revenue.** One report becomes a monitoring subscription that re-checks a site and reports when something changes.
- **Agents as customers.** The public API lets software and other AI agents buy answers about the physical world. Monid does for tools what our acquisition agent does for Earth data, and Terragent is the Earth intelligence tool those agents are missing.
- **Better supply economics.** Pooling many customers' demand earns volume pricing and priority access from imagery providers.

The long-term path has three stages:

1. **The cloud.** Answers on demand, then monitoring and signal-driven sales.
2. **The land.** Analyze the Earth proactively, without waiting for a request, to find promising land and assets.
3. **Space.** Our own satellites, starting with hosted payloads and aimed at the exact data gaps our demand reveals.

## Team

Aiden, Aarush, Laurence.

## Learn more

[Product spec](terragent-master-prompt.md) · [Architecture](docs/ARCHITECTURE.md) · [Build notes](NOTES.md) · [Verified platform reference](docs/platform/README.md)

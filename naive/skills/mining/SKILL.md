---
name: playbook-mining
description: Mining playbook - new-claim and news signals, mining buyers, the indicator and change recipes, indicator-only report format, outreach message and price.
---
# Mining

Small miners, prospectors and the people around them need to watch sites: is a pit expanding, has a tailings pond changed,
does the surface show alteration minerals. This playbook delivers indicators and change, never resource claims.

## Signals (feeds behind terragent.poll_signals, playbook "mining")

| Feed | What it gives | Act on |
|---|---|---|
| `blm_claims` (BLM MLRS mining claims, free, refreshed daily) | blocks of new US claims staked in the last days: claim count, acres, name, state, case numbers, outline | big new blocks (25+ claims = a funded explorer). The claimant is not in the feed: look a case number up at mlrs.blm.gov, then find the company |
| `mrds` (USGS Mineral Resources Data System) | known deposits and occurrences (historic, not updated since 2011) | context only: what is known near a site. It answers region queries only, so a plain poll returns a warning for it, not signals |
| `news` (PAID: Monid news, about $0.01 per poll) | junior miners announcing raises, drilling results, permits, expansions, tailings incidents | the company and site named. poll_signals includes it by default; pass allow_paid:false to keep a sweep free |

Forest-loss alerts near mining regions (e.g. Amazon gold) come from the deforestation playbook's `gfw` feed:
terragent.list_signals({ feed: "gfw" }) if you want them as context for possible illegal mining expansion.

## Buyers (business-to-business only)

- Junior miners and explorers (site monitoring, reconnaissance indicators on nearby ground).
- Prospectors and claim holders.
- Royalty and streaming companies tracking operators' sites.
- Landowners, ranches and municipalities next to active mines (expansion, water).
- NGOs and government offices monitoring illegal mining (inbound).
- Operators that must watch tailings dams and waste dumps.

Scoring hints: fit = an identifiable site we can outline; urgency = news or claims in the last 30 days; ability to pay =
funded company; reach = a public investor-relations or operations contact.

## Data recipe

- Recipe `mining_indicators`: iron-oxide ratio (Red/Blue, B04/B02) and clay/hydroxyl ratio (SWIR1/SWIR2, B11/B12, 20 m).
- Recipe `change_detection` for pit, dump or pond expansion between dates.
- Windows: before = the same season one year earlier (or before the news event), after = the most recent clear window.
  Use dry-season, low-vegetation scenes when possible.
- AOI: the site or claim block, 1-10 km².

## Report format

- Answer first: "Between <dates> the disturbed area at <site> grew by about X ha" or "surface iron-oxide and clay indicators
  are elevated over <area>".
- Measurements: indicator ratios (mean, and area above threshold), change area, pond/water area change.
- Images: before, after, indicator or change map, dated.
- Language: ALWAYS "indicators" (iron-oxide indicator, clay/alteration indicator). NEVER deposits, reserves, resources, ore,
  grade or discovery. Band ratios show surface minerals, not what is underground.
- Limitations: 10-20 m resolution, vegetation and moisture mask the surface, ratios also respond to soils and rock types.
  Recommend human review (a geologist) before any decision.
- Never comment on share prices, investment merit or securities. We sell imagery analysis, not investment advice.

## Outreach message (comms-outreach; always the founder-approved template)

> Subject: Satellite change check for <site name>
>
> Hi <name>, Terragent's automated analysis of Sentinel-2 imagery shows <one concrete finding, e.g. "the disturbed area at
> <site> grew by about 14 ha between March and October">. The before/after map is here: <link>. We can monitor the site
> monthly or check neighbouring ground for surface indicators (<price>). This message was written by an AI agent at
> Terragent, an AI-run company. Reply to reach us; opt out: <link>.

## Price

- Quote = data + analysis cost + margin (pricing agent). Site change or indicator check from free data: from $49 per site.
- Monitoring (expansion, tailings ponds; monthly): $49 per site per month.
- High-resolution or hyperspectral data: pass-through cost + margin, quoted and held for founder approval.

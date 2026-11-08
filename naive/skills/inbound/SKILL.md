---
name: playbook-inbound
description: Inbound playbook - any question about any place from the portal, email or API; screening, recipe choice, the standard report format and price.
---
# Inbound (anything)

Anyone (a person, a business, or another AI agent through the API) can ask about any place on Earth. This playbook
covers requests that do not come from our signal engine.

## Signals

None: requests arrive through the portal, hello@ email or `POST /answer`. Free samples from the other playbooks use their
own skill.

## Who asks

- Homeowners and small businesses about their own property ("did my street flood?", "is there construction next door?").
- Farmers and land managers (crop and pasture condition, water).
- Journalists, researchers and NGOs (change at a named place).
- Software products and AI agents through the API (they want short, structured answers).

Screen every request first (comms-customer): refuse surveillance or tracking of individuals, stalking, targeting, weapons
and illegal activity. Asking about your own property, a business site, land, water, forest or a public place is fine.

## Data recipe (planner)

| Question | Recipe |
|---|---|
| Flooding, standing water, reservoir level | `flood_extent` |
| Fire, burn scar | `burn_severity` |
| Tree loss, clearing | `forest_loss` |
| Crops, vegetation, drought | `vegetation_health` |
| Mine, quarry, surface minerals | `mining_indicators` |
| Construction, any other change | `change_detection` |
| "What does it look like now?" | `true_color` |

- Always check the Earth index first (earth_index_lookup); reuse a recent result when it answers the question.
- Free Sentinel-2 (10 m) answers most questions. Questions needing sub-metre detail (cars, roofs, people) need paid data:
  say so, estimate it, and never buy without a founder.
- AOI: just big enough for the question; max 100 km² from free data without asking.

## Report format

- Answer first, in 2-6 plain sentences, directly answering the question asked.
- Measurements with units and before/after values; images (before, after, index/change) with dates and captions.
- Confidence (high/medium/low) with the reason; sources with collection, scene id and date; limitations.
- Human review recommended for insurance, legal, lending, safety and regulatory uses.
- API answers: keep the answer to 1-3 sentences; the structured fields carry the rest.

## Price

- Quote = data + analysis cost + margin (pricing agent); a free-data report is never below $29.
- Quotes at or under $50 are auto-approved; above that a founder approves.
- API: $9 per request. Monitoring: $49 per site per month.
- Paid data: pass-through cost + margin, prepared and held for founder approval; deliver only derived results.

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
- Free Sentinel-2 (10 m) data answers most questions. Questions needing sub-metre detail (cars, roofs, people) need paid
  data: offer it as a quote option; it is bought (by a founder) only after the customer accepts that option.
- AOI: just big enough for the question; max 100 km² from free data without asking.

## Report format

- Answer first, in 2-6 plain sentences, directly answering the question asked.
- Measurements with units and before/after values; images (before, after, index/change) with dates and captions.
- Confidence (high/medium/low) with the reason; sources with collection, scene id and date; limitations.
- Human review recommended for insurance, legal, lending, safety and regulatory uses.
- API answers: keep the answer to 1-3 sentences; the structured fields carry the rest.

## Price

- Only the investigation (planning and comparing sources) is free; its output is the quote. Every answer is paid.
- The quote offers 1-3 options, priced per job by the server (terragent.price_options: data + analysis + risk buffer + margin);
  the pricing agent writes labels and notes, never prices. The cheapest option is never below $29.
- Nothing runs until the customer accepts one option (a reply naming A/B/C, a plain "yes" for the recommended one, or the
  accept link). Paid data is bought by a founder only after that acceptance; reports carry only derived results from it.
- Recommend the cheapest option that answers the question; when free data can't (resolution, clouds, no recent scene),
  recommend the paid option and say why.
- Typical options: A = answer from free 10 m Sentinel-2 data (one image of one place is the cheapest job); B = sub-metre archive when the
  question needs detail (cars, roofs, single buildings); C = new capture (tasking) when it must show today or the archive
  is missing or cloudy. More dates, more data types and larger areas cost more; an unknown supplier price is quoted as a range.
- API requests are quoted like any other request (from $29). The client sees the options in its status response and
  accepts one there (POST /api/quotes/accept); nothing runs before that.
- Monitoring: $49 per site per month, a separate subscription. create_monitor only after the customer accepted that monthly
  price, with their words as evidence.

---
name: playbook-deforestation
description: Deforestation compliance playbook - forest-loss signals, importer buyers, the forest-loss recipe, compliance report format, outreach message and price.
---
# Deforestation compliance

Importers of forest-risk commodities must show their supply regions and farm plots were not deforested. This
playbook checks a supplier's land for tree-cover loss and writes a plain compliance summary.

## Signals (feeds behind terragent.poll_signals, playbook "deforestation")

| Feed | What it gives | Act on |
|---|---|---|
| `gfw` (Global Forest Watch integrated alerts: GLAD-L, GLAD-S2, RADD) | recent tree-cover-loss alerts with confidence, one signal per clearing front | high-confidence clusters in the watched commodity regions (Rondônia, Pará, Mato Grosso, Paraguayan Chaco, Riau, West Kalimantan, western Côte d'Ivoire, western Ghana) |
| `firms` (NASA FIRMS VIIRS, same regions) | active fires in those forest regions | fire clusters on or next to forest: clearing by burning, often ahead of GFW alerts |
| Not feeds: Naïve data tools (trade, jobs, companies, news), web_search | customs import records, companies hiring EUDR / sustainability compliance roles, EUDR enforcement news | importers of the seven commodities, companies or regions named |

The seven EUDR commodities: cattle (beef, leather), cocoa, coffee, oil palm, rubber, soya, wood. The EUDR cut-off
date is 31 December 2020: land deforested after it cannot supply the EU market.

## Buyers (business-to-business only)

- Small and mid-size importers, traders and processors of the seven commodities (coffee roasters, chocolate makers,
  timber and furniture importers, rubber and palm-oil traders), especially those selling into the EU.
- Producer cooperatives and exporters who must give buyers evidence about their plots.
- Sustainability and compliance managers at those companies (the person hiring for EUDR is the right contact).

Scoring hints: fit = imports a covered commodity from a region with fresh alerts; urgency = alerts in the last 30 days or
a recent compliance hire; ability to pay = regular import volume; reach = a public compliance/sustainability contact.

## Data recipe

- Recipe `forest_loss`: NDVI drop between windows plus GFW alerts inside the AOI.
- For EUDR questions: before = a dry-season window around the cut-off (e.g. 2020-10-01 to 2021-01-31; Sentinel-2 L2A covers
  it), after = the most recent clear dry-season window. For a fresh alert: before = same season a year earlier.
- AOI: the plot or supply area, 1-25 km² for plots, larger only for a region summary. Tropics are cloudy: allow wide windows
  (60-120 days) rather than raising the cloud limit above 30 %.

## Report format

- Answer first: "Within <plot/region>, imagery shows <no detectable / about X ha of> tree-cover loss between <before date>
  and <after date>" and whether it falls after the 31 Dec 2020 cut-off.
- Measurements: area with NDVI drop past the threshold (ha and % of AOI), mean NDVI before/after, count of GFW alerts.
- Images: before, after and the NDVI-change map, dated.
- Compliance summary: one short paragraph a compliance manager can file: what was checked, dates, sources, result.
- Limitations: 10 m resolution (small clearings under about 0.1 ha can be missed), clouds, plantation harvest vs natural
  forest is not distinguished, plot boundaries as given by the customer. This is evidence for due diligence, not a legal
  determination: always recommend human review for compliance filings.

## Outreach message (comms-outreach; always the founder-approved template)

> Subject: Forest-loss check for your <commodity> supply region <region>
>
> Hi <name>, Terragent's automated analysis found <one concrete finding, e.g. "about 12 ha of new tree-cover loss near
> <place> since March, flagged by GFW and confirmed in Sentinel-2 imagery"> in a region your <commodity> imports come from.
> The before/after map is here: <link>. We can check your specific supplier plots against the 31 Dec 2020 cut-off
> (<price>). This message was written by an AI agent at Terragent, an AI-run company. Reply to reach us; opt out: <link>.

No accusations: we describe what the imagery shows, never who is at fault.

## Price

- Only the investigation (planning and comparing sources) is free; its output is the quote. Every answer is paid.
- The quote offers 1-3 options, priced per job by the server (terragent.price_options: data + analysis + risk buffer + margin);
  the pricing agent writes labels and notes, never prices. The cheapest option is never below $29.
- Nothing runs until the customer accepts one option (a reply naming A/B/C, a plain "yes" for the recommended one, or the
  accept link). Paid data is bought by a founder only after that acceptance; reports carry only derived results from it.
- Recommend the cheapest option that answers the question; when free data can't (resolution, clouds, no recent scene),
  recommend the paid option and say why.
- Typical options: A = check of a plot or supply region against the cut-off from free 10 m data (two dates; from $29);
  B = sub-metre archive when clearings under about 0.1 ha matter; a multi-year time series (more dates) or a large region
  (more compute) costs more.
- Batch of supplier plots: one quote for the batch, priced per job.
- Monitoring (re-check plots each month and alert on new loss): $49 per site per month.

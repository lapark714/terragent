---
name: playbook-disasters
description: Disasters & property playbook - which flood/fire/storm signals to act on, who buys, the data recipe, report format, outreach message and price.
---
# Disasters and property

One engine, many playbooks. This one turns a flood, fire or storm into a before/after check of a specific
property, for the business that owns or insures it.

## Signals (feeds behind terragent.poll_signals, playbook "disasters")

| Feed | What it gives | Act on |
|---|---|---|
| `nws` (api.weather.gov alerts) | Flood Warning, Flash Flood Warning, Hurricane/Storm Surge Warning, polygons via affected zones | Severity Severe/Extreme, status Actual, land areas |
| `nwps_flood` (NOAA river gauges) | gauges at minor/moderate/major flood stage, with impact text | moderate or major; read the impact text for which streets/areas flood |
| `firms` (NASA FIRMS VIIRS, 24 h) | active-fire detections | clusters of several detections near built-up or farmed land |
| `openfema` | disaster declarations by county | context: confirms a serious event, names counties |
| `usgs_quake` | significant earthquakes | only M6+ near settlements; damage is mostly NOT visible at 10 m, so low priority |

There is no news feed for this playbook. To confirm a flood's or fire's extent and dates from local reports, use
web_search or the Naïve data tools (data_search / data_run, category news) once a signal is worth keeping.

Keep a signal only if its effect is visible to Sentinel-2 at 10 m: flood water extent, burn scars, large debris
fields or landslides. Wind damage to individual roofs is not visible; skip those.

## Buyers (business-to-business only)

- Property managers and multifamily owners with buildings in the footprint (portfolio managers love a quick status).
- HOAs and commercial landlords (warehouses, retail centres, offices).
- Small lenders and credit unions holding property collateral in the area.
- Small insurers, MGAs and claims teams that need a fast first look before adjusters arrive.
- Farms, ranches, golf courses, campgrounds and other land-heavy businesses.

Homeowners are served only when they come to us (inbound). Never prospect individuals. Work contacts only.

Scoring hints: fit = asset clearly inside the footprint; urgency = event within the last 7 days and still active;
ability to pay = a business with several sites or a lender/insurer; reach = a public business contact page or work email.

## Data recipe

- Flooding: recipe `flood_extent` (NDWI/MNDWI before vs after; "new water" = MNDWI after > 0 and before <= 0).
- Fire: recipe `burn_severity` (NBR, dNBR classes: < 0.1 unburned, 0.1-0.27 low, 0.27-0.44 moderate-low, 0.44-0.66 moderate-high, >= 0.66 high).
- Other visible change: recipe `change_detection`.
- Windows: before = the 30 days ending the day before the event; after = event date to today. Floods recede fast, so
  prefer the earliest clear scene after the peak; burn scars persist, so the clearest post-fire scene is fine.
- AOI: the property plus a margin, about 0.5-2 km across. Data type optical, 10 m, max cloud 20 % (storms leave clouds:
  widen the after window before raising the cloud limit).

## Report format

- Answer first: "Imagery from <date> shows <new standing water covering about X km² / burn scar of severity Y> within
  <distance> of <asset>" or "no visible flooding at the property on <date>".
- Measurements: new-water area (km²), mean index before/after, burn-severity class areas, distance from the asset.
- Images: before, after and the index or change map, each dated and captioned.
- Confidence: lower it when clouds hide part of the AOI or the after scene is days past the peak.
- Limitations: 10 m pixels (a building is a few pixels), water under trees or in streets can be missed, flood peak may fall
  between passes. Recommend human review for insurance claims or lending decisions.
- If high-resolution archive imagery (30-50 cm) would show roof-level damage, add a paid-data estimate.

## Outreach message (comms-outreach; always the founder-approved template)

Shape: their property + one finding + the image + next step and price + who we are + AI disclosure + opt-out.

> Subject: Satellite check of <property name> after the <event> on <date>
>
> Hi <name or team>, Terragent's automated analysis of Sentinel-2 imagery from <date> shows <one concrete finding about
> their property>. The before/after image is here: <link>. If useful, we can check all your properties in the area or
> keep watching this one as new images arrive (<price>). This message was written by an AI agent at Terragent, an
> AI-run company. Reply to reach us; to opt out, use <opt-out link>.

Be helpful, never fear-based. Only write when the imagery actually shows something. We are not adjusters or contractors.

## Price

- Only the investigation (planning and comparing sources) is free; its output is the quote. Every answer is paid.
- The quote offers 1-3 options, priced per job by the server (terragent.price_options: data + analysis + risk buffer + margin);
  the pricing agent writes labels and notes, never prices. The cheapest option is never below $29.
- Nothing runs until the customer accepts one option (a reply naming A/B/C, a plain "yes" for the recommended one, or the
  accept link). Paid data is bought by a founder only after that acceptance; reports carry only derived results from it.
- Recommend the cheapest option that answers the question; when free data can't (resolution, clouds, no recent scene),
  recommend the paid option and say why.
- Typical options: A = before/after check of one property from free Sentinel-2 data (from $29); B = 30-50 cm archive for
  roof-level damage (pass-through data cost + analysis + margin); C = new capture after the event when the archive has no
  clear post-event scene (tasking: fastest answer, highest price, often a range until the supplier confirms).
- Portfolio check (10+ properties in one event area): priced per job, so the per-property price falls with volume.
- Monitoring through recovery (re-check as new images arrive): $49 per site per month.

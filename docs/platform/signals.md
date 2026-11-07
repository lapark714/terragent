# Signals platform reference: free signal feeds and geocoding

Status: COMPLETE (research agent, 2026-11-07). Supersedes nothing; predecessor attempt left no doc. All "live" samples fetched 2026-11-07 ~22:15-22:45Z.
All live requests used `User-Agent: Terragent/0.1 (hackathon research)`. No keys, no accounts, nothing submitted.
Evidence levels: **LIVE** = real request made, trimmed response pasted; **DOC** = official docs page/spec fetched; **UNVERIFIED** = see section 8.
Scope: free signal feeds (disasters, forests, mining, construction) + no-key geocoding. Everything here is plain HTTPS + JSON/CSV/GML — no SDK.

## 1. TL;DR for builders

- No SDKs. Every feed is plain `fetch()`; all of the calls below work **today with no key**. Always send a non-empty `User-Agent` (NWS and Nominatim return **403** on empty UA).
- The 5 calls that matter:
  1. NWS: `GET https://api.weather.gov/alerts/active?status=actual&region_type=land&severity=Severe,Extreme` -> then GET each `properties.affectedZones[]` URL for polygons (96% of alerts have `geometry: null`).
  2. Floods now: `GET https://mapservices.weather.noaa.gov/eventdriven/rest/services/water/riv_gauges/MapServer/0/query?where=status IN ('minor','moderate','major')&outFields=*&f=geojson` (0.3 s), then `GET https://api.water.noaa.gov/nwps/v1/gauges/{lid}` for flood stages + impact text.
  3. Fires: `GET https://firms.modaps.eosdis.nasa.gov/data/active_fire/noaa-20-viirs-c2/csv/J1_VIIRS_C2_USA_contiguous_and_Hawaii_24h.csv` (no key) + USGS quakes `.../summary/significant_week.geojson`/`4.5_day.geojson` + FEMA `GET https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries?$filter=declarationDate ge '...'&$orderby=declarationDate desc`.
  4. Forest: `POST https://data-api.globalforestwatch.org/dataset/gfw_integrated_alerts/{vYYYYMMDD}/download/json` body `{sql, geometry}` — **works without a key** (the `/query/json` path needs one).
  5. Mining/construction: BLM claims `.../HUB/BLM_Natl_MLRS_Mining_Claims_Not_Closed/FeatureServer/0/query?where=Created >= DATE '...'`; permits `https://data.sf.gov/resource/i98e-djp9.json?$where=...`. Geocode US addresses with the Census geocoder (`benchmark=Public_AR_Current` is required).
- Traps: NWS enums are TitleCase (`severity=severe` -> 400) and `/alerts/active` has no `limit`; NWPS full gauge list is 13 MB / 37-54 s and has 504'd; USGS waterservices shuts down 2027-02-22; `data.sfgov.org` -> 301 `data.sf.gov`; Socrata numbers are text (`estimated_cost::number`); FEMA has no geojson; Nominatim is 1 req/s, cron = 4 req/min, no personal data, no reselling.

## 2. Install & setup

No vendor SDK exists or is needed for any feed in this doc. Node 18+ global `fetch` is enough. Optional helpers (versions from `npm view`, 2026-11-07; all published >2 weeks ago except where noted):
| package | version | publish date | use |
|---|---|---|---|
| `h3-js` | `4.5.0` | 2026-07-01 | bucket FIRMS points / alerts into H3 cells (spec 3.4) |
| `@turf/turf` | `7.4.0` | 2026-08-03 | point-in-polygon (asset inside NWS/WFIGS polygon), buffers |
| `csv-parse` | `7.0.3` | 2026-09-25 | FIRMS CSV, MRDS CSV, BLM hub CSV |
| `fast-xml-parser` | `5.11.2` | 2026-09-29 | MRDS WFS GML (latest is `5.12.0`, published 2026-11-03 — only 4 days old, so pin 5.11.2) |
| `@types/geojson` | `7946.0.16` | 2026-10-04 | types |
```bash
npm i h3-js@4.5.0 @turf/turf@7.4.0 csv-parse@7.0.3 fast-xml-parser@5.11.2 && npm i -D @types/geojson@7946.0.16
```
Python equivalent (Analytics agent in the Naïve sandbox): `requests`, `h3`, `shapely` — not version-verified here (UNVERIFIED).
Env (all optional for MVP): `NWS_USER_AGENT` (e.g. `Terragent/0.1 (terragent.vercel.app, <ops inbox>)`), `FIRMS_MAP_KEY`, `GFW_API_KEY`, `USGS_WATERDATA_API_KEY`, `SOCRATA_APP_TOKEN` — see section 6.

## 3. API reference

### 3.1 NWS alerts — `api.weather.gov` (LIVE-VERIFIED 2026-11-07, no key)

- Base: `https://api.weather.gov`. OpenAPI: `https://api.weather.gov/openapi.json` (info.version `3.12.2`).
- Auth: none. A `User-Agent` header is REQUIRED. Live: empty UA -> `403 Access Denied` (Akamai HTML page); curl's default UA -> 200. Docs: "A User Agent is required to identify your application... This will be replaced with an API key in the future." Example format from docs: `User-Agent: (myweatherapp.com, contact@myweatherapp.com)`.
- Response: `content-type: application/geo+json`, `cache-control: public, max-age=5, s-maxage=5`, CORS `access-control-allow-origin: *`.

`GET /alerts/active` -> GeoJSON FeatureCollection. Top-level keys (live): `@context, type, features, title, updated`. **No pagination on /alerts/active** (`limit` -> 400 `Query parameter "limit" is not recognized`; `limit`/`cursor` exist only on `/alerts`). Live: 403 features, 1.83 MB, 1.6 s.

Query params (from openapi.json `/alerts/active`; arrays are comma-separated):
| param | type | enum / notes |
|---|---|---|
| `status` | array | `actual, exercise, system, test, draft` (lowercase in query) |
| `message_type` | array | `alert, update, cancel` |
| `event` | array | event name, e.g. `Flood Warning,Flash Flood Warning` (URL-encode spaces) |
| `code` | array | SAME/event code, e.g. `FLW` (live: `code=FLW` == `event=Flood Warning`, 12 hits) |
| `area` | array | state/territory (`CA`, `TX`...) or marine area (`AM, AN, GM, LC, LE, LH, LM, LO, LS, PH, PK, PM, PS, PZ, SL`) |
| `point` | string | `lat,lon` e.g. `37.77,-122.42` |
| `region` | array | marine region `AL, AT, GL, GM, PA, PI` |
| `region_type` | string | `land` or `marine` |
| `zone` | array | zone ID (forecast or county), e.g. `CAZ043,AZC013` |
| `urgency` | array | **Case-sensitive TitleCase**: `Immediate, Expected, Future, Past, Unknown` |
| `severity` | array | **TitleCase**: `Extreme, Severe, Moderate, Minor, Unknown` (live: `severity=severe` -> 400 "Does not have a value in the enumeration") |
| `certainty` | array | **TitleCase**: `Observed, Likely, Possible, Unlikely, Unknown` |

`area`, `point`, `region`, `region_type`, `zone` are mutually exclusive (live: `area=CA&point=...` -> 400 `parameters may not be used together: area, point`).

Other endpoints: `GET /alerts/active/count` -> `{total, land, marine, regions:{AL,AT,...}, areas:{CA:17,...}, zones:{...}}` (live). `GET /alerts?start=&end=&limit=&cursor=` for history. `GET /alerts/{id}`.

Feature `properties` keys (live): `@id, @type, id, areaDesc, geocode{SAME[],UGC[]}, affectedZones[] (zone URLs), references, sent, effective, onset, expires, ends, status, messageType, category, severity, certainty, urgency, event, sender, senderName, headline, description, instruction, response, note, parameters{AWIPSidentifier, WMOidentifier, NWSheadline, BLOCKCHANNEL, VTEC, eventEndingTime, expiredReferences...}, scope, code, language, web, eventCode{SAME[], NationalWeatherService[]}`.
Schema enums (openapi components): `AlertStatus` = `Actual, Exercise, System, Test, Draft`; `AlertMessageType` = `Alert, Update, Cancel, Ack, Error`. Live distribution: category all `Met`; response values seen `Avoid, Prepare, Execute, Monitor, None`.

Trimmed live feature (Flood Warning with polygon):
```json
{"id":"urn:oid:2.49.0.1.840.0.8dc22f89c725848e71ed04e6f2611dec01e8660c.001.1",
 "areaDesc":"Maricopa, AZ","geocode":{"SAME":["004013"],"UGC":["AZC013"]},
 "affectedZones":["https://api.weather.gov/zones/county/AZC013"],
 "sent":"2026-11-07T10:25:00-07:00","onset":"2026-11-07T10:25:00-07:00","expires":"2026-11-08T23:00:00-07:00","ends":"2026-11-08T23:00:00-07:00",
 "status":"Actual","messageType":"Update","category":"Met","severity":"Severe","certainty":"Likely","urgency":"Expected",
 "event":"Flood Warning","senderName":"NWS Phoenix AZ","response":"Avoid",
 "eventCode":{"SAME":["FLW"],"NationalWeatherService":["FAW"]},
 "parameters":{"VTEC":["/O.EXT.KPSR.FA.W.0040.000000T0000Z-261109T0600Z/"],"NWSheadline":["FLOOD WARNING NOW IN EFFECT UNTIL 11 PM MST SUNDAY"]},
 "geometry":{"type":"Polygon","coordinates":[[[-111.65,33.55],[-111.67,33.55],"..."]]}}
```

**Geometry vs zone-only alerts (big trap).** Live snapshot: 15 of 403 active alerts had `geometry` (all `Polygon`); **388 had `geometry: null`** (zone-based: Small Craft, Gale, Frost, Coastal Flood Advisory...). For those, polygons come from the zones API:
- `geocode.UGC` codes: `XXZnnn` = forecast/public zone, `XXCnnn` = county zone (e.g. `CAZ043`, `AZC013`). `geocode.SAME` = 6-digit `0` + state FIPS + county FIPS (e.g. `006073` = San Diego County, CA) — use for county joins with FEMA/Census.
- `affectedZones[]` are full URLs like `https://api.weather.gov/zones/forecast/CAZ043` or `.../zones/county/AZC013`. **GET each URL** -> a GeoJSON `Feature` with `geometry` (live: Polygon, 50-120 KB each, ~0.1 s). Properties: `id, type (public|county|fire|...), name, state, forecastOffices, timeZone, effectiveDate, expirationDate, cwa, radarStation, observationStations`.
- **`GET /zones?id=...&include_geometry=true` does NOT return geometry** (live: tried `true`, `1`, with `type=`; all features had `geometry: null`). Also note the same ID can appear twice with different `type` (CAZ552 came back as both `fire` and `public`). So: fetch zone geometries one by one and cache them (zones change rarely; `expirationDate` 2200-01-01).
- Zone types enum (`NWSZoneType`): `land, marine, forecast, public, coastal, offshore, fire, county`. Path form: `GET /zones/{type}/{zoneId}`.

```ts
const NWS_UA = "Terragent/0.1 (terragent.vercel.app, ops contact)"; // must be non-empty
const nws = (path: string) =>
  fetch(`https://api.weather.gov${path}`, { headers: { "User-Agent": NWS_UA, Accept: "application/geo+json" } })
    .then(r => { if (!r.ok) throw new Error(`NWS ${r.status}`); return r.json(); });

const alerts = await nws("/alerts/active?status=actual&region_type=land&severity=Severe,Extreme");
const zoneCache = new Map<string, GeoJSON.Geometry>();
for (const f of alerts.features) {
  if (f.geometry) continue;                       // polygon alert
  const geoms = [];
  for (const url of f.properties.affectedZones as string[]) {
    if (!zoneCache.has(url)) zoneCache.set(url, (await fetch(url, { headers: { "User-Agent": NWS_UA } }).then(r => r.json())).geometry);
    geoms.push(zoneCache.get(url));
  }
  f.geometry = { type: "GeometryCollection", geometries: geoms.filter(Boolean) };
}
```
Rate limit (docs): "not public information, but allows a generous amount for typical use. If the rate limit is exceeded a request will return with an error, and may be retried after the limit clears (typically within 5 seconds)."
Source: https://www.weather.gov/documentation/services-web-api ; https://api.weather.gov/openapi.json ; live curl 2026-11-07 22:19Z.

### 3.2 USGS earthquakes — GeoJSON summary feeds (LIVE-VERIFIED, no key)

URL pattern: `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/{level}_{period}.geojson`
- `level`: `significant`, `4.5`, `2.5`, `1.0`, `all`; `period`: `hour`, `day`, `week`, `month`. Live 200 for `significant_week` (0 features right now, 259 B), `significant_month` (14), `4.5_day` (13), `4.5_week`, `2.5_day`, `all_hour`, `all_day` (123 KB).
- Docs: every feed "Updated every minute." Headers: `cache-control: public, max-age=60`, `access-control-allow-origin: *`. JSONP variant wraps in `eqfeed_callback`.
- Top level: `{type:"FeatureCollection", metadata:{generated(ms), url, title, status, api:"2.8.2", count}, bbox:[minLon,minLat,minDepth,maxLon,maxLat,maxDepth], features[]}`.
- Feature: `{type, id:"us7000twu1", geometry:{type:"Point", coordinates:[lon, lat, depthKm]}, properties}`.
- `properties` (live, documented types): `mag` Decimal, `place` String, `time` Long (epoch ms), `updated` Long ms, `tz` Int (null now), `url`, `detail` (detail GeoJSON URL), `felt` Int, `cdi` Decimal, `mmi` Decimal, `alert` String (PAGER level; live values `green`,`yellow`,`orange`; null when none), `status` (`reviewed`/`automatic`), `tsunami` Int 0/1, `sig` Int (significance, 0-1000+; live max 1006), `net`, `code`, `ids` (",us7000twu1,"), `sources`, `types` (",origin,phase-data,"), `nst`, `dmin`, `rms`, `gap`, `magType`, `type` ("earthquake"), `title`.

Trimmed live feature:
```json
{"type":"Feature","id":"us7000twu1","geometry":{"type":"Point","coordinates":[128.5121,-3.905,136.656]},
 "properties":{"mag":4.7,"place":"43 km ESE of Ambon, Indonesia","time":1794084938512,"updated":1794086342040,
  "url":"https://earthquake.usgs.gov/earthquakes/eventpage/us7000twu1",
  "detail":"https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/us7000twu1.geojson",
  "felt":null,"cdi":null,"mmi":null,"alert":null,"status":"reviewed","tsunami":0,"sig":340,"net":"us",
  "types":",origin,phase-data,","magType":"mb","type":"earthquake","title":"M 4.7 - 43 km ESE of Ambon, Indonesia"}}
```
Significant-month sample (live): `us6000u43g` M7.0 "189 km ENE of Nagqu, China", sig 1006, alert `orange`.

Custom queries (FDSN, same field shape): `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=2026-11-01&minmagnitude=4&latitude=37.77&longitude=-122.42&maxradiuskm=2000&orderby=time&limit=3` -> 200, metadata adds `limit`, `offset`, `api:"2.8.4"`.
Detail feed `.../detail/{id}.geojson` -> `properties.products` (e.g. `shakemap[0].contents` with download URLs) for intensity polygons (predecessor saw `cont_mmi.json`; not re-verified).
Source: https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php ; live curl 2026-11-07.

### 3.3 Flood gauges

#### 3.3a NOAA NWPS gauges — `api.water.noaa.gov/nwps/v1` (LIVE-VERIFIED, no key) — the source for "in flood right now"

- Swagger 2.0 spec: `https://api.water.noaa.gov/nwps/v1/docs/swagger.json` (title "National Water Prediction Service API", version 1.0.0, contact nws.nwc.ops@noaa.gov). UI: `https://api.water.noaa.gov/nwps/v1/docs/`.
- Endpoints (from swagger):
  - `GET /nwps/v1/gauges` params `bbox.xmin, bbox.ymin, bbox.xmax, bbox.ymax` (number), `srid` enum `SRID_UNSPECIFIED | EPSG_3857 | EPSG_4326`, `catfim` (bool)
  - `GET /nwps/v1/gauges/{identifier}` (identifier = NWS LID like `ARCF1`; USGS id may also work — unverified)
  - `GET /nwps/v1/gauges/{identifier}/stageflow` and `/stageflow/{product}` with product `observed | forecast`
  - `GET /nwps/v1/gauges/{identifier}/ratings?limit=&sort=&onlyTenths=`, `/riverflow`
  - `POST /nwps/v1/gauges/raag`, `GET /nwps/v1/monitor`, `GET /nwps/v1/products/stageflow/{identifier}/{pedts}`
  - `GET /nwps/v1/reaches/{reachId}`, `/reaches/{reachId}/streamflow?series=analysis_assimilation|short_range|medium_range|long_range|medium_range_blend`
- List response: `{ gauges: Gauge[] }`; Gauge = `{lid, name, rfc{abbreviation,name}, wfo{abbreviation,name}, state{abbreviation,name}, latitude, longitude, pedts{observed,forecast}, status{observed, forecast}}`; status.* = `{primary, primaryUnit, secondary, secondaryUnit, floodCategory, validTime}`. `-999` = missing.
- `floodCategory` values observed live across all 12,961 gauges (swagger types it as plain string, no enum): observed: `no_flooding 7167, not_defined 4172, obs_not_current 855, out_of_service 655, low_threshold 59, action 39, minor 8, moderate 4, major 2`; forecast adds `fcst_not_current`. **"In flood" = `minor | moderate | major`** (`action` = near flood stage).
- Gauge detail (`/gauges/ARCF1`, 48 KB, 0.7 s) keys: `lid, usgsId ("02296750"), reachId, name, description, rfc, wfo, state, county ("DeSoto"), timeZone, latitude, longitude, pedts, status, flood{stageUnits, flowUnits, categories{action,minor,moderate,major: {stage, flow}}, lro, crests, lowWaters, impacts[{stage, statement}]}, images, dataAttribution, normalThreshold, hydronotes, datums, inundation, upstreamLid, downstreamLid, inService{enabled,message}, lowThreshold, forecastReliability, ObservedFloodCategory, ForecastFloodCategory`.
  Live: `flood.categories = {major:{stage:16,flow:-9999}, moderate:{stage:14}, minor:{stage:11}, action:{stage:9}}`, stageUnits `ft`; status.observed `{primary:15.72,"primaryUnit":"ft",secondary:10.3,"secondaryUnit":"kcfs",floodCategory:"moderate",validTime:"2026-11-07T21:30:00Z"}`. `impacts[].statement` gives human text ("Up to 60 homes at River Acres are flooded...") — great for report copy.
- `stageflow/observed` (430 KB, 2,859 points): `{pedts, issuedTime, wfo, timeZone, primaryName:"Stage", primaryUnits:"ft", secondaryName:"Flow", secondaryUnits:"kcfs", data:[{validTime, generatedTime, primary, secondary}]}`.
Source: https://api.water.noaa.gov/nwps/v1/docs/swagger.json (DOC) + live `/gauges`, `/gauges/ARCF1`, `/gauges/ARCF1/stageflow/observed`.

**Trap: the full list is huge and slow.** `GET /gauges` (no params) and a CONUS bbox both return ~13.2 MB / 12,961 gauges and took **36.7 s and 54 s** live; the interrupted predecessor got a **504 Gateway Time-out** on the same call an hour earlier. Do not call it per request — use the MapServer query below for "what's flooding now", and use NWPS only for per-gauge detail.

#### 3.3b NOAA riv_gauges ArcGIS MapServer (LIVE-VERIFIED, no key) — fastest "gauges in flood" query

`https://mapservices.weather.noaa.gov/eventdriven/rest/services/water/riv_gauges/MapServer` layers: `0 Observed River Stages`, `1..14 River Stages 24..336 hour Forecast`, `15 Full Forecast Period Stages`. Layer 0 `maxRecordCount` 10000. Fields: `objectid, gaugelid, status, location, waterbody, state, obstime, wfo, url, action, units, lowthresh, lowthreshu, secvalue, secunit, flood, moderate, major, observed, latitude, longitude, hdatum, pedts, idp_filedate, idp_ingestdate, shape`. (Note: thresholds/observed are **strings**; `flood` here = minor flood stage.)
Distinct `status` values (live): `action, low_threshold, major, minor, moderate, no_flooding, not_defined, obs_not_current, out_of_service`.

```bash
curl -G 'https://mapservices.weather.noaa.gov/eventdriven/rest/services/water/riv_gauges/MapServer/0/query' \
  --data-urlencode "where=status IN ('minor','moderate','major')" \
  --data-urlencode 'outFields=gaugelid,status,location,waterbody,state,obstime,observed,action,flood,moderate,major,units,url,latitude,longitude' \
  --data-urlencode 'f=geojson'      # or f=json (+ returnGeometry=false)
```
Live: 200, 14 features, 0.33 s (same 14 LIDs as the NWPS full list). Trimmed attributes:
```json
{"gaugelid":"ARCF1","status":"moderate","location":"SR 70 Arcadia","waterbody":"Peace River","state":"FL",
 "obstime":"2026-11-07 20:30:00","observed":"15.79","action":"9","flood":"11","moderate":"14","major":"16",
 "units":"ft","url":"https://water.noaa.gov/gauges/arcf1","latitude":27.221944,"longitude":-81.876111}
```
Live gauges in flood at 22:30Z: ARCF1, COCF1, GENF1 (moderate, FL); DCBN8, ESLN8 (major, ND — Devils Lake); ASTF1, BPLI4, JCRF1, MNRC2, MOEA3, MROI4, NOCF1, SIGI4, SUKF1 (minor). Layer 0 lagged NWPS by ~1 h in this sample (obstime 20:30 vs NWPS validTime 21:30Z; obstime timezone not stated — treat as UTC, unverified).
Source: MapServer `?f=json` and `/0?f=json` (live).

#### 3.3c USGS Water Services instantaneous values — `waterservices.usgs.gov/nwis/iv/` (LIVE-VERIFIED, no key) — legacy, being shut down

- **Banner on https://waterservices.usgs.gov/ (live): "WaterServices will be permanently shut down on February 22nd, 2027. Requests will be intentionally slowed down and there will be intentional outages beginning in January 2027. Users must migrate to https://api.waterdata.usgs.gov."** Fine for this weekend; use the OGC API (3.3d) for anything that should outlive Jan 2027.
- `GET https://waterservices.usgs.gov/nwis/iv/?format=json&sites=11447650&parameterCd=00060,00065&siteStatus=active` -> 200, 3.9 KB, 0.45 s, `Cache-Control: max-age=900`.
- Exactly ONE "major filter" per query: `sites` (≤100, comma-sep) | `stateCd` | `huc` | `bBox` | `countyCd`. `bBox=west,south,east,north`; "The product of the range of latitude and longitude cannot exceed 25 degrees." Parameter codes: `00060` discharge ft3/s, `00065` gage height ft. Supports `period=P7D` or `startDT/endDT` (not both). Docs recommend `Accept-Encoding: gzip`. 403 = your IP was blocked for excessive use.
- Live: `bBox=-122.6,37.2,-121.5,38.2&parameterCd=00065` -> 57 series, 84 KB, **6.5 s**; `stateCd=ca&parameterCd=00065` -> 532 series, 775 KB, 1.2 s.
- Shape: `value.timeSeries[]` each `{name:"USGS:11447650:00060:00000", sourceInfo{siteName, siteCode[{value,network,agencyCode}], geoLocation.geogLocation{srs,latitude,longitude}, ...}, variable{variableCode[{value}], variableName, unit{unitCode}, noDataValue:-999999.0}, values[{value:[{value:"4300", qualifiers:["P"], dateTime:"2026-11-07T13:15:00.000-08:00"}]}]}`. Values are strings. **No flood stage in this API** — join to NWPS via `usgsId` for thresholds.
Source: https://waterservices.usgs.gov/docs/instantaneous-values/instantaneous-values-details/ (DOC) + live.

#### 3.3d USGS Water Data OGC API — `api.waterdata.usgs.gov/ogcapi/v0` (LIVE-VERIFIED, key optional)
- `GET https://api.waterdata.usgs.gov/ogcapi/v0/collections/latest-continuous/items?f=json&monitoring_location_id=USGS-11447650&parameter_code=00065&limit=1` -> 200 (also `bbox=minLon,minLat,maxLon,maxLat`). Live feature properties: `time_series_id, monitoring_location_id ("USGS-11447650"), parameter_code, statistic_id, time, value ("103.62", string), unit_of_measure ("ft"), approval_status ("Provisional"), qualifier, last_modified, method_category`; geometry Point.
- Collections (live): `latest-continuous, continuous, latest-daily, daily, monitoring-locations, time-series-metadata, field-measurements, peaks, parameter-codes, states, counties, ...`.
- Keys: optional, from api.data.gov; pass `?api_key=` or `X-Api-Key:`; without one you just hit a lower rate limit (429). Docs: a key lets you "make more requests per hour"; limits are reported in `X-RateLimit-Limit` / `X-RateLimit-Remaining` headers (docs example header value `X-RateLimit-Limit: 1000`). Anonymous live responses did not include those headers.
- **Trap:** `latest-continuous` returns stale series too (a bbox sample returned `time: 2025-10-01` for USGS-11313434). Filter on `time`.
- Docs examples use `/ogcapi/v1/...`, and `/v1/` also answered 200 live. Pick one and pin it.
Source: https://api.waterdata.usgs.gov/docs/ogcapi/keys/ (DOC) + live.

### 3.4 NASA FIRMS active fires

#### 3.4a No-key 24h text files (LIVE-VERIFIED) — use these now
Base `https://firms.modaps.eosdis.nasa.gov/data/active_fire/`. Files regenerate continuously (FAQ: "FIRMS fire maps are updated every 5 minutes, and the SHP, KML and CSV files..."; `last-modified` on all files was within ~40 min of the request).

| file (append to base) | live result |
|---|---|
| `noaa-20-viirs-c2/csv/J1_VIIRS_C2_USA_contiguous_and_Hawaii_24h.csv` | 200, 191 KB, 2,254 rows |
| `noaa-20-viirs-c2/csv/J1_VIIRS_C2_Global_24h.csv` | 200, 9.3 MB, 10.8 s |
| `noaa-21-viirs-c2/csv/J2_VIIRS_C2_Global_24h.csv` | 200, 10.4 MB, 11.1 s |
| `modis-c6.1/csv/MODIS_C6_1_USA_contiguous_and_Hawaii_24h.csv` | 200, 21 KB |
| `modis-c6.1/csv/MODIS_C6_1_Global_24h.csv` | 200, 1.8 MB |
| `suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_*_24h.csv` | 200 but **header only (112 B)** — S-NPP currently empty; don't rely on it |
| `.../kml/..._24h.kml`, `.../shapes/zips/..._24h.zip` | 200 (KML and zipped SHP variants exist) |
| `_48h.csv`, `_7d.csv` variants | 200 on HEAD and range GET (exist) |

VIIRS CSV columns: `latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,bright_ti5,frp,daynight`
MODIS CSV columns: `latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,confidence,version,bright_t31,frp,daynight`
- `acq_date` `YYYY-MM-DD`, `acq_time` `HHMM` UTC (string, leading zeros: `0005`). `satellite` `N20|N21|T|A`. `version` e.g. `2.0NRT` / `6.1NRT`. `daynight` `D|N`. `frp` = fire radiative power (MW).
- **`confidence` differs by sensor**: VIIRS = `low | nominal | high` (live US sample: nominal 2220, low 23, high 11); MODIS = integer 0-100. Normalize before scoring.
```
latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,bright_ti5,frp,daynight
47.95849,-117.04482,303.67,0.41,0.37,2026-11-06,0947,N20,nominal,2.0NRT,270.74,0.72,N
```
Points are 375 m (VIIRS) / 1 km (MODIS) pixel centres, not fire perimeters; cluster them (e.g. H3 res 7) before treating as "a fire". Many are ag burns/flares.

#### 3.4b FIRMS Area API (needs free MAP_KEY — format DOC-verified, not callable without key)
```
GET https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/{SOURCE}/{AREA_COORDINATES}/{DAY_RANGE}
GET https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/{SOURCE}/{AREA_COORDINATES}/{DAY_RANGE}/{DATE}
```
- `SOURCE`: `LANDSAT_NRT` (US/Canada only), `MODIS_NRT`, `MODIS_SP`, `VIIRS_NOAA20_NRT`, `VIIRS_NOAA20_SP`, `VIIRS_NOAA21_NRT`, `VIIRS_NOAA21_SP`, `VIIRS_SNPP_NRT`, `VIIRS_SNPP_SP`.
- `AREA_COORDINATES`: `west,south,east,north` (e.g. `-85,-57,-32,14`) or `world`. `DAY_RANGE`: `1..5`. `DATE`: `YYYY-MM-DD` optional (returns DATE..DATE+DAY_RANGE-1; omitted = most recent).
- Availability: `GET /api/data_availability/csv/{MAP_KEY}/all`. Key status: `GET /mapserver/mapkey_status/?MAP_KEY=...`.
- Limit (docs): "MAP_KEY limit is 5000 transactions / 10-minute interval. Larger transactions may count as multiple requests (ex. requesting 7 days)."
- RT/URT: NRT within 3 h of overpass; RT within 30 min; URT within 5 min (US/Canada) — URT/RT rows are replaced when NRT is processed or after 6 h.
- Live error shapes with a bogus key: area API -> `400` body `Invalid MAP_KEY.`; mapkey_status -> `403` "MAP_KEY is invalid or your have exceeded your transaction/time limit..."; data_availability -> `401 Invalid MAP_KEY.`
- How to get a key: https://firms.modaps.eosdis.nasa.gov/api/map_key/ — "sign up for free MAP_KEY using your email. The key will be sent to your email." (human task; no account/password, just an email).
Source: https://firms.modaps.eosdis.nasa.gov/api/area/ , /api/map_key/ , https://www.earthdata.nasa.gov/data/tools/firms/faq (DOC) + live.

#### 3.4c Bonus: NIFC WFIGS current wildfire perimeters (LIVE-VERIFIED, no key)
`https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query?where=1=1&outFields=*&f=geojson` — live count 59 perimeters (US). Fields used live: `poly_IncidentName, attr_IncidentSize (acres), attr_PercentContained, attr_FireDiscoveryDateTime (epoch ms), attr_POOState ("US-UT"), attr_IncidentTypeCategory ("WF" wildfire | "RX" prescribed)`. Real polygons, so better than FIRMS points for "is this asset inside a fire". Filter `attr_IncidentTypeCategory='WF'`.
Source: live ArcGIS query 2026-11-07 (`returnCountOnly=true` -> `{"count":59}`).

### 3.5 OpenFEMA DisasterDeclarationsSummaries v2 (LIVE-VERIFIED, no key)

`GET https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries` — JSON, `cache-control: public, max-age=150`, CORS `*`. ~0.3 s. 70,599 records total.
OData-style query params (all verified live; URL-encode `$` params with `curl -G --data-urlencode`):
| param | verified example | notes |
|---|---|---|
| `$filter` | `declarationDate ge '2026-10-01T00:00:00.000Z'` ; `incidentType eq 'Flood' and state eq 'TX'` ; `incidentType in ('Flood','Hurricane','Fire')` ; `contains(declarationTitle,'FIRE')` ; `declarationDate ge '2026-09-01'` | strings single-quoted; `eq ge gt le lt and or in contains` all worked |
| `$orderby` | `declarationDate desc` | |
| `$top` | `3`, `10000`, `10001` | **default 1000** when omitted (live); 10001 also returned 10001 rows (no 10k cap observed) |
| `$skip` | `2` | paging |
| `$select` | `disasterNumber,state,incidentType,declarationDate,designatedArea,fipsStateCode,fipsCountyCode` | |
| `$count=true` | -> `metadata.count` = total matches (165 for since-Oct-1); without it `metadata.count` is `0` | `$inlinecount=allpages` also works (70599) |
| `$metadata=off` | drops the `metadata` object | |
| `$format` | `json` (default), `csv` OK; **`geojson` -> 400** "does not support geojson format" | |

Response: `{ metadata:{skip, select, rundate, top, filter, format, metadata, orderby, entityname, version:"v2", url, count}, DisasterDeclarationsSummaries:[...] }`.
Fields (from `https://www.fema.gov/api/open/v1/OpenFemaDataSetFields?$filter=openFemaDataSet eq 'DisasterDeclarationsSummaries' and datasetVersion eq 2` — live, 29 fields):
`femaDeclarationString (text, "DR-4955-FL"), disasterNumber (smallint), state (2-letter), declarationType (text: DR | EM | FM), declarationDate (date), fyDeclared, incidentType (text), declarationTitle, ihProgramDeclared, iaProgramDeclared, paProgramDeclared, hmProgramDeclared (bool), incidentBeginDate, incidentEndDate, disasterCloseoutDate, tribalRequest, fipsStateCode (text "12"), fipsCountyCode (text "037"; "000" = statewide), placeCode ("99"+county FIPS), designatedArea ("Franklin (County)"), declarationRequestNumber, declarationRequestDate, lastIAFilingDate, incidentId, region (1-10), designatedIncidentTypes (comma list of codes), lastRefresh, hash, id (uuid)`.
- `declarationType`: DR = major disaster, EM = emergency, FM = fire management (live values since 2020: DR, FM; latest EM: NM Flood 2026-10-26).
- `incidentType` values seen live (2015+): `Biological, Coastal Storm, Dam/Levee Break, Earthquake, Fire, Flood, Hurricane, Mud/Landslide, Other, Severe Ice Storm, Severe Storm, Snowstorm, Straight-Line Winds, Tornado, Tropical Depression, Tropical Storm, Typhoon, Winter Storm`.
- `designatedIncidentTypes` codes (field dictionary): `0 N/A; 1 Explosion; 2 Straight-Line Winds; 3 Tidal Wave; 4 Tropical Storm; 5 Winter Storm; 8 Tropical Depression; A Tsunami; B Biological; C Coastal Storm; D Drought; E Earthquake; F Flood; G Freezing; H Hurricane; I Terrorist; J Typhoon; K Dam/Levee Break; L Chemical; M Mud/Landslide; N Nuclear; O Severe Ice Storm; P Fishing Losses; Q Crop Losses; R Fire; S Snowstorm; T Tornado; U Civil Unrest; V Volcanic Eruption; W Severe Storm; X Toxic Substances; Y Human Cause; Z Other`.
- One row per designated area (county) per declaration. County FIPS join key = `fipsStateCode + fipsCountyCode` (5 digits) — matches NWS `geocode.SAME` minus the leading `0`.

```ts
const u = new URL("https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries");
u.searchParams.set("$filter", `declarationDate ge '${since.toISOString()}'`);
u.searchParams.set("$orderby", "declarationDate desc");
u.searchParams.set("$top", "1000");
u.searchParams.set("$count", "true");
const { metadata, DisasterDeclarationsSummaries: rows } = await fetch(u).then(r => r.json());
```
Trimmed live record:
```json
{"femaDeclarationString":"DR-4955-FL","disasterNumber":4955,"state":"FL","declarationType":"DR",
 "declarationDate":"2026-10-27T00:00:00.000Z","incidentType":"Hurricane","declarationTitle":"HURRICANE ISAIAS",
 "paProgramDeclared":true,"incidentBeginDate":"2026-10-06T00:00:00.000Z","incidentEndDate":"2026-10-12T00:00:00.000Z",
 "fipsStateCode":"12","fipsCountyCode":"037","placeCode":"99037","designatedArea":"Franklin (County)",
 "incidentId":"2026100601","region":4,"designatedIncidentTypes":"H","lastRefresh":"2026-11-06T12:27:53.589Z","id":"7d33bf7c-979d-4ec5-9768-d619c64b1099"}
```
Docs: data dictionary `https://www.fema.gov/openfema-data-page/Disaster-Declarations-Summaries-v2` (from OpenFemaDataSets metadata). **The fema.gov HTML docs pages return 403 (Akamai) to curl, even with a browser UA**; the API itself does not. Rate limits / key policy therefore not read from docs (no key was needed for any call).
Source: live API + OpenFEMA metadata API (OpenFemaDataSetFields, OpenFemaDataSets).

### 3.6 Global Forest Watch Data API — `data-api.globalforestwatch.org` (LIVE-VERIFIED; key needed for `/query`, NOT for `/download`)

- OpenAPI 3.1: `https://data-api.globalforestwatch.org/openapi.json` (title "GFW DATA API", version `0.3.0`). ReDoc UI at `/`.
- Security schemes (openapi): `APIKeyOriginQuery` (query `x-api-key`), `APIKeyOriginHeader` (header `x-api-key`), `OAuth2PasswordBearer` (tokenUrl `/token`).

Alert datasets (all live; `GET /dataset/{ds}/latest` -> 307 redirect to `/dataset/{ds}/{version}`; versions are `vYYYYMMDD`, refreshed ~daily):
| dataset | latest version (2026-11-07) | content_date_range | alert fields |
|---|---|---|---|
| `gfw_integrated_alerts` (GLAD-L + GLAD-S2 + RADD merged; 10 m; "30°N to 30°S"; update "Daily"; CC BY 4.0) | `v20261107` | 2014-12-31 .. 2026-11-07 | `gfw_integrated_alerts__date`, `__confidence`, `__intensity`, `__date_conf` |
| `umd_glad_landsat_alerts` (GLAD-L) | `v20261105` | 2020-01-01 .. 2026-11-05 | `umd_glad_landsat_alerts__date`, `__confidence`, `__date_conf` |
| `umd_glad_sentinel2_alerts` (GLAD-S2) | `v20261106` | 2020-01-01 .. 2026-11-06 | `umd_glad_sentinel2_alerts__date`, `__confidence`, `__date_conf` (+ `umd_glad_sentinel2_alerts_coverage__coverage`) |
| `wur_radd_alerts` (RADD, Sentinel-1 radar) | `v20261101` | 2020-01-01 .. 2026-11-01 | `wur_radd_alerts__date`, `__confidence`, `__date_conf` (+ `wur_radd_coverage__default`) |
| `umd_glad_dist_alerts`, `gfw_integrated_dist_alerts` (global land disturbance) | `v20261031`, `v20261107` | | |
Also pre-aggregated tables: `gadm__integrated_alerts__{iso,adm1,adm2}_daily_alerts`, `wdpa_protected_areas__integrated_alerts__daily_alerts`, `geostore__integrated_alerts__daily_alerts`, and fire: `nasa_viirs_fire_alerts`, `nasa_modis_fire_alerts`. Full list: `GET /datasets` (382 datasets, 610 KB).
Confidence values seen live: integrated = `nominal | high | highest`; RADD = `nominal | high`. `__intensity` integer (e.g. 55). Reserved fields usable in SQL: `area__ha`, `latitude`, `longitude`. Fields list: `GET /dataset/{ds}/{version}/fields` (integrated alerts lists 81 fields incl. joinable raster layers, e.g. `umd_tree_cover_density_2000__percent`, `is__umd_regional_primary_forest_2001`, `gadm_administrative_boundaries__adm0`, `wdpa_protected_areas__iucn_cat`).

Endpoints:
- `GET|POST /dataset/{ds}/{v}/query/json` and `/query/csv` — **require API key**. Live without key: `403 {"status":"failed","message":"Request is missing valid API key. Please see documentation at https://data-api.globalforestwatch.org/#tag/Authentication on how to create one."}`. `POST /dataset/{ds}/{v}/query` -> 308 redirect to `/query/json`.
- `GET|POST /dataset/{ds}/{v}/download/json` and `/download/csv` — **no security in openapi, and live they work WITHOUT a key** (200, ~2-3 s) for the raster alert datasets when a geometry is given. (The openapi description says download "only works for datasets with (geo-)database tables", yet raster queries succeeded — treat as best-effort; it could be locked down.)
- Raster datasets **require a geometry**: without one -> `422 {"status":"failed","message":"Raster tile set queries require a geometry."}`. Pass `geometry` (GeoJSON Polygon/MultiPolygon) in the POST body, or `geostore_id` on GET.
- POST body schema `QueryRequestIn` = `{ sql: string (required), geometry?: { type, coordinates } }` (additionalProperties false). Table name in SQL is `results`.
- `/analysis/zonal/{geostore_id}` and `POST /analysis/zonal` need API key.

Working no-key example (live 200):
```ts
const GFW = "https://data-api.globalforestwatch.org";
const body = {
  sql: "SELECT gfw_integrated_alerts__confidence, COUNT(*), SUM(area__ha) FROM results " +
       "WHERE gfw_integrated_alerts__date >= '2026-01-01' GROUP BY gfw_integrated_alerts__confidence",
  geometry: { type: "Polygon", coordinates: [[[-62.0,-9.0],[-61.9,-9.0],[-61.9,-8.9],[-62.0,-8.9],[-62.0,-9.0]]] },
};
const rows = await fetch(`${GFW}/dataset/gfw_integrated_alerts/v20261107/download/json`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}).then(r => r.json());
// live -> [{"gfw_integrated_alerts__confidence":"high","count":201,"ha":2.44609},
//          {"gfw_integrated_alerts__confidence":"highest","count":14,"ha":0.17037},
//          {"gfw_integrated_alerts__confidence":"nominal","count":122,"ha":1.48469}]
```
Point rows (live): `[{"latitude":-8.93815,"longitude":-61.97395,"gfw_integrated_alerts__date":"2026-10-03","gfw_integrated_alerts__confidence":"nominal","gfw_integrated_alerts__intensity":55}, ...]` (one row per 10 m pixel; a 0.1° box returned 337 rows since 2026-01-01).
1°x1° box (-63..-62, -10..-9), daily group-by since 2026-10-20: 200 in 2.6 s, e.g. `{"gfw_integrated_alerts__date":"2026-11-05","count":3652,"area__ha":44.34}`.
SQL quirks seen live: `COUNT(*) AS n` came back as key `count` (alias ignored), `SUM(area__ha)` without alias came back as `area__ha`, `SUM(area__ha) AS ha` kept `ha`; a `MIN()/MAX()` on the date field was silently dropped (only `count` returned). Always use `GROUP BY` on the date/confidence fields instead of MIN/MAX.

How a key is obtained (openapi, human task — needs an account):
1. `POST /auth/sign-up` JSON `{name, email}` (SignUpRequestIn) -> account created, credentials emailed (unverified what the email contains).
2. `POST /auth/token` form `grant_type=password&username=&password=` -> bearer token.
3. `POST /auth/apikey` (Bearer) JSON `APIKeyRequestIn` = `{alias (req), organization (req), email (req), domains: string[] (default []), never_expires (admin only)}`. "Default keys are valid for one year." "If no domain is listed, the key will be set by default to the lowest rate limiting tier." When calling with the key, send header `x-api-key: <key>` **and an `Origin` header matching one of `domains`** (e.g. `localhost` for dev, no port; wildcards `*.vercel.app` allowed for subdomains only).
Source: https://data-api.globalforestwatch.org/openapi.json + live calls 2026-11-07.

### 3.7 Mining

#### 3.7a USGS MRDS — `mrdata.usgs.gov/mrds/` (LIVE-VERIFIED, no key; static, no new events)
- Landing page (live): "As of 2011, USGS has ceased systematic updates to MRDS". So MRDS is **reference/context** (what deposits are near an asset), not a signal feed. Use BLM claims (3.7b) for "new activity".
- **WFS 1.1.0**: `https://mrdata.usgs.gov/services/wfs/mrds` — one feature type `ms:mrds` (typeName `mrds`). Output formats: GML only (`application/gml+xml; version=3.2`, `text/xml; subtype=gml/3.2.1|3.1.1|2.1.2`); `outputFormat=geojson` -> ServiceException. Live:
  - WFS 1.1.0 + EPSG:4326 uses **lat,lon axis order**: `...&version=1.1.0&request=GetFeature&typeName=mrds&maxFeatures=2&BBOX=39.5,-106.5,40.0,-106.0,EPSG:4326` -> 200, `<gml:pos>39.921370 -106.336180</gml:pos>`.
  - WFS 1.0.0 uses **lon,lat**: `...&version=1.0.0&request=GetFeature&typeName=mrds&maxFeatures=2&BBOX=-106.5,39.5,-106.0,40.0` -> 200, `<gml:coordinates>-106.336180,39.921370</gml:coordinates>`.
  - WFS fields (DescribeFeatureType): `geometry (Point), dep_id, site_name, dev_stat, fips_code ("f08049"), huc_code ("h14010002"), quad_code, url, code_list (" SDG" commodity codes)`.
  ```xml
  <ms:mrds gml:id="mrds.17700"><ms:dep_id>10018220</ms:dep_id><ms:site_name>Unknown</ms:site_name><ms:dev_stat>Occurrence</ms:dev_stat>
   <ms:fips_code>f08049</ms:fips_code><ms:url>https://mrdata.usgs.gov/mrds/show-mrds.php?dep_id=10018220</ms:url><ms:code_list> SDG</ms:code_list></ms:mrds>
  ```
- WMS 1.3.0: `https://mrdata.usgs.gov/services/mrds` (for map overlay).
- Bulk: `https://mrdata.usgs.gov/mrds/mrds-csv.zip` (live: 25,791,223 bytes, last-modified 2022-08-23; single `mrds.csv`). Also `mrds-trim.zip` (shapefile ~10 MB), `rdbms-tab.zip` (20 MB), `rdbms-tab-all.zip` (118 MB). CSV header (live, decoded from first 200 KB):
  `dep_id,url,mrds_id,mas_id,site_name,latitude,longitude,region,country,state,county,com_type,commod1,commod2,commod3,oper_type,dep_type,prod_size,dev_stat,ore,gangue,other_matl,orebody_fm,work_type,model,alteration,conc_proc,names,ore_ctrl,reporter,hrock_unit,hrock_type,arock_unit,arock_type,structure,tectonic,ref,yfp_ba,yr_fst_prd,ylp_ba,yr_lst_prd,dy_ba,disc_yr,prod_yrs,discr,score`
  Values seen (first 1,665 rows): `dev_stat` Occurrence | Past Producer | Prospect | Producer | Unknown | Plant; `com_type` M | N | B; `score` (record quality) A..E (B/C/D/E seen); `oper_type` Unknown | Surface | Underground | Processing Plant | Surface-Underground | Placer | Well; `prod_size` '' | N | S | M | L | U | Y.
- Field meanings: https://mrdata.usgs.gov/mrds/about.php (DOC). Commodity codes: https://mrdata.usgs.gov/mrds/commodity-codes.html.
Source: https://mrdata.usgs.gov/mrds/ (DOC), WFS GetCapabilities/DescribeFeatureType/GetFeature (live), mrds-csv.zip HEAD + first 200 KB (live).
- Recommendation: load the CSV once into Neon (≈300k rows; size unverified) or query WFS by bbox per AOI.

#### 3.7b BLM MLRS mining claims (LIVE-VERIFIED, no key) — public ArcGIS services + bulk download
MLRS itself (`https://mlrs.blm.gov/s/`) is a Salesforce "Virtual Public Room" web app with no documented public API. The usable machine endpoints are BLM ArcGIS services built from MLRS:

**(1) Best for signals — BLM Natl MLRS Mining Claims - Not Closed (hub FeatureServer, has `Created` date):**
`https://nlsdbpubgis.blm.gov/arcgishub/rest/services/HUB/BLM_Natl_MLRS_Mining_Claims_Not_Closed/FeatureServer/0`
- capabilities `Query,Extract`, maxRecordCount 2000, polygon. Fields: `OBJECTID, ID, CSE_NAME, STAGE_ID, BLM_PROD, CSE_TYPE_NR, CSE_NR, LEG_CSE_NR, SF_ID, CSE_DISP, SRC, QLTY, CSE_META, RCRD_ACRS, Created (Date), Modified (Date), Shape__Length, Shape__Area`.
- Live: count 595,411; `Created >= DATE '2026-10-01'` -> 6,621 claims; newest `Created` = 1794009600000 (2026-11-07T00:00Z) — refreshed ~daily. Distinct (CSE_DISP, BLM_PROD) since Oct 1: `Active|Draft|Filed|Under Review` x `LODE CLAIM|PLACER CLAIM|Mill Site - National Park`.
```bash
curl -G 'https://nlsdbpubgis.blm.gov/arcgishub/rest/services/HUB/BLM_Natl_MLRS_Mining_Claims_Not_Closed/FeatureServer/0/query' \
  --data-urlencode "where=Created >= DATE '2026-11-01'" \
  --data-urlencode 'outFields=CSE_NR,CSE_NAME,BLM_PROD,CSE_DISP,RCRD_ACRS,Created' \
  --data-urlencode 'orderByFields=Created DESC' --data-urlencode 'outSR=4326' --data-urlencode 'f=geojson'
```
Live row: `{"CSE_NR":"AZ106868986","CSE_NAME":"Treasure Gulch 19","BLM_PROD":"PLACER CLAIM","CSE_DISP":"Filed","STAGE_ID":"2230141964733288448","RCRD_ACRS":20.0,"Created":1794009600000,"Modified":1794011520000}`; GeoJSON feature geometry = claim polygon (e.g. UT106856048 "BERNICE 15", 13.2 acres). Response flags `exceededTransferLimit: true` when more rows exist -> page with `resultOffset`.
- `outStatistics` on this layer -> 400 "Unable to complete operation" (use `returnCountOnly` instead).
- Companion: `.../HUB/BLM_Natl_MLRS_Mining_Claims_Closed/FeatureServer` ("Closed (Past Year)").
- Bulk CSV via ArcGIS Hub (live 200 `text/csv`, HEAD only): `https://hub.arcgis.com/api/v3/datasets/abec5ef96dc8495d9c29a01b30cc04ee_0/downloads/data?format=csv&spatialRefId=4326&where=1%3D1`. Dataset discovered via `https://gbp-blm-egis.hub.arcgis.com/api/search/v1/collections/dataset/items?q=mining%20claims` (also lists state layers: BLM NM, AK, OR).

**(2) NLSDB MapServer (no usable dates):** `https://nlsdbpubgis.blm.gov/arcgis/rest/services/Mining_Claims/MiningClaims/MapServer` (`gis.blm.gov/nlsdb/...` 301-redirects here). Layers `0 Case`, `1 Active Mining Claims`, `2 Closed Mining Claims`; maxRecordCount 2000. Fields: `ADMIN_STATE, GEO_STATE, BLM_PROD, CSE_DISP, CSE_TYPE_NR, CSE_NR, LEG_CSE_NR, CSE_NAME, LOC_DT, SRC, QLTY, CSE_META (PLSS legal description), RCRD_ACRS, SF_ID, REC_TYPE_CSE_GRP, MC_PATENTED, MC_EXCLUDED, MC_CONVEYED, OBJECTID`. Live: 595,524 active; **`LOC_DT` is NULL for every row** (`LOC_DT IS NOT NULL` count = 0) and ADMIN_STATE/GEO_STATE were null in samples; queries take **10-19 s**. Use (1) instead.
Source: ArcGIS REST `?f=json` service/layer descriptors + live queries 2026-11-07.

### 3.8 Construction — Socrata SODA building permits (LIVE-VERIFIED, no key on SODA 2.x `/resource/`)

**San Francisco "Building Permits" `i98e-djp9`** — **domain moved: `data.sfgov.org` now 301-redirects to `data.sf.gov`** (live). Use `https://data.sf.gov/resource/i98e-djp9.json` directly (Node `fetch` follows 301 for GET, but don't depend on it).
- Response headers carry the schema: `X-SODA2-Fields` / `X-SODA2-Types`, plus `X-SODA2-Truth-Last-Modified` (live: `Sat, 07 Nov 2026 13:26:52 GMT` -> refreshed daily).
- Fields (live, 55): `permit_number, permit_type, permit_type_definition, permit_creation_date, block, lot, street_number, street_number_suffix, street_name, street_suffix, unit, unit_suffix, description, primary_priority, all_priority_types, status, status_date, filed_date, issued_date, completed_date, first_construction_document_date, approved_date, structural_notification, number_of_existing_stories, number_of_proposed_stories, voluntary_soft_story_retrofit, fire_only_permit, estimated_cost, revised_cost, existing_use, existing_units, proposed_use, proposed_units, plansets, tidf_compliance, existing_occupancy, proposed_occupancy, existing_construction_type, existing_construction_type_description, proposed_construction_type, proposed_construction_type_description, site_permit, last_permit_activity_date, application_submission_method, adu, primary_address_flag, supervisor_district, neighborhoods_analysis_boundaries, zipcode, location, point_source, reroof, record_id, data_as_of, data_loaded_at`.
- Types trap: dates are `floating_timestamp` (no TZ, e.g. `2026-11-06T13:16:01.000`); **`estimated_cost`, `revised_cost`, units are `text`** -> cast in SoQL: `estimated_cost::number >= 1000000`. `location` is `point` (GeoJSON `{type:"Point",coordinates:[lon,lat]}`).
- `status` values (live, 2026 YTD counts): `issued 8018, complete 7182, filed 2534, cancelled 119, withdrawn 97, reinstated 80, approved 56, suspend 23, denied 3, revoked 1, expired 1`.

Verified SoQL queries (all 200, 0.4-0.7 s):
```bash
S=https://data.sf.gov/resource/i98e-djp9.json
# big new permits
curl -G $S --data-urlencode "\$where=filed_date >= '2026-10-01T00:00:00' AND estimated_cost::number >= 1000000" \
  --data-urlencode '$select=permit_number,permit_type_definition,status,filed_date,issued_date,estimated_cost,street_number,street_name,street_suffix,zipcode,location' \
  --data-urlencode '$order=filed_date DESC' --data-urlencode '$limit=2'
# count / group
curl -G $S --data-urlencode '$select=count(*)' --data-urlencode "\$where=filed_date >= '2026-10-01T00:00:00'"     # -> [{"count":"1818"}]
curl -G $S --data-urlencode '$select=status, count(*) AS n' --data-urlencode '$group=status' --data-urlencode '$order=n DESC'
# radius search (metres)
curl -G $S --data-urlencode "\$where=within_circle(location, 37.7749, -122.4194, 500) AND issued_date >= '2026-10-01T00:00:00'"
```
Live row: `{"permit_number":"202611050415","permit_type_definition":"otc alterations permit","status":"filed","filed_date":"2026-11-05T14:36:27.000","estimated_cost":"3200000.0","street_number":"475","street_name":"Sansome","street_suffix":"St","zipcode":"94111","location":{"type":"Point","coordinates":[-122.401949644,37.794710133]}}`. Note counts/aggregates come back as **strings** (`"1818"`).

**NYC "DOB NOW: Build – Approved Permits" `rbx6-tga4`** — `https://data.cityofnewyork.us/resource/rbx6-tga4.json` (live 200, ~1.7-2 s). Fields include `job_filing_number, work_permit, filing_reason, house_no, street_name, borough, lot, bin, block, work_type, approved_date, issued_date, expired_date, job_description, estimated_job_costs (text), owner_business_name, owner_name, permit_status, zip_code, latitude, longitude (text), bbl, nta`.
- **Trap: `$order=issued_date DESC` without a filter returned a row with no `issued_date` first ("Permit is not yet issued")** — nulls sort first on DESC. Always add `issued_date IS NOT NULL` or a `>=` filter. Working: `$where=issued_date >= '2026-11-01T00:00:00' AND work_type='General Construction'` -> rows like `{"job_filing_number":"M01167662-I1","issued_date":"2026-11-06T00:00:00.000","estimated_job_costs":"310000","house_no":"200","street_name":"MADISON AVENUE","borough":"Manhattan","owner_business_name":"PR","permit_status":"Permit Issued"}`.
- NYC rows include individual names (`owner_name`, `applicant_first_name`); spec section 8 says businesses only — filter to `owner_business_name`.

SODA rules (DOC, dev.socrata.com): `$limit` defaults to 1,000; "Version 2.0 endpoints have a maximum $limit of 50,000; Version 2.1 and 3.0 endpoints have no maximum." Page with `$offset` + stable `$order`. Without an app token, throttling is per source IP from a shared pool; with one (`X-App-Token` header, preferred, or `$$app_token` param) "we do not throttle API requests... unless abusive". **SODA 3 (`/api/v3/views/{id}/query.json`) requires auth/app token** — live: `403 {"code":"authentication_required","message":"This request must be authenticated or have an application token"}`. Stick to `/resource/{id}.json` (SODA 2.x) for no-key use.
Source: https://dev.socrata.com/docs/app-tokens.html , https://dev.socrata.com/docs/queries/limit.html (DOC) + live.

### 3.9 Geocoding (no key)

#### 3.9a US Census Geocoder (LIVE-VERIFIED) — default for US addresses
- Form: `https://geocoding.geo.census.gov/geocoder/{returntype}/{searchtype}?...` with returntype `locations | geographies`, searchtype `onelineaddress | address | coordinates | addressbatch | coordinatesbatch`.
- **`benchmark` is required** (live without it: `400 {"errors":["Benchmark must be specified"],"status":"400"}`). Use `benchmark=Public_AR_Current` (id `4`). `GET /geocoder/benchmarks` (live) lists `Public_AR_Current(4), Public_AR_ACS2026(8), Public_AR_LUCA(11), Public_AR_Census2020(2020)`. For `geographies/*` also pass `vintage=Current_Current` and optional `layers=Counties,Census Tracts`.
- US / Puerto Rico / Island Areas only (docs). Non-US: 200 with `addressMatches: []`.

```ts
const u = new URL("https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress");
u.search = new URLSearchParams({ address: "1 Dr Carlton B Goodlett Pl, San Francisco, CA 94102",
  benchmark: "Public_AR_Current", vintage: "Current_Current", layers: "Counties", format: "json" }).toString();
const { result } = await fetch(u).then(r => r.json());
const m = result.addressMatches[0];        // undefined if no match
const [lon, lat] = [m.coordinates.x, m.coordinates.y];
const countyFips = m.geographies.Counties[0].GEOID;   // "06075" -> join to FEMA/NWS SAME
```
Live `locations/onelineaddress` (0.45 s): `{"result":{"input":{...,"benchmark":{"id":"4","benchmarkName":"Public_AR_Current","isDefault":true}},"addressMatches":[{"tigerLine":{"side":"L","tigerLineId":"635441232"},"coordinates":{"x":-122.41831039539,"y":37.778536095745},"addressComponents":{"zip":"94102","streetName":"DR CARLTON P GOODLETT","city":"SAN FRANCISCO","state":"CA","suffixType":"PL","fromAddress":"1","toAddress":"99"},"matchedAddress":"1 DR CARLTON P GOODLETT PL, SAN FRANCISCO, CA, 94102"}]}}`.
Live `geographies/onelineaddress` with `layers=Counties,Census Tracts`: `geographies.Counties[0] = {GEOID:"06075", NAME:"San Francisco County", STATE:"06", COUNTY:"075"}`, `geographies["Census Tracts"][0].GEOID = "06075012405"`.
Reverse to county: `GET /geocoder/geographies/coordinates?x=-81.8761&y=27.2219&benchmark=Public_AR_Current&vintage=Current_Current&layers=Counties&format=json` -> `Counties: [("12027","DeSoto County")]` (live). Note `x`=lon, `y`=lat. Coordinates are interpolated along TIGER address ranges (not rooftop).
- Batch: `POST /geocoder/{locations|geographies}/addressbatch` multipart `addressFile=@file.csv`, `benchmark=4` (+`vintage=4` for geographies). CSV rows `Unique ID, Street address, City, State, ZIP`. "There is currently an upper limit of 10,000 records per batch file." (not called live).
Source: https://geocoding.geo.census.gov/geocoder/Geocoding_Services_API.pdf (DOC) + live.

#### 3.9b Nominatim (OSM) — LIVE-VERIFIED, but policy-restricted; dev/test and place names only
- `GET https://nominatim.openstreetmap.org/search?q=...&format=jsonv2&limit=1&addressdetails=1` -> 200 (0.74 s). `format=geojson&polygon_geojson=1` returns boundary polygons (e.g. "Arcadia, Florida" -> admin relation polygon). `GET /reverse?lat=&lon=&format=jsonv2&zoom=18` -> 200.
- **Empty User-Agent -> 403** (live). Policy requires a UA "identifying the application (stock User-Agents as set by http libraries will not do)".
- Result (live, trimmed): `[{"place_id":319846272,"licence":"Data © OpenStreetMap contributors, ODbL 1.0. http://osm.org/copyright","osm_type":"relation","osm_id":7261820,"lat":"37.7792929","lon":"-122.4192601","category":"amenity","type":"townhall","place_rank":30,"importance":0.44,"addresstype":"amenity","name":"San Francisco City Hall","display_name":"San Francisco City Hall, 1, Dr. Carlton B. Goodlett Place, ...","address":{"house_number":"1","road":"Dr. Carlton B. Goodlett Place","city":"San Francisco","state":"California","ISO3166-2-lvl4":"US-CA","postcode":"94102","country_code":"us"},"boundingbox":["37.7786554","37.7798972","-122.4198330","-122.4186300"]}]` — `lat`/`lon`/`boundingbox` are **strings**.
- Usage policy (https://operations.osmfoundation.org/policies/nominatim/, DOC) — the parts that bind us:
  - "an absolute maximum of 1 request per second"; limits apply to the sum of all users of the app.
  - "periodic requests from apps are considered bulk geocoding and as such are strongly discouraged"; "Scripts running longer than a day and scripts that are run at regular intervals are restricted to 4 requests per minute." Results must be cached; repeated identical queries may get you blocked.
  - Forbidden: autocomplete, systematic/grid queries, scraping details, and "Reselling of geocoding results: Applications and services whose primary function is related to geocoding must run their own service."
  - "Please do not submit personal data or other confidential material" — **don't send customer home addresses** to Nominatim.
  - Attribution required ("Data © OpenStreetMap contributors, ODbL 1.0"); must be able to switch provider without a software update.
  - The policy also says code generated by LLMs must follow it and the public API must not be wired in as a generic geocoder by vibe-coding tools; using it here is a deliberate, documented choice, limited to the cases above.
Source: https://operations.osmfoundation.org/policies/nominatim/ (DOC) + live `/search`, `/reverse`, empty-UA test.

### 3.10 Cross-feed join keys (verified)
- **County FIPS (5 digits)** is the universal join: FEMA `fipsStateCode+fipsCountyCode` ("12"+"037"); NWS `geocode.SAME` = "0"+FIPS ("012037"); Census geocoder `geographies.Counties[0].GEOID` ("12037"); MRDS WFS `fips_code` = "f"+FIPS ("f08049").
- **County polygon without a GIS stack**: NWS county zones are `{STATE}C{3-digit county FIPS}`. Live: `GET https://api.weather.gov/zones/county/AZC013` -> Maricopa, Polygon; `GET https://api.weather.gov/zones/county/FLC037` -> "Franklin" FL, **GeometryCollection** (711 KB). So a FEMA row (`state:"FL", fipsCountyCode:"037"`) maps to `/zones/county/FLC037`. Handle `Polygon | MultiPolygon | GeometryCollection`.
- **USGS site <-> NWS gauge**: NWPS gauge detail has `usgsId` ("02296750" for ARCF1); USGS IV uses `sites=02296750`; OGC API uses `monitoring_location_id=USGS-02296750`.
- Coordinates order: GeoJSON everywhere is `[lon, lat]`; Census uses `x`=lon,`y`=lat; Nominatim returns string `lat`/`lon`; MRDS WFS 1.1.0 is **lat lon**; NWS `point=lat,lon`; USGS IV `bBox=W,S,E,N`; FIRMS area `W,S,E,N`.

## 4. Discrepancies with the master prompt

| # | Spec says | Reality (verified) | Impact on build |
|---|---|---|---|
| 1 | 5.1 "USGS water and flood gauges" | USGS Water Services (`waterservices.usgs.gov`) banner: permanently shut down **2027-02-22**, intentional slowdowns/outages from Jan 2027; replacement is `api.waterdata.usgs.gov` (OGC API). Neither USGS API carries flood stages. | Use **NOAA NWPS + riv_gauges MapServer** for "gauge in flood" (they carry action/minor/moderate/major stages). Use USGS only for raw readings. Fine for the weekend. |
| 2 | 5.1 "Global Forest Watch alert datasets (may need an API key)" | `/query/json` and `/query/csv` return 403 without a key. **`/download/json` and `/download/csv` (POST `{sql, geometry}`) returned 200 without a key** for `gfw_integrated_alerts`, `wur_radd_alerts`. Getting a key requires creating a GFW account (`/auth/sign-up`) and the key is bound to `domains` + `Origin` header. | Build the forest playbook on `/download/json` now; request a key as a fallback (human task). Don't call GFW from the browser with a key unless the origin is allowlisted. |
| 3 | 5.1 "NASA FIRMS active fires" (no key mentioned) | Area API needs a free `MAP_KEY` (emailed). 24h/48h/7d CSV/KML/SHP files under `/data/active_fire/` need **no key**. S-NPP 24h files currently header-only (empty). | Use NOAA-20/NOAA-21 + MODIS 24h CSVs now. Key only adds bbox queries, history (`DATE`) and URT. |
| 4 | 5.1 "BLM mining claim records (MLRS)" | MLRS (`mlrs.blm.gov/s/`) is a Salesforce web app with no public API. BLM publishes MLRS-derived ArcGIS services; the NLSDB MapServer has `LOC_DT` null on all 595k rows. The **ArcGIS Hub FeatureServer `BLM_Natl_MLRS_Mining_Claims_Not_Closed`** has `Created`/`Modified` dates (6,621 claims created since 2026-10-01; newest 2026-11-07). | Mining signal = "new claims filed in last N days" from the Hub FeatureServer. Claimant names are **not** in these layers — Monid or MLRS web lookups are needed to find the business. |
| 5 | 5.1 "USGS mineral resource data (for example MRDS)" | MRDS: "As of 2011, USGS has ceased systematic updates". | MRDS is context for reports (known deposits nearby), not a trigger. |
| 6 | 5.1 "city building-permit open data portals (many cities use Socrata)" | True, but SF moved `data.sfgov.org` -> `data.sf.gov` (301). SODA 3 endpoints (`/api/v3/views/.../query.json`) need an app token (403); SODA 2 `/resource/{id}.json` works with no key. Costs/units are text. | Hard-code `data.sf.gov` and `/resource/` URLs. Cast numerics in SoQL. |
| 7 | 3.1 Brain 1 "Uses Monid (maps and places for geocoding...)" | Free, fast, no-key US geocoding exists (Census, 0.45 s, returns county FIPS directly). Nominatim's policy forbids periodic/bulk use (cron capped at 4 req/min), personal data, and "reselling of geocoding results" by services whose primary function is geocoding. | Default: Census geocoder for US addresses (inbound + demo), Monid for non-US/business places; Nominatim only for dev tests and one-off, user-triggered place-name lookups, with attribution and caching. |
| 8 | 5.1 "NWS alerts (`api.weather.gov/alerts`)" | Works, but 388 of 403 active alerts had **no geometry**; `/zones?include_geometry=true` doesn't return geometry; must GET each zone URL. Enums are case-sensitive TitleCase; `/alerts/active` has no paging params. | Build a zone-geometry cache (Neon table keyed by zone URL). |
| 9 | 5.1 "OpenFEMA disaster declarations" | Works with no key; county-level only (`designatedArea`, FIPS), **no geometry and no geojson format** (400). | Join to polygons via NWS county zones (3.10) or Census. FEMA is a slow, official signal: the declaration can lag the incident by weeks (example: DR-4955-FL, incident 10-06..10-12, declared 10-27). |
| 10 | 8 "Businesses for outbound; consumers through inbound only" | NYC DOB permits include individual owner/applicant names; FEMA/NWS/NWPS are area-level; FIRMS is points. | Signal -> business matching must go through Monid; filter permits on `owner_business_name`; never email individuals from permit data. |

## 5. Answers to open questions (spec section 14)

Section 14 contains no question about signal feeds or geocoding (its questions are about Naïve models, email wake-up, Neon extensions, imagery pricing, sponsors, and pitch logistics). The related open points embedded elsewhere in the spec, answered:
| Question (from spec text) | Answer | Source | Confidence |
|---|---|---|---|
| 5.1: Does Global Forest Watch need an API key? | For `/query/*` and `/analysis/*`: yes (403 without). For `/download/json|csv` with `{sql, geometry}`: no — worked live for integrated and RADD alerts. Key requires an account (sign-up -> token -> `/auth/apikey` with `domains`). | openapi.json + live calls | high (that it works today); medium (that it stays open) |
| 5.1: Which disaster feeds work without anyone answering an email? | NWS, USGS quakes, NWPS + riv_gauges, USGS water, FIRMS 24h files, NIFC WFIGS perimeters, OpenFEMA: all no-key, live 200. Only FIRMS area API needs an (emailed, free) key. | live | high |
| 5.1: Is there a machine-readable BLM MLRS feed? | Not MLRS itself; yes via BLM ArcGIS Hub FeatureServer (with `Created` date) and a Hub CSV bulk download. | live | high |
| 3.1/13: Can Brain 1 geocode a judge's address fast with no key? | Yes, US addresses: Census geocoder 0.45 s, returns lon/lat + county FIPS. Non-US: Nominatim (user-triggered, 1 req/s) or Monid. | live + policy page | high |
| 3.4: How to key signals into H3? | All feeds return lon/lat points or GeoJSON polygons (except FEMA: county FIPS -> NWS county zone polygon). `h3-js@4.5.0` exists on npm. Cell choice is the builders' call. | live, npm view | high |

## 6. Credentials needed

None of these are needed for the MVP; every feed has a working no-key path. All are free. A founder must create each (account or email signup).
| env var | service | where to get it | cost | what it unlocks |
|---|---|---|---|---|
| `NWS_USER_AGENT` | NWS api.weather.gov | not a credential: a string we choose, e.g. `Terragent/0.1 (terragent.vercel.app, <ops inbox>)`. Docs ask for app id + optional contact so NWS can reach us. Use a team/ops address, not a personal one. | free | required header (empty UA -> 403) |
| `FIRMS_MAP_KEY` | NASA FIRMS | https://firms.modaps.eosdis.nasa.gov/api/map_key/ — enter an email, key is emailed | free | Area API (bbox, `DAY_RANGE` 1-5, `DATE` history, URT/RT), 5000 transactions / 10 min |
| `GFW_API_KEY` | Global Forest Watch Data API | account via `POST https://data-api.globalforestwatch.org/auth/sign-up {name,email}` (or GFW website account), then `POST /auth/token` -> `POST /auth/apikey {alias, organization, email, domains:["terragent.vercel.app","localhost"]}`; valid 1 year | free | `/query/json|csv`, `/analysis/zonal`; higher rate tier when `domains` set. Send `x-api-key` + matching `Origin` header |
| `USGS_WATERDATA_API_KEY` | USGS Water Data OGC API (api.data.gov key) | signup page linked from https://api.waterdata.usgs.gov/docs/ogcapi/keys/ — key emailed | free | higher hourly limit (`?api_key=` or `X-Api-Key`), avoids 429 |
| `SOCRATA_APP_TOKEN` | Socrata portals (data.sf.gov, data.cityofnewyork.us) | create in the developer settings of a Socrata/Tyler account on any portal (UNVERIFIED exact click path) | free | per-app throttling pool instead of shared IP pool; required for SODA 3 endpoints |
No key exists or is needed for: USGS earthquakes, NWPS, riv_gauges MapServer, NIFC WFIGS, OpenFEMA, MRDS, BLM ArcGIS services, US Census geocoder, Nominatim (UA + policy only).

## 7. Gotchas & limits

| feed | limits / quotas | payload & latency (live) | other traps |
|---|---|---|---|
| NWS alerts | rate limit "not public", "generous"; on excess retry after ~5 s. `cache-control: max-age=5`. | `/alerts/active` 1.8 MB, 1.6 s; zone 50-700 KB each | Non-empty UA required. TitleCase enums. No `limit` on `/alerts/active`. `area`/`point`/`zone`/`region`/`region_type` mutually exclusive. Most alerts zone-only. `messageType: Update` re-issues the same event -> dedupe on the VTEC office/phenomenon/significance/ETN segment (e.g. `KPSR.FA.W.0040` from `/O.EXT.KPSR.FA.W.0040.000000T0000Z-261109T0600Z/`) or follow `references`. Includes 1 `Test` alert -> filter `status=actual`. |
| USGS quakes | feeds "updated every minute"; `max-age=60` | 0.3-123 KB | `time` is epoch ms. `alert` null for most events. Coordinates have depth as 3rd element. `significant_week` can be empty (0 features). |
| NWPS | none documented | full list 13.2 MB, **37-54 s, also seen 504**; gauge detail 48 KB/0.7 s; stageflow 430 KB | `-999`/`-9999` = missing. `floodCategory` typed as plain string; full vocabulary in 3.3a. |
| riv_gauges MapServer | maxRecordCount 10000 | in-flood query 6.5 KB / 0.33 s | Numbers are strings. `flood` field = minor flood stage. ~1 h behind NWPS in sample. |
| USGS waterservices IV | IP-based blocking (403) on abuse; one major filter; bBox area ≤ 25 sq deg | bbox 84 KB took 6.5 s; state 775 KB/1.2 s | **Decommission 2027-02-22**. Values are strings; `-999999` no-data. Ask for gzip. |
| USGS OGC API | 429 when over anonymous limit; key raises it (`X-RateLimit-*` headers) | 0.25 s | `latest-continuous` includes stale series (2025 dates). |
| FIRMS files | none (static files) | US 24h 0.2 MB; global 24h 9-10 MB, ~11 s | Regenerated continuously; poll ≤ every 15-30 min. VIIRS confidence `low/nominal/high` vs MODIS 0-100. S-NPP currently empty. Points are pixels, not fires. |
| FIRMS area API | **5000 transactions / 10 min** per MAP_KEY; multi-day counts as multiple | n/a | `DAY_RANGE` max 5. Bad key -> 400 `Invalid MAP_KEY.` (plain text, not JSON). |
| NIFC WFIGS | ArcGIS defaults | 59 perimeters, 0.37 s | Includes prescribed burns (`RX`). |
| OpenFEMA | not documented in anything we could fetch (docs site 403s curl) | 0.3 s; `$top=10001` returned 9.1 MB | Default `$top` 1000. `metadata.count` is 0 unless `$count=true`. No geojson. One row per county per declaration. |
| GFW Data API | anonymous / no-domain keys = "lowest rate limiting tier" (numbers UNVERIFIED) | 2-3 s per query; 1°x1° aggregate OK | Raster datasets need a geometry (422 otherwise). Version pinned in URL (`/latest` is a 307 redirect; follow it or resolve once per day). Integrated alerts cover 30°N-30°S only. COUNT alias ignored; MIN/MAX dropped. Licence CC BY 4.0: attribute "UMD/GLAD and WUR". |
| MRDS | none | WFS 0.3 s; CSV zip 25.8 MB | GML only. WFS 1.1.0 axis order lat,lon. Not updated since 2011. |
| BLM Hub claims | maxRecordCount 2000 -> page with `resultOffset` | 0.2-0.3 s | `outStatistics` -> 400. NLSDB MapServer alternative is 10-19 s and has null dates. Polygons are PLSS-derived approximations (`QLTY`, `SRC:"LLD"`). |
| Socrata | no token: shared per-IP throttle; `$limit` default 1000, max 50,000 on 2.0 endpoints | 0.4-2 s | Nulls first on `DESC`. Text-typed numbers. Floating timestamps (no TZ; presumably city-local time — UNVERIFIED). SODA 3 needs token. |
| Census geocoder | rate limits not stated in the API PDF; batch ≤ 10,000 rows/file | 0.45 s | `benchmark` required. US only. Interpolated, not rooftop. |
| Nominatim | **1 req/s absolute max** across all users; periodic/cron scripts **4 req/min**; must cache | 0.3-0.7 s | No autocomplete, no grid/systematic queries, no personal data, attribution required, no reselling by geocoding-centric services. Empty UA -> 403. |

Recommended architecture: one Naïve cron (`loose` window) per playbook that polls the feeds below, normalizes each event to `{source, source_id, event_type, severity, observed_at, geometry, county_fips?, url}` and upserts into Neon with a unique key on `(source, source_id)` so re-polls are idempotent.
(critic-verified against Naïve docs) **How the cron agent actually polls and writes:**
- Don't use the agent's `web_fetch`. It returns page text truncated at `max_content_tokens` (default 4000), which cuts off the 1.8 MB NWS JSON and the FIRMS CSVs, and it doesn't send POST bodies such as GFW `/download/json`.
- A Naïve sandbox can't hold `DATABASE_URL`: the vault injects only into MCP connections (naive-orchestration.md §3.7).
- So either the cron agent calls a Terragent MCP tool (e.g. `signals_poll({playbook})`) that fetches, normalises and upserts on Vercel (≤300 s), or the agent runs `curl`/Python in its computer (every feed here is keyless) and passes the normalised rows to an MCP write tool.

The first option keeps tokens low, because the feed bytes never enter model context.

## 8. Unverified

Everything below was NOT confirmed. Each line says how to confirm it.
- **NWS**: numeric rate limit (docs say not public). Confirm by watching for non-200s under load; back off 5 s.
- **USGS quakes**: `alert` value `red` (only green/yellow/orange observed live); ShakeMap product file names in the detail feed (predecessor saw `cont_mmi.json`; not re-fetched). Confirm with `GET .../detail/{id}.geojson` on a large event.
- **NWPS**: rate limits; whether `/gauges/{identifier}` accepts a USGS site id as well as the LID; meaning of `catfim=true`; `/monitor` and `raag` payloads. Confirm via swagger UI calls.
- **riv_gauges MapServer**: timezone of `obstime` (assumed UTC); refresh cadence (~1 h lag observed once).
- **USGS OGC API**: anonymous rate limit number (no `X-RateLimit-*` headers on anonymous responses). Confirm with a key: headers appear.
- **FIRMS Area API**: actual response with a real key (assumed same columns as the 24h CSVs); `data_availability` response shape; whether 48h/7d file contents match their names (only HEAD/range checked). Confirm once `FIRMS_MAP_KEY` exists: `curl https://firms.modaps.eosdis.nasa.gov/api/area/csv/$FIRMS_MAP_KEY/VIIRS_NOAA20_NRT/-125,32,-114,42/1 | head`.
- **OpenFEMA**: published rate limits, max `$top`, and any key policy — fema.gov docs pages return 403 to non-browser clients. Confirm by opening https://www.fema.gov/about/openfema/api in a normal browser.
- **GFW**: (a) whether `/download/*` will stay open without a key; (b) rate limits for anonymous and keyed use; (c) maximum geometry size / query timeout (1°x1° worked; larger untested); (d) what the sign-up email contains (password vs link). Confirm (a)/(b) after getting `GFW_API_KEY`: call `/query/json` with `x-api-key` + `Origin` and compare headers.
- **MRDS**: total row count of `mrds.csv` (only first 1,665 rows decoded) and full value lists of `dev_stat`, `prod_size`, `score` (A not seen in sample).
- **BLM Hub**: exact refresh schedule (inferred daily from `Created` = midnight UTC values); whether `Created` is the MLRS filing date or the ETL load date (they may differ — high risk for "new claim" logic; check a few `CSE_NR` in the MLRS web app); claimant names not present in either service.
- **Socrata**: numeric throttle limits without a token; exact path to create an app token; timezone of floating timestamps.
- **Census geocoder**: rate limits (not in the API PDF); batch endpoints not called live.
- **Python packages** (`requests`, `h3`, `shapely`) versions: not checked with pip.
- **NIFC WFIGS**: full field list (`outFields=*` not inspected; only 6 fields used) and refresh cadence.

## 9. Feed summary table

| feed | works now without key? | key needed for | recommended poll |
|---|---|---|---|
| NWS `/alerts/active` (+ `/zones/...` polygons) | **Yes** (UA required) | — | every 10 min (`max-age=5`; cache zone geometries indefinitely) |
| USGS quakes summary GeoJSON | **Yes** | — | every 5 min (`significant_week` / `4.5_day`) |
| NOAA riv_gauges MapServer layer 0 (in-flood query) | **Yes** | — | every 30-60 min |
| NOAA NWPS `/gauges/{lid}` detail + stageflow | **Yes** | — | on demand per flooded gauge; never poll the full list |
| USGS waterservices IV (legacy) | **Yes** (until 2027-02-22) | — | on demand |
| USGS Water Data OGC API | **Yes** (lower limit) | higher rate limit (`USGS_WATERDATA_API_KEY`) | on demand |
| FIRMS 24h CSV (NOAA-20/21, MODIS) | **Yes** | — | every 30-60 min |
| FIRMS Area API | No | `FIRMS_MAP_KEY` (free, email) | every 30-60 min per AOI |
| NIFC WFIGS current perimeters | **Yes** | — | every 30-60 min |
| OpenFEMA DisasterDeclarationsSummaries v2 | **Yes** | — | every 6-12 h |
| GFW `/download/json` (integrated, GLAD-L, GLAD-S2, RADD) | **Yes** (observed; could change) | — | daily per AOI (new dataset version ~daily) |
| GFW `/query/json`, `/analysis/zonal` | No | `GFW_API_KEY` (account + domains) | daily per AOI |
| USGS MRDS WFS / CSV | **Yes** | — | one-time load (static since 2011) |
| BLM MLRS claims Hub FeatureServer (`Created`) | **Yes** | — | daily |
| BLM NLSDB MiningClaims MapServer | **Yes** (slow, no dates) | — | avoid; use Hub layer |
| SF permits `data.sf.gov/resource/i98e-djp9` | **Yes** | SODA 3 / higher throttle (`SOCRATA_APP_TOKEN`) | daily |
| NYC DOB NOW permits `rbx6-tga4` | **Yes** | same | daily |
| US Census geocoder | **Yes** | — | on demand |
| Nominatim | **Yes** (UA + policy) | — | on demand only, ≤1 req/s; any cron use ≤4 req/min, cached |

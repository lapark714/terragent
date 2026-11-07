# Free satellite imagery and the analysis pipeline (Planetary Computer STAC)

Status: COMPLETE (research agent, 2026-11-07). Everything outside section 8 was checked live, in installed package source, or on a cited primary page on 2026-11-07. Scratch artefacts (scripts, raw responses, PNGs): `/private/tmp/claude-504/-Users-laurence-terragent/22c3e839-95bd-4a29-a8d4-0ec9c4c36ffd/scratchpad/research/imagery/`.

## 1. TL;DR for builders

- **No key, no account, no money.** STAC search, SAS signing and COG reads on Planetary Computer (PC) all work anonymously (verified live). Python: `pip install pystac-client planetary-computer rasterio numpy pillow shapely pyproj` (all wheels, 9.6 s, needs Python >= 3.12 for current rasterio/numpy/pyproj).
- The calls that matter: (1) `pystac_client.Client.open(STAC_URL, modifier=planetary_computer.sign_inplace)` (2) `.search(collections=["sentinel-2-l2a"], intersects=..., datetime=..., query={"eo:cloud_cover":{"lt":30}}, sortby=..., max_items=20)` (3) read the 20 m `SCL` window to check the AOI is clear (4) `rasterio.open(item.assets["B04"].href)` + `from_bounds(...)` windowed read in the item's UTM CRS (5) `reflectance = (DN - 1000)/10000` when `s2:processing_baseline >= "04.00"`.
- Measured: before/after pair for a 2x2 km AOI in **7-31 s** end to end (fits the 2-minute demo). Seed script in 3.12, tested on downtown LA and the Jan 2025 Eaton fire (dNBR detects the burn).
- No-Python option: the PC data API (TiTiler) returns cropped true-colour / NDVI PNGs in ~1.2 s and zonal stats in ~0.8 s from a plain `fetch` (3.8). Good for Next.js and the globe.
- Traps: (a) PC applies **no** BOA offset metadata, so you apply -1000 yourself; (b) pystac 1.16 renames `proj:epsg` → `proj:code`; (c) always pass `max_items`; (d) `eo:cloud_cover` is per 110 km tile, so check the AOI with SCL; (e) signed hrefs die after **45 min**; (f) the COG nodata tag is unset, so DN 0 must be masked by hand; (g) SCL calls dark urban shadow "water".
- Copernicus Data Space search is open, but downloads need an account (HTTP 401). Keep it as a human-gated fallback only.

## 2. Install & setup

Python (sandbox / Analytics agent). Verified with a fresh venv on macOS arm64, CPython 3.13.15, `pip install --no-cache-dir`: **9.6 s wall clock, all binary wheels, no compiler needed.**

```bash
python3 -m venv .venv && .venv/bin/pip install pystac-client planetary-computer rasterio numpy pillow shapely pyproj
```

| package | version resolved 2026-11-07 | requires_python | cp313 binary wheels on PyPI |
|---|---|---|---|
| pystac-client | 0.9.1 (2026-10-20) | >=3.10 | pure python |
| planetary-computer | 1.0.0 (2023-07-05) | >=3.7 | pure python (pulls pydantic, python-dotenv, click, pytz) |
| pystac | 1.16.0 (**2026-11-04**, pulled transitively) | >=3.10 | pure python; now a meta-package over `pystac-core` + 22 `pystac-ext-*` packages |
| rasterio | 1.5.2 (2026-09-30) | **>=3.12** | macosx_15_0 arm64/x86_64, manylinux_2_28 x86_64/aarch64, win (bundles GDAL) |
| numpy | 2.5.4 | **>=3.12** | macOS 10.13+/11+/14+, manylinux_2_28, musllinux |
| pillow | 13.0.0 | >=3.11 | macOS, manylinux_2_28, musllinux |
| shapely | 2.2.0 | >=3.11 | macOS, manylinux_2_28, musllinux |
| pyproj | 3.8.0 | **>=3.12** | macosx_14_0 arm64, macosx_15_0 x86_64, manylinux_2_28, musllinux |
| odc-stac (optional) | 0.5.3 | >=3.10 | pure python but pulls dask[array], xarray, pandas, odc-geo, odc-loader. **Not light; not used.** |

Source: `https://pypi.org/pypi/<pkg>/json` (fetched 2026-11-07), `pip list` of the fresh venv.

Notes:
- rasterio 1.5.x has **no musllinux wheel** (Alpine would need GDAL from source) and needs glibc >= 2.28. On Python 3.11 pip silently falls back to rasterio 1.4.4, numpy 2.4.6, pyproj 3.7.2; on 3.10 to rasterio 1.4.4, numpy 2.2.6, pyproj 3.7.1 (last releases per `requires_python`, from PyPI JSON). The seed script uses nothing version-specific, but wheel availability for those older versions on the sandbox platform is not checked. Check `python3 --version` in the Naive sandbox first.
- No API key, no account, no config file is needed for anything in this doc.
- Node/TypeScript: there is no official Planetary Computer JS SDK. From Next.js, call the REST endpoints directly with `fetch` (search = POST JSON, sign = GET). The heavy pixel work stays in Python.

## 3. API reference

### 3.1 Endpoints (all anonymous, all verified live 2026-11-07)

| purpose | method + URL | auth |
|---|---|---|
| STAC root (landing page) | `GET https://planetarycomputer.microsoft.com/api/stac/v1/` | none |
| search | `POST https://planetarycomputer.microsoft.com/api/stac/v1/search` (JSON body) or `GET .../search?...` | none |
| collection | `GET .../api/stac/v1/collections/{collection_id}` | none |
| queryables | `GET .../api/stac/v1/collections/{collection_id}/queryables` | none |
| item | `GET .../api/stac/v1/collections/{collection_id}/items/{item_id}` | none |
| SAS token for a collection | `GET https://planetarycomputer.microsoft.com/api/sas/v1/token/{collection_id}` | none (optional header `Ocp-Apim-Subscription-Key`) |
| SAS token for account/container | `GET https://planetarycomputer.microsoft.com/api/sas/v1/token/{storage_account}/{container}` | none |
| sign one URL | `GET https://planetarycomputer.microsoft.com/api/sas/v1/sign?href={blob_url}` | none |

STAC root response (trimmed): `"id": "microsoft-pc"`, `"title": "Microsoft Planetary Computer STAC API"`, `"stac_version": "1.0.0"`. `conformsTo` includes `item-search`, `item-search#query`, `item-search#sort`, `item-search#fields`, `item-search#filter` (CQL2 text + JSON), `ogcapi-features`. Both `GET` and `POST` `rel=search` links are advertised.

Source: live `GET https://planetarycomputer.microsoft.com/api/stac/v1` (2026-11-07 22:24 UTC).

### 3.2 Collection `sentinel-2-l2a` (exact id)

- Title "Sentinel-2 Level-2A"; temporal extent `2015-06-27T10:25:31Z` to open; processed with Sen2Cor, stored as COGs in Azure `westeurope`, storage account `sentinel2l2a01`, container `sentinel2-l2`.
- Item ids look like `S2C_MSIL2A_20261024T183431_R027_T11SLT_20261024T214812` (platform, datatake time, relative orbit, MGRS tile, generation time).
- Live items include **Sentinel-2C** (`"platform": "Sentinel-2C"`), even though the collection `summaries.platform` still says only `["Sentinel-2A","Sentinel-2B"]`. Do not filter on platform.

Asset keys (from collection `item_assets`, matches a live item):

| asset key | band / content | common_name | centre wl (um) | gsd (m) | notes |
|---|---|---|---|---|---|
| `B01` | coastal aerosol | coastal | 0.443 | 60 | |
| `B02` | blue | blue | 0.49 | 10 | |
| `B03` | green | green | 0.56 | 10 | |
| `B04` | red | red | 0.665 | 10 | |
| `B05` `B06` `B07` | red edge 1/2/3 | rededge | 0.704 / 0.74 / 0.783 | 20 | |
| `B08` | NIR (broad) | nir | 0.842 | 10 | use for NDVI/NDWI/NBR at 10 m |
| `B8A` | narrow NIR ("Vegetation red edge 4") | rededge | 0.865 | 20 | |
| `B09` | water vapour | (none) | 0.945 | 60 | |
| `B11` | SWIR 1.6 | swir16 | 1.61 | 20 | |
| `B12` | SWIR 2.2 | swir22 | 2.19 | 20 | |
| `SCL` | scene classification map (uint8) | - | - | 20 | cloud mask, see 3.6 |
| `AOT`, `WVP` | aerosol optical thickness, water vapour | - | - | 10 | quantification 1000 |
| `visual` | true-colour TCI, 3-band uint8 (B04,B03,B02) | - | - | 10 | ready-made RGB, already stretched by ESA |
| `preview` | thumbnail | - | - | - | role `thumbnail` |
| `product-metadata` | `MTD_MSIL2A.xml` | - | - | - | has `BOA_ADD_OFFSET`, SCL legend |
| `granule-metadata`, `datastrip-metadata`, `inspire-metadata`, `safe-manifest` | XML | | | | |
| `tilejson`, `rendered_preview` | links to the PC data (TiTiler) API | | | | present on items, not in item_assets |

There is **no** B10 in L2A. Assets carry `proj:bbox`, `proj:shape`, `proj:transform`, `gsd`, `eo:bands` but **no `raster:bands` scale/offset** (unlike Landsat). Item properties carry `"proj:epsg": 32611` (int); there is no `proj:code` in the raw JSON.

Real item properties (trimmed, LA tile 11SLT):
```json
{"datetime":"2026-10-24T18:34:31.025000Z","platform":"Sentinel-2C","proj:epsg":32611,
 "s2:mgrs_tile":"11SLT","eo:cloud_cover":0.004011,"s2:processing_baseline":"05.13",
 "s2:product_uri":"S2C_MSIL2A_20261024T183431_N0513_R027_T11SLT_20261024T214812.SAFE",
 "s2:generation_time":"2026-10-24T21:48:12.000000Z","sat:relative_orbit":27,
 "s2:water_percentage":57.80,"s2:vegetation_percentage":10.41,"s2:nodata_pixel_percentage":0.0,
 "s2:high_proba_clouds_percentage":0.000338,"s2:medium_proba_clouds_percentage":0.00284,
 "s2:thin_cirrus_percentage":0.000833,"s2:cloud_shadow_percentage":0.0,
 "s2:snow_ice_percentage":0.00653,"s2:reflectance_conversion_factor":1.00937}
```

Queryables (usable in `query` / `filter`): `id, datetime, geometry, proj:epsg, instruments, end_datetime, s2:mgrs_tile, constellation, s2:granule_id, eo:cloud_cover, s2:datatake_id, s2:product_uri, start_datetime, s2:datastrip_id, s2:product_type, sat:orbit_state, s2:datatake_type, s2:generation_time, sat:relative_orbit, s2:water_percentage, s2:mean_solar_zenith, s2:mean_solar_azimuth, s2:processing_baseline, s2:snow_ice_percentage, s2:vegetation_percentage, s2:thin_cirrus_percentage, s2:cloud_shadow_percentage, s2:nodata_pixel_percentage, s2:unclassified_percentage, s2:dark_features_percentage, s2:not_vegetated_percentage, s2:degraded_msi_data_percentage, s2:high_proba_clouds_percentage, s2:reflectance_conversion_factor, s2:medium_proba_clouds_percentage, s2:saturated_defective_pixel_percentage`.

Source: live `GET .../collections/sentinel-2-l2a`, `.../collections/sentinel-2-l2a/queryables`, `POST .../search` (2026-11-07).

### 3.3 Collection `landsat-c2-l2` (exact id)

- Title "Landsat Collection 2 Level-2"; extent `1982-08-22` to open; platforms `landsat-4,5,7,8,9`; storage account `landsateuwest`, container `landsat-c2`.
- Asset keys are **common names**, not `SR_B4`: `coastal, blue, green, red, nir08, swir16, swir22, lwir11` (L8/9 TIRS B10), `lwir` (TM/ETM+), `qa_pixel`, `qa_radsat`, `qa_aerosol`, `cloud_qa`, `atran, cdist, drad, emis, emsd, trad, urad, qa`, `atmos_opacity`, `mtl.txt`, `mtl.xml`, `mtl.json`, `ang`.
- Reflectance assets carry `raster:bands`: `{"scale": 2.75e-05, "offset": -0.2, "nodata": 0, "data_type": "uint16", "spatial_resolution": 30}` → `reflectance = DN * 0.0000275 - 0.2`.
- Surface temperature (`lwir11`, `lwir`): `{"unit":"kelvin","scale":0.00341802,"offset":149,"nodata":0}` → `K = DN * 0.00341802 + 149`.
- `qa_pixel`: uint16 bit flags, `nodata: 1`.
- Landsat-specific queryables: `landsat:wrs_path, landsat:wrs_row, landsat:cloud_cover_land, landsat:collection_category, landsat:correction, platform, view:sun_elevation, eo:cloud_cover, ...`.

Source: live `GET .../collections/landsat-c2-l2` and `/queryables` (2026-11-07).

### 3.4 SAS signing (anonymous: works)

Live anonymous response from `GET /api/sas/v1/token/sentinel-2-l2a` (sig redacted):
```json
{"msft:expiry":"2026-11-07T23:09:59Z",
 "token":"st=2026-11-06T22%3A24%3A59Z&se=2026-11-07T23%3A09%3A59Z&sp=rl&sv=2025-07-05&sr=c&skoid=...&sktid=...&skt=...&ske=...&sks=b&skv=2025-07-05&sig=REDACTED"}
```
- Issued 22:24:59 UTC, expires 23:09:59 UTC: **anonymous token lifetime = 45 minutes** (outside West Europe, no key). `sp=rl` = read+list, `sr=c` = whole container. Response headers carry **no rate-limit headers** (`x-azure-ref`, `x-cache: CONFIG_NOCACHE` only).
- Signed URL = `{blob_href}?{token}`. `GET /api/sas/v1/sign?href=...` returns `{"msft:expiry": ..., "href": "<signed url>"}`.
- An **unsigned** blob GET returns HTTP **409** (public access disabled). If you see 403/409 on a COG, the token is missing or expired.
- Token/container map: `sentinel-2-l2a` → `sentinel2l2a01/sentinel2-l2`; `landsat-c2-l2` → `landsateuwest/landsat-c2`.

Python package internals (`planetary_computer` 1.0.0, `sas.py`):
- `planetary_computer.sign(obj)` accepts str URL, `Asset`, `Item`, `ItemCollection`, `ItemSearch`, or a mapping; `sign_inplace(obj)` = `sign(obj, copy=False)` and is the intended `modifier=` for `pystac_client.Client.open`.
- `sign_url` only signs hosts ending `.blob.core.windows.net` (skips `ai4edatasetspublicassets` and URLs already containing `st/se/sp`).
- `get_token(account, container, retry_total=10, retry_backoff_factor=0.8)` keeps a process-wide `TOKEN_CACHE` keyed by `{sas_url}/{account}/{container}` and refreshes when `ttl() < 60` s. It retries on `429, 500, 502, 503, 504`.
- Sends `Ocp-Apim-Subscription-Key` header only if `PC_SDK_SUBSCRIPTION_KEY` env var (or `~/.planetarycomputer/settings.env`) is set. `PC_SDK_SAS_URL` overrides the token endpoint.

Source: live calls above; `venv_fresh/lib/python3.13/site-packages/planetary_computer/sas.py` lines 36-110, 139-170, 417-476; `settings.py` lines 8-65; docs `https://raw.githubusercontent.com/microsoft/PlanetaryComputerDataCatalog/main/docs/concepts/sas.md` ("Datasets in the Planetary Computer are anonymously accessible: you don't need to supply a subscription key").

### 3.5 Sentinel-2 L2A radiometry: BOA_ADD_OFFSET (processing baseline >= 04.00)

Verified in the product metadata XML (`product-metadata` asset = `MTD_MSIL2A.xml`) of two live items:

| item | `s2:processing_baseline` | `BOA_QUANTIFICATION_VALUE` | `BOA_ADD_OFFSET` | SATURATED DN |
|---|---|---|---|---|
| S2C_MSIL2A_20261024T183431_R027_T11SLT_... | `05.13` | 10000 | `-1000` for all 13 bands (`band_id` 0-12) | 32767 |
| S2A_MSIL2A_20210612T182921_R027_T11SLT_... | `02.12` | 10000 | **absent** | 65535 |

Formula: `reflectance = (DN + BOA_ADD_OFFSET) / BOA_QUANTIFICATION_VALUE`, DN 0 = NODATA.

Detect it from STAC, not from the date: `float(item.properties["s2:processing_baseline"]) >= 4.0` → offset -1000. Live boundary over LA tile 11SLT: 2022-01-24 item is `03.00`, 2022-01-28 item is `04.00`. PC has **not** reprocessed the old archive (2018 and 2021 items are still `02.12`/`03.00`), so a single date range can mix both. Values seen: `02.12`, `03.00`, `04.00`, `05.13`.

Source: live `product-metadata` XML of the two items (fetched with `planetary_computer.sign_url`), live searches 2018-06, 2021-06, 2022-01/02.

### 3.6 SCL classes (verified from the product's own legend)

`Scene_Classification_List` in `MTD_MSIL2A.xml` (PB 05.13): `0 SC_NODATA, 1 SC_SATURATED_DEFECTIVE, 2 SC_CAST_SHADOW, 3 SC_CLOUD_SHADOW, 4 SC_VEGETATION, 5 SC_NOT_VEGETATED, 6 SC_WATER, 7 SC_UNCLASSIFIED, 8 SC_CLOUD_MEDIUM_PROBA, 9 SC_CLOUD_HIGH_PROBA, 10 SC_THIN_CIRRUS, 11 SC_SNOW_ICE`. In PB 02.12 class 2 is named `SC_DARK_FEATURE_SHADOW`; codes are identical.

Mask (invalid) default: **`{0, 1, 3, 8, 9, 10}`** (nodata, saturated, cloud shadow, cloud medium, cloud high, cirrus). Optional extras: `2` (cast/topographic shadow, mountains), `11` (snow) for vegetation work, `7` (unclassified) if strict. Keep `6` (water) for NDWI/MNDWI.

Source: live MTD XML of both items above.

### 3.7 pystac / pystac-client behaviour (verified in installed source and by running)

- `pystac_client.Client.open(url, headers=None, parameters=None, ignore_conformance=None, modifier=None, request_modifier=None, stac_io=None, timeout=None)`. Pass `modifier=planetary_computer.sign_inplace` and every item/asset it returns is signed automatically.
- `Client.search(*, method="POST", max_items=None, limit=None, ids=None, collections=None, bbox=None, intersects=None, datetime=None, query=None, filter=None, filter_lang=None, sortby=None, fields=None) -> ItemSearch`. `ItemSearch.items()`, `.items_as_dicts()`, `.pages()`, `.item_collection()`, `.matched()`.
- **Always pass `max_items`**: iteration follows `rel=next` links (PC returns a `next` link with `"method": "POST"` and a `token` in the body) until the result set is exhausted.
- PC search responses carry **no `numberMatched` / `context`**, so `ItemSearch.matched()` cannot give a count.
- **pystac 1.16.0 (released 2026-11-04) migrates items on load**: raw JSON `"proj:epsg": 32611` becomes `item.properties["proj:code"] == "EPSG:32611"` and `proj:epsg` is **removed**; extension URIs become projection v2.0.0 / eo v1.1.0. Code that does `item.properties["proj:epsg"]` raises `KeyError`. Read either key (see `epsg_of` in 3.9). Raw `fetch()` JSON in TypeScript still has `proj:epsg`.

Source: `venv_fresh/lib/python3.13/site-packages/pystac_client/client.py` lines 99-110 and 501-517; `item_search.py` lines 765-858; live run of `check_pystac.py` (prints `has proj:epsg False ... has proj:code True EPSG:32611`).

### 3.8 Data API (TiTiler) as a no-Python fallback: verified live

`https://planetarycomputer.microsoft.com/api/data/v1` (OpenAPI title "Preview of Tile Access Features"), anonymous, no SAS needed (the server signs). 48 paths, including:
`/item/bbox/{minx},{miny},{maxx},{maxy}/{width}x{height}.{format}`, `/item/bbox/{minx},{miny},{maxx},{maxy}.{format}`, `/item/crop` (POST GeoJSON), `/item/statistics` (GET/POST), `/item/point/{lon},{lat}`, `/item/preview.{format}`, `/item/tiles/{tileMatrixSetId}/{z}/{x}/{y}.{format}`, `/item/{tileMatrixSetId}/tilejson.json`, `/item/info`.
`format` enum: `png, npy, tif, jpeg, jpg, jp2, webp, pngraw`. Required query: `collection`, `item`. Optional: `assets`, `expression`, `asset_bidx`, `asset_as_band`, `nodata`, `unscale`, `rescale`, `colormap_name`, `colormap`, `color_formula`, `coord_crs` (default epsg:4326), `dst_crs`, `resampling`, `max_size`, `return_mask`.

Live results (LA 2 km box, item `S2C_MSIL2A_20261024T183431_R027_T11SLT_20261024T214812`):
```bash
D=https://planetarycomputer.microsoft.com/api/data/v1
IT=S2C_MSIL2A_20261024T183431_R027_T11SLT_20261024T214812
BB=-118.2608,34.0410,-118.2392,34.0590            # lon/lat, EPSG:4326
# true colour from the TCI asset: 200 image/png 166 kB in 1.24 s
curl "$D/item/bbox/$BB/400x400.png?collection=sentinel-2-l2a&item=$IT&assets=visual&asset_bidx=visual%7C1,2,3&nodata=0"
# NDVI colour map: 200 image/png 117 kB in 1.26 s. Expression uses BARE asset names + asset_as_band=true
curl "$D/item/bbox/$BB/400x400.png?collection=sentinel-2-l2a&item=$IT&expression=(B08-B04)/(B08%2BB04)&asset_as_band=true&rescale=-0.2,0.8&colormap_name=rdylgn"
# zonal stats: POST a GeoJSON Feature -> 200 in 0.76 s
curl -X POST -H 'content-type: application/json' "$D/item/statistics?collection=sentinel-2-l2a&item=$IT&expression=(B08-B04)/(B08%2BB04-2000)&asset_as_band=true" -d '{"type":"Feature","properties":{},"geometry":{"type":"Polygon","coordinates":[[[-118.2608,34.041],[-118.2392,34.041],[-118.2392,34.059],[-118.2608,34.059],[-118.2608,34.041]]]}}'
```
- Expression `(B08_b1-B04_b1)/...` fails with HTTP 500 `"Could not find any valid assets in ... expression"`; use `B08`, `B04` with `asset_as_band=true`.
- `GET /item/statistics` without a geometry returned 500 (whole 110 km tile); POST with a Feature works. Its `median` NDVI over the box = 0.0708, which matches the local rasterio pipeline (0.0706).
- The server does **not** apply BOA_ADD_OFFSET (no raster:bands metadata, so `unscale` does nothing). For PB >= 04.00, write `(B08-B04)/(B08+B04-2000)` (the numerator offsets cancel, the denominator does not). Dark pixels with `B08+B04 < 2000` give inf / -155 (stats came back `mean: null, max: 1.79e308`), so use `median` and percentiles, or the Python pipeline.
- `nodata=0` with the `visual` asset makes pure-black building shadows transparent.

Source: live `GET .../api/data/v1/openapi.json`, live requests above (2026-11-07 ~22:35 UTC).

### 3.9 The pipeline, run end to end (live, 2026-11-07)

Script: `pipeline2.py` for the first three runs, then the cleaned `terragent_imagery.py` (full code in 3.12; it also reads B8A for NBR). Flow: STAC search (cloud filter, newest first) → drop items whose footprint does not fully contain the AOI → screen candidates by reading only the 20 m SCL window (cheap) and take the first with >= 80 % clear AOI → parallel windowed reads of B02 B03 B04 B08 (B8A) B11 B12 SCL → BOA offset → indices → PNGs + JSON. Repeated for "before" and "after" ranges, then change metrics.

COG facts (rasterio on a live signed B04/SCL href): `uint16` (SCL `uint8`), **512x512 internal tiles**, deflate, overviews `[2, 4, 8, 16]`, **`nodata=None`** (DN 0 is not auto-masked; mask it yourself), `scales=(1.0,)`, `offsets=(0.0,)` (the COG does not carry the BOA offset either), CRS `EPSG:32611` for tile 11SLT. Setting `GDAL_INGESTED_BYTES_AT_OPEN`, `GDAL_HTTP_MULTIPLEX`, `GDAL_HTTP_MERGE_CONSECUTIVE_RANGES` made no measurable difference (open ~1.0 s + read ~1.4 s for one 10 m band window from California).

Measured runs (macOS, residential connection in California, data in Azure West Europe):

| run | AOI | before / after items | step timings (s) | total |
|---|---|---|---|---|
| LA downtown, cold (first run) | 34.05, -118.25, 2x2 km | S2C 2025-10-29 (PB 05.11) / S2C 2026-10-24 (PB 05.13) | client_open 0.62, stac_search 2.47 (2 searches), scl_screen 6.04, cog_reads 21.58, compute 0.01, png 0.02 | **30.7 s** (+~4 s Python imports) |
| LA downtown, warm | same | same | client_open 0.26, stac_search 1.98, scl_screen 2.18, cog_reads 5.33 (each band 2.2-2.7 s in parallel, SCL 0.8 s), compute 0.015, png 0.023 | **9.8 s** |
| Eaton fire, Altadena | 34.185, -118.135 | S2A 2025-01-02 / S2C 2025-02-01 (both PB 05.11) | stac_search 1.50, scl_screen 1.52, cog_reads 3.71 | **7.3 s** |

So the satellite part of the "address to report in ~2 minutes" demo fits comfortably, leaving > 90 s for geocoding, the LLM write-up and email. Budget 30-40 s for imagery in the worst case.

Results that sanity-check the maths:
- LA downtown after: AOI clear fraction 1.0, NDVI median 0.072 (urban); SCL histogram `{4: 1192, 5: 37580, 6: 1228}` at 10 m. The ~3 % "water" (class 6) is skyscraper shadow, not water: SCL misclassifies dark urban shadow as water.
- LA year-on-year change: dNDVI median -0.012, dNBR mean 0.004, 82 % of pixels "unburned": no real change, as expected.
- Eaton fire (Jan 2025): NDVI median 0.424 → 0.216, NBR median 0.236 → 0.052, **dNBR mean 0.174**; pixel classes `unburned 15753, low 13881, moderate_low 6089, moderate_high 3087, high 569` of 40000. Burn clearly detected. Server-side and local NDVI medians for LA agree to 0.0002 (0.0708 vs 0.0706).

Re-run with the final seed script (`terragent_imagery.py`, 3.12; NBR now on B8A/B12): Eaton 22.1 s total (stac_search 1.58, scl_screen 4.09, cog_reads 15.83: a slow-network run), dNBR mean 0.158, class fractions `unburned 0.467, low 0.307, moderate_low 0.165, moderate_high 0.056, high 0.004`; LA 9.9 s total, dNBR mean -0.008, 83.5 % unburned. **Observed end-to-end range for a before/after pair: 7-31 s**, dominated by COG reads from West Europe.

### 3.10 Index formulas and band mapping

Reflectance inputs (after the BOA offset). S2 = Sentinel-2 asset key; L8/9 = Landsat 8/9 band (PC `landsat-c2-l2` asset key).

| index | formula | Sentinel-2 | Landsat 8/9 | reference |
|---|---|---|---|---|
| NDVI | (NIR - Red) / (NIR + Red) | (B08 - B04)/(B08 + B04), 10 m | (B5 - B4)/(B5 + B4) = `nir08`,`red` | Rouse et al. 1974, https://ntrs.nasa.gov/citations/19740022614 |
| NDWI (McFeeters) | (Green - NIR) / (Green + NIR) | (B03 - B08)/(B03 + B08), 10 m | `green`,`nir08` | McFeeters 1996, https://doi.org/10.1080/01431169608948714 |
| MNDWI (Xu) | (Green - SWIR1) / (Green + SWIR1) | (B03 - B11)/(B03 + B11), B11 is 20 m | `green`,`swir16` | Xu 2006, https://doi.org/10.1080/01431160600589179 |
| NBR | (NIR - SWIR2) / (NIR + SWIR2) | (B8A - B12)/(B8A + B12) (EFFIS choice, both 20 m) or B08/B12 | (B5 - B7)/(B5 + B7) = `nir08`,`swir22` | USGS (Landsat NBR page); Key & Benson, https://doi.org/10.3133/ofr0211 |
| dNBR | NBR_prefire - NBR_postfire | | | Key & Benson 2006 (FIREMON LA) |
| Iron-oxide ratio (**indicator only**) | Red / Blue | B04 / B02 | `red`/`blue` (TM 3/1) | band-ratio convention for ferric iron (Sabins 1999, Ore Geology Reviews); see section 8 |
| Clay / hydroxyl ratio (**indicator only**) | SWIR1 / SWIR2 | B11 / B12 | `swir16`/`swir22` (TM 5/7) | same; see section 8 |

Water threshold convention: NDWI > 0 or MNDWI > 0 = water (McFeeters/Xu). The pipeline flags "new water" as `MNDWI_after > 0 and MNDWI_before <= 0`.

dNBR burn-severity classes (USGS FIREMON, Key & Benson 2006). Published tables are x1000; the code uses unscaled values:

| class | dNBR x1000 | dNBR (unscaled, code) |
|---|---|---|
| enhanced regrowth, high | < -250 | < -0.25 |
| enhanced regrowth, low | -250 to -100 | -0.25 to -0.1 |
| unburned | -100 to +100 | -0.1 to 0.1 |
| low severity | 100 to 270 | 0.1 to 0.27 |
| moderate-low | 270 to 440 | 0.27 to 0.44 |
| moderate-high | 440 to 660 | 0.44 to 0.66 |
| high | >= 660 | >= 0.66 |

Sources: Awesome Spectral Indices catalogue `https://raw.githubusercontent.com/awesome-spectral-indices/awesome-spectral-indices/main/output/spectral-indices-dict.json` (formulas, references, band map S2: B=B2 G=B3 R=B4 N=B8 N2=B8A S1=B11 S2=B12); EFFIS fire-severity page `https://forest-fire.emergency.copernicus.eu/about-effis/technical-background/fire-severity` ("Bands 8A and 12"; the class table x1000 from 100 up, citing Key & Benson 2006); USGS `https://www.usgs.gov/landsat-missions/landsat-normalized-burn-ratio` ("NBR = (Band 5 - Band 7) / (Band 5 + Band 7)"); Humboldt State GSP 216 NBR lesson (full 7-class table incl. regrowth, "from the USGS FireMon program"). Thresholds vary by region and vegetation (USGS metadata note); label results "indicative".

### 3.11 Landsat C2 L2 (verified live, if used)

- Live item `LC08_L2SP_041036_20261024_02_T1` (landsat-8, 0.23 % cloud, `proj:epsg` 32611). Note the item id drops the processing date while the asset filename keeps it: `.../LC08_L2SP_041036_20261024_20261030_02_T1_SR_B4.TIF` = asset key `red`.
- Filter platforms with `"query": {"platform": {"in": ["landsat-8","landsat-9"]}}` (Landsat 7 has SLC-off stripes).
- Scale: `SR = DN * 0.0000275 - 0.2` (fill 0, valid DN 7273-43636); `ST_K = DN * 0.00341802 + 149` (fill 0). Both in the asset `raster:bands`, so rasterio users must apply them by hand. USGS example: DN 18639 → 0.313.
- `qa_pixel` bits (from the live item's `classification:bitfields`): 0 fill, 1 dilated_cloud, 2 cirrus, 3 cloud, 4 cloud_shadow, 5 snow, 6 clear, 7 water, 8-9 cloud_confidence, 10-11 cloud_shadow_confidence, 12-13 snow_confidence, 14-15 cirrus_confidence. Mask: `valid = (qa & 0b11111) == 0` (bits 0-4), or keep only `(qa >> 6) & 1`.
- 30 m pixels: a 2x2 km AOI is only ~67x67 pixels. Use Landsat only as a fallback (S2 gap) or for pre-2017 history.

Source: live `POST .../search` on `landsat-c2-l2` (2026-11-07); USGS FAQ `https://www.usgs.gov/faqs/how-do-i-use-a-scale-factor-landsat-level-2-science-products`.

### 3.12 Seed script (ran successfully, outputs and timings above)

Final version pins the "before" search to the "after" scene's `s2:mgrs_tile` so both dates share one UTM grid (re-run on Eaton: identical metrics, total 17.7 s of which one STAC search took 10.8 s; the same query normally takes 0.5-0.8 s, so expect occasional slow responses).

`python -I terragent_imagery.py 34.185 -118.135 2025-01-12/2025-02-10 2024-12-01/2025-01-06 out/` writes `after_truecolor.png`, `after_truecolor_masked.png`, `after_ndvi.png`, the same for `before_`, and `result.json` (200x200 px PNGs at 10 m).

```python
"""Terragent imagery pipeline seed. Verified live against Microsoft Planetary Computer on 2026-11-07.

lat/lon -> STAC search (Sentinel-2 L2A) -> latest scene whose 2x2 km AOI is clear (SCL screen)
-> parallel windowed COG reads -> BOA offset fix -> indices -> PNGs + JSON, for a before/after pair.

Usage: python -I terragent_imagery.py LAT LON AFTER_RANGE BEFORE_RANGE OUTDIR
       ranges are STAC datetime intervals, e.g. 2026-09-01/2026-11-07
No API key needed. Deps: pystac-client planetary-computer rasterio numpy pillow shapely pyproj
"""
import json, math, os, sys, time
from concurrent.futures import ThreadPoolExecutor

os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")  # don't list sidecar files over HTTP
os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".tif,.TIF,.tiff")
os.environ.setdefault("GDAL_HTTP_MAX_RETRY", "3")
os.environ.setdefault("GDAL_HTTP_RETRY_DELAY", "1")

import numpy as np
import planetary_computer
import pystac_client
import rasterio
from PIL import Image
from pyproj import Transformer
from rasterio.enums import Resampling
from rasterio.windows import from_bounds
from shapely.geometry import box, shape

STAC_URL = "https://planetarycomputer.microsoft.com/api/stac/v1"
COLLECTION = "sentinel-2-l2a"
HALF = 1000  # metres: 2 km x 2 km AOI
GRID = 20    # snap AOI to the 20 m grid so 10 m and 20 m bands line up exactly
# SCL legend from MTD_MSIL2A.xml: 0 NODATA 1 SATURATED_DEFECTIVE 2 CAST_SHADOW 3 CLOUD_SHADOW 4 VEGETATION
# 5 NOT_VEGETATED 6 WATER 7 UNCLASSIFIED 8 CLOUD_MEDIUM_PROBA 9 CLOUD_HIGH_PROBA 10 THIN_CIRRUS 11 SNOW_ICE
SCL_INVALID = (0, 1, 3, 8, 9, 10)
BANDS = ("B02", "B03", "B04", "B08", "B8A", "B11", "B12")
T = {}


def tick(name, t0):
    T[name] = round(T.get(name, 0) + time.perf_counter() - t0, 3)


def boa_offset(item):
    """-1000 for processing baseline >= 04.00 (ESA, from 2022-01-25), else 0. PC assets carry no raster:offset."""
    return -1000 if float(item.properties.get("s2:processing_baseline", "0")) >= 4.0 else 0


def epsg_of(item):
    """Raw PC JSON has proj:epsg (int); pystac >= 1.16 migrates it to proj:code 'EPSG:32611' and drops proj:epsg."""
    p = item.properties
    return int(p["proj:epsg"]) if p.get("proj:epsg") else int(str(p["proj:code"]).split(":")[1])


def aoi_utm(lat, lon, epsg):
    x, y = Transformer.from_crs("EPSG:4326", f"EPSG:{epsg}", always_xy=True).transform(lon, lat)
    minx, miny = math.floor((x - HALF) / GRID) * GRID, math.floor((y - HALF) / GRID) * GRID
    return (minx, miny, minx + 2 * HALF, miny + 2 * HALF)


def aoi_lonlat(lat, lon):
    dlat, dlon = HALF / 111_320, HALF / (111_320 * math.cos(math.radians(lat)))
    return box(lon - dlon, lat - dlat, lon + dlon, lat + dlat)


def read_window(href, bounds, out_px):
    with rasterio.open(href) as src:  # href is already SAS-signed by the client modifier
        win = from_bounds(*bounds, transform=src.transform)
        return src.read(1, window=win, out_shape=(out_px, out_px), resampling=Resampling.nearest)


def search(catalog, lat, lon, dt, max_cloud=30, max_items=20, tile=None):
    t0 = time.perf_counter()
    aoi = aoi_lonlat(lat, lon)
    q = {"eo:cloud_cover": {"lt": max_cloud}}
    if tile:  # pin "before" to the "after" MGRS tile -> same UTM grid -> pixel-aligned change maps
        q["s2:mgrs_tile"] = {"eq": tile}
    items = list(catalog.search(
        collections=[COLLECTION], intersects=aoi.__geo_interface__, datetime=dt,
        query=q,
        sortby=[{"field": "properties.datetime", "direction": "desc"}],
        max_items=max_items,  # ALWAYS set: otherwise the client keeps following rel=next pages
    ).items())
    tick("stac_search", t0)
    items = [i for i in items if shape(i.geometry).contains(aoi)]  # skip swath-edge tiles with nodata wedges
    best = {}  # one item per (datetime, tile): keep the newest generation if PC holds duplicates
    for i in items:
        k = (i.properties["datetime"], i.properties.get("s2:mgrs_tile"))
        if k not in best or i.properties.get("s2:generation_time", "") > best[k].properties.get("s2:generation_time", ""):
            best[k] = i
    return sorted(best.values(), key=lambda i: i.properties["datetime"], reverse=True)


def pick_clear(items, lat, lon, min_clear=0.8, max_checks=6):
    """Newest first; first scene whose AOI is >= min_clear valid by SCL wins, else the clearest seen."""
    best = (None, -1.0)
    for item in items[:max_checks]:
        t0 = time.perf_counter()
        scl = read_window(item.assets["SCL"].href, aoi_utm(lat, lon, epsg_of(item)), 2 * HALF // 20)
        tick("scl_screen", t0)
        cf = float(np.isin(scl, SCL_INVALID, invert=True).mean())
        if cf >= min_clear:
            return item, cf
        if cf > best[1]:
            best = (item, cf)
    return best


def load(item, bounds):
    t0 = time.perf_counter()
    n = 2 * HALF // 10  # everything on the 10 m grid (20 m bands nearest-upsampled)
    hrefs = {b: item.assets[b].href for b in BANDS + ("SCL",)}
    with ThreadPoolExecutor(len(hrefs)) as ex:
        dn = dict(zip(hrefs, ex.map(lambda h: read_window(h, bounds, n), hrefs.values())))
    tick("cog_reads", t0)
    off = boa_offset(item)
    out = {}
    for b in BANDS:
        r = (dn[b].astype("float32") + off) / 10000.0  # L2A: (DN + BOA_ADD_OFFSET) / 10000
        r[dn[b] == 0] = np.nan                          # DN 0 = NODATA (COG nodata tag is unset)
        out[b] = r
    out["SCL"] = dn["SCL"]
    return out


def nd(a, b):
    den = a + b
    with np.errstate(divide="ignore", invalid="ignore"):
        v = (a - b) / den
    v[~(den > 1e-4)] = np.nan  # offset can push dark pixels <= 0 -> inf; drop them
    return v


def ratio(a, b):
    with np.errstate(divide="ignore", invalid="ignore"):
        v = a / b
    v[~(b > 1e-4)] = np.nan
    return v


def indices(B):
    return {
        "ndvi": nd(B["B08"], B["B04"]),            # (NIR-Red)/(NIR+Red), Rouse 1974
        "ndwi": nd(B["B03"], B["B08"]),            # (Green-NIR)/(Green+NIR), McFeeters 1996
        "mndwi": nd(B["B03"], B["B11"]),           # (Green-SWIR1)/(Green+SWIR1), Xu 2006
        "nbr": nd(B["B8A"], B["B12"]),             # (NIR-SWIR2)/(NIR+SWIR2); EFFIS uses B8A & B12
        "iron_oxide": ratio(B["B04"], B["B02"]),   # Red/Blue: INDICATOR ONLY
        "clay_hydroxyl": ratio(B["B11"], B["B12"]),  # SWIR1/SWIR2: INDICATOR ONLY
    }


def truecolor_png(B, path, invalid=None, max_refl=0.3, gamma=1 / 1.6):
    rgb = np.clip(np.nan_to_num(np.dstack([B["B04"], B["B03"], B["B02"]])) / max_refl, 0, 1) ** gamma
    img = (rgb * 255).astype("uint8")
    if invalid is not None:
        img[invalid] = (255, 0, 255)  # cloud/shadow/nodata in magenta
    Image.fromarray(img).save(path)


def ramp_png(a, path, vmin=-0.2, vmax=0.8, invalid=None):  # red -> yellow -> green, no matplotlib
    t = np.clip((np.nan_to_num(a, nan=vmin) - vmin) / (vmax - vmin), 0, 1)
    img = (np.dstack([np.where(t < .5, 1, 2 - 2 * t), np.where(t < .5, 2 * t, 1), 0 * t]) * 255).astype("uint8")
    if invalid is not None:
        img[invalid] = (128, 128, 128)
    Image.fromarray(img).save(path)


DNBR_BINS = [-0.25, -0.1, 0.1, 0.27, 0.44, 0.66]  # USGS FIREMON / Key & Benson 2006, unscaled
DNBR_LABELS = ["regrowth_high", "regrowth_low", "unburned", "low", "moderate_low", "moderate_high", "high"]


def stats(a, m):
    v = a[m & np.isfinite(a)]
    return {"mean": round(float(v.mean()), 4), "median": round(float(np.median(v)), 4)} if v.size else None


def run(lat, lon, after_dt, before_dt, outdir):
    os.makedirs(outdir, exist_ok=True)
    t_all = time.perf_counter()
    catalog = pystac_client.Client.open(STAC_URL, modifier=planetary_computer.sign_inplace)
    res, sc, tile = {}, {}, None
    for label, dt in (("after", after_dt), ("before", before_dt)):
        items = search(catalog, lat, lon, dt, tile=tile)
        if not items:
            raise SystemExit(f"no {label} scene in {dt}")
        item, cf = pick_clear(items, lat, lon)
        tile = tile or item.properties.get("s2:mgrs_tile")
        B = load(item, aoi_utm(lat, lon, epsg_of(item)))
        idx = indices(B)
        valid = np.isin(B["SCL"], SCL_INVALID, invert=True)
        truecolor_png(B, f"{outdir}/{label}_truecolor.png")
        truecolor_png(B, f"{outdir}/{label}_truecolor_masked.png", invalid=~valid)
        ramp_png(idx["ndvi"], f"{outdir}/{label}_ndvi.png", invalid=~valid)
        res[label] = {
            "item_id": item.id, "datetime": item.properties["datetime"], "platform": item.properties.get("platform"),
            "processing_baseline": item.properties.get("s2:processing_baseline"), "boa_offset": boa_offset(item),
            "scene_cloud_cover_pct": item.properties.get("eo:cloud_cover"), "epsg": epsg_of(item),
            "aoi_clear_fraction": round(float(valid.mean()), 4), "candidates": len(items),
            **{k: stats(v, valid) for k, v in idx.items()},
        }
        sc[label] = (idx, valid, epsg_of(item))
    (ia, va, ea), (ib, vb, eb) = sc["after"], sc["before"]
    if ea == eb:  # same UTM grid -> pixel-aligned (AOI is snapped to the 20 m grid)
        both = va & vb & np.isfinite(ia["nbr"]) & np.isfinite(ib["nbr"]) & np.isfinite(ia["ndvi"]) & np.isfinite(ib["ndvi"])
        dnbr = (ib["nbr"] - ia["nbr"])[both]  # dNBR = NBR_pre - NBR_post
        cls = np.digitize(dnbr, DNBR_BINS)
        res["change"] = {
            "both_clear_fraction": round(float(both.mean()), 4),
            "d_ndvi_median": round(float(np.median((ia["ndvi"] - ib["ndvi"])[both])), 4),
            "frac_ndvi_drop_gt_0.2": round(float(((ia["ndvi"] - ib["ndvi"])[both] < -0.2).mean()), 4),
            "dnbr_mean": round(float(dnbr.mean()), 4),
            "dnbr_class_fraction": {l: round(float((cls == i).mean()), 4) for i, l in enumerate(DNBR_LABELS)},
            "frac_new_water_mndwi": round(float(((ia["mndwi"] > 0) & (ib["mndwi"] <= 0))[both].mean()), 4),
        }
    T["total"] = round(time.perf_counter() - t_all, 3)
    res["timings_s"] = T
    json.dump(res, open(f"{outdir}/result.json", "w"), indent=1)
    return res


if __name__ == "__main__":
    a = sys.argv
    print(json.dumps(run(float(a[1]), float(a[2]), a[3], a[4], a[5] if len(a) > 5 else "out"), indent=1))
```

### 3.13 Copernicus Data Space Ecosystem (CDSE) as a fallback

- STAC search is **anonymous**: `POST https://stac.dataspace.copernicus.eu/v1/search` (root `id: "cdse-stac"`, "Copernicus Data Space Ecosystem (CDSE) asset-level STAC catalogue") returned 200 in 5.7 s, collection id also `sentinel-2-l2a`.
- **Downloading pixels needs an account.** Asset hrefs are `s3://eodata/...jp2` (`auth:refs: ["s3"]`, S3 keys from a CDSE account) or the HTTPS alternate `https://download.dataspace.copernicus.eu/odata/v1/Products(...)/Nodes(...)/$value` with `auth:refs: ["oidc"]`. That URL answered **HTTP 401** without a token.
- Files are **JP2, not COG** (asset keys like `B04_10m`, `B04_20m`, `SCL_20m`, `TCI_10m`, `CLD_20m`, `SNW_20m`), so windowed HTTP reads are much slower than PC.
- CDSE assets do carry `"raster:scale": 0.0001, "raster:offset": -0.1` and `processing:version: "05.13"`. This independently confirms the PB >= 04.00 rule `reflectance = (DN - 1000) / 10000`.
- Verdict: PC is primary (no account). CDSE needs a human-created free account plus OAuth tokens; only worth it if PC is down.

Source: live requests to `https://stac.dataspace.copernicus.eu/v1/` and the odata href (2026-11-07 22:34 UTC).

### 3.14 TypeScript (Next.js API route / dashboard): search + server-rendered crops

Two runs on Node v24.21.0 (global `fetch`, 2026-11-07). First as plain JS (`pc_fetch.mjs`): search 728 ms (first item `S2C_MSIL2A_20261024T183431_R027_T11SLT_20261024T214812`, `proj:epsg: 32611`), true-colour 256 px PNG 200 in 1076 ms, NDVI PNG 200 in 829 ms, `/sas/v1/sign` returned a signed href. Then the exact TypeScript below was extracted from this doc and run with Node's built-in type stripping (`node pc_client.ts`): truecolor 200 `image/png`, ndvi 200 `image/png`, sign OK. It has not been type-checked with `tsc`.

```ts
const STAC = "https://planetarycomputer.microsoft.com/api/stac/v1";
const DATA = "https://planetarycomputer.microsoft.com/api/data/v1";

export type Scene = { id: string; datetime: string; cloud: number; baseline: string; tile: string; epsg: number };

export async function latestScenes(lat: number, lon: number, datetime: string, maxCloud = 30, limit = 10): Promise<Scene[]> {
  const d = 0.009; // ~1 km
  const res = await fetch(`${STAC}/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      collections: ["sentinel-2-l2a"],
      intersects: { type: "Polygon", coordinates: [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]] },
      datetime, // RFC3339 interval, e.g. "2026-09-01T00:00:00Z/2026-11-07T23:59:59Z"
      query: { "eo:cloud_cover": { lt: maxCloud } },
      sortby: [{ field: "datetime", direction: "desc" }],
      limit,
    }),
  });
  if (!res.ok) throw new Error(`STAC search ${res.status}`);
  const fc = await res.json();
  return fc.features.map((f: any) => ({
    id: f.id,
    datetime: f.properties.datetime,
    cloud: f.properties["eo:cloud_cover"],
    baseline: f.properties["s2:processing_baseline"], // "05.13" etc.
    tile: f.properties["s2:mgrs_tile"],
    epsg: f.properties["proj:epsg"], // raw JSON keeps proj:epsg (only pystac renames it)
  }));
}

/** Server-rendered PNG crop (no SAS needed). bbox in lon/lat. */
export function cropPngUrl(scene: Scene, bbox: [number, number, number, number], kind: "truecolor" | "ndvi" = "truecolor", px = 512): string {
  const q = new URLSearchParams({ collection: "sentinel-2-l2a", item: scene.id });
  if (kind === "truecolor") {
    q.set("assets", "visual");
    q.set("asset_bidx", "visual|1,2,3");
  } else {
    const off = parseFloat(scene.baseline) >= 4 ? 2000 : 0; // two bands x 1000 BOA offset in the denominator
    q.set("expression", `(B08-B04)/(B08+B04-${off})`);
    q.set("asset_as_band", "true");
    q.set("rescale", "-0.2,0.8");
    q.set("colormap_name", "rdylgn");
  }
  return `${DATA}/item/bbox/${bbox.join(",")}/${px}x${px}.png?${q}`;
}

/** Sign one blob URL (45-minute anonymous SAS). */
export async function signHref(href: string): Promise<string> {
  const r = await fetch(`https://planetarycomputer.microsoft.com/api/sas/v1/sign?href=${encodeURIComponent(href)}`);
  if (!r.ok) throw new Error(`sign ${r.status}`);
  return (await r.json()).href as string;
}
```
- For the globe: each item also has a `tilejson` asset (data API `.../item/{tileMatrixSetId}/tilejson.json?...`), usable as an XYZ raster layer. Not exercised beyond its presence in the item.
- `URLSearchParams` encodes `+` as `%2B` and `|` as `%7C`, which the API needs (a raw `+` would decode as a space).

## 4. Discrepancies with the master prompt

| spec says | reality (verified) | impact on build |
|---|---|---|
| 5.1: free imagery "through the Microsoft Planetary Computer STAC API ... or Copernicus" works "without anyone answering an email" | True for PC (anonymous search, token, reads). **Not true for Copernicus Data Space**: search is open but pixel download returns HTTP 401 without an OIDC token from a registered account; files are JP2, not COG | PC is the only zero-human free path. A CDSE fallback needs a founder to create a free account (add to the "humans do" list). Don't build it unless PC fails. |
| 5.1: "`pystac-client` plus the `planetary-computer` signing package" | Correct. `planetary-computer` 1.0.0 is from 2023 but still works. pystac 1.16.0 (2026-11-04) changes item property names on load (`proj:epsg` → `proj:code`) | Use `epsg_of()` from 3.12, or pin `pystac<1.16` if other code assumes `proj:epsg`. |
| 5.3: "Cloud masking (Sentinel-2's SCL band)" | Correct, but SCL is 20 m, labels building shadow as water (class 6) in dense cities, and `eo:cloud_cover` is a whole-tile number | Screen per AOI with SCL (cheap: about 0.5 s per candidate), not by `eo:cloud_cover` alone. Report "clear fraction of AOI" as part of the confidence level. |
| 5.3 / 7: Analytics runs "imagery processing in the Naïve sandbox computer (Python)" | Not verified here (Naïve topic). Current rasterio 1.5.x needs Python >= 3.12 and glibc >= 2.28 (manylinux_2_28), has no musllinux wheel, and needs outbound HTTPS to `planetarycomputer.microsoft.com` and `*.blob.core.windows.net` | First thing to test in the sandbox: `python3 --version`, `pip install` time, and one signed COG read. If blocked, call the PC data API from Next.js instead (3.8). |
| 13: judge's address → report "within about 2 minutes" | Imagery part measured at 7-31 s per before/after pair from California (data is in Azure West Europe) | Feasible. Pre-warm (import modules, open client) and cap candidates (`max_checks=6`). Record the backup video anyway: one search took 10.8 s and one cold run took 31 s. |
| 5.3: "Mining: iron-oxide and clay band-ratio indicators" | B4/B2 (iron oxide) has published Sentinel-2 use. B11/B12 is the S2 analogue of Landsat TM 5/7, but one S2 study used it for *lateritic iron*, not clay. Both are at 10-20 m | Keep them as "indicators" exactly as the spec says. Report ratio anomalies relative to the AOI's surroundings, never "deposits". |
| 3.1/3.5 registry: "license terms" per provider | Sentinel-2: Copernicus licence: free, full, open use; attribution "Contains modified Copernicus Sentinel data [Year]". Landsat: USGS public-domain data policy (collection `license` link) | Put these attribution strings in the registry and in every report footer. Free imagery *may* be delivered as PNGs (unlike paid imagery). |
| 5.1 Sentinel-2 "revisit every few days" | Live data includes Sentinel-2A, 2B and **2C** (the collection summary lists only 2A/2B). LA tile 11SLT acquisitions seen in our searches included 10-09, 10-14, 10-16, 10-19, 10-24, 10-29, 11-03, 11-05 (2026) | About a 2-3 day revisit at mid-latitudes. Don't filter by `platform`. |

## 5. Answers to relevant open questions (spec section 14)

Section 14 has no imagery-specific question. The closest ones, plus the implicit questions this topic raises:

| question | answer | source | confidence |
|---|---|---|---|
| (14) "What do paid imagery providers charge, and on what license terms?" | Out of scope for this doc (paid providers). Free sources: Sentinel-2 is free for commercial use with attribution "Contains modified Copernicus Sentinel data [Year]"; Landsat is public domain under USGS policy | Copernicus Sentinel data licence (ads.atmosphere.copernicus.eu/licences/ec-sentinel), collection `license` links | medium (legal notice PDF host unreachable; secondary copies of the wording) |
| Does PC need a key or account? | No. `GET /api/sas/v1/token/{collection}` works anonymously; docs: "you don't need to supply a subscription key". A key (`PC_SDK_SUBSCRIPTION_KEY`) only changes rate tier and token lifetime; the Hub that issued keys was retired June 2024 | live calls; sas.md; GitHub discussion #347 | high |
| Anonymous SAS lifetime / rate limits? | Token lifetime **45 min** (observed `se` = issue + 45 min, twice). No numeric rate limits published ("should be generous"). 12 concurrent searches + 12 token calls: all 200, no rate-limit headers. The SDK retries 429/5xx | live; sas.md; `sas.py` L453-458 | high (lifetime), medium (limits) |
| How to detect the BOA offset? | `float(props["s2:processing_baseline"]) >= 4.0` → -1000 on all bands. Verified in MTD XML (05.13 has `BOA_ADD_OFFSET` -1000 x13, 02.12 has none) and by CDSE's `raster:offset: -0.1` | live MTD XML; ESA formula on Sentinel Online | high |
| Which SCL classes to mask? | 0,1,3,8,9,10 by default; optionally 2 (cast shadow), 7, 11. Keep 6 for water indices | live MTD legend | high (codes), medium (choice of set is a convention) |
| Can Neon store the derived results? | Not covered here (Neon topic). The pipeline outputs only small JSON metrics + PNGs, so it fits the "derived results only" Earth index | - | - |

## 6. Credentials needed

| env var | service | where to get it | cost | needed for |
|---|---|---|---|---|
| (none) | Planetary Computer STAC + SAS + data API | not needed | free | everything in this doc (verified anonymous) |
| `PC_SDK_SUBSCRIPTION_KEY` (optional) | Planetary Computer | historically from the PC account/Hub; the Hub was retired 2024-06-06 and new key sign-up may not exist | free | only better rate tier and longer token lifetime; **skip it** |
| `CDSE_USERNAME` / `CDSE_PASSWORD` or S3 keys (names are our choice) | Copernicus Data Space Ecosystem | a human registers at dataspace.copernicus.eu | free | **fallback only**: downloading pixels (search needs nothing) |

## 7. Gotchas & limits

1. **SAS expiry 45 min (anonymous, outside West Europe).** Items signed by `modifier=sign_inplace` carry fixed hrefs. A long-running worker (cron/monitoring) must call `planetary_computer.sign(item)` again before reading. The token cache auto-refreshes when < 60 s are left, but only on a new sign call. Expired or unsigned blob reads fail (unsigned = HTTP 409).
2. **No published numeric rate limits.** Docs: limits depend on (a) request origin (West Europe region gets the best tier) and (b) presence of a subscription key; "should be generous". No 429 seen at 12 concurrent requests. `get_token` retries 429/500/502/503/504 (10 tries, backoff 0.8). Add GDAL retries (`GDAL_HTTP_MAX_RETRY=3`).
3. **Latency is network-bound.** Data lives in Azure West Europe. From California one 10 m band window takes 2.2-2.7 s; 7 bands in parallel take ~2.6-8 s per scene; searches take 0.5-2 s with an outlier at 10.8 s. Set `Client.open(..., timeout=...)` and a total job deadline; for the live demo pre-run the judge's area if possible.
4. **BOA offset**: PB >= 04.00 needs -1000 before /10000. The STAC item and COG carry no scale/offset (`scales=(1.0,)`, `offsets=(0.0,)`), so nothing applies it for you (rasterio, TiTiler `unscale`, odc-stac). Mixing old and new baselines without it biases NDVI.
5. **Negative / zero reflectance** after the offset (DN < 1000: water, deep shadow) gives `+-inf` in normalised differences. The server-side NDVI stats came back `max 1.79e308, mean null`. Mask denominators <= 0 (see `nd()`), and prefer medians.
6. **DN 0 = NODATA**, but the COG has `nodata=None`: mask it manually. Saturated = 32767 (PB >= 04) or 65535 (old PB).
7. **`max_items`**: without it pystac-client keeps following `next` (POST + token) pages. PC returns no `numberMatched`, so `matched()` gives no count.
8. **pystac 1.16 migration**: `proj:epsg` → `proj:code: "EPSG:32611"`. Raw JSON (TypeScript `fetch`) still has `proj:epsg`.
9. **AOI geometry**: compute the window in the item's UTM CRS (`proj:epsg` 326xx/327xx) with pyproj. Snap to the 20 m grid so 10/20 m bands align. Require `shape(item.geometry).contains(aoi)`, since swath-edge tiles have nodata wedges. Pin before/after to the same `s2:mgrs_tile` so the pixels align. Near UTM-zone edges the same point is in two tiles with different EPSGs.
10. **Cloud cover** `eo:cloud_cover` / `s2:*_percentage` are per 110x110 km tile. A 15.8 % cloudy tile had a 100 % clear AOI (Eaton after-scene). Screen with SCL over the AOI.
11. **SCL quality**: 20 m, and it misclassifies dark urban shadow as water (~3 % of downtown LA). Treat MNDWI "new water" in cities with suspicion.
12. **Resolution**: a 2x2 km AOI = 200x200 px at 10 m (B02/03/04/08), 100x100 at 20 m (B8A/B11/B12/SCL); Landsat 30 m = ~67x67. Don't promise building-level answers.
13. **Data API**: `GET /item/statistics` without a geometry returned 500 for a full tile. POST a GeoJSON Feature instead. In `expression` use bare asset names (`B08`) with `asset_as_band=true`.
14. **Ingest latency**: a 2026-11-05 18:38 UTC acquisition was searchable on PC by 2026-11-07 22:35 UTC (same item also on CDSE). Exact PC latency was not measured (see 8).
15. **Cost**: free. PC docs: "The data hosted by the Planetary Computer is free for anyone to use". There is no billing relationship for anonymous use.
16. **Licence/attribution**: Sentinel needs "Contains modified Copernicus Sentinel data 2026". For Landsat, credit USGS; the exact wording (e.g. "Landsat imagery courtesy of the U.S. Geological Survey") is not verified, see the collection `license` link `https://www.usgs.gov/core-science-systems/hdds/data-policy`. Put both in report footers.

## 8. Unverified

- (critic-verified, live ~23:00Z 2026-11-07) Anonymous `GET /api/sas/v1/token/sentinel-2-l2a` still returns a token with a 45-min expiry. On the Naïve side, the docs say outbound internet from `bash` is open (computer/networking.md). They also give indirect evidence of Python plus package installs on agent computers (capabilities/3d.md: `build_3d` toolchain "installs on first use"). The Python version is still unknown. If it is < 3.12, pip resolves rasterio 1.4.4; if rasterio won't install at all, use the §3.8 data API from Vercel.
- **Naïve sandbox compatibility**: Python version, glibc, pip availability and outbound HTTPS to `*.blob.core.windows.net` and `planetarycomputer.microsoft.com` in the Naïve computer. Confirm by running `python3 --version && pip install rasterio && python -I terragent_imagery.py 34.05 -118.25 2026-09-01/2026-11-07 2025-09-01/2025-11-07 out` inside it (needs the Naïve key; different research topic).
- **Numeric PC rate limits and keyed token lifetime**: not published; only anonymous 45 min observed. Whether new subscription keys can still be issued after the Hub retirement is unconfirmed (a maintainer said keys are no longer required for any dataset).
- **PC ingest latency** for new Sentinel-2 scenes (hours vs days): only the bound "acquired 11-05 18:38 UTC, visible by 11-07 22:35 UTC". Confirm by polling `sortby datetime desc` for a tile on the day of an overpass.
- **Mining ratio provenance**: B4/B2 iron-oxide use on Sentinel-2 is published (e.g. hematite mapping studies). The *clay/hydroxyl* reading of B11/B12 is an analogy to Landsat TM 5/7 (Sabins 1999, Ore Geology Reviews 14:157-183, DOI verified via Crossref, text not read). One S2 study used B11/B12 for lateritic iron instead. Keep "indicator only" labels.
- **dNBR regrowth class bounds**: the 100/270/440/660 (x1000) thresholds are from EFFIS citing Key & Benson 2006. The two regrowth classes (-250, -100) come from a university course page citing USGS FireMon. The FIREMON LA chapter itself (RMRS-GTR-164-CD) was not read.
- **ESA official PB 04.00 deployment date** (spec says 2022-01-25): the ESA news page says "planned ... 26 October" (2021); live PC data shows LA tile switching between the 2022-01-24 (03.00) and 2022-01-28 (04.00) acquisitions. Detection by `s2:processing_baseline` makes the exact date irrelevant.
- **Sentinel legal notice PDF** (`sentinel.esa.int/documents/247904/690755/Sentinel_Data_Legal_Notice`) was unreachable (DNS failure). The attribution wording comes from the Copernicus licence page and secondary copies.
- **Duplicate items per acquisition** (reprocessed generations): not seen in 2018/2021/2022/2025/2026 LA searches. The seed keeps the newest `s2:generation_time` per (datetime, tile) defensively.
- **odc-stac / stackstac**: not installed or tested (heavy dask/xarray/pandas dependencies). Not needed for single-AOI work.
- **CDSE token flow** (OIDC endpoint, S3 credentials) not exercised: it needs an account.

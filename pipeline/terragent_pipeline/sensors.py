"""Per-collection facts: band names, radiometry, cloud masks (docs/platform/imagery.md §3.2-3.6, §3.11)."""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

import numpy as np

# SCL legend (MTD_MSIL2A.xml): 0 nodata 1 saturated 2 cast shadow 3 cloud shadow 4 vegetation 5 not vegetated
# 6 water 7 unclassified 8 cloud medium 9 cloud high 10 thin cirrus 11 snow/ice. Water stays valid for NDWI/MNDWI.
SCL_INVALID = (0, 1, 3, 8, 9, 10)
# Landsat qa_pixel bits 0-4: fill, dilated cloud, cirrus, cloud, cloud shadow.
QA_INVALID_BITS = 0b11111


def boa_offset(props: dict) -> int:
    """Sentinel-2 processing baseline >= 04.00 stores DN + 1000; PC carries no offset metadata, so apply it here."""
    try:
        return -1000 if float(props.get("s2:processing_baseline") or 0) >= 4.0 else 0
    except ValueError:
        return 0


def s2_reflectance(props: dict, dn: np.ndarray) -> np.ndarray:
    """L2A surface reflectance = (DN + BOA_ADD_OFFSET) / 10000. DN 0 is nodata (the COG nodata tag is unset)."""
    r = (dn.astype(np.float32) + boa_offset(props)) / 10000.0
    r[dn == 0] = np.nan
    return r


def landsat_reflectance(_props: dict, dn: np.ndarray) -> np.ndarray:
    """Collection 2 Level-2 SR = DN * 2.75e-5 - 0.2 (asset raster:bands). DN 0 is fill."""
    r = dn.astype(np.float32) * 2.75e-5 - 0.2
    r[dn == 0] = np.nan
    return r


def scl_clear(scl: np.ndarray) -> np.ndarray:
    return ~np.isin(scl, SCL_INVALID)


def qa_clear(qa: np.ndarray) -> np.ndarray:
    # 0 never occurs in real qa_pixel data; it is what our reads fill outside the scene.
    return ((qa & QA_INVALID_BITS) == 0) & (qa != 0)


@dataclass(frozen=True)
class Sensor:
    collection: str
    provider_id: str
    name: str
    bands: dict[str, str]  # common band name -> asset key
    native_m: dict[str, int]  # asset key -> native pixel size
    mask_asset: str
    base_res_m: int
    reflectance: Callable[[dict, np.ndarray], np.ndarray]
    clear: Callable[[np.ndarray], np.ndarray]
    query: dict  # extra STAC query terms
    attribution: str  # "{year}" is replaced by the scene year

    def credit(self, year: int | str) -> str:
        return self.attribution.format(year=year)


SENTINEL2 = Sensor(
    collection="sentinel-2-l2a",
    provider_id="pc-sentinel-2-l2a",
    name="Sentinel-2",
    bands={"blue": "B02", "green": "B03", "red": "B04", "nir": "B08", "nir08": "B8A", "swir16": "B11", "swir22": "B12"},
    native_m={"B02": 10, "B03": 10, "B04": 10, "B08": 10, "B8A": 20, "B11": 20, "B12": 20, "SCL": 20},
    mask_asset="SCL",
    base_res_m=10,
    reflectance=s2_reflectance,
    clear=scl_clear,
    query={},
    attribution="Contains modified Copernicus Sentinel data {year}",
)

LANDSAT = Sensor(
    collection="landsat-c2-l2",
    provider_id="pc-landsat-c2-l2",
    name="Landsat",
    # Landsat has one NIR band; it stands in for Sentinel-2's narrow NIR (B8A) in NBR.
    bands={"blue": "blue", "green": "green", "red": "red", "nir": "nir08", "nir08": "nir08", "swir16": "swir16", "swir22": "swir22"},
    native_m={"blue": 30, "green": 30, "red": 30, "nir08": 30, "swir16": 30, "swir22": 30, "qa_pixel": 30},
    mask_asset="qa_pixel",
    base_res_m=30,
    reflectance=landsat_reflectance,
    clear=qa_clear,
    query={"platform": {"in": ["landsat-8", "landsat-9"]}},  # Landsat 7 has SLC-off stripes
    attribution="Landsat data courtesy of the U.S. Geological Survey ({year})",
)

SENSORS = {s.collection: s for s in (SENTINEL2, LANDSAT)}


def epsg_of(item: dict) -> int:
    """Raw PC JSON has proj:epsg; pystac >= 1.16 style proj:code ("EPSG:32611") is accepted too."""
    p = item.get("properties", {})
    if p.get("proj:epsg"):
        return int(p["proj:epsg"])
    return int(str(p["proj:code"]).split(":")[1])

"""Synthetic STAC items, grids and scenes so every test runs offline."""
from __future__ import annotations

import numpy as np
import pytest

from terragent_pipeline.grid import grid_for_bbox
from terragent_pipeline.scenes import Scene
from terragent_pipeline.sensors import SENTINEL2

# A 2 x 2 km box in downtown Los Angeles and its UTM 11N analysis grid (10 m, about 200 x 200 px).
LA_BBOX = (-118.2608, 34.0410, -118.2392, 34.0590)
LA_GRID = grid_for_bbox(LA_BBOX, 32611, 10)
SHAPE = LA_GRID.shape


def make_item(
    item_id: str = "S2C_MSIL2A_20261024T183431_R027_T11SLT_20261024T214812",
    when: str = "2026-10-24T18:34:31Z",
    *,
    baseline: str = "05.13",
    tile: str = "11SLT",
    cloud: float = 1.0,
    bbox: tuple[float, float, float, float] = (-119.0, 33.5, -117.5, 34.6),
    generation: str = "2026-10-24T21:48:12Z",
    collection: str = "sentinel-2-l2a",
) -> dict:
    x0, y0, x1, y1 = bbox
    return {
        "id": item_id,
        "collection": collection,
        "geometry": {"type": "Polygon", "coordinates": [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]},
        "properties": {
            "datetime": when,
            "platform": "Sentinel-2C",
            "proj:epsg": 32611,
            "s2:mgrs_tile": tile,
            "s2:processing_baseline": baseline,
            "s2:generation_time": generation,
            "eo:cloud_cover": cloud,
        },
        "assets": {},
    }


def refl(**bands: float | np.ndarray) -> dict[str, np.ndarray]:
    """Full reflectance dict on SHAPE; unspecified bands get a plausible bare-soil value."""
    base = {"blue": 0.08, "green": 0.10, "red": 0.12, "nir": 0.25, "nir08": 0.25, "swir16": 0.22, "swir22": 0.16}
    base.update(bands)
    return {k: np.broadcast_to(np.asarray(v, dtype=np.float32), SHAPE).copy() for k, v in base.items()}


def make_scene(r: dict[str, np.ndarray], clear: np.ndarray | None = None, when: str = "2026-10-24T18:34:31Z") -> Scene:
    item = make_item(when=when, item_id=f"S2C_MSIL2A_{when[:10].replace('-', '')}_TEST")
    return Scene(item, SENTINEL2, r, np.ones(SHAPE, bool) if clear is None else clear)


@pytest.fixture
def left_half() -> np.ndarray:
    m = np.zeros(SHAPE, bool)
    m[:, : SHAPE[1] // 2] = True
    return m

"""The analysis grid: the AOI in a UTM CRS, snapped so 10/20/30 m bands line up pixel for pixel."""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from rasterio.transform import Affine
from rasterio.warp import transform, transform_bounds

MAX_SIDE_PX = 1024  # coarsen the grid for big AOIs rather than read millions of pixels


@dataclass(frozen=True)
class Grid:
    epsg: int
    minx: float
    miny: float
    maxx: float
    maxy: float
    res: float

    @property
    def width(self) -> int:
        return max(1, round((self.maxx - self.minx) / self.res))

    @property
    def height(self) -> int:
        return max(1, round((self.maxy - self.miny) / self.res))

    @property
    def shape(self) -> tuple[int, int]:
        return (self.height, self.width)

    @property
    def bounds(self) -> tuple[float, float, float, float]:
        return (self.minx, self.miny, self.maxx, self.maxy)

    @property
    def transform(self) -> Affine:
        return Affine(self.res, 0.0, self.minx, 0.0, -self.res, self.maxy)

    @property
    def crs(self) -> str:
        return f"EPSG:{self.epsg}"

    @property
    def pixel_km2(self) -> float:
        return self.res * self.res / 1e6

    def with_res(self, res: float) -> Grid:
        """Same extent, different pixel size (e.g. the 20 m SCL screen of a 10 m grid)."""
        return Grid(self.epsg, self.minx, self.miny, self.maxx, self.maxy, res)

    def pixel_lonlat(self, stride: int = 1) -> tuple[np.ndarray, np.ndarray]:
        """Lon/lat of pixel centres, every `stride`-th pixel, shaped like grid[::stride, ::stride]."""
        cols = self.minx + (np.arange(0, self.width, stride) + 0.5) * self.res
        rows = self.maxy - (np.arange(0, self.height, stride) + 0.5) * self.res
        xx, yy = np.meshgrid(cols, rows)
        lon, lat = transform(self.crs, "EPSG:4326", xx.ravel().tolist(), yy.ravel().tolist())
        return np.asarray(lon).reshape(xx.shape), np.asarray(lat).reshape(xx.shape)


def grid_res(extent_m: float, base_res: int) -> int:
    """Native resolution, doubled until the longest side fits MAX_SIDE_PX."""
    res = base_res
    while extent_m / res > MAX_SIDE_PX:
        res *= 2
    return res


def grid_for_bbox(bbox: tuple[float, float, float, float], epsg: int, base_res: int = 10) -> Grid:
    minx, miny, maxx, maxy = transform_bounds("EPSG:4326", f"EPSG:{epsg}", *bbox, densify_pts=21)
    res = grid_res(max(maxx - minx, maxy - miny), base_res)
    snap = 20 if res == 10 else res  # a 10 m grid snapped to 20 m keeps the 20 m bands aligned too
    return Grid(
        epsg,
        math.floor(minx / snap) * snap,
        math.floor(miny / snap) * snap,
        math.ceil(maxx / snap) * snap,
        math.ceil(maxy / snap) * snap,
        res,
    )

"""Windowed Cloud-Optimized GeoTIFF reads onto the analysis grid (GDAL over HTTPS, SAS-signed hrefs)."""
from __future__ import annotations

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.vrt import WarpedVRT
from rasterio.windows import from_bounds

from .grid import Grid


def read_on_grid(href: str, grid: Grid, resampling: Resampling = Resampling.nearest) -> np.ndarray:
    """Band 1 of `href` resampled onto `grid`. Pixels outside the file come back as 0 (= nodata).

    Same CRS: a plain window read (the grid is snapped to the 20 m pixel lattice, so no resampling shift).
    Other CRS (scene from a neighbouring UTM zone): warped onto the grid so before/after stay pixel-aligned.
    """
    with rasterio.open(href) as src:
        if src.crs and src.crs.to_epsg() == grid.epsg:
            win = from_bounds(*grid.bounds, transform=src.transform)
            inside = (
                win.col_off >= 0
                and win.row_off >= 0
                and win.col_off + win.width <= src.width
                and win.row_off + win.height <= src.height
            )
            return src.read(1, window=win, out_shape=grid.shape, resampling=resampling, boundless=not inside, fill_value=0)
        with WarpedVRT(
            src, crs=grid.crs, transform=grid.transform, width=grid.width, height=grid.height, resampling=resampling, nodata=0
        ) as vrt:
            return vrt.read(1)

"""Per-H3-cell means of the recipe layers, for the Earth index (derived values only, never pixels)."""
from __future__ import annotations

import math

import h3
import numpy as np

from .grid import Grid

MAX_SAMPLES = 160_000  # pixel centres to index; bigger grids are sampled with a stride
MIN_SAMPLES = 20  # cells that only clip the AOI edge would report noise


def h3_metrics(grid: Grid, layers: dict[str, np.ndarray], res: int) -> list[dict]:
    """[{h3_cell, h3_res, metric, value}] with value = mean of the layer over the cell's valid pixels."""
    if not layers:
        return []
    stride = max(1, math.ceil(math.sqrt(grid.width * grid.height / MAX_SAMPLES)))
    lon, lat = grid.pixel_lonlat(stride)
    cells = np.array([h3.latlng_to_cell(la, lo, res) for la, lo in zip(lat.ravel(), lon.ravel())])
    uniq, inverse = np.unique(cells, return_inverse=True)
    out: list[dict] = []
    for metric, values in layers.items():
        v = values[::stride, ::stride].ravel()
        ok = np.isfinite(v)
        n = np.bincount(inverse[ok], minlength=uniq.size)
        total = np.bincount(inverse[ok], weights=v[ok], minlength=uniq.size)
        for i in np.flatnonzero(n >= MIN_SAMPLES):
            out.append({"h3_cell": str(uniq[i]), "h3_res": res, "metric": metric, "value": round(float(total[i] / n[i]), 4)})
    return out

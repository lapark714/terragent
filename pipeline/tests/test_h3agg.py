import h3
import numpy as np
import pytest

from conftest import LA_GRID, SHAPE
from terragent_pipeline.h3agg import h3_metrics


def test_cell_means_of_a_constant_layer():
    rows = h3_metrics(LA_GRID, {"ndvi_mean": np.full(SHAPE, 0.42)}, 8)
    assert rows, "a 2 x 2 km grid spans several res-8 cells"
    assert all(r["metric"] == "ndvi_mean" and r["h3_res"] == 8 and r["value"] == 0.42 for r in rows)
    assert all(h3.get_resolution(r["h3_cell"]) == 8 for r in rows)
    assert len({r["h3_cell"] for r in rows}) == len(rows)


def test_nan_pixels_are_ignored_and_tiny_cells_dropped():
    values = np.full(SHAPE, 0.2)
    values[:, : SHAPE[1] // 2] = np.nan
    rows = h3_metrics(LA_GRID, {"x": values}, 8)
    assert rows and all(r["value"] == pytest.approx(0.2) for r in rows)
    assert h3_metrics(LA_GRID, {"x": np.full(SHAPE, np.nan)}, 8) == []
    assert h3_metrics(LA_GRID, {}, 8) == []


def test_mean_per_cell_matches_pixels():
    lon, lat = LA_GRID.pixel_lonlat()
    values = lat - lat.min()  # varies north-south, so cells get different means
    rows = h3_metrics(LA_GRID, {"lat_offset": values}, 7)
    cells = np.vectorize(lambda a, b: h3.latlng_to_cell(a, b, 7))(lat, lon)
    for r in rows:
        assert r["value"] == pytest.approx(values[cells == r["h3_cell"]].mean(), abs=1e-4)

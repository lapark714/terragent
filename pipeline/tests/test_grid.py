import h3
import numpy as np

from conftest import LA_BBOX
from terragent_pipeline.grid import MAX_SIDE_PX, grid_for_bbox, grid_res


def test_two_km_aoi_is_about_200_px_snapped_to_20_m():
    g = grid_for_bbox(LA_BBOX, 32611, 10)
    assert g.res == 10
    assert all(v % 20 == 0 for v in g.bounds)
    assert 195 <= g.width <= 210 and 195 <= g.height <= 210
    assert g.pixel_km2 == 1e-4


def test_big_aoi_coarsens_by_doubling():
    assert grid_res(5_000, 10) == 10
    assert grid_res(10_240, 10) == 10
    assert grid_res(30_000, 10) == 40
    assert grid_res(30_000, 30) == 30
    g = grid_for_bbox((-118.6, 33.8, -118.0, 34.3), 32611, 10)
    assert max(g.width, g.height) <= MAX_SIDE_PX and g.res == 80


def test_pixel_centres_round_trip_to_lonlat():
    g = grid_for_bbox(LA_BBOX, 32611, 10)
    lon, lat = g.pixel_lonlat(stride=10)
    assert lon.shape == (len(range(0, g.height, 10)), len(range(0, g.width, 10)))
    assert abs(np.mean(lon) - (LA_BBOX[0] + LA_BBOX[2]) / 2) < 0.002
    assert abs(np.mean(lat) - (LA_BBOX[1] + LA_BBOX[3]) / 2) < 0.002
    assert h3.latlng_to_cell(float(lat[0, 0]), float(lon[0, 0]), 8).startswith("88")

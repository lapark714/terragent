"""Windowed reads and the AOI screen against real (synthetic, local) Cloud-Optimized GeoTIFFs: no network."""
from pathlib import Path

import numpy as np
import pytest
import rasterio
from rasterio.shutil import copy as rio_copy
from rasterio.transform import from_origin

from conftest import LA_BBOX, LA_GRID, make_item
from terragent_pipeline import scenes
from terragent_pipeline.reader import read_on_grid
from terragent_pipeline.sensors import SENTINEL2

MARGIN = 400  # metres of file around the grid


def write_cog(path: Path, data: np.ndarray, *, epsg: int, west: float, north: float, res: float) -> str:
    """Single-band COG (written as a GeoTIFF, then copied with the COG driver, like the files on Planetary Computer)."""
    tmp = path.with_suffix(".src.tif")
    profile = {"driver": "GTiff", "width": data.shape[1], "height": data.shape[0], "count": 1, "dtype": data.dtype.name,
               "crs": f"EPSG:{epsg}", "transform": from_origin(west, north, res, res)}
    with rasterio.open(tmp, "w", **profile) as dst:
        dst.write(data, 1)
    rio_copy(tmp, path, driver="COG", blocksize=128)
    tmp.unlink()
    return str(path)


def utm_file(tmp_path: Path, name: str, res: float, fill, *, cover_left_only: bool = False) -> tuple[str, np.ndarray]:
    """A file on the grid's own UTM lattice, extending MARGIN past it (or ending at the grid's middle)."""
    west, north = LA_GRID.minx - MARGIN, LA_GRID.maxy + MARGIN
    east = (LA_GRID.minx + LA_GRID.maxx) / 2 if cover_left_only else LA_GRID.maxx + MARGIN
    width, height = round((east - west) / res), round((north - (LA_GRID.miny - MARGIN)) / res)
    data = fill(height, width)
    return write_cog(tmp_path / name, data, epsg=LA_GRID.epsg, west=west, north=north, res=res), data


def test_same_crs_reads_the_exact_window(tmp_path):
    rows_cols = lambda h, w: (np.arange(h * w, dtype=np.uint16).reshape(h, w) % 60000) + 1  # noqa: E731
    href, data = utm_file(tmp_path, "b04.tif", 10, rows_cols)
    got = read_on_grid(href, LA_GRID)
    off = MARGIN // 10
    assert got.shape == LA_GRID.shape
    np.testing.assert_array_equal(got, data[off : off + LA_GRID.height, off : off + LA_GRID.width])


def test_a_20m_band_lines_up_with_the_10m_grid(tmp_path):
    rows_cols = lambda h, w: np.arange(h * w, dtype=np.uint16).reshape(h, w) + 1  # noqa: E731
    href, data = utm_file(tmp_path, "scl.tif", 20, rows_cols)
    got = read_on_grid(href, LA_GRID)  # nearest: every 20 m pixel becomes 2 x 2 grid pixels, no half-pixel shift
    off = MARGIN // 20
    expected = np.repeat(np.repeat(data[off:, off:], 2, axis=0), 2, axis=1)[: LA_GRID.height, : LA_GRID.width]
    np.testing.assert_array_equal(got, expected)


def test_pixels_outside_the_file_come_back_as_nodata(tmp_path):
    href, _ = utm_file(tmp_path, "edge.tif", 10, lambda h, w: np.full((h, w), 1234, np.uint16), cover_left_only=True)
    got = read_on_grid(href, LA_GRID)
    half = LA_GRID.width // 2
    assert (got[:, : half - 1] == 1234).all()
    assert (got[:, half + 1 :] == 0).all()


def test_other_crs_is_warped_onto_the_grid(tmp_path):
    # A scene from another projection (here plain lon/lat) still lands pixel-aligned on the UTM grid.
    x0, y0, x1, y1 = LA_BBOX
    res = 0.0001
    w, h = round((x1 - x0 + 0.02) / res), round((y1 - y0 + 0.02) / res)
    href = write_cog(tmp_path / "geo.tif", np.full((h, w), 777, np.uint16), epsg=4326, west=x0 - 0.01, north=y1 + 0.01, res=res)
    got = read_on_grid(href, LA_GRID)
    assert got.shape == LA_GRID.shape and (got == 777).all()


@pytest.fixture
def s2_item(tmp_path):
    """A Sentinel-2 item whose SCL (20 m) and B02 (10 m) assets are local COGs: top quarter cloud, blue DN 2000."""
    def scl(h, w):
        a = np.full((h, w), 4, np.uint8)  # vegetation
        top = MARGIN // 20 + LA_GRID.height // 2 // 4  # first quarter of the AOI rows (20 m rows)
        a[:top] = 9  # cloud, high probability
        return a

    scl_href, _ = utm_file(tmp_path, "SCL.tif", 20, scl)
    b02_href, _ = utm_file(tmp_path, "B02.tif", 10, lambda h, w: np.full((h, w), 2000, np.uint16))
    item = make_item()
    item["assets"] = {"SCL": {"href": scl_href}, "B02": {"href": b02_href}}
    return item


def test_screen_measures_the_aoi_clear_fraction_and_blue(s2_item):
    got = scenes.screen(s2_item, SENTINEL2, LA_BBOX)  # local paths are not blob URLs, so nothing is signed
    assert got.clear == pytest.approx(0.75, abs=0.02)
    assert got.blue == pytest.approx(0.1)  # (2000 - 1000 offset, baseline 05.13) / 10000


def test_screen_of_an_all_cloud_scene_has_no_blue(tmp_path):
    scl_href, _ = utm_file(tmp_path, "SCL.tif", 20, lambda h, w: np.full((h, w), 9, np.uint8))
    b02_href, _ = utm_file(tmp_path, "B02.tif", 10, lambda h, w: np.full((h, w), 2000, np.uint16))
    item = make_item()
    item["assets"] = {"SCL": {"href": scl_href}, "B02": {"href": b02_href}}
    got = scenes.screen(item, SENTINEL2, LA_BBOX)
    assert got.clear == 0 and got.blue is None

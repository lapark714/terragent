import numpy as np
from PIL import Image

from terragent_pipeline import render
from terragent_pipeline.render import MAP_SIDE, MIN_WIDTH, NDVI_RAMP, Header, data_ramp, hex_rgb, nice_date, stretch_for

HEADER = Header("NDVI", "vegetation index · 1 Feb 2025", "Contains modified Copernicus Sentinel data 2025", 10)


def test_ramp_endpoints_and_nan():
    rgb = NDVI_RAMP.rgb(np.array([[-1.0, 0.9, np.nan]]))
    assert tuple(rgb[0, 0]) == hex_rgb("#8c510a") == tuple(rgb[0, 2])
    assert tuple(rgb[0, 1]) == hex_rgb("#14532d")


def test_data_ramp_handles_flat_data():
    r = data_ramp(1.5, 1.5)
    assert r.hi > r.lo and r.decimals == 2


def test_stretch_is_shared_and_clamped():
    rgb = np.random.default_rng(1).uniform(0.02, 0.25, (50, 50, 3)).astype(np.float32)
    lo, hi = stretch_for([(rgb, np.ones((50, 50), bool))])
    assert 0 <= lo <= 0.08 and 0.15 <= hi <= 0.5
    assert stretch_for([]) == (0.0, 0.3)


def test_index_map_png_is_map_plus_footer(tmp_path):
    values = np.linspace(-0.2, 0.9, 200 * 120).reshape(120, 200)
    valid = np.ones_like(values, bool)
    valid[:10] = False
    path = tmp_path / "ndvi.png"
    render.save_index_map(path, values, valid, NDVI_RAMP, HEADER)
    with Image.open(path) as im:
        assert im.mode == "RGB"
        assert im.size[0] == MAP_SIDE and im.size[1] > MAP_SIDE * 120 / 200
    assert path.stat().st_size < 250_000


def test_tall_narrow_maps_keep_room_for_the_legend(tmp_path):
    path = tmp_path / "tall.png"
    render.save_class_map(path, np.zeros((300, 60, 3), np.uint8), np.zeros((300, 60), int),
                          [("new water", (47, 123, 255), 0.9)], np.zeros((300, 60), bool), HEADER)
    with Image.open(path) as im:
        assert im.size[0] == MIN_WIDTH


def test_true_color_png_is_palettised(tmp_path):
    path = tmp_path / "after.png"
    rgb = np.random.default_rng(2).uniform(0, 0.3, (200, 200, 3)).astype(np.float32)
    render.save_true_color(path, rgb, (0.0, 0.3), HEADER)
    with Image.open(path) as im:
        assert im.mode == "P" and max(im.size) <= MAP_SIDE + 80


def test_nice_date():
    assert nice_date("2025-02-01T18:34:31Z") == "1 Feb 2025"

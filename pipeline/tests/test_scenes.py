import numpy as np
import pytest

from conftest import LA_BBOX, make_item
from terragent_pipeline import scenes
from terragent_pipeline.job import SceneChoice, Window
from terragent_pipeline.scenes import Screened, is_hazy, min_clear, pick
from terragent_pipeline.sensors import LANDSAT, SENTINEL2

WINDOW = Window("2026-09-01", "2026-11-07")


def s(day: int, clear: float, blue: float | None = 0.10) -> Screened:
    return Screened(make_item(f"S2_{day}", f"2026-10-{day:02d}T18:00:00Z"), clear, blue)


def test_min_clear_from_max_cloud_pct():
    assert min_clear(20) == pytest.approx(0.8)
    assert min_clear(0) == 0.95  # never demand a perfect SCL
    assert min_clear(100) == 0.0


def test_newest_clear_scene_wins():
    got = pick([s(24, 0.5), s(19, 0.97), s(9, 1.0)], need=0.8)
    assert got and got.item["id"] == "S2_19"


def test_hazy_scenes_are_skipped_even_when_scl_calls_them_clear():
    # Real case (downtown LA, 2025-11-03): SCL 99.7% clear, median blue 0.135 vs 0.101 on a clear day.
    got = pick([s(24, 0.997, 0.135), s(19, 1.0, 0.101)], need=0.8)
    assert got and got.item["id"] == "S2_19"
    assert is_hazy(0.135, 0.101) and not is_hazy(0.11, 0.101) and not is_hazy(None, 0.1)


def test_falls_back_to_clearest_newest_on_ties():
    got = pick([s(24, 0.3), s(19, 0.6), s(9, 0.6)], need=0.8)
    assert got and got.item["id"] == "S2_19"
    assert pick([], need=0.8) is None


@pytest.fixture
def fake_catalog(monkeypatch):
    """Stub search + screen: per-collection item lists and a clear fraction per item id. Like the real API, search
    returns one page: items sorted by the requested direction, cut to `limit`."""
    state = {"items": {}, "clear": {}, "queries": [], "oldest_first": []}

    def search(collection, bbox, window, query=None, limit=50, oldest_first=False):
        state["queries"].append((collection, query))
        state["oldest_first"].append(oldest_first)
        items = sorted(state["items"].get(collection, []), key=lambda i: i["properties"]["datetime"], reverse=not oldest_first)
        return items[:limit]

    def screen(item, sensor, bbox):
        return Screened(item, state["clear"].get(item["id"], 1.0), 0.1)

    monkeypatch.setattr(scenes.stac, "search", search)
    monkeypatch.setattr(scenes, "screen", screen)
    return state


def test_find_scene_reports_cloudy_fallback(fake_catalog):
    fake_catalog["items"]["sentinel-2-l2a"] = [make_item("A", "2026-10-24T18:00:00Z"), make_item("B", "2026-10-19T18:00:00Z")]
    fake_catalog["clear"].update(A=0.4, B=0.6)
    chosen, notes = scenes.find_scene("after", LA_BBOX, WINDOW, 20, SENTINEL2)
    assert chosen and chosen.item["id"] == "B" and chosen.screened_clear == 0.6
    assert "No clear after scene" in notes[0] and "40% of the area" in notes[0]


def test_find_scene_screens_extra_low_cloud_candidates(fake_catalog):
    items = [make_item(f"N{d}", f"2026-10-{d:02d}T18:00:00Z", cloud=70) for d in range(28, 28 - scenes.MAX_SCREEN, -1)]
    items.append(make_item("OLD", "2026-09-05T18:00:00Z", cloud=2))
    fake_catalog["items"]["sentinel-2-l2a"] = items
    fake_catalog["clear"].update({i["id"]: 0.2 for i in items[: scenes.MAX_SCREEN]}, OLD=1.0)
    chosen, notes = scenes.find_scene("after", LA_BBOX, WINDOW, 20, SENTINEL2)
    assert chosen and chosen.item["id"] == "OLD" and notes == []


def test_find_scene_falls_back_to_landsat(fake_catalog):
    fake_catalog["items"]["landsat-c2-l2"] = [make_item("LC09_X", collection="landsat-c2-l2")]
    chosen, notes = scenes.find_scene("before", LA_BBOX, WINDOW, 20, SENTINEL2)
    assert chosen and chosen.sensor is LANDSAT
    assert "Used Landsat (30 m)" in notes[0]
    assert fake_catalog["queries"][-1][1]["platform"] == {"in": ["landsat-8", "landsat-9"]}


def test_find_scene_none_when_nothing_covers(fake_catalog):
    chosen, notes = scenes.find_scene("after", LA_BBOX, WINDOW, 20, SENTINEL2)
    assert chosen is None and notes == [f"No Sentinel-2 or Landsat scene covers the area in the after window {WINDOW}."]


def test_find_scene_pins_before_to_after_tile(fake_catalog):
    fake_catalog["items"]["sentinel-2-l2a"] = [make_item("P")]
    scenes.find_scene("before", LA_BBOX, WINDOW, 20, SENTINEL2, pin=make_item(tile="11SLT"))
    assert fake_catalog["queries"][0][1]["s2:mgrs_tile"] == {"eq": "11SLT"}


def test_find_scene_uses_named_scene(monkeypatch, fake_catalog):
    monkeypatch.setattr(scenes.stac, "get_item", lambda c, i: make_item(i) if i == "KNOWN" else None)
    chosen, notes = scenes.find_scene("after", LA_BBOX, WINDOW, 20, SENTINEL2, SceneChoice("sentinel-2-l2a", "KNOWN"))
    assert chosen and chosen.item["id"] == "KNOWN" and chosen.screened_clear is None and notes == []
    fake_catalog["items"]["sentinel-2-l2a"] = [make_item("FOUND")]
    chosen, notes = scenes.find_scene("after", LA_BBOX, WINDOW, 20, SENTINEL2, SceneChoice("sentinel-2-l2a", "GONE"))
    assert chosen and chosen.item["id"] == "FOUND" and "GONE was not found" in notes[0]
    chosen, notes = scenes.find_scene("before", LA_BBOX, None, 20, SENTINEL2, SceneChoice("sentinel-2-l2a", "GONE"))
    assert chosen is None


def test_load_scene_masks_clouds_and_nodata(monkeypatch):
    from conftest import LA_GRID

    def read(href, grid, resampling=None):
        key = href.rsplit("/", 1)[-1]
        if key == "SCL":
            scl = np.full(grid.shape, 4, np.uint8)
            scl[0, :] = 9  # cloud row
            return scl
        dn = np.full(grid.shape, 2000, np.uint16)
        dn[1, :] = 0  # nodata row
        return dn

    item = make_item()
    item["assets"] = {k: {"href": f"https://x.blob.core.windows.net/c/{k}"} for k in ("B02", "B03", "B04", "B08", "SCL")}
    monkeypatch.setattr(scenes, "read_on_grid", read)
    monkeypatch.setattr(scenes.stac, "sign", lambda href, c: href)
    sc = scenes.load_scene(item, SENTINEL2, LA_GRID, ("blue", "green", "red", "nir"))
    assert sc.refl["red"][5, 5] == pytest.approx(0.1)  # (2000 - 1000) / 10000
    assert not sc.clear[0].any() and not sc.clear[1].any() and sc.clear[2:].all()
    assert sc.summary()["clear_fraction"] == pytest.approx(1 - 2 / LA_GRID.height, abs=1e-4)


def test_find_scene_can_prefer_the_earliest_clear_scene(fake_catalog):
    # Floods recede within days: the first clear scene after the event matters, not the latest.
    fake_catalog["items"]["sentinel-2-l2a"] = [make_item(f"D{d}", f"2026-10-{d:02d}T18:00:00Z") for d in (28, 25, 22, 19)]
    fake_catalog["clear"].update(D19=0.3)
    latest, _ = scenes.find_scene("after", LA_BBOX, WINDOW, 20, SENTINEL2)
    first, _ = scenes.find_scene("after", LA_BBOX, WINDOW, 20, SENTINEL2, earliest=True)
    assert latest and latest.item["id"] == "D28"
    assert first and first.item["id"] == "D22"


def test_find_scene_earliest_reads_the_oldest_page_of_a_long_window(fake_catalog):
    # Event date to today: 60 passes, more than one STAC page. Only the first two after the event are clear.
    from datetime import date, timedelta

    days = [(date(2023, 4, 21) + timedelta(days=5 * i)).isoformat() for i in range(60)]
    fake_catalog["items"]["sentinel-2-l2a"] = [make_item(f"D{d}", f"{d}T18:00:00Z") for d in days]
    fake_catalog["clear"].update({f"D{d}": 1.0 if i < 2 else 0.2 for i, d in enumerate(days)})
    window = Window(days[0], days[-1])
    first, notes = scenes.find_scene("after", LA_BBOX, window, 20, SENTINEL2, earliest=True)
    assert first and first.item["id"] == f"D{days[0]}" and notes == []
    assert fake_catalog["oldest_first"] == [True]
    # Newest first (the default) never sees those scenes: only the newest 50 are on its page.
    latest, _ = scenes.find_scene("after", LA_BBOX, window, 20, SENTINEL2)
    assert latest and latest.item["id"] != f"D{days[0]}"
    assert fake_catalog["oldest_first"] == [True, False]


def test_find_scene_earliest_keeps_the_tile_pin_and_order(fake_catalog):
    fake_catalog["items"]["sentinel-2-l2a"] = [make_item(f"D{d}", f"2026-10-{d:02d}T18:00:00Z") for d in (19, 28, 22, 25)]
    first, _ = scenes.find_scene("after", LA_BBOX, WINDOW, 20, SENTINEL2, pin=make_item(tile="11SLT"), earliest=True)
    assert first and first.item["id"] == "D19"
    assert fake_catalog["queries"][0][1]["s2:mgrs_tile"] == {"eq": "11SLT"} and fake_catalog["oldest_first"] == [True]


# --- Stitching the tiles of one pass ---
BANDS = ("blue", "green", "red", "nir")


def tile_with_assets(tile, baseline="05.13", when="2026-10-24T18:34:31Z"):
    item = make_item(item_id=f"S2_{tile}", tile=tile, baseline=baseline, when=when)
    item["assets"] = {k: {"href": f"https://x.blob.core.windows.net/c/{tile}/{k}"} for k in ("B02", "B03", "B04", "B08", "SCL")}
    return item


@pytest.fixture
def two_tiles(monkeypatch):
    """Tile A has data in the top half only and tile B in the bottom three quarters (rows overlap in the middle).
    B has a pre-offset baseline, so the same DN gives a different reflectance. Row 0 of B's data is cloud."""
    from conftest import LA_GRID

    h = LA_GRID.height

    def read(href, grid, resampling=None):
        _, tile, key = href.rsplit("/", 2)
        rows = np.arange(grid.shape[0]) * h // grid.shape[0]
        valid = (rows < h // 2) if tile == "A" else (rows >= h // 4)
        out = np.zeros(grid.shape, np.uint16 if key != "SCL" else np.uint8)
        out[valid] = 4 if key == "SCL" else 2000
        if tile == "B" and key == "SCL":
            out[rows == h // 2 + 1] = 9  # a cloud row only B can see
        return out

    monkeypatch.setattr(scenes, "read_on_grid", read)
    monkeypatch.setattr(scenes.stac, "sign", lambda href, c: href)
    return LA_GRID, tile_with_assets("A"), tile_with_assets("B", baseline="02.12")


def test_load_pass_fills_gaps_from_the_other_tile(monkeypatch, two_tiles):
    grid, a, b = two_tiles
    monkeypatch.setattr(scenes.stac, "same_pass", lambda item, collection, bbox: [b])
    sc = scenes.load_pass(a, SENTINEL2, grid, BANDS, (0, 0, 1, 1))
    h = grid.height
    assert sc.data_fraction == 1.0
    assert sc.refl["red"][h // 4, 5] == pytest.approx(0.1)  # overlap row: tile A wins, with its own offset
    assert sc.refl["red"][h - 1, 5] == pytest.approx(0.2)  # filled from B, with B's scaling
    assert not sc.clear[h // 2 + 1].any() and sc.clear[h // 2 + 2:].all()  # B's cloud row stays cloud
    assert sc.tiles == ["A", "B"]
    assert sc.item["id"] == "S2_A"


def test_load_pass_leaves_a_complete_tile_alone(monkeypatch):
    from conftest import LA_GRID

    monkeypatch.setattr(scenes, "read_on_grid", lambda href, grid, resampling=None: np.full(grid.shape, 2000 if not href.endswith("SCL") else 4, np.uint16))
    monkeypatch.setattr(scenes.stac, "sign", lambda href, c: href)
    monkeypatch.setattr(scenes.stac, "same_pass", lambda *a: pytest.fail("looked for other tiles"))
    sc = scenes.load_pass(tile_with_assets("A"), SENTINEL2, LA_GRID, BANDS, (0, 0, 1, 1))
    assert sc.tiles == [] and sc.data_fraction == 1.0


def test_load_pass_survives_a_failed_tile_lookup(monkeypatch, two_tiles):
    grid, a, _ = two_tiles

    def boom(*a):
        raise TimeoutError("STAC down")

    monkeypatch.setattr(scenes.stac, "same_pass", boom)
    sc = scenes.load_pass(a, SENTINEL2, grid, BANDS, (0, 0, 1, 1))
    assert sc.tiles == [] and sc.fill_failed and sc.data_fraction == pytest.approx(0.5, abs=0.01)


def test_screen_measures_the_whole_pass(monkeypatch, two_tiles):
    grid, a, b = two_tiles
    monkeypatch.setattr(scenes.stac, "same_pass", lambda item, collection, bbox: [b])
    monkeypatch.setattr(scenes, "grid_for_bbox", lambda bbox, epsg, res: grid)
    with_b = scenes.screen(a, SENTINEL2, (0, 0, 1, 1))
    monkeypatch.setattr(scenes.stac, "same_pass", lambda item, collection, bbox: [])
    alone = scenes.screen(a, SENTINEL2, (0, 0, 1, 1))
    assert alone.clear == pytest.approx(0.5, abs=0.01)
    assert with_b.clear > 0.95


def _fail_tile_reads(monkeypatch, tile):
    from rasterio.errors import RasterioIOError

    real = scenes.read_on_grid

    def read(href, grid, resampling=None):
        if f"/{tile}/" in href:
            raise RasterioIOError("503 from blob storage")
        return real(href, grid, resampling)

    monkeypatch.setattr(scenes, "read_on_grid", read)


def test_load_pass_keeps_going_when_a_neighbouring_tile_cannot_be_read(monkeypatch, two_tiles):
    grid, a, b = two_tiles
    monkeypatch.setattr(scenes.stac, "same_pass", lambda item, collection, bbox: [b])
    _fail_tile_reads(monkeypatch, "B")
    sc = scenes.load_pass(a, SENTINEL2, grid, BANDS, (0, 0, 1, 1))
    assert sc.fill_failed and sc.tiles == [] and sc.data_fraction == pytest.approx(0.5, abs=0.01)


def test_a_failed_read_of_the_main_tile_still_raises(monkeypatch, two_tiles):
    from rasterio.errors import RasterioIOError

    grid, a, b = two_tiles
    monkeypatch.setattr(scenes.stac, "same_pass", lambda item, collection, bbox: [b])
    _fail_tile_reads(monkeypatch, "A")
    with pytest.raises(RasterioIOError):
        scenes.load_pass(a, SENTINEL2, grid, BANDS, (0, 0, 1, 1))


def test_screen_keeps_going_when_a_neighbouring_tile_cannot_be_read(monkeypatch, two_tiles):
    grid, a, b = two_tiles
    monkeypatch.setattr(scenes.stac, "same_pass", lambda item, collection, bbox: [b])
    monkeypatch.setattr(scenes, "grid_for_bbox", lambda bbox, epsg, res: grid)
    _fail_tile_reads(monkeypatch, "B")
    assert scenes.screen(a, SENTINEL2, (0, 0, 1, 1)).clear == pytest.approx(0.5, abs=0.01)


def test_no_tile_pin_across_a_tile_edge(fake_catalog):
    edge = make_item(item_id="after_edge", bbox=(-119.0, 33.5, -117.5, LA_BBOX[1] + 0.005))
    fake_catalog["items"]["sentinel-2-l2a"] = [make_item(item_id="b1", when="2026-09-20T18:34:31Z", tile="11SLT")]
    edge_pick, _ = scenes.find_scene("before", LA_BBOX, Window("2026-09-01", "2026-09-30"), 20, SENTINEL2, pin={**edge, "collection": "sentinel-2-l2a"})
    assert edge_pick.item["id"] == "b1"
    assert all("s2:mgrs_tile" not in (q or {}) for _, q in fake_catalog["queries"])


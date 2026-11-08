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
    """Stub search + screen: per-collection item lists and a clear fraction per item id."""
    state = {"items": {}, "clear": {}, "queries": []}

    def search(collection, bbox, window, query=None, limit=50):
        state["queries"].append((collection, query))
        return list(state["items"].get(collection, []))

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

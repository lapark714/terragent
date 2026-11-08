import numpy as np
import pytest
from PIL import Image

from conftest import LA_GRID, SHAPE, make_scene, refl
from terragent_pipeline.job import Window
from terragent_pipeline.recipes import RECIPE_SPECS, Ctx, default_before
from terragent_pipeline.render import MAP_SIDE

PX_KM2 = LA_GRID.pixel_km2
HALF_KM2 = SHAPE[0] * (SHAPE[1] // 2) * PX_KM2  # about 2 km2


def ctx(tmp_path, after, before=None):
    return Ctx(after, before, LA_GRID, tmp_path, (0.0, 0.3))


def row(outcome, name):
    return next(r for r in outcome.indices if r["name"] == name)


def check_images(outcome, tmp_path):
    for img in outcome.images:
        with Image.open(tmp_path / img["path"]) as im:
            width, height = im.size
            assert width <= MAP_SIDE and MAP_SIDE < height <= MAP_SIDE + 120  # square map + legend footer
        assert img["caption"]
        assert img["role"] in {"index", "change"}


def test_burn_severity_flags_the_burned_half(tmp_path, left_half):
    nir08 = np.where(left_half, 0.12, 0.35)  # left half burned: NIR drops, SWIR2 rises
    swir22 = np.where(left_half, 0.25, 0.12)
    before = make_scene(refl(nir08=0.35, swir22=0.12), when="2025-01-02T18:00:00Z")
    after = make_scene(refl(nir08=nir08, swir22=swir22), when="2025-02-01T18:00:00Z")
    o = RECIPE_SPECS["burn_severity"].analyse(ctx(tmp_path, after, before))
    dnbr = row(o, "dnbr")
    assert dnbr["affected_area_km2"] == pytest.approx(HALF_KM2)
    assert dnbr["delta"] == pytest.approx(((0.35 - 0.12) / 0.47 - (0.12 - 0.25) / 0.37) / 2, abs=1e-3)
    assert row(o, "dnbr_high")["affected_area_km2"] == pytest.approx(HALF_KM2)  # dNBR 0.84
    assert row(o, "dnbr_low")["affected_area_km2"] == 0
    nbr = row(o, "nbr")
    assert nbr["before_mean"] > nbr["after_mean"] and nbr["delta"] < 0
    assert {i["path"] for i in o.images} == {"index_nbr.png", "change_burn.png"}
    assert set(o.layers) == {"nbr_mean", "dnbr_mean"}
    check_images(o, tmp_path)


def test_burn_without_before_scene_reports_after_only(tmp_path):
    o = RECIPE_SPECS["burn_severity"].analyse(ctx(tmp_path, make_scene(refl())))
    assert [r["name"] for r in o.indices] == ["nbr"]
    assert row(o, "nbr")["before_mean"] is None and row(o, "nbr")["delta"] is None


def test_flood_extent_counts_new_water_only_where_both_clear(tmp_path, left_half):
    wet = refl(green=np.where(left_half, 0.08, 0.10), nir=np.where(left_half, 0.03, 0.25),
               swir16=np.where(left_half, 0.02, 0.22))
    clear = np.ones(SHAPE, bool)
    clear[:50, :] = False  # top quarter cloudy after the flood
    o = RECIPE_SPECS["flood_extent"].analyse(ctx(tmp_path, make_scene(wet, clear), make_scene(refl())))
    expected = (SHAPE[0] - 50) * (SHAPE[1] // 2) * PX_KM2
    assert row(o, "mndwi")["affected_area_km2"] == pytest.approx(expected)
    assert row(o, "ndwi")["affected_area_km2"] == pytest.approx(expected)
    assert "new surface water" in row(o, "mndwi")["threshold"]
    assert any("shadow" in w for w in o.warnings)
    check_images(o, tmp_path)


def test_forest_loss_needs_vegetation_before(tmp_path, left_half):
    before = make_scene(refl(red=0.04, nir=np.where(left_half, 0.40, 0.08)))  # left: forest (NDVI .82), right: NDVI .33
    after = make_scene(refl(red=0.12, nir=np.where(left_half, 0.20, 0.10)))  # both fall, only left was forest
    o = RECIPE_SPECS["forest_loss"].analyse(ctx(tmp_path, after, before))
    assert row(o, "ndvi")["affected_area_km2"] == pytest.approx(HALF_KM2)
    assert row(o, "ndvi")["delta"] < -0.2
    check_images(o, tmp_path)


def test_mining_indicators_are_labelled_as_indicators(tmp_path):
    red = np.full(SHAPE, 0.12, np.float32)
    red[:10, :10] = 0.30  # an iron-oxide-red patch of 100 px
    o = RECIPE_SPECS["mining_indicators"].analyse(ctx(tmp_path, make_scene(refl(red=red, nir=0.16))))
    iron = row(o, "iron_oxide")
    assert iron["unit"] == "ratio"
    assert iron["affected_area_km2"] == pytest.approx(100 * PX_KM2)
    assert "indicator only, not a deposit" in iron["threshold"]
    assert any("not evidence of a mineral deposit" in w for w in o.warnings)
    assert all("indicator only" in i["caption"] for i in o.images)
    assert set(o.layers) == {"iron_oxide_ratio", "clay_ratio"}
    check_images(o, tmp_path)


def test_mining_warns_when_area_is_vegetated(tmp_path):
    o = RECIPE_SPECS["mining_indicators"].analyse(ctx(tmp_path, make_scene(refl(red=0.04, nir=0.4))))
    assert any("bare ground" in w for w in o.warnings)
    assert row(o, "iron_oxide")["after_mean"] is None


def test_change_detection_and_vegetation_health(tmp_path, left_half):
    before = make_scene(refl(red=0.05, nir=0.40))
    after = make_scene(refl(red=0.05, nir=np.where(left_half, 0.10, 0.40)))
    change = RECIPE_SPECS["change_detection"].analyse(ctx(tmp_path, after, before))
    assert row(change, "ndvi")["affected_area_km2"] == pytest.approx(HALF_KM2)
    assert {i["role"] for i in change.images} == {"index", "change"}
    veg = RECIPE_SPECS["vegetation_health"].analyse(ctx(tmp_path, after, before))
    assert row(veg, "ndvi")["affected_area_km2"] == pytest.approx(HALF_KM2)  # right half still NDVI .78
    assert "ndvi_delta" in veg.layers
    check_images(veg, tmp_path)


def test_true_color_reports_ndvi_context(tmp_path):
    o = RECIPE_SPECS["true_color"].analyse(ctx(tmp_path, make_scene(refl(red=0.05, nir=0.45))))
    assert row(o, "ndvi")["after_mean"] == pytest.approx(0.8)
    assert o.images == [] and set(o.layers) == {"ndvi_mean"}


def test_true_color_image_caption(tmp_path):
    c = ctx(tmp_path, make_scene(refl()))
    img = c.true_color_image(c.after, "after")
    assert img == {"role": "after", "path": "after_true_color.png",
                   "caption": "After: Sentinel-2 true colour, 24 Oct 2026 (100% of the area clear)."}
    assert (tmp_path / "after_true_color.png").stat().st_size < 400_000


def test_default_before_windows():
    after = Window("2025-01-12", "2025-02-10")
    assert default_before(RECIPE_SPECS["burn_severity"], after) == Window("2024-11-13", "2025-01-11")
    assert default_before(RECIPE_SPECS["forest_loss"], after) == Window("2024-01-13", "2024-02-11")
    assert default_before(RECIPE_SPECS["true_color"], after) is None


def test_every_recipe_has_a_spec():
    from terragent_pipeline.job import RECIPES

    assert set(RECIPE_SPECS) == set(RECIPES)

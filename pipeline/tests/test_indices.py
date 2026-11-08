import numpy as np
import pytest

from terragent_pipeline.indices import (
    DNBR_CLASSES,
    area_km2,
    clay,
    dnbr_class,
    iron_oxide,
    masked,
    mean,
    mndwi,
    nbr,
    nd,
    ndvi,
    ndwi,
    ratio,
    robust_high,
)


def bands(**kw):
    return {k: np.array([v], dtype=np.float32) for k, v in kw.items()}


def test_normalised_difference_and_guards():
    np.testing.assert_allclose(nd(np.array([0.5, 0.2]), np.array([0.1, 0.2])), [0.6667, 0.0], atol=1e-4)
    assert np.isnan(nd(np.array([-0.05]), np.array([0.05]))[0])  # zero denominator after the BOA offset
    assert np.isnan(nd(np.array([0.01]), np.array([0.02]), min_sum=0.05)[0])


def test_index_formulas_use_the_documented_bands():
    r = bands(blue=0.05, green=0.10, red=0.05, nir=0.45, nir08=0.40, swir16=0.20, swir22=0.10)
    assert ndvi(r)[0] == pytest.approx((0.45 - 0.05) / 0.50)
    assert ndwi(r)[0] == pytest.approx((0.10 - 0.45) / 0.55)
    assert mndwi(r)[0] == pytest.approx((0.10 - 0.20) / 0.30)
    assert nbr(r)[0] == pytest.approx((0.40 - 0.10) / 0.50)  # narrow NIR (B8A), not B08
    assert iron_oxide(r)[0] == pytest.approx(1.0)
    assert clay(r)[0] == pytest.approx(2.0)


def test_vegetation_indices_skip_dark_pixels_but_water_indices_keep_them():
    water = bands(blue=0.03, green=0.04, red=0.02, nir=0.01, nir08=0.01, swir16=0.005, swir22=0.003)
    assert np.isnan(ndvi(water)[0]) and np.isnan(nbr(water)[0])
    assert mndwi(water)[0] > 0 and ndwi(water)[0] > 0


def test_ratio_rejects_non_positive_inputs():
    assert np.isnan(ratio(np.array([0.1, -0.1]), np.array([0.0, 0.1]))).all()


@pytest.mark.parametrize(
    "value, label",
    [(-0.3, "regrowth_high"), (-0.2, "regrowth_low"), (0.0, "unburned"), (0.1, "low"), (0.3, "moderate_low"),
     (0.5, "moderate_high"), (0.66, "high"), (0.9, "high")],
)
def test_dnbr_usgs_classes(value, label):
    assert DNBR_CLASSES[dnbr_class(np.array([value]))[0]] == label


def test_dnbr_class_marks_nan():
    assert dnbr_class(np.array([np.nan]))[0] == -1


def test_stats_helpers():
    v = np.array([1.0, 3.0, np.nan, 100.0])
    ok = np.array([True, True, True, False])
    assert mean(masked(v, ok)) == 2.0
    assert mean(np.array([np.nan])) is None
    assert area_km2(np.ones((10, 10), bool), 1e-4) == 0.01  # 100 Sentinel-2 pixels = 0.01 km2
    flat = np.r_[np.full(99, 1.0), 5.0]
    assert robust_high(flat) == pytest.approx(1.0)  # MAD 0: anything above the median stands out
    assert robust_high(np.array([1.0, 2.0])) is None

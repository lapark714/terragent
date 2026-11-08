import numpy as np
import pytest

from terragent_pipeline.sensors import (
    LANDSAT,
    SENTINEL2,
    boa_offset,
    epsg_of,
    landsat_reflectance,
    qa_clear,
    s2_reflectance,
    scl_clear,
)


@pytest.mark.parametrize("baseline, offset", [("05.13", -1000), ("04.00", -1000), ("03.00", 0), ("02.12", 0), (None, 0), ("n/a", 0)])
def test_boa_offset_follows_processing_baseline(baseline, offset):
    assert boa_offset({"s2:processing_baseline": baseline}) == offset


def test_s2_reflectance_applies_offset_and_masks_dn_zero():
    dn = np.array([[0, 1000, 2000, 11000]], dtype=np.uint16)
    new = s2_reflectance({"s2:processing_baseline": "05.13"}, dn)
    assert np.isnan(new[0, 0])
    np.testing.assert_allclose(new[0, 1:], [0.0, 0.1, 1.0])
    old = s2_reflectance({"s2:processing_baseline": "02.12"}, dn)
    np.testing.assert_allclose(old[0, 1:], [0.1, 0.2, 1.1])


def test_landsat_scale_and_fill():
    r = landsat_reflectance({}, np.array([0, 18639], dtype=np.uint16))
    assert np.isnan(r[0])
    assert r[1] == pytest.approx(0.3126, abs=1e-4)  # USGS worked example


def test_scl_mask_keeps_land_water_snow_and_drops_cloud_shadow_nodata():
    scl = np.arange(12)
    assert scl_clear(scl).tolist() == [False, False, True, False, True, True, True, True, False, False, False, True]


def test_qa_pixel_bits():
    clear, fill, cloud, shadow, cirrus, outside = 0b1000000, 0b1, 0b1000, 0b10000, 0b100, 0
    assert qa_clear(np.array([clear, fill, cloud, shadow, cirrus, outside], dtype=np.uint16)).tolist() == [
        True, False, False, False, False, False,
    ]


def test_epsg_from_raw_json_or_pystac_style():
    assert epsg_of({"properties": {"proj:epsg": 32611}}) == 32611
    assert epsg_of({"properties": {"proj:code": "EPSG:32755"}}) == 32755


def test_band_maps_cover_every_recipe_band():
    for sensor in (SENTINEL2, LANDSAT):
        assert set(sensor.bands) == {"blue", "green", "red", "nir", "nir08", "swir16", "swir22"}
        assert all(asset in sensor.native_m for asset in sensor.bands.values())
        assert sensor.mask_asset in sensor.native_m
    assert SENTINEL2.credit(2025) == "Contains modified Copernicus Sentinel data 2025"

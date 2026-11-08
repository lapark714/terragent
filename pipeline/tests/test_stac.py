import time

import pytest

from conftest import LA_BBOX, make_item
from terragent_pipeline import stac
from terragent_pipeline.job import Window


def test_covers_needs_all_four_corners():
    inside = make_item(bbox=(-119, 33.5, -117.5, 34.6))
    edge = make_item(bbox=(-118.25, 33.5, -117.5, 34.6))  # cuts through the AOI
    assert stac.covers(inside["geometry"], LA_BBOX)
    assert not stac.covers(edge["geometry"], LA_BBOX)
    multi = {"type": "MultiPolygon", "coordinates": [edge["geometry"]["coordinates"], inside["geometry"]["coordinates"]]}
    assert stac.covers(multi, LA_BBOX)
    assert not stac.covers(None, LA_BBOX)


def test_candidates_dedupe_sort_and_prefer_full_cover():
    old = make_item("A", "2026-10-01T18:00:00Z")
    new_edge = make_item("B", "2026-10-20T18:00:00Z", bbox=(-118.25, 33.5, -117.5, 34.6))
    dup_old_gen = make_item("C1", "2026-10-10T18:00:00Z", generation="2026-10-10T20:00:00Z")
    dup_new_gen = make_item("C2", "2026-10-10T18:00:00Z", generation="2026-10-11T09:00:00Z")
    got = stac.candidates([old, new_edge, dup_old_gen, dup_new_gen], LA_BBOX)
    assert [i["id"] for i in got] == ["C2", "A"]  # newest first, edge tile dropped, newest generation kept
    assert [i["id"] for i in stac.candidates([new_edge], LA_BBOX)] == ["B"]  # nothing covers fully: keep it


def test_candidates_keep_one_tile_per_acquisition():
    # Valencia sits on the 30SYJ / 31SBD overlap: the same datatake comes back once per tile.
    edge = make_item("T30-edge", "2024-11-10T10:51:59Z", tile="30SYJ", bbox=(-118.25, 33.5, -117.5, 34.6))
    full = make_item("T31-full", "2024-11-10T10:51:59Z", tile="31SBD")
    assert [i["id"] for i in stac.candidates([full, edge], LA_BBOX)] == ["T31-full"]
    assert [i["id"] for i in stac.candidates([edge, full], LA_BBOX)] == ["T31-full"]


def test_tile_helpers():
    s2 = make_item(tile="11SLT")
    assert stac.tile_of(s2) == "11SLT"
    assert stac.tile_query(s2) == {"s2:mgrs_tile": {"eq": "11SLT"}}
    ls = {"properties": {"landsat:wrs_path": "041", "landsat:wrs_row": "036"}}
    assert stac.tile_of(ls) == "041/036"
    assert stac.tile_query(ls) == {"landsat:wrs_path": {"eq": "041"}, "landsat:wrs_row": {"eq": "036"}}


def test_search_posts_the_stac_body(monkeypatch):
    sent = {}

    def fake(url, body=None, tries=3, timeout=20.0):
        sent.update(url=url, body=body)
        return {"features": [make_item()]}

    monkeypatch.setattr(stac, "_http_json", fake)
    items = stac.search("sentinel-2-l2a", LA_BBOX, Window("2026-09-01", "2026-11-07"), {"eo:cloud_cover": {"lte": 80}})
    assert len(items) == 1
    assert sent["url"].endswith("/api/stac/v1/search")
    body = sent["body"]
    assert body["collections"] == ["sentinel-2-l2a"]
    assert body["datetime"] == "2026-09-01T00:00:00Z/2026-11-07T23:59:59Z"
    assert body["intersects"]["coordinates"][0][0] == [LA_BBOX[0], LA_BBOX[1]]
    assert body["sortby"] == [{"field": "datetime", "direction": "desc"}]
    assert body["query"] == {"eo:cloud_cover": {"lte": 80}} and body["limit"] == 50
    # The page is all we read: "earliest" must ask for the oldest end of the window.
    stac.search("sentinel-2-l2a", LA_BBOX, Window("2023-04-20", "2026-11-07"), oldest_first=True)
    assert sent["body"]["sortby"] == [{"field": "datetime", "direction": "asc"}]


def test_sign_caches_token_and_skips_non_blob_urls(monkeypatch):
    calls = []
    expiry = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 2700))

    def fake(url, body=None, tries=3):
        calls.append(url)
        return {"token": "st=1&se=2&sig=x", "msft:expiry": expiry}

    monkeypatch.setattr(stac, "_http_json", fake)
    monkeypatch.setattr(stac, "_tokens", {})
    blob = "https://sentinel2l2a01.blob.core.windows.net/sentinel2-l2/a/B04.tif"
    assert stac.sign(blob, "sentinel-2-l2a") == blob + "?st=1&se=2&sig=x"
    assert stac.sign(blob, "sentinel-2-l2a") == blob + "?st=1&se=2&sig=x"
    assert calls == ["https://planetarycomputer.microsoft.com/api/sas/v1/token/sentinel-2-l2a"]
    assert stac.sign("https://example.com/x.tif", "sentinel-2-l2a") == "https://example.com/x.tif"


def test_http_404_is_none(monkeypatch):
    import urllib.error

    def boom(*a, **k):
        raise urllib.error.HTTPError("u", 404, "nf", {}, None)

    monkeypatch.setattr(stac.urllib.request, "urlopen", boom)
    assert stac.get_item("sentinel-2-l2a", "missing") is None


def test_http_retries_then_raises(monkeypatch):
    import urllib.error

    attempts = []

    def flaky(*a, **k):
        attempts.append(1)
        raise urllib.error.HTTPError("u", 503, "busy", {}, None)

    monkeypatch.setattr(stac.urllib.request, "urlopen", flaky)
    monkeypatch.setattr(stac.time, "sleep", lambda s: None)
    with pytest.raises(urllib.error.HTTPError):
        stac.get_item("sentinel-2-l2a", "x")
    assert len(attempts) == 3


# --- A pass across a tile edge: the AOI straddles lat 34.05 between two tiles of one pass ---
AOI = (-118.26, 34.04, -118.24, 34.06)
SOUTH = (-119.0, 33.0, -117.5, 34.05)
NORTH = (-119.0, 34.05, -117.5, 35.0)


def tile_item(tile, bbox, when="2026-10-24T18:34:31Z", orbit=27, generation="2026-10-24T21:48:12Z", platform="Sentinel-2C"):
    it = make_item(item_id=f"S2_{tile}_{when[:10]}_{orbit}_{generation[:13]}", when=when, tile=tile, bbox=bbox, generation=generation)
    it["properties"]["sat:relative_orbit"] = orbit
    it["properties"]["platform"] = platform
    return it


def test_coverage_is_the_union_of_the_footprints():
    assert stac.coverage([tile_item("S", SOUTH)["geometry"]], AOI) == pytest.approx(0.5, abs=0.05)
    assert stac.coverage([tile_item("S", SOUTH)["geometry"], tile_item("N", NORTH)["geometry"]], AOI) == 1.0
    assert stac.coverage([None], AOI) == 0.0


def test_candidates_counts_a_pass_whose_tiles_together_cover_the_aoi():
    old_full = tile_item("W", (-119.0, 33.0, -117.5, 35.0), when="2026-10-14T18:34:31Z", orbit=27)
    stitched = [tile_item("S", SOUTH), tile_item("N", NORTH)]
    partial_newer = tile_item("S", SOUTH, when="2026-10-29T18:34:31Z", orbit=27)
    out = stac.candidates([partial_newer, *stitched, old_full], AOI)
    assert [i["properties"]["datetime"][:10] for i in out] == ["2026-10-24", "2026-10-14"]  # the half-covered pass is dropped


def test_candidates_keeps_partial_passes_when_none_covers():
    out = stac.candidates([tile_item("S", SOUTH), tile_item("N", NORTH, when="2026-10-14T18:34:31Z")], AOI)
    assert len(out) == 2


def test_candidates_keeps_the_tile_with_the_largest_share():
    small = tile_item("SMALL", (-119.0, 33.0, -117.5, 34.043))
    large = tile_item("LARGE", (-119.0, 33.0, -117.5, 34.055))
    assert stac.candidates([small, large], AOI)[0]["properties"]["s2:mgrs_tile"] == "LARGE"


def test_same_pass_makes_no_search_when_the_item_covers_the_aoi(monkeypatch):
    monkeypatch.setattr(stac, "search", lambda *a, **k: pytest.fail("searched"))
    assert stac.same_pass(tile_item("W", (-119.0, 33.0, -117.5, 35.0)), "sentinel-2-l2a", AOI) == []


def test_same_pass_returns_only_other_tiles_of_that_pass_newest_processing_first(monkeypatch):
    main = tile_item("S", SOUTH)
    north_old = tile_item("N", NORTH, generation="2026-10-24T21:00:00Z")
    north_new = tile_item("N", NORTH, generation="2026-10-25T09:00:00Z")
    other_orbit = tile_item("E", NORTH, orbit=70)
    other_sat = tile_item("F", NORTH, platform="Sentinel-2A")
    seen = {}

    def search(collection, bbox, window, query=None, limit=50, oldest_first=False, tries=3, timeout=20.0):
        seen.update(collection=collection, window=window.stac(), tries=tries, timeout=timeout)
        return [main, north_old, north_new, other_orbit, other_sat]

    monkeypatch.setattr(stac, "search", search)
    assert [i["id"] for i in stac.same_pass(main, "sentinel-2-l2a", AOI)] == [north_new["id"]]
    assert seen == {"collection": "sentinel-2-l2a", "window": "2026-10-24T00:00:00Z/2026-10-24T23:59:59Z", "tries": 1, "timeout": 8.0}


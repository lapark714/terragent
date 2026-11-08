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

    def fake(url, body=None, tries=3):
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

"""Planetary Computer STAC search + SAS signing over plain HTTPS. Anonymous: no key, no account, no cost.

Raw JSON on purpose (not pystac): item properties keep `proj:epsg`, and there are fewer deps to install
on a fresh 1 vCPU computer. Verified endpoints: docs/platform/imagery.md §3.1, §3.4.
"""
from __future__ import annotations

import json
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime

import certifi

from .job import Window

STAC_URL = "https://planetarycomputer.microsoft.com/api/stac/v1"
SAS_URL = "https://planetarycomputer.microsoft.com/api/sas/v1/token"
RETRY_STATUS = {429, 500, 502, 503, 504}
TIMEOUT_S = 20.0

_ssl = ssl.create_default_context(cafile=certifi.where())
_tokens: dict[str, tuple[str, float]] = {}  # collection -> (SAS token, expiry epoch seconds)
_tokens_lock = threading.Lock()

BBox = tuple[float, float, float, float]


def _http_json(url: str, body: dict | None = None, tries: int = 3, timeout: float = TIMEOUT_S) -> dict | None:
    """GET (or POST JSON) with retries on 429/5xx and network errors. 404 -> None."""
    data = json.dumps(body).encode() if body is not None else None
    headers = {"content-type": "application/json", "user-agent": "terragent-pipeline"}
    for attempt in range(tries):
        req = urllib.request.Request(url, data=data, headers=headers, method="POST" if data else "GET")
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=_ssl) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if e.code not in RETRY_STATUS or attempt == tries - 1:
                raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == tries - 1:
                raise
        time.sleep(0.8 * 2**attempt)
    return None


def bbox_polygon(bbox: BBox) -> dict:
    x0, y0, x1, y1 = bbox
    return {"type": "Polygon", "coordinates": [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]]}


def search(
    collection: str, bbox: BBox, window: Window, query: dict | None = None, limit: int = 50, oldest_first: bool = False,
    tries: int = 3, timeout: float = TIMEOUT_S,
) -> list[dict]:
    """Items intersecting the AOI in the window, newest first (oldest first with `oldest_first`). One page only
    (`limit` is the page size), so the sort decides which end of a long window is seen at all."""
    body: dict = {
        "collections": [collection],
        "intersects": bbox_polygon(bbox),
        "datetime": window.stac(),
        "sortby": [{"field": "datetime", "direction": "asc" if oldest_first else "desc"}],
        "limit": limit,
    }
    if query:
        body["query"] = query
    fc = _http_json(f"{STAC_URL}/search", body, tries=tries, timeout=timeout)
    return list((fc or {}).get("features", []))


def get_item(collection: str, item_id: str) -> dict | None:
    c, i = urllib.parse.quote(collection), urllib.parse.quote(item_id)
    return _http_json(f"{STAC_URL}/collections/{c}/items/{i}")


def sign(href: str, collection: str) -> str:
    """Append the collection's anonymous SAS token (45 min lifetime, refreshed when < 60 s remain)."""
    if not urllib.parse.urlparse(href).netloc.endswith(".blob.core.windows.net") or "se=" in href:
        return href
    with _tokens_lock:
        token, expiry = _tokens.get(collection, ("", 0.0))
        if expiry - time.time() < 60:
            res = _http_json(f"{SAS_URL}/{urllib.parse.quote(collection)}") or {}
            token = res["token"]
            expiry = datetime.fromisoformat(res["msft:expiry"].replace("Z", "+00:00")).timestamp()
            _tokens[collection] = (token, expiry)
    return f"{href}?{token}"


def tile_of(item: dict) -> str | None:
    """Sentinel-2 MGRS tile or Landsat WRS path/row: scenes on one tile share a pixel grid."""
    p = item.get("properties", {})
    if p.get("s2:mgrs_tile"):
        return str(p["s2:mgrs_tile"])
    if p.get("landsat:wrs_path") and p.get("landsat:wrs_row"):
        return f"{p['landsat:wrs_path']}/{p['landsat:wrs_row']}"
    return None


def tile_query(item: dict) -> dict:
    """STAC `query` clause pinning a search to the item's tile."""
    p = item.get("properties", {})
    if p.get("s2:mgrs_tile"):
        return {"s2:mgrs_tile": {"eq": p["s2:mgrs_tile"]}}
    if p.get("landsat:wrs_path") and p.get("landsat:wrs_row"):
        return {"landsat:wrs_path": {"eq": p["landsat:wrs_path"]}, "landsat:wrs_row": {"eq": p["landsat:wrs_row"]}}
    return {}


def covers(geometry: dict | None, bbox: BBox) -> bool:
    """True if the item footprint contains all four AOI corners (footprints are convex, AOIs small)."""
    if not geometry:
        return False
    polys = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry.get("coordinates", [])
    x0, y0, x1, y1 = bbox
    corners = ((x0, y0), (x1, y0), (x1, y1), (x0, y1))
    return any(all(_inside(pt, poly[0]) for pt in corners) for poly in polys)


def _inside(pt: tuple[float, float], ring: list) -> bool:
    x, y = pt
    inside = False
    for (xa, ya), (xb, yb) in zip(ring, ring[1:] + ring[:1]):
        if (ya > y) != (yb > y) and x < (xb - xa) * (y - ya) / (yb - ya) + xa:
            inside = not inside
    return inside


def coverage(geometries: list[dict | None], bbox: BBox, n: int = 24) -> float:
    """Share of the AOI inside the union of the footprints, from an n x n sample of points."""
    rings = []
    for g in geometries:
        if g:
            rings += [poly[0] for poly in ([g["coordinates"]] if g["type"] == "Polygon" else g.get("coordinates", []))]
    x0, y0, x1, y1 = bbox
    points = [(x0 + (i + 0.5) * (x1 - x0) / n, y0 + (j + 0.5) * (y1 - y0) / n) for i in range(n) for j in range(n)]
    return sum(any(_inside(pt, ring) for ring in rings) for pt in points) / len(points)


def pass_key(item: dict) -> str:
    """One satellite pass: UTC day, platform and orbit. Its tiles are cut from one continuous image, so they stitch."""
    p = item.get("properties", {})
    return f"{str(p.get('datetime'))[:10]}|{p.get('platform', '')}|{p.get('sat:relative_orbit', p.get('landsat:wrs_path', ''))}"


FULL_COVERAGE = 0.995  # the sampled union counts as the whole AOI (one sample point is about 0.17%)
FILL_LOOKUP_TIMEOUT_S = 8.0  # one try: the fill is optional and the whole job has a 75 s deadline


def candidates(items: list[dict], bbox: BBox) -> list[dict]:
    """Newest first, one item per satellite pass (tiles overlap, so an AOI can sit in two). The item kept is the tile
    that covers the most of the AOI, then the latest processing. A pass whose tiles together cover the AOI counts as
    covering it (the reader stitches them: see same_pass); passes that don't are dropped if any pass does."""

    def rank(it: dict) -> tuple:
        p = it.get("properties", {})
        return (covers(it.get("geometry"), bbox), coverage([it.get("geometry")], bbox), str(p.get("s2:generation_time", "")), tile_of(it) or "")

    groups: dict[str, list[dict]] = {}
    for it in items:
        groups.setdefault(pass_key(it), []).append(it)
    best: list[dict] = []
    full: set[str] = set()
    for group in groups.values():
        top = max(group, key=rank)
        best.append(top)
        if covers(top.get("geometry"), bbox) or coverage([i.get("geometry") for i in group], bbox) >= FULL_COVERAGE:
            full.add(top["id"])
    unique = sorted(best, key=lambda i: i["properties"].get("datetime", ""), reverse=True)
    return [i for i in unique if i["id"] in full] or unique


def same_pass(item: dict, collection: str, bbox: BBox) -> list[dict]:
    """The other tiles of `item`'s satellite pass over the AOI, the largest contribution first; the newest processing
    of each. Empty, with no search, when `item` alone covers the AOI."""
    if covers(item.get("geometry"), bbox):
        return []
    day = str(item["properties"]["datetime"])[:10]
    key, own = pass_key(item), tile_of(item)
    newest: dict[str, dict] = {}
    for it in search(collection, bbox, Window(day, day), tries=1, timeout=FILL_LOOKUP_TIMEOUT_S):
        tile = tile_of(it)
        if tile is None or tile == own or pass_key(it) != key:
            continue
        generated = str(it.get("properties", {}).get("s2:generation_time", ""))
        if tile not in newest or generated > str(newest[tile].get("properties", {}).get("s2:generation_time", "")):
            newest[tile] = it
    return sorted(newest.values(), key=lambda it: coverage([it.get("geometry")], bbox), reverse=True)

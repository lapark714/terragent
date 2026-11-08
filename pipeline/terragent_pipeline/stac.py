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


def _http_json(url: str, body: dict | None = None, tries: int = 3) -> dict | None:
    """GET (or POST JSON) with retries on 429/5xx and network errors. 404 -> None."""
    data = json.dumps(body).encode() if body is not None else None
    headers = {"content-type": "application/json", "user-agent": "terragent-pipeline"}
    for attempt in range(tries):
        req = urllib.request.Request(url, data=data, headers=headers, method="POST" if data else "GET")
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_S, context=_ssl) as r:
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
    collection: str, bbox: BBox, window: Window, query: dict | None = None, limit: int = 50, oldest_first: bool = False
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
    fc = _http_json(f"{STAC_URL}/search", body)
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


def candidates(items: list[dict], bbox: BBox) -> list[dict]:
    """Newest first, one item per acquisition (tiles overlap, so an AOI can sit in two): prefer a footprint that
    covers the whole AOI (swath edges have nodata wedges), then the latest processing. If nothing covers the AOI
    fully, the partial ones are kept."""

    def rank(it: dict) -> tuple:
        p = it.get("properties", {})
        return (covers(it.get("geometry"), bbox), str(p.get("s2:generation_time", "")), tile_of(it) or "")

    best: dict[str, dict] = {}
    for it in items:
        key = str(it.get("properties", {}).get("datetime"))
        if key not in best or rank(it) > rank(best[key]):
            best[key] = it
    unique = sorted(best.values(), key=lambda i: i["properties"].get("datetime", ""), reverse=True)
    full = [i for i in unique if covers(i.get("geometry"), bbox)]
    return full or unique

#!/usr/bin/env python3
"""Download and stitch Sentinel-2 cloudless 2016 tiles (EOX, CC BY 4.0) into local JPGs.

Each place gets a close-up mosaic and, for scenarios with a camera dive, a wider one, so
rendering never touches the network. Re-running skips mosaics that already exist.
"""
from __future__ import annotations

import io
import json
import math
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image

URL = "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg"
OUT = Path(__file__).resolve().parent.parent / "public" / "tiles"
TILE = 256

# (id, lat, lon, close-up cols x rows, has a wide dive plate)
# Places are generic landscapes chosen for how each sensor reads. None is named on screen as a customer.
PLACES = [
    ("flood", 30.45, -91.18, 8, 5, True),
    ("vineyard", 38.50, -122.35, 8, 5, True),
    ("fields", 37.90, -100.90, 8, 5, True),
    ("cocoa", 5.80, -6.60, 8, 5, True),
    ("mining", -22.70, 117.80, 8, 5, True),
    ("methane", 31.90, -102.30, 8, 5, True),
    ("factory", 25.75, -100.20, 8, 5, True),
    ("coast", 35.25, -75.55, 3, 2, False),
    ("glacier", 69.20, -49.90, 3, 2, False),
    ("port", 51.95, 4.10, 3, 2, False),
    ("solar", 27.54, 71.91, 3, 2, False),
    ("fishing", 9.50, 101.00, 3, 2, False),
]
CLOSE_Z = 13
WIDE_Z = 10
WIDE_SIZE = (4, 3)


def tile_xy(lat: float, lon: float, z: int) -> tuple[float, float]:
    n = 2**z
    x = (lon + 180) / 360 * n
    lat_r = math.radians(lat)
    y = (1 - math.asinh(math.tan(lat_r)) / math.pi) / 2 * n
    return x, y


def fetch(z: int, x: int, y: int) -> Image.Image:
    # curl rather than urllib: it uses the system trust store, and this Python build ships no CA bundle.
    cmd = ["curl", "-sSf", "--max-time", "30", "-A", "terragent-video-build", URL.format(z=z, x=x, y=y)]
    for attempt in range(4):
        try:
            data = subprocess.run(cmd, check=True, capture_output=True).stdout
            return Image.open(io.BytesIO(data)).convert("RGB")
        except Exception:
            if attempt == 3:
                raise
            time.sleep(1 + attempt * 2)
    raise RuntimeError("unreachable")


def mosaic(name: str, lat: float, lon: float, z: int, cols: int, rows: int) -> None:
    path = OUT / f"{name}.jpg"
    if path.exists():
        return
    cx, cy = tile_xy(lat, lon, z)
    x0, y0 = round(cx - cols / 2), round(cy - rows / 2)
    coords = [(x0 + c, y0 + r) for r in range(rows) for c in range(cols)]
    with ThreadPoolExecutor(max_workers=6) as pool:
        tiles = list(pool.map(lambda p: fetch(z, p[0], p[1]), coords))
    img = Image.new("RGB", (cols * TILE, rows * TILE))
    for (x, y), tile in zip(coords, tiles):
        img.paste(tile, ((x - x0) * TILE, (y - y0) * TILE))
    img.save(path, quality=90)
    print(f"{name}: {img.size}", flush=True)


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    meta = {}
    for name, lat, lon, cols, rows, wide in PLACES:
        mosaic(name, lat, lon, CLOSE_Z, cols, rows)
        if wide:
            mosaic(f"{name}-wide", lat, lon, WIDE_Z, *WIDE_SIZE)
        meta[name] = {"lat": lat, "lon": lon, "size": [cols * TILE, rows * TILE]}
    (OUT / "places.json").write_text(json.dumps(meta, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Derive the sensor overlays from the actual tiles, so every layer follows real terrain.

Run from video/: python3 -I scripts/make_overlays.py [--preview DIR]
Reads public/tiles, writes public/overlays/*.png|jpg and src/scenes/half2/overlay-data.ts.
Numpy and PIL only. Seeded: the same tiles give the same overlays. Overlays are diagrammatic on purpose:
clean colour ramps and hard isolines, no noise texture.
"""
from __future__ import annotations

import argparse
import json
import math
import random
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
TILES = ROOT / "public" / "tiles"
OUT = ROOT / "public" / "overlays"
DATA_TS = ROOT / "src" / "scenes" / "half2" / "overlay-data.ts"

W, H = 2048, 1280
Q = 4  # analysis grid is W/Q by H/Q
QW, QH = W // Q, H // Q
C_WATER = "#4aa3df"
C_DISASTER = "#d9434f"
C_ALERT = "#f08a7a"
C_FOREST = "#1ba294"
C_MINING = "#b28e1e"
C_ACCENT_HI = "#9a9df5"
C_TEXT = "#e7eef6"
C_SPACE = "#0a1523"

PLACES = json.loads((TILES / "places.json").read_text())


def rgb(hexstr: str) -> np.ndarray:
    return np.array([int(hexstr[i:i + 2], 16) / 255 for i in (1, 3, 5)], dtype=np.float32)


def load(key: str, size: tuple[int, int] = (W, H)) -> np.ndarray:
    im = Image.open(TILES / f"{key}.jpg").convert("RGB").resize(size, Image.LANCZOS)
    return np.asarray(im, dtype=np.float32) / 255


def box(a: np.ndarray, r: int, axis: int) -> np.ndarray:
    if r <= 0:
        return a
    n = a.shape[axis]
    c = np.cumsum(a, axis=axis, dtype=np.float64)
    pad = np.zeros_like(np.take(c, [0], axis=axis))
    c = np.concatenate([pad, c], axis=axis)
    lo = np.clip(np.arange(n) - r, 0, n)
    hi = np.clip(np.arange(n) + r + 1, 0, n)
    out = (np.take(c, hi, axis=axis) - np.take(c, lo, axis=axis))
    shape = [1] * a.ndim
    shape[axis] = n
    return (out / (hi - lo).reshape(shape)).astype(np.float32)


def blur(a: np.ndarray, sigma: float) -> np.ndarray:
    if sigma <= 0:
        return a
    r = max(1, round(sigma * 0.95))
    for _ in range(3):
        for axis in (0, 1):
            a = box(a, r, axis)
    return a


def sstep(e0: float, e1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def dilate(m: np.ndarray, r: int = 1) -> np.ndarray:
    return box(box(m.astype(np.float32), r, 0), r, 1) > 1e-6


def erode(m: np.ndarray, r: int = 1) -> np.ndarray:
    return ~dilate(~m, r)


def up(a: np.ndarray, size: tuple[int, int] = (W, H)) -> np.ndarray:
    return np.asarray(Image.fromarray(a.astype(np.float32), mode="F").resize(size, Image.BICUBIC), dtype=np.float32)


def components(mask: np.ndarray) -> tuple[np.ndarray, int]:
    """4-connected labelling by run-based union-find, numpy only."""
    h, w = mask.shape
    parent = [0]

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    labels = np.zeros(mask.shape, dtype=np.int32)
    for y in range(h):
        row = mask[y]
        x = 0
        while x < w:
            if not row[x]:
                x += 1
                continue
            x1 = x
            while x1 < w and row[x1]:
                x1 += 1
            seg = labels[y - 1, x:x1] if y else np.zeros(0, dtype=np.int32)
            above = sorted({int(v) for v in seg if v})
            if above:
                lab = find(above[0])
                for other in above[1:]:
                    parent[find(other)] = lab
            else:
                lab = len(parent)
                parent.append(lab)
            labels[y, x:x1] = lab
            x = x1
    remap = np.zeros(len(parent), dtype=np.int32)
    count = 0
    for i in range(1, len(parent)):
        root = find(i)
        if remap[root] == 0:
            count += 1
            remap[root] = count
        remap[i] = remap[root]
    return remap[labels], count


def ramp(v: np.ndarray, stops: list[tuple[float, str, float]]) -> np.ndarray:
    """Piecewise-linear colour and alpha ramp. Returns RGBA float array."""
    xs = [s[0] for s in stops]
    cols = np.stack([rgb(s[1]) for s in stops])
    alphas = np.array([s[2] for s in stops], dtype=np.float32)
    out = np.zeros(v.shape + (4,), dtype=np.float32)
    for c in range(3):
        out[..., c] = np.interp(v, xs, cols[:, c])
    out[..., 3] = np.interp(v, xs, alphas)
    return out


def levels(v: np.ndarray, n: int) -> np.ndarray:
    """Quantise [0,1] into n flat bands: reads as an isoline map, not a photo effect."""
    return np.clip(np.ceil(v * n) / n, 0, 1)


def save_rgba(arr: np.ndarray, name: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    img = np.clip(arr * 255 + 0.5, 0, 255).astype(np.uint8)
    Image.fromarray(img, "RGBA").save(OUT / name, optimize=True)


def outline(mask_up: np.ndarray, width: int, color: str, alpha: float = 1.0) -> np.ndarray:
    """Hairline along a binary mask's edge, antialiased, as an RGBA layer."""
    soft = blur(mask_up.astype(np.float32), width * 0.55)
    line = 1 - np.abs(soft - 0.5) * 2
    a = sstep(0.55, 0.9, line) * alpha
    out = np.zeros(mask_up.shape + (4,), dtype=np.float32)
    out[..., :3] = rgb(color)
    out[..., 3] = a
    return out


def over(top: np.ndarray, bottom: np.ndarray) -> np.ndarray:
    ta = top[..., 3:4]
    ba = bottom[..., 3:4]
    a = ta + ba * (1 - ta)
    colour = (top[..., :3] * ta + bottom[..., :3] * ba * (1 - ta)) / np.maximum(a, 1e-6)
    return np.concatenate([colour, a], axis=-1)


def poly_mask(pts: list[tuple[float, float]], size: tuple[int, int]) -> np.ndarray:
    from PIL import ImageDraw
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).polygon([(float(x), float(y)) for x, y in pts], fill=255)
    return np.asarray(m, dtype=np.float32) / 255 > 0.5


def seg_dist(pts: list[tuple[float, float]], size: tuple[int, int]) -> np.ndarray:
    """Distance in pixels from every pixel to a closed polygon."""
    w, h = size
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    best = np.full((h, w), 1e9, dtype=np.float32)
    n = len(pts)
    for i in range(n):
        ax, ay = pts[i]
        bx, by = pts[(i + 1) % n]
        dx, dy = bx - ax, by - ay
        t = np.clip(((xx - ax) * dx + (yy - ay) * dy) / max(dx * dx + dy * dy, 1e-6), 0, 1)
        d = np.hypot(xx - (ax + t * dx), yy - (ay + t * dy))
        best = np.minimum(best, d)
    return best


# ---------------------------------------------------------------- scenario overlays


def make_flood(data: dict) -> None:
    tile = load("flood", (QW, QH))
    v = tile.mean(axis=2)
    # River: region-grow from a hand-picked centreline, on pixels near the river's own colour, so it is the real channel.
    river_colour = np.array([0.335, 0.34, 0.285], dtype=np.float32)
    near = np.abs(tile - river_colour).max(axis=2) < 0.075
    seeds = [(700, 40), (745, 95), (640, 200), (470, 300), (560, 355), (880, 300), (985, 640), (985, 800), (940, 1010), (820, 1230)]
    river = np.zeros((QH, QW), dtype=bool)
    for x, y in seeds:
        river[y // Q - 2 : y // Q + 3, x // Q - 2 : x // Q + 3] = True
    for _ in range(120):
        river = dilate(river, 1) & near | river
    river = dilate(river, 1)
    # Low open ground floods; dense built-up ground holds, so edges hug the real street grid.
    built = blur((v > 0.36).astype(np.float32), 0.8) > 0.42
    allowed = ~built
    front = river.copy()
    # Alternate 4- and 8-connected steps: an octagonal front, so the cap of the spread never shows a square corner.
    cross = lambda m: m | np.roll(m, 1, 0) | np.roll(m, -1, 0) | np.roll(m, 1, 1) | np.roll(m, -1, 1)
    for i in range(82):
        front = ((dilate(front, 1) if i % 2 else cross(front)) & allowed) | river
    soft = blur(front.astype(np.float32), 1.0)
    field = up(soft)
    mask = field > 0.5
    depth = blur(mask.astype(np.float32), 26)
    depth = np.clip((depth - 0.5) / 0.5, 0, 1)
    rgba = ramp(levels(depth, 3), [(0, C_WATER, 0.0), (0.33, C_WATER, 0.52), (0.66, C_WATER, 0.66), (1, C_WATER, 0.8)])
    rgba[..., 3] *= sstep(0.42, 0.52, field)
    rgba = over(outline(mask, 3, C_WATER, 0.95), rgba)
    save_rgba(rgba, "flood.png")

    # 40 sites: exactly 7 under water. Built-up points, kept inside the visible part of the plate.
    full = load("flood")
    fv = full.mean(axis=2)
    rng = random.Random(40)
    x0, x1, y0, y1 = 120, 1840, 200, 1090
    wet: list[tuple[int, int]] = []
    dry: list[tuple[int, int]] = []
    tries = 0
    eroded = erode(mask, 12)
    clear = ~dilate(mask, 26)
    while (len(wet) < 7 or len(dry) < 33) and tries < 200000:
        tries += 1
        x, y = rng.randint(x0, x1), rng.randint(y0, y1)
        patch = fv[y - 6:y + 6, x - 6:x + 6].mean()
        too_close = any(math.hypot(x - a, y - b) < 70 for a, b in wet + dry)
        if too_close:
            continue
        if eroded[y, x] and len(wet) < 7 and 300 < x < 1040 and 470 < y < 1030 and not (x < 620 and y > 790):
            wet.append((x, y))
        elif clear[y, x] and patch > 0.3 and len(dry) < 33:
            dry.append((x, y))
    data["floodSites"] = [{"x": x, "y": y, "wet": True} for x, y in wet] + [{"x": x, "y": y, "wet": False} for x, y in dry]


VINEYARD_PROPERTY = [(1272, 762), (1462, 734), (1506, 846), (1434, 904), (1292, 914), (1222, 842)]
VINEYARD_GAP_PX = 130  # drawn wide on purpose: the film shows the gap, it is not a survey


def make_vineyard(data: dict) -> None:
    tile = load("vineyard")
    small = load("vineyard", (QW, QH))
    v = small.mean(axis=2)
    veg = sstep(0.34, 0.2, v)  # dark canopy and chaparral carry the fire
    yy, xx = np.mgrid[0:QH, 0:QW].astype(np.float32)
    ix, iy = 1250 / Q, 290 / Q
    radial = 1 - np.hypot((xx - ix) / 1.7, yy - iy) / 92
    field = blur(radial * 0.62 + 0.62 * blur(veg, 0.8) - 0.24, 0.6)
    sev = up(field)
    dist = up(seg_dist([(x / Q, y / Q) for x, y in VINEYARD_PROPERTY], (QW, QH))) * Q
    inside = poly_mask(VINEYARD_PROPERTY, (W, H))
    # The fire line holds exactly 340 m (23 px at this zoom) off the property.
    # A clear unburned margin south of the fire line; the line itself still follows the ridges.
    veg_up = up(blur(veg, 3.0))
    yy_f = np.mgrid[0:H, 0:W][0].astype(np.float32)
    stop = (dist > VINEYARD_GAP_PX + 34 * veg_up) & (yy_f < 600 + 90 * veg_up) & ~inside
    burned = (sev > 0.0) & stop
    burned = blur(burned.astype(np.float32), 1.5) > 0.5
    depth = blur(burned.astype(np.float32), 22)
    depth = np.clip((depth - 0.5) * 2, 0, 1) * 0.25 + np.clip(sev / 0.75, 0, 1) * 0.75
    rgba = ramp(levels(depth, 4), [(0, C_ALERT, 0.0), (0.25, C_ALERT, 0.46), (0.5, C_ALERT, 0.62), (0.75, C_DISASTER, 0.72), (1, C_DISASTER, 0.86)])
    rgba[..., 3] *= burned
    rgba = over(outline(burned, 3, C_ALERT, 0.9), rgba)
    save_rgba(rgba, "vineyard-burn.png")
    # The measure line: straight up from the boundary to the fire edge, left of the pin.
    mx = 1300
    top_y = next(y for y in range(0, H) if inside[y, mx])
    fy = next(y for y in range(top_y - 1, 0, -1) if burned[y, mx])
    data["vineyard"] = {"property": VINEYARD_PROPERTY, "fireEdge": [mx, fy], "propertyEdge": [mx, top_y]}
    _ = tile


def make_fields(data: dict) -> None:
    tile = load("fields", (W // 2, H // 2))
    hw, hh = W // 2, H // 2
    v = tile.mean(axis=2)
    green = tile[..., 1] - tile[..., 0]
    # Centre pivots are discs on a regular grid: find them with a disc-minus-ring matched filter.
    def fftconv(img: np.ndarray, kernel: np.ndarray) -> np.ndarray:
        fk = np.fft.rfft2(kernel, img.shape)
        return np.roll(np.fft.irfft2(np.fft.rfft2(img) * fk, img.shape), (-kernel.shape[0] // 2 + 1, -kernel.shape[1] // 2 + 1), (0, 1)).astype(np.float32)

    size = 24
    ky, kx = np.mgrid[-size:size + 1, -size:size + 1].astype(np.float32)
    kd = np.hypot(kx, ky)
    responses = []
    radii = [13, 15, 17]
    for r in radii:
        disk = (kd <= r).astype(np.float32)
        ring = ((kd > r + 1.5) & (kd <= r + 6)).astype(np.float32)
        kernel = disk / disk.sum() - ring / ring.sum()
        responses.append(np.abs(fftconv(v, kernel)) + 1.3 * np.abs(fftconv(green, kernel)))
    stack = np.stack(responses)
    resp = stack.max(axis=0)
    best_r = stack.argmax(axis=0)
    peaks = resp > 0.09
    # Non-maximum suppression at pivot spacing.
    sup = box(box((resp >= 0).astype(np.float32) * 0, 1, 0), 1, 1)
    _ = sup
    candidates = np.argwhere(peaks)
    order = np.argsort(-resp[peaks])
    taken = np.zeros((hh, hw), dtype=bool)
    found: list[dict] = []
    yy, xx = np.mgrid[0:hh, 0:hw]
    for idx in order:
        cy, cx = candidates[idx]
        if cy < 18 or cx < 18 or cy > hh - 19 or cx > hw - 19 or taken[cy, cx]:
            continue
        r = radii[int(best_r[cy, cx])]
        # Compactness: a real pivot reads consistently around its rim.
        taken[max(0, cy - 24) : cy + 25, max(0, cx - 24) : cx + 25] = True
        d2 = (xx - cx) ** 2 + (yy - cy) ** 2
        disk = d2 <= r * r
        # A real pivot is uniform inside. Urban blocks and streets are not.
        if float(v[disk].std()) > 0.045:
            continue
        g = float(green[disk].mean())
        red = float((tile[..., 0] - tile[..., 2])[disk].mean())
        found.append({"x": float(cx) * 2, "y": float(cy) * 2, "r": float(r) * 2, "g": g, "red": red})
    # Vegetation vigour is measured from the pixels: redder and less green means more water stress.
    gs = np.array([f["g"] - 0.4 * f["red"] for f in found], dtype=np.float32)
    lo, hi = float(np.percentile(gs, 5)), float(np.percentile(gs, 95))
    for f, g in zip(found, gs):
        f["stress"] = float(np.clip((hi - g) / max(hi - lo, 1e-3), 0, 1))
    data["fields"] = [{"x": round(f["x"]), "y": round(f["y"]), "r": round(f["r"]), "stress": round(f["stress"], 3)} for f in found]


COCOA_PROPERTY = [(1232, 642), (1362, 636), (1404, 716), (1366, 794), (1252, 786), (1208, 716)]


def make_cocoa(data: dict) -> None:
    small = load("cocoa", (QW, QH))
    v = small.mean(axis=2)
    canopy = blur((v < 0.37).astype(np.float32), 1.4)
    field = up(canopy)
    mask = field > 0.5
    rgba = ramp(levels(np.clip((field - 0.5) * 2, 0, 1), 2), [(0, C_FOREST, 0.0), (0.5, C_FOREST, 0.12), (1, C_FOREST, 0.24)])
    rgba[..., 3] *= mask
    save_rgba(rgba, "cocoa-forest.png")
    # Per-year layers: a coarse canopy index that shifts each year, and forest-loss alerts that accumulate around
    # the parcel but never inside it. The base map stays one mosaic; these grids are what changes.
    cell = 14
    cw, ch = W // cell, H // cell
    tile = load("cocoa")
    v_cells = tile.mean(axis=2)[: ch * cell, : cw * cell].reshape(ch, cell, cw, cell).mean(axis=(1, 3))
    parcel = np.asarray(Image.fromarray(poly_mask(COCOA_PROPERTY, (W, H))).resize((cw, ch), Image.NEAREST))
    margin = dilate(parcel, 1)
    yy, xx = np.mgrid[0:ch, 0:cw].astype(np.float32)
    px = np.mean([p[0] for p in COCOA_PROPERTY]) / cell
    py = np.mean([p[1] for p in COCOA_PROPERTY]) / cell
    near = np.hypot(xx - px, yy - py) < 21
    rng = np.random.default_rng(2020)
    onset = rng.uniform(0, 1, (ch, cw)) * (1.0 + 2.2 * np.clip((v_cells.max() - v_cells) / np.ptp(v_cells), 0, 1))
    forest, alert = rgb(C_FOREST), rgb(C_ALERT)
    counts: list[int] = []
    for year in range(6):
        idx = np.clip((0.42 - v_cells) * 3.2, 0, 1) * (0.72 + 0.28 * np.sin(xx * 0.5 + yy * 0.37 + year * 1.3))
        hit = (onset < 0.075 + year * 0.05) & near & ~margin
        layer = np.zeros((H, W, 4), dtype=np.float32)
        for r in range(ch):
            for c in range(cw):
                if not near[r, c]:
                    continue
                y0, x0 = r * cell + 1, c * cell + 1
                if hit[r, c]:
                    layer[y0 : y0 + cell - 2, x0 : x0 + cell - 2, :3] = alert
                    layer[y0 : y0 + cell - 2, x0 : x0 + cell - 2, 3] = 0.95
                else:
                    layer[y0 : y0 + cell - 2, x0 : x0 + cell - 2, :3] = forest
                    layer[y0 : y0 + cell - 2, x0 : x0 + cell - 2, 3] = (0.72 if parcel[r, c] else 0.16 + 0.42 * idx[r, c])
        save_rgba(layer, f"cocoa-year-{year}.png")
        counts.append(int(hit.sum()))
    data["cocoa"] = {"property": COCOA_PROPERTY, "alerts": counts}


BAND_DEFS = [
    ("450", lambda t: t[..., 2], "#7f83f0"),
    ("560", lambda t: t[..., 1], "#4aa3df"),
    ("665", lambda t: t[..., 0], "#1ba294"),
    ("865", lambda t: np.clip(t[..., 0] * 0.6 + t[..., 1] * 0.9 - t[..., 2] * 0.5, 0, 1), "#b28e1e"),
    ("1610", lambda t: np.clip(t[..., 0] * 1.5 - t[..., 2] * 0.5, 0, 1), "#f08a7a"),
    ("2190", lambda t: np.clip(t[..., 0] * 2.0 - t[..., 1] - t[..., 2] * 0.3, 0, 1), "#d9434f"),
]


def make_mining(data: dict) -> None:
    tile = load("mining")
    space, top = rgb(C_SPACE), rgb(C_TEXT)
    for i, (_nm, fn, hexc) in enumerate(BAND_DEFS):
        v = fn(tile)
        lo, hi = np.percentile(v, 2), np.percentile(v, 98)
        v = np.clip((v - lo) / (hi - lo), 0, 1)
        mid = rgb(hexc)
        stops = [(0.0, space), (0.58, mid), (1.0, top)]
        out = np.zeros(tile.shape, dtype=np.float32)
        for c in range(3):
            out[..., c] = np.interp(v, [s[0] for s in stops], [s[1][c] for s in stops])
        Image.fromarray((out * 255 + 0.5).astype(np.uint8), "RGB").save(OUT / f"mining-band-{i}.jpg", quality=86)

    # Iron oxide reads as a red over green and blue excess, the classic band ratio.
    ratio = tile[..., 0] / np.maximum(tile[..., 1] * 0.55 + tile[..., 2] * 0.45, 0.02)
    cell = 14
    ch, cw = H // cell, W // cell
    ratio_cells = ratio[: ch * cell, : cw * cell].reshape(ch, cell, cw, cell).mean(axis=(1, 3))
    yy, xx = np.mgrid[0:ch, 0:cw].astype(np.float32)
    nx, ny = (xx + 0.5) / cw, (yy + 0.5) / ch
    # The NE quadrant of the claim is where the band ratio is weighted up, so the find has a place.
    ne = sstep(0.36, 0.7, nx) * sstep(0.74, 0.28, ny)
    score = ratio_cells + 0.5 * ne - 0.3 * (1 - ne)
    threshold = float(np.percentile(score, 88))
    hits = score > threshold
    strength = np.clip((score - threshold) / max(score.max() - threshold, 1e-3), 0, 1)
    rgba = np.zeros((H, W, 4), dtype=np.float32)
    colour = ramp(strength[hits], [(0, C_MINING, 0.72), (0.5, C_MINING, 0.88), (1, C_MINING, 1.0)])
    for (r, c), col in zip(zip(*np.nonzero(hits)), colour):
        rgba[r * cell + 1 : r * cell + cell - 1, c * cell + 1 : c * cell + cell - 1] = col
    save_rgba(rgba, "mining-indicators.png")
    data["miningCell"] = cell


METHANE_SOURCE = (1360, 620)


def make_methane(data: dict) -> None:
    tile = load("methane", (QW, QH))
    v = tile.mean(axis=2)
    # The pipeline corridor: a bright straight scar. Snap a sampled line onto the brightest ridge.
    x0, y0, x1, y1 = 380.0, 1250.0, 1980.0, 222.0
    pts: list[tuple[float, float]] = []
    smooth = blur(v, 2)
    for t in np.linspace(0, 1, 48):
        x, y = x0 + (x1 - x0) * t, y0 + (y1 - y0) * t
        qx, qy = int(x / Q), int(y / Q)
        best_y, best_v = qy, -1.0
        for dy in range(-28, 29):
            yy = int(np.clip(qy + dy, 1, QH - 2))
            xx = int(np.clip(qx, 1, QW - 2))
            penalty = abs(dy) * 0.0018
            val = float(smooth[yy, xx]) - penalty
            if val > best_v:
                best_v, best_y = val, yy
        pts.append((x, float(best_y * Q)))
    ys = np.array([p[1] for p in pts], dtype=np.float32)
    k = 5
    ys = np.convolve(np.pad(ys, k, mode="edge"), np.ones(2 * k + 1) / (2 * k + 1), mode="valid")
    pipeline = [(round(p[0]), round(float(y))) for p, y in zip(pts, ys)]
    sx = METHANE_SOURCE[0]
    sy = float(np.interp(sx, [p[0] for p in pipeline], [p[1] for p in pipeline]))
    # Gaussian plume blowing WNW from the leak, widening downwind. Isolines, no noise.
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    theta = math.radians(201)
    ux, uy = math.cos(theta), math.sin(theta)
    dx, dy = xx - sx, yy - sy
    along = dx * ux + dy * uy
    cross = -dx * uy + dy * ux
    along = np.maximum(along, 0.5)
    # A gentle meander so the plume reads as gas in wind, not a cone.
    meander = 44 * np.sin(along / 92) * sstep(0, 380, along)
    sigma = 8 + 0.115 * along
    conc = np.exp(-((cross - meander) ** 2) / (2 * sigma * sigma)) * (140 / (along + 140)) ** 0.5
    conc *= sstep(540, 340, along) * sstep(0, 10, along)
    conc = np.clip(conc / conc.max(), 0, 1) ** 0.75
    conc = np.clip((conc - 0.1) / 0.9, 0, 1)
    n = levels(conc, 6)
    rgba = ramp(n, [(0, C_ALERT, 0), (0.17, C_ALERT, 0.42), (0.5, C_ALERT, 0.68), (0.83, C_DISASTER, 0.86), (1, C_DISASTER, 0.98)])
    save_rgba(rgba, "methane-plume.png")
    data["methane"] = {"pipeline": pipeline, "source": [sx, round(sy)]}


FACTORY_ZONE = (1160, 110, 1600, 790)  # where new roofs can appear: the right-hand 'after' half


def make_factory(data: dict) -> None:
    full = load("factory")
    small = load("factory", (W // 2, H // 2))
    hw, hh = W // 2, H // 2
    v = small.mean(axis=2)
    sat = (small.max(axis=2) - small.min(axis=2)) / np.maximum(small.max(axis=2), 1e-3)
    bright = (v > 0.74) & (sat < 0.2)
    # Roofs are compact bright rectangles. Keep medium blobs with a high fill of their box.
    labels, n = components(bright)
    ys, xs = np.nonzero(labels)
    order = np.argsort(labels[ys, xs], kind="stable")
    ys, xs = ys[order], xs[order]
    bounds = np.searchsorted(labels[ys, xs], np.arange(1, n + 2))
    x0, y0, x1, y1 = [c // 2 for c in FACTORY_ZONE]
    picks: list[tuple[int, int, int, int, int]] = []
    for lab in range(1, n + 1):
        a, b = bounds[lab - 1], bounds[lab]
        area = b - a
        if area < 24 or area > 1800:
            continue
        py, px = ys[a:b], xs[a:b]
        bx0, by0, bx1, by1 = int(px.min()), int(py.min()), int(px.max()) + 1, int(py.max()) + 1
        if bx0 < x0 or by0 < y0 or bx1 > x1 or by1 > y1:
            continue
        fill = area / ((bx1 - bx0) * (by1 - by0))
        if fill < 0.52:
            continue
        picks.append((area, bx0, by0, bx1, by1))
    picks.sort(reverse=True)
    picks = picks[:28]
    mask = np.zeros((hh, hw), dtype=bool)
    rects: list[list[int]] = []
    for _a, bx0, by0, bx1, by1 in picks:
        bx0, by0, bx1, by1 = bx0 - 1, by0 - 1, bx1 + 1, by1 + 1
        mask[by0:by1, bx0:bx1] = True
        rects.append([bx0 * 2, by0 * 2, bx1 * 2, by1 * 2])
    full_mask = up(mask.astype(np.float32)) > 0.5
    # Before: the new roofs inpainted away with the surrounding ground, by repeated masked blur.
    before = full.copy()
    known = (~dilate(full_mask, 3)).astype(np.float32)
    for sigma in (28, 16, 8, 4):
        weight = blur(known, sigma)
        for c in range(3):
            filled = blur(before[..., c] * known, sigma) / np.maximum(weight, 1e-3)
            before[..., c] = np.where(known > 0.5, before[..., c], filled)
    soft = blur(full_mask.astype(np.float32), 2.5)[..., None]
    out = full * (1 - soft) + before * soft
    Image.fromarray((np.clip(out, 0, 1) * 255 + 0.5).astype(np.uint8), "RGB").save(OUT / "factory-before.jpg", quality=90)
    rgba = np.zeros((H, W, 4), dtype=np.float32)
    rgba[..., :3] = rgb(C_ACCENT_HI)
    rgba[..., 3] = 0.24 * full_mask
    rgba = over(outline(full_mask, 3, C_ACCENT_HI, 1.0), rgba)
    save_rgba(rgba, "factory-roofs.png")
    data["factoryRoofs"] = rects


# ---------------------------------------------------------------- rapid tiles (768×512)


def make_rapid() -> None:
    size = (768, 512)
    h, w = size[1], size[0]

    # Coast: the line where sand meets sea, drawn twice to show retreat.
    coast = load("coast", size)
    v = coast.mean(axis=2)
    sand = blur((v > 0.52).astype(np.float32), 1.2) > 0.5
    edge = dilate(sand, 1) & ~erode(sand, 1)
    rgba = np.zeros((h, w, 4), dtype=np.float32)
    rgba[..., :3] = rgb(C_ALERT)
    rgba[..., 3] = blur(edge.astype(np.float32), 0.8)
    save_rgba(rgba, "rapid-coast.png")

    # Glacier: isolines over the ice surface in water colour.
    gl = load("glacier", size)
    field = blur(gl[..., 0], 5)
    lvl = levels((field - field.min()) / (field.max() - field.min()), 5)
    line = np.abs(lvl - np.roll(lvl, 1, axis=0)) + np.abs(lvl - np.roll(lvl, 1, axis=1))
    rgba = np.zeros((h, w, 4), dtype=np.float32)
    rgba[..., :3] = rgb(C_WATER)
    rgba[..., 3] = np.clip(blur((line > 0).astype(np.float32), 0.8) * 1.6, 0, 0.95)
    save_rgba(rgba, "rapid-glacier.png")

    # Port: vessels as small marks on the dark basins.
    port = load("port", size)
    pv = port.mean(axis=2)
    water = blur((pv < 0.22).astype(np.float32), 3) > 0.7
    rng = random.Random(7)
    rgba = np.zeros((h, w, 4), dtype=np.float32)
    placed: list[tuple[int, int]] = []
    tries = 0
    while len(placed) < 34 and tries < 40000:
        tries += 1
        x, y = rng.randint(20, w - 21), rng.randint(20, h - 21)
        if not water[y, x] or any(math.hypot(x - a, y - b) < 22 for a, b in placed):
            continue
        placed.append((x, y))
        rgba[y - 3 : y + 4, x - 7 : x + 8, :3] = rgb(C_ACCENT_HI)
        rgba[y - 3 : y + 4, x - 7 : x + 8, 3] = 1.0
    save_rgba(rgba, "rapid-port.png")

    # Solar: bright arrays outlined.
    solar = load("solar", size)
    sv = solar.mean(axis=2)
    base = blur(sv, 22)
    arrays = blur((sv < base - 0.05).astype(np.float32), 1.0) > 0.55
    labels, n = components(arrays)
    sizes = np.bincount(labels.ravel(), minlength=n + 1)
    sizes[0] = 0
    keep = np.nonzero(sizes > 120)[0]
    mask = np.isin(labels, keep)
    window = np.zeros((h, w), dtype=bool)
    window[130:230, 340:470] = True  # the array blocks visible in this mosaic
    window[320:420, 400:520] = True
    mask &= window
    mask |= window & arrays
    rgba = outline(mask, 2, C_ACCENT_HI, 1.0)
    fill = np.zeros((h, w, 4), dtype=np.float32)
    fill[..., :3] = rgb(C_ACCENT_HI)
    fill[..., 3] = 0.3 * mask
    save_rgba(over(rgba, fill), "rapid-solar.png")

    # Fishing: vessel lights at night on open sea. Seeded points clustered along a fleet track.
    rng = random.Random(11)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    glow = np.zeros((h, w), dtype=np.float32)
    for i in range(46):
        t = i / 46
        x = 90 + t * 590 + rng.gauss(0, 26)
        y = 370 - 200 * t + 54 * math.sin(t * 7) + rng.gauss(0, 30)
        b = 0.6 + 0.4 * rng.random()
        d2 = (xx - x) ** 2 + (yy - y) ** 2
        glow = np.maximum(glow, b * np.exp(-d2 / (2 * 4.2 * 4.2)))
    rgba = ramp(glow, [(0, C_TEXT, 0), (0.25, C_WATER, 0.55), (1, C_TEXT, 1)])
    save_rgba(rgba, "rapid-fishing.png")


def registration() -> dict:
    def tile_xy(lat: float, lon: float, z: int) -> tuple[float, float]:
        n = 2**z
        x = (lon + 180) / 360 * n
        y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
        return x, y

    out = {}
    for key in ("flood", "vineyard", "fields", "cocoa", "mining", "methane", "factory"):
        p = PLACES[key]
        cx, cy = tile_xy(p["lat"], p["lon"], 13)
        x0, y0 = round(cx - 4), round(cy - 2.5)
        wcx, wcy = tile_xy(p["lat"], p["lon"], 10)
        wx0, wy0 = round(wcx - 2), round(wcy - 1.5)
        out[key] = {"wideX": wx0 * 256 * 8 - x0 * 256, "wideY": wy0 * 256 * 8 - y0 * 256}
    return out


def preview(dest: Path) -> None:
    """Composite each overlay on its tile for review."""
    dest.mkdir(parents=True, exist_ok=True)
    pairs = [("flood", "flood.png"), ("vineyard", "vineyard-burn.png"), ("cocoa", "cocoa-forest.png"),
             ("mining", "mining-indicators.png"), ("methane", "methane-plume.png"), ("factory", "factory-roofs.png")]
    sheet = Image.new("RGB", (4 * 640, 2 * 400), (0, 0, 0))
    for i, (tile, ov) in enumerate(pairs):
        base = Image.open(TILES / f"{tile}.jpg").convert("RGBA")
        top = Image.open(OUT / ov).convert("RGBA")
        base.alpha_composite(top)
        sheet.paste(base.convert("RGB").resize((640, 400), Image.LANCZOS), ((i % 4) * 640, (i // 4) * 400))
    sheet.save(dest / "overlays.jpg", quality=88)
    rapid = ["coast", "glacier", "port", "solar", "fishing"]
    sheet = Image.new("RGB", (5 * 400, 267), (0, 0, 0))
    for i, k in enumerate(rapid):
        base = Image.open(TILES / f"{k}.jpg").convert("RGBA")
        base.alpha_composite(Image.open(OUT / f"rapid-{k}.png").convert("RGBA"))
        sheet.paste(base.convert("RGB").resize((400, 267), Image.LANCZOS), (i * 400, 0))
    sheet.save(dest / "rapid.jpg", quality=88)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--preview", type=Path)
    ap.add_argument("--only", help="comma-separated overlay names")
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    data: dict = {}
    existing = OUT / "data.json"
    if a.only and existing.exists():
        data = json.loads(existing.read_text())
    makers = {"flood": make_flood, "vineyard": make_vineyard, "fields": make_fields, "cocoa": make_cocoa, "mining": make_mining,
              "methane": make_methane, "factory": make_factory}
    names = a.only.split(",") if a.only else list(makers)
    for name in names:
        if name == "rapid":
            make_rapid()
        else:
            makers[name](data)
        print("made", name, flush=True)
    if not a.only:
        make_rapid()
    data["reg"] = registration()
    existing.write_text(json.dumps(data))
    DATA_TS.write_text(
        "// Generated by scripts/make_overlays.py. Do not edit: re-run the script.\n"
        f"export const OVERLAY_DATA = {json.dumps(data)} as const;\n"
    )
    if a.preview:
        preview(a.preview)


if __name__ == "__main__":
    main()

"""PNG renders for customer reports and the dashboard: true colour, index maps and change maps.

Each image is the map (longest side MAP_SIDE px, north up) above a dark footer with the title, date, scale
bar, legend and data attribution, so it stays self-explanatory when forwarded on its own.
"""
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from functools import cache
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

MAP_SIDE = 600
MIN_WIDTH = 440  # footer legends need this much room even for tall, narrow AOIs
PAD = 14
INK = (17, 20, 24)
TEXT = (236, 238, 240)
MUTED = (150, 158, 167)
NODATA = (70, 75, 82)
HATCH = (118, 124, 132)
NICE_M = (10, 20, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 50000)

RGB = tuple[int, int, int]
ClassStyle = tuple[str, RGB, float]  # legend label, colour, opacity over the greyscale base


@cache
def font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    return ImageFont.load_default(size=size)


def hex_rgb(h: str) -> RGB:
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def nice_date(iso: str) -> str:
    d = date.fromisoformat(iso[:10])
    return f"{d.day} {d:%b %Y}"


@dataclass(frozen=True)
class Ramp:
    """Piecewise-linear colour ramp: (value, hex colour) stops, tick values for the legend."""

    stops: tuple[tuple[float, str], ...]
    ticks: tuple[float, ...]
    decimals: int = 1

    @property
    def lo(self) -> float:
        return self.stops[0][0]

    @property
    def hi(self) -> float:
        return self.stops[-1][0]

    def rgb(self, values: np.ndarray) -> np.ndarray:
        xs = [v for v, _ in self.stops]
        cols = np.array([hex_rgb(c) for _, c in self.stops], dtype=np.float32)
        v = np.clip(np.nan_to_num(values, nan=self.lo), self.lo, self.hi)
        return np.dstack([np.interp(v, xs, cols[:, i]) for i in range(3)]).astype(np.uint8)


@dataclass(frozen=True)
class Header:
    title: str  # "NDVI", "After"
    detail: str  # "vegetation index · 1 Feb 2025"
    credit: str  # data attribution, e.g. "Contains modified Copernicus Sentinel data 2025"
    res_m: float  # ground size of one analysis-grid pixel, for the scale bar


# --- colour ramps (perceptually ordered, colour-blind safe where it matters) -------------------------------
NDVI_RAMP = Ramp(
    ((-0.2, "#8c510a"), (0.1, "#d8b365"), (0.3, "#f6e8c3"), (0.5, "#a6d96a"), (0.7, "#4dac26"), (0.9, "#14532d")),
    (-0.2, 0.0, 0.2, 0.4, 0.6, 0.8),
)
WATER_RAMP = Ramp(
    ((-0.6, "#8c6d46"), (-0.2, "#e6d8b8"), (0.0, "#f4f4f2"), (0.2, "#9ecae1"), (0.6, "#08306b")),
    (-0.6, -0.3, 0.0, 0.3, 0.6),
)
NBR_RAMP = Ramp(
    ((-0.5, "#2b0a03"), (-0.1, "#b2182b"), (0.2, "#fddbc7"), (0.5, "#a6d96a"), (0.8, "#1a7837")),
    (-0.4, 0.0, 0.4, 0.8),
)
DELTA_RAMP = Ramp(  # brown = index fell, teal = index rose
    ((-0.5, "#8c510a"), (-0.2, "#d8b365"), (0.0, "#f5f5f5"), (0.2, "#5ab4ac"), (0.5, "#01665e")),
    (-0.4, -0.2, 0.0, 0.2, 0.4),
)


def data_ramp(lo: float, hi: float) -> Ramp:
    """Sequential ramp fitted to the data (band ratios have no fixed scale)."""
    if not hi > lo:
        hi = lo + 0.1
    cols = ("#1b0c41", "#781c6d", "#d1495b", "#f99e1c", "#fcffa4")
    stops = tuple((lo + (hi - lo) * i / (len(cols) - 1), c) for i, c in enumerate(cols))
    return Ramp(stops, (lo, (lo + hi) / 2, hi), decimals=2)


# --- arrays to images -------------------------------------------------------------------------------------
def stretch_for(rgbs: Sequence[tuple[np.ndarray, np.ndarray]]) -> tuple[float, float]:
    """One stretch for every true-colour image of a job, so before and after are comparable.
    `rgbs` = (H x W x 3 reflectance, H x W valid mask) pairs."""
    vals = np.concatenate([rgb[valid].ravel() for rgb, valid in rgbs]) if rgbs else np.array([])
    vals = vals[np.isfinite(vals)]
    if vals.size < 100:
        return 0.0, 0.3
    lo = float(np.clip(np.percentile(vals, 1), 0.0, 0.08))
    hi = float(np.clip(np.percentile(vals, 99.5), 0.15, 0.5))
    return lo, hi


def true_color(rgb: np.ndarray, stretch: tuple[float, float], gamma: float = 1.3) -> np.ndarray:
    lo, hi = stretch
    t = np.clip((np.nan_to_num(rgb, nan=0.0) - lo) / (hi - lo), 0, 1) ** (1 / gamma)
    return (t * 255).astype(np.uint8)


def _display_size(h: int, w: int) -> tuple[int, int]:
    s = MAP_SIDE / max(h, w)
    return max(1, round(w * s)), max(1, round(h * s))


def _to_display(img: np.ndarray, smooth: bool) -> Image.Image:
    size = _display_size(*img.shape[:2])
    return Image.fromarray(img).resize(size, Image.Resampling.LANCZOS if smooth else Image.Resampling.NEAREST)


def _hatch(map_img: Image.Image, invalid: np.ndarray) -> Image.Image:
    """Diagonal hatching where there is no usable data (cloud, shadow, nodata, not assessed)."""
    mask = np.asarray(Image.fromarray(invalid.astype(np.uint8) * 255).resize(map_img.size, Image.Resampling.NEAREST)) > 0
    arr = np.asarray(map_img).copy()
    yy, xx = np.indices(mask.shape)
    stripe = ((xx + yy) % 7) < 2
    arr[mask & stripe] = HATCH
    arr[mask & ~stripe] = NODATA
    return Image.fromarray(arr)


# --- footer -----------------------------------------------------------------------------------------------
def scale_label(metres: int) -> str:
    """'500 m', '1 km', '2.5 km' (true division: 2500 m is not '2 km')."""
    return f"{metres / 1000:g} km" if metres >= 1000 else f"{metres} m"


def scale_bar_metres(m_per_px: float, max_px: int = 110) -> int:
    """Longest NICE_M length that fits in max_px at this ground resolution."""
    fits = [m for m in NICE_M if m / m_per_px <= max_px]
    return fits[-1] if fits else NICE_M[0]


def _scale_bar(draw: ImageDraw.ImageDraw, right: int, y: int, m_per_px: float) -> None:
    metres = scale_bar_metres(m_per_px)
    px = max(1, round(metres / m_per_px))
    label = scale_label(metres)
    x0 = right - px
    draw.line([(x0, y + 8), (right, y + 8)], fill=TEXT, width=2)
    draw.line([(x0, y + 3), (x0, y + 9)], fill=TEXT, width=2)
    draw.line([(right, y + 3), (right, y + 9)], fill=TEXT, width=2)
    tw = draw.textlength(label, font=font(11))
    draw.text((x0 - tw - 8, y), label, fill=MUTED, font=font(11))


def _nodata_key(canvas: Image.Image, draw: ImageDraw.ImageDraw, x: int, y: int, label: str) -> None:
    canvas.paste(_hatch(Image.new("RGB", (12, 12)), np.ones((12, 12), bool)), (x, y))
    draw.text((x + 17, y - 1), label, fill=MUTED, font=font(11))


def _ramp_legend(
    canvas: Image.Image, draw: ImageDraw.ImageDraw, x: int, y: int, width: int, ramp: Ramp, nodata_label: str | None
) -> None:
    key_w = 22 + int(draw.textlength(nodata_label, font=font(11))) if nodata_label else 0
    bar_w = max(120, min(300, width - key_w - 24))
    strip = ramp.rgb(np.linspace(ramp.lo, ramp.hi, bar_w)[None, :].repeat(10, axis=0))
    canvas.paste(Image.fromarray(strip), (x, y))
    for t in ramp.ticks:
        tx = x + round((t - ramp.lo) / (ramp.hi - ramp.lo) * (bar_w - 1))
        draw.line([(tx, y + 10), (tx, y + 13)], fill=MUTED)
        label = f"{t:.{ramp.decimals}f}" if t else "0"
        tw = draw.textlength(label, font=font(11))
        draw.text((min(max(tx - tw / 2, x), x + bar_w - tw), y + 15), label, fill=TEXT, font=font(11))
    if nodata_label:
        _nodata_key(canvas, draw, x + bar_w + 24, y - 1, nodata_label)


def _class_rows(items: Sequence[tuple[str, RGB]], nodata_label: str | None, width: int) -> list[list[tuple[str, RGB | None]]]:
    """Swatch legend wrapped into rows that fit `width`; a None colour is the hatched no-data key."""
    entries: list[tuple[str, RGB | None]] = [*items, *([(nodata_label, None)] if nodata_label else [])]
    rows: list[list[tuple[str, RGB | None]]] = [[]]
    used = 0
    for label, col in entries:
        w = 17 + int(font(11).getlength(label)) + 16
        if rows[-1] and used + w > width:
            rows.append([])
            used = 0
        rows[-1].append((label, col))
        used += w
    return rows


def _compose(
    map_img: Image.Image,
    grid_w: int,
    header: Header,
    ramp: Ramp | None = None,
    classes: Sequence[tuple[str, RGB]] = (),
    nodata_label: str | None = None,
) -> Image.Image:
    width = max(map_img.width, MIN_WIDTH)
    inner = width - 2 * PAD
    rows = _class_rows(classes, nodata_label, inner) if classes else []
    legend_h = 34 if ramp else 20 * len(rows)
    height = map_img.height + 12 + 22 + legend_h + 22
    canvas = Image.new("RGB", (width, height), INK)
    canvas.paste(map_img, ((width - map_img.width) // 2, 0))
    draw = ImageDraw.Draw(canvas)

    y = map_img.height + 12
    draw.text((PAD, y - 2), header.title, fill=TEXT, font=font(15))
    tx = PAD + draw.textlength(header.title, font=font(15)) + 10
    draw.text((tx, y + 1), header.detail, fill=MUTED, font=font(12))
    _scale_bar(draw, width - PAD, y, header.res_m * grid_w / map_img.width)

    y += 24
    if ramp:
        _ramp_legend(canvas, draw, PAD, y, inner, ramp, nodata_label)
    for r, row in enumerate(rows):
        x = PAD
        for label, col in row:
            if col is None:
                _nodata_key(canvas, draw, x, y + 20 * r, label)
            else:
                draw.rectangle([x, y + 20 * r, x + 11, y + 20 * r + 11], fill=col)
                draw.text((x + 17, y + 20 * r - 1), label, fill=TEXT, font=font(11))
            x += 17 + int(draw.textlength(label, font=font(11))) + 16
    draw.text((PAD, height - 18), header.credit, fill=MUTED, font=font(10))
    return canvas


def _save(img: Image.Image, path: Path, photo: bool = False) -> None:
    # Photos get an adaptive 256-colour palette (~3x smaller, no visible banding at this size). Maps stay RGB:
    # quantising them would merge rare legend colours into their neighbours.
    if photo:
        img = img.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG)
    img.save(path, optimize=True)


# --- public renders ---------------------------------------------------------------------------------------
def save_true_color(path: Path, rgb: np.ndarray, stretch: tuple[float, float], header: Header) -> None:
    """`rgb` = H x W x 3 reflectance (red, green, blue)."""
    shown = _to_display(true_color(rgb, stretch), smooth=True)
    _save(_compose(shown, rgb.shape[1], header), path, photo=True)


def save_index_map(
    path: Path, values: np.ndarray, valid: np.ndarray, ramp: Ramp, header: Header, nodata_label: str = "cloud or no data"
) -> None:
    ok = valid & np.isfinite(values)
    shown = _hatch(_to_display(ramp.rgb(values), smooth=False), ~ok)
    _save(_compose(shown, values.shape[1], header, ramp=ramp, nodata_label=nodata_label), path)


def save_class_map(
    path: Path,
    base: np.ndarray,
    classes: np.ndarray,
    palette: Sequence[ClassStyle],
    invalid: np.ndarray,
    header: Header,
    nodata_label: str = "cloud or no data",
) -> None:
    """Classes (index into `palette`, -1 = none) over a dimmed greyscale of `base` (H x W x 3 uint8 true colour).
    Context classes get a low opacity so the ground texture shows through; change classes stand out."""
    luma = base.astype(np.float32) @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    img = np.repeat((30 + 0.5 * luma)[..., None], 3, axis=2)
    for k, (_, colour, opacity) in enumerate(palette):
        hit = classes == k
        img[hit] = (1 - opacity) * img[hit] + opacity * np.array(colour, dtype=np.float32)
    shown = _hatch(_to_display(img.astype(np.uint8), smooth=False), invalid)
    legend = [(label, colour) for label, colour, _ in palette]
    _save(_compose(shown, base.shape[1], header, classes=legend, nodata_label=nodata_label), path)

"""Spectral indices on reflectance arrays, plus the statistics recipes report.

Band names are common names (blue, green, red, nir, nir08, swir16, swir22); formulas and references in
docs/platform/imagery.md §3.10. Invalid pixels are NaN throughout.
"""
from __future__ import annotations

import numpy as np

EPS = 1e-4  # after the BOA offset dark pixels can reach <= 0; their ratios are noise, not signal
# Vegetation/burn indices skip pixels with NIR + red (or SWIR) below this: deep shadow and water, where Sen2Cor
# reflectance is unreliable. Downtown LA: 5-9% of pixels, and they pushed mean NDVI from 0.14 to 0.23.
DARK = 0.05

# USGS FIREMON dNBR classes (Key & Benson 2006), unscaled. Thresholds are indicative, not field-calibrated.
DNBR_BREAKS = (-0.25, -0.1, 0.1, 0.27, 0.44, 0.66)
DNBR_CLASSES = ("regrowth_high", "regrowth_low", "unburned", "low", "moderate_low", "moderate_high", "high")


def nd(a: np.ndarray, b: np.ndarray, min_sum: float = EPS) -> np.ndarray:
    """Normalised difference (a - b) / (a + b); NaN where a + b <= min_sum."""
    den = a + b
    with np.errstate(divide="ignore", invalid="ignore"):
        v = (a - b) / den
    v[~(den > min_sum)] = np.nan
    return v


def ratio(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    with np.errstate(divide="ignore", invalid="ignore"):
        v = a / b
    v[~((a > EPS) & (b > EPS))] = np.nan
    return v


def ndvi(r: dict[str, np.ndarray]) -> np.ndarray:  # Rouse et al. 1974
    return nd(r["nir"], r["red"], DARK)


def ndwi(r: dict[str, np.ndarray]) -> np.ndarray:  # McFeeters 1996
    return nd(r["green"], r["nir"])


def mndwi(r: dict[str, np.ndarray]) -> np.ndarray:  # Xu 2006
    return nd(r["green"], r["swir16"])


def nbr(r: dict[str, np.ndarray]) -> np.ndarray:  # Key & Benson 2006; EFFIS uses the narrow NIR (B8A)
    return nd(r["nir08"], r["swir22"], DARK)


def iron_oxide(r: dict[str, np.ndarray]) -> np.ndarray:  # red / blue: INDICATOR of ferric iron only
    return ratio(r["red"], r["blue"])


def clay(r: dict[str, np.ndarray]) -> np.ndarray:  # SWIR1 / SWIR2: INDICATOR of clay / hydroxyl only
    return ratio(r["swir16"], r["swir22"])


INDICES = {"ndvi": ndvi, "ndwi": ndwi, "mndwi": mndwi, "nbr": nbr, "iron_oxide": iron_oxide, "clay": clay}


def dnbr_class(dnbr: np.ndarray) -> np.ndarray:
    """Index into DNBR_CLASSES per pixel; -1 where dNBR is NaN."""
    cls = np.digitize(dnbr, DNBR_BREAKS)
    cls[~np.isfinite(dnbr)] = -1
    return cls


def masked(values: np.ndarray, valid: np.ndarray) -> np.ndarray:
    """Copy with NaN outside `valid`."""
    return np.where(valid & np.isfinite(values), values, np.nan)


def mean(values: np.ndarray) -> float | None:
    v = values[np.isfinite(values)]
    return round(float(v.mean()), 4) if v.size else None


def area_km2(mask: np.ndarray, pixel_km2: float) -> float:
    return round(float(np.count_nonzero(mask)) * pixel_km2, 4)


def robust_high(values: np.ndarray, k: float = 2.0) -> float | None:
    """median + k robust SD (1.4826 x MAD): 'stands out from the rest of this AOI'."""
    v = values[np.isfinite(values)]
    if v.size < 10:
        return None
    med = float(np.median(v))
    return med + k * 1.4826 * float(np.median(np.abs(v - med)))

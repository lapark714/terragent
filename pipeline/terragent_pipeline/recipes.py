"""The analysis recipes (RECIPES in src/lib/domain.ts): measurements, maps and H3 layers for each.

Every IndexMeasurement compares before and after over pixels clear in BOTH scenes, so `delta` is a
like-for-like change; `affected_area_km2` is the area crossing the recipe threshold described in `threshold`.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import timedelta
from pathlib import Path

import numpy as np

from . import render
from .grid import Grid
from .indices import DNBR_CLASSES, INDICES, area_km2, dnbr_class, masked, mean, robust_high
from .job import Window
from .render import DELTA_RAMP, NBR_RAMP, NDVI_RAMP, WATER_RAMP, Header, Ramp, hex_rgb, nice_date
from .scenes import Scene

RGBN = ("blue", "green", "red", "nir")
NO_DATA = "cloud or no data"
DARK_NO_DATA = "cloud, shadow, water or no data"  # NDVI / NBR skip dark pixels (indices.DARK)
MINING_CAVEAT = (
    "Band ratios are indicators of surface iron-oxide and clay/hydroxyl signatures only. "
    "They are not evidence of a mineral deposit."
)


@dataclass
class Outcome:
    indices: list[dict] = field(default_factory=list)
    images: list[dict] = field(default_factory=list)  # AnalysisImage: {role, path, caption}
    layers: dict[str, np.ndarray] = field(default_factory=dict)  # H3 metric -> per-pixel values, NaN = none
    warnings: list[str] = field(default_factory=list)


@dataclass
class Ctx:
    after: Scene
    before: Scene | None
    grid: Grid
    out: Path
    stretch: tuple[float, float]
    _cache: dict[str, tuple[np.ndarray, np.ndarray | None]] = field(default_factory=dict)

    def index(self, name: str) -> tuple[np.ndarray, np.ndarray | None]:
        """(after, before) values of an index; before is None without a before scene."""
        if name not in self._cache:
            fn = INDICES[name]
            self._cache[name] = (fn(self.after.refl), fn(self.before.refl) if self.before else None)
        return self._cache[name]

    @property
    def both(self) -> np.ndarray:
        return self.after.clear & self.before.clear if self.before else self.after.clear

    def measure(
        self,
        name: str,
        *,
        unit: str | None = None,
        area: float | None = None,
        threshold: str | None = None,
        after_ok: np.ndarray | None = None,
        before_ok: np.ndarray | None = None,
    ) -> dict:
        """IndexMeasurement row. With a before scene both means use pixels valid in both scenes."""
        a, b = self.index(name)
        ok_a = self.after.clear if after_ok is None else after_ok
        if b is None or self.before is None:
            am, bm = mean(masked(a, ok_a)), None
        else:
            ok = ok_a & (self.before.clear if before_ok is None else before_ok)
            am, bm = mean(masked(a, ok & np.isfinite(b))), mean(masked(b, ok & np.isfinite(a)))
        delta = round(am - bm, 4) if am is not None and bm is not None else None
        return {
            "name": name,
            "before_mean": bm,
            "after_mean": am,
            "delta": delta,
            "unit": unit,
            "affected_area_km2": area,
            "threshold": threshold,
        }

    def area(self, mask: np.ndarray) -> float:
        return area_km2(mask, self.grid.pixel_km2)

    def after_layer(self, name: str, ok: np.ndarray | None = None) -> np.ndarray:
        return masked(self.index(name)[0], self.after.clear if ok is None else ok)

    def delta(self, name: str) -> np.ndarray | None:
        a, b = self.index(name)
        return None if b is None else masked(a - b, self.both)

    # --- images ---
    def _header(self, title: str, detail: str, *scenes: Scene) -> Header:
        credits = dict.fromkeys(s.sensor.credit(_years(scenes, s.sensor.collection)) for s in scenes)
        return Header(title, detail, " · ".join(credits), self.grid.res)

    def true_color_image(self, scene: Scene, role: str) -> dict:
        file, when = f"{role}_true_color.png", nice_date(scene.date)
        header = self._header(role.title(), f"true colour · {when} · {scene.platform}", scene)
        render.save_true_color(self.out / file, scene.rgb, self.stretch, header)
        caption = f"{role.title()}: {scene.sensor.name} true colour, {when} ({100 * scene.clear_fraction:.0f}% of the area clear)."
        return {"role": role, "path": file, "caption": caption}

    def index_map(self, file: str, values: np.ndarray, ok: np.ndarray, ramp: Ramp, title: str, what: str,
                  nodata: str = NO_DATA) -> dict:
        when = nice_date(self.after.date)
        render.save_index_map(self.out / file, values, ok, ramp, self._header(title, f"{what} · {when}", self.after), nodata)
        caption = f"{title} ({what}) on {when}, {self.after.platform}. Hatched: {nodata}."
        return {"role": "index", "path": file, "caption": caption}

    def delta_map(self, file: str, title: str, values: np.ndarray, nodata: str = NO_DATA) -> dict:
        """Continuous after-minus-before map."""
        header = self._header(title, f"after minus before · {self._span(' to ')}", *self._pair())
        render.save_index_map(self.out / file, values, self.both, DELTA_RAMP, header, nodata)
        return self._change_image(file, title, "after minus before", nodata)

    def class_map(self, file: str, title: str, what: str, classes: np.ndarray, palette: tuple[tuple[str, str, float], ...],
                  measured: np.ndarray, nodata: str = NO_DATA) -> dict:
        """Change classes (index into `palette`, -1 = no change) over a dimmed after scene."""
        header = self._header(title, f"{what} · {self._span(' to ')}", *self._pair())
        base = render.true_color(self.after.rgb, self.stretch)
        rgb_palette = [(label, hex_rgb(colour), opacity) for label, colour, opacity in palette]
        render.save_class_map(self.out / file, base, classes, rgb_palette, ~(self.both & measured), header, nodata)
        return self._change_image(file, title, what, nodata)

    def _pair(self) -> tuple[Scene, Scene]:
        assert self.before is not None, "change maps need a before scene"
        return self.before, self.after

    def _span(self, sep: str) -> str:
        before, after = self._pair()
        return f"{nice_date(before.date)}{sep}{nice_date(after.date)}"

    def _change_image(self, file: str, title: str, what: str, nodata: str) -> dict:
        caption = f"{title} ({what}) between {self._span(' and ')}. Hatched: {nodata} in either scene."
        return {"role": "change", "path": file, "caption": caption}


def _years(scenes: tuple[Scene, ...], collection: str) -> str:
    ys = sorted({s.date[:4] for s in scenes if s.sensor.collection == collection})
    return ys[0] if len(ys) == 1 else f"{ys[0]}-{ys[-1]}"


# --- recipes ----------------------------------------------------------------------------------------------
def true_color(c: Ctx) -> Outcome:
    """Latest clear image; NDVI is reported as context."""
    return Outcome(indices=[c.measure("ndvi")], layers={"ndvi_mean": c.after_layer("ndvi")})


def vegetation_health(c: Ctx) -> Outcome:
    a, _ = c.index("ndvi")
    healthy = c.after.clear & (a >= 0.4)
    o = Outcome(
        indices=[c.measure("ndvi", area=c.area(healthy), threshold="NDVI >= 0.4 (dense, healthy vegetation) in the after scene")],
        images=[_ndvi_map(c)],
        layers={"ndvi_mean": c.after_layer("ndvi")},
    )
    d = c.delta("ndvi")
    if d is not None:
        o.images.append(c.delta_map("change_ndvi.png", "NDVI change", d, DARK_NO_DATA))
        o.layers["ndvi_delta"] = d
    return o


def _ndvi_map(c: Ctx) -> dict:
    return c.index_map("index_ndvi.png", c.index("ndvi")[0], c.after.clear, NDVI_RAMP, "NDVI", "vegetation index", DARK_NO_DATA)


def flood_extent(c: Ctx) -> Outcome:
    o = Outcome(warnings=["Dark building shadow can look like water to SCL and water indices; treat small "
                          "'new water' patches in dense urban areas with caution."])
    for name, label in (("mndwi", "MNDWI"), ("ndwi", "NDWI")):
        a, b = c.index(name)
        if b is None:
            water = c.after.clear & (a > 0)
            o.indices.append(c.measure(name, area=c.area(water), threshold=f"{label} > 0 (open water) in the after scene"))
        else:
            new = c.both & (a > 0) & (b <= 0)
            o.indices.append(c.measure(name, area=c.area(new), threshold=f"{label} > 0 after and <= 0 before (new surface water)"))
    a, b = c.index("mndwi")
    o.images.append(c.index_map("index_mndwi.png", a, c.after.clear, WATER_RAMP, "MNDWI", "water index"))
    o.layers["mndwi_mean"] = c.after_layer("mndwi")
    d = c.delta("mndwi")
    if b is not None and d is not None:
        cls = np.full(a.shape, -1)
        cls[c.both & (a > 0) & (b > 0)] = 1
        cls[c.both & (a > 0) & (b <= 0)] = 0
        cls[c.both & (a <= 0) & (b > 0)] = 2
        palette = (("new water", "#2f7bff", 0.9), ("water before and after", "#9ecae1", 0.45), ("water receded", "#d8a35a", 0.9))
        o.images.append(c.class_map("change_water.png", "Flood extent", "MNDWI water before vs after", cls, palette,
                                    np.isfinite(a) & np.isfinite(b)))
        o.layers["mndwi_delta"] = d
    return o


BURN_PALETTE = (("low", "#f5e63b", 0.85), ("moderate-low", "#ffaf38", 0.85), ("moderate-high", "#ff641b", 0.85),
                ("high", "#a41fd6", 0.85), ("enhanced regrowth", "#7a8737", 0.6))
# dnbr_class() + 1 (so -1 = no data is index 0) -> BURN_PALETTE entry; unburned stays uncoloured.
BURN_LUT = np.array([-1, 4, 4, -1, 0, 1, 2, 3])
BURN_THRESHOLDS = {3: "0.10 <= dNBR < 0.27", 4: "0.27 <= dNBR < 0.44", 5: "0.44 <= dNBR < 0.66", 6: "dNBR >= 0.66"}


def burn_severity(c: Ctx) -> Outcome:
    a, _ = c.index("nbr")
    o = Outcome(
        indices=[c.measure("nbr")],
        images=[c.index_map("index_nbr.png", a, c.after.clear, NBR_RAMP, "NBR", "normalised burn ratio", DARK_NO_DATA)],
        layers={"nbr_mean": c.after_layer("nbr")},
        warnings=["dNBR severity classes use USGS FIREMON thresholds; they are indicative, not field-calibrated."],
    )
    d = c.delta("nbr")
    if d is None:
        return o
    dnbr = -d  # dNBR = NBR_before - NBR_after
    cls = dnbr_class(dnbr)
    o.indices.append({"name": "dnbr", "before_mean": None, "after_mean": None, "delta": mean(dnbr), "unit": None,
                      "affected_area_km2": c.area(cls >= 3), "threshold": "dNBR >= 0.10 (USGS low severity or worse)"})
    for k, rule in BURN_THRESHOLDS.items():
        label = DNBR_CLASSES[k].replace("_", "-")
        o.indices.append({"name": f"dnbr_{DNBR_CLASSES[k]}", "before_mean": None, "after_mean": None, "delta": None,
                          "unit": None, "affected_area_km2": c.area(cls == k), "threshold": f"{rule} (USGS {label} severity)"})
    o.images.append(c.class_map("change_burn.png", "Burn severity", "dNBR, USGS classes", BURN_LUT[cls + 1],
                                BURN_PALETTE, np.isfinite(dnbr), DARK_NO_DATA))
    o.layers["dnbr_mean"] = dnbr
    return o


def forest_loss(c: Ctx) -> Outcome:
    a, b = c.index("ndvi")
    o = Outcome(images=[_ndvi_map(c)], layers={"ndvi_mean": c.after_layer("ndvi")})
    if b is None:
        cover = c.after.clear & (a >= 0.5)
        o.indices.append(c.measure("ndvi", area=c.area(cover), threshold="NDVI >= 0.5 (likely tree or dense cover) in the after scene"))
        return o
    loss = c.both & (b >= 0.5) & (a - b < -0.2)
    o.indices.append(c.measure("ndvi", area=c.area(loss),
                               threshold="NDVI fell by more than 0.2 where it was >= 0.5 before (likely canopy loss)"))
    cls = np.full(a.shape, -1)
    cls[c.both & (b >= 0.5) & (a >= 0.5)] = 1
    cls[loss] = 0
    palette = (("likely canopy loss", "#ff5a36", 0.9), ("vegetation kept", "#3f8f5a", 0.35))
    o.images.append(c.class_map("change_forest.png", "Forest loss", "NDVI drop > 0.2", cls, palette,
                                np.isfinite(a) & np.isfinite(b), DARK_NO_DATA))
    o.layers["ndvi_delta"] = masked(a - b, c.both)
    return o


def mining_indicators(c: Ctx) -> Outcome:
    """Iron-oxide (red/blue) and clay (SWIR1/SWIR2) ratios over bare ground: INDICATORS, never deposits."""
    o = Outcome(warnings=[MINING_CAVEAT])
    bare_a = _bare(c.after.refl) & c.after.clear
    bare_b = _bare(c.before.refl) & c.before.clear if c.before else None
    if bare_a.mean() < 0.05:
        o.warnings.append(f"Only {100 * bare_a.mean():.0f}% of the area is bare ground; band-ratio indicators mean little here.")
    for name, title, bands in (("iron_oxide", "Iron-oxide ratio", "red / blue"), ("clay", "Clay ratio", "SWIR1 / SWIR2")):
        a, _ = c.index(name)
        values = masked(a, bare_a)
        hi = robust_high(values)
        anomaly = bare_a & (a > hi) if hi is not None else None
        threshold = (f"{bands} > {hi:.2f} on bare ground (AOI median + 2 robust SD); indicator only, not a deposit"
                     if hi is not None else None)
        o.indices.append(c.measure(name, unit="ratio", area=c.area(anomaly) if anomaly is not None else None,
                                   threshold=threshold, after_ok=bare_a, before_ok=bare_b))
        finite = values[np.isfinite(values)]
        ramp = render.data_ramp(*np.percentile(finite, [2, 98])) if finite.size else render.data_ramp(0.5, 2.5)
        o.images.append(c.index_map(f"index_{name}.png", a, bare_a, ramp, title, f"{bands}, indicator only",
                                    nodata="cloud, vegetation or water"))
        o.layers[f"{name}_ratio"] = values
    return o


def _bare(refl: dict[str, np.ndarray]) -> np.ndarray:
    ndvi, mndwi = INDICES["ndvi"](refl), INDICES["mndwi"](refl)
    return (ndvi < 0.3) & (mndwi <= 0)


def change_detection(c: Ctx) -> Outcome:
    a, b = c.index("ndvi")
    o = Outcome(images=[_ndvi_map(c)], layers={"ndvi_mean": c.after_layer("ndvi")})
    d = c.delta("ndvi")
    if d is None or b is None:
        o.indices.append(c.measure("ndvi"))
        return o
    changed = c.both & (np.abs(a - b) > 0.2)
    o.indices.append(c.measure("ndvi", area=c.area(changed), threshold="NDVI changed by more than 0.2 (either direction)"))
    o.images.append(c.delta_map("change_ndvi.png", "NDVI change", d, DARK_NO_DATA))
    o.layers["ndvi_delta"] = d
    return o


# --- registry ---------------------------------------------------------------------------------------------
@dataclass(frozen=True)
class RecipeSpec:
    bands: tuple[str, ...]
    analyse: Callable[[Ctx], Outcome]
    compare: str | None = None  # default before window when the job has none: "pre_event" | "year_before"
    earliest_after: bool = False  # first clear scene after the event rather than the latest (floods recede in days)


RECIPE_SPECS: dict[str, RecipeSpec] = {
    "true_color": RecipeSpec(RGBN, true_color),
    "vegetation_health": RecipeSpec(RGBN, vegetation_health),
    "flood_extent": RecipeSpec((*RGBN, "swir16"), flood_extent, "pre_event", earliest_after=True),
    "burn_severity": RecipeSpec(("blue", "green", "red", "nir08", "swir22"), burn_severity, "pre_event"),
    "forest_loss": RecipeSpec(RGBN, forest_loss, "year_before"),
    "mining_indicators": RecipeSpec((*RGBN, "swir16", "swir22"), mining_indicators),
    "change_detection": RecipeSpec(RGBN, change_detection, "year_before"),
}


def default_before(spec: RecipeSpec, after: Window) -> Window | None:
    """Pre-event: the 60 days before the after window. Year before: same season a year earlier."""
    if spec.compare == "pre_event":
        end = after.start_date - timedelta(days=1)
        return Window((end - timedelta(days=59)).isoformat(), end.isoformat())
    if spec.compare == "year_before":
        return after.shifted(-365)
    return None

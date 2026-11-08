"""Scene choice and loading: the most recent scene whose AOI (not tile) is clear, by the SCL / QA mask."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from http.client import HTTPException

import numpy as np
from rasterio.enums import Resampling
from rasterio.errors import RasterioError

from . import stac
from .grid import Grid, grid_for_bbox
from .job import SceneChoice, Window
from .reader import read_on_grid
from .sensors import LANDSAT, SENSORS, SENTINEL2, Sensor, epsg_of

MAX_SCREEN = 4  # newest candidates screened (mask + blue band, in parallel; more just contend for bandwidth)
EXTRA_SCREEN = 4  # if none is clear enough: the least cloudy (by tile) of the rest
TILE_CLOUD_CAP = 80  # tile eo:cloud_cover is per 110 km tile; only drop the hopeless ones before screening
HAZE_ABS, HAZE_REL = 0.025, 1.2  # blue reflectance above the window's clearest scene by both margins = hazy
# Filling from a neighbouring tile is optional: if it fails the job goes on with what it has and says what is missing.
FILL_ERRORS = (OSError, ValueError, KeyError, RasterioError, HTTPException)


@dataclass
class Pick:
    item: dict
    sensor: Sensor
    screened_clear: float | None  # AOI clear fraction from the screen; None when the job named the scene


@dataclass
class Scene:
    item: dict
    sensor: Sensor
    refl: dict[str, np.ndarray]  # common band name -> surface reflectance on the analysis grid
    clear: np.ndarray  # bool: clear sky by SCL / QA and data in every band read
    tiles: list[str] = field(default_factory=list)  # set when load_pass stitched more than one tile
    fill_failed: bool = False  # a neighbouring tile could not be looked up or read, so gaps may be fillable on a retry

    @property
    def has_data(self) -> np.ndarray:
        """Bool: the pixel has data in every band read (whatever the sky was)."""
        return np.logical_and.reduce([np.isfinite(r) for r in self.refl.values()])

    @property
    def data_fraction(self) -> float:
        return float(self.has_data.mean())

    @property
    def date(self) -> str:
        return str(self.item["properties"]["datetime"])[:10]

    @property
    def platform(self) -> str:
        return str(self.item["properties"].get("platform") or self.sensor.name)

    @property
    def clear_fraction(self) -> float:
        return float(self.clear.mean())

    @property
    def rgb(self) -> np.ndarray:
        """H x W x 3 reflectance (red, green, blue) for true-colour renders."""
        return np.dstack([self.refl["red"], self.refl["green"], self.refl["blue"]])

    def summary(self) -> dict:
        """SceneSummary in src/lib/domain.ts."""
        cloud = self.item["properties"].get("eo:cloud_cover")
        return {
            "collection": self.sensor.collection,
            "item_id": self.item["id"],
            "datetime": self.item["properties"]["datetime"],
            "cloud_pct": round(float(cloud), 2) if cloud is not None else None,
            "clear_fraction": round(self.clear_fraction, 4),
        }


def min_clear(max_cloud_pct: float) -> float:
    """Share of the AOI that must be clear. Capped below 1: SCL flags a few stray pixels in most scenes."""
    return min(max(1 - max_cloud_pct / 100, 0.0), 0.95)


@dataclass(frozen=True)
class Screened:
    item: dict
    clear: float  # AOI clear fraction by SCL / QA
    blue: float | None  # median blue reflectance of the clear pixels; haze and thin cloud raise it


def is_hazy(blue: float | None, clearest: float | None) -> bool:
    """SCL often calls haze and fog "clear". Within one window the land barely changes, so a median blue
    reflectance well above the window's clearest scene means haze (observed: 0.135 hazy vs 0.101 clear)."""
    if blue is None or clearest is None:
        return False
    return blue > clearest + HAZE_ABS and blue > clearest * HAZE_REL


def pick(screened: list[Screened], need: float) -> Screened | None:
    """`screened` is in preference order (newest first, or oldest first for floods). The first scene that is clear
    enough and not hazy wins; failing that the first clear-enough one; failing that the clearest (first on ties)."""
    ok = [s for s in screened if s.clear >= need]
    if ok:
        blues = [s.blue for s in ok if s.blue is not None]
        clearest = min(blues) if blues else None
        return next((s for s in ok if not is_hazy(s.blue, clearest)), ok[0])
    return max(screened, key=lambda s: s.clear) if screened else None


def _other_tiles(item: dict, sensor: Sensor, bbox: stac.BBox) -> list[dict] | None:
    """Same-pass tiles to fill `item`'s gaps; None if the lookup failed."""
    try:
        return stac.same_pass(item, sensor.collection, bbox)
    except FILL_ERRORS:
        return None


def _screen_tile(item: dict, sensor: Sensor, grid: Grid) -> tuple[np.ndarray, np.ndarray]:
    """(clear, blue reflectance) of one tile on the screening grid; blue is NaN where the tile has no data."""
    hrefs = {k: stac.sign(item["assets"][k]["href"], sensor.collection) for k in (sensor.mask_asset, sensor.bands["blue"])}
    mask = read_on_grid(hrefs[sensor.mask_asset], grid)
    blue = sensor.reflectance(item["properties"], read_on_grid(hrefs[sensor.bands["blue"]], grid, Resampling.average))
    return sensor.clear(mask) & np.isfinite(blue), blue


def screen(item: dict, sensor: Sensor, bbox: stac.BBox) -> Screened:
    """Mask + blue band over the AOI at the mask's native 20/30 m: cheap enough to run on every candidate. An AOI
    across a tile edge is measured over the whole satellite pass, like the full read (load_pass)."""
    grid = grid_for_bbox(bbox, epsg_of(item), sensor.base_res_m)
    grid = grid.with_res(sensor.native_m[sensor.mask_asset])
    clear, blue = _screen_tile(item, sensor, grid)
    for other in _other_tiles(item, sensor, bbox) or []:
        gaps = ~np.isfinite(blue)
        if not gaps.any():
            break
        try:
            other_clear, other_blue = _screen_tile(other, sensor, grid)
        except FILL_ERRORS:
            continue
        fill = gaps & np.isfinite(other_blue)
        clear[fill], blue[fill] = other_clear[fill], other_blue[fill]
    return Screened(item, float(clear.mean()), float(np.median(blue[clear])) if clear.any() else None)


def _screen_all(items: list[dict], sensor: Sensor, bbox: stac.BBox) -> list[Screened]:
    if not items:
        return []
    with ThreadPoolExecutor(len(items)) as ex:
        return list(ex.map(lambda it: screen(it, sensor, bbox), items))


def _tile_cloud(item: dict) -> float:
    cloud = item["properties"].get("eo:cloud_cover")
    return 100.0 if cloud is None else float(cloud)


def _search(
    sensor: Sensor, bbox: stac.BBox, window: Window, max_cloud_pct: float, pin: dict | None, earliest: bool = False
) -> list[dict]:
    """Candidates in preference order: newest first, or oldest first with `earliest`. The STAC page is sorted the
    same way, so a long window (event date to today) still returns the first scenes after the event."""
    query = {"eo:cloud_cover": {"lte": max(TILE_CLOUD_CAP, max_cloud_pct)}, **sensor.query}

    def run(q: dict) -> list[dict]:
        cands = stac.candidates(stac.search(sensor.collection, bbox, window, q, oldest_first=earliest), bbox)
        return cands[::-1] if earliest else cands  # candidates() sorts newest first

    # Same tile before and after means one pixel grid. Not across a tile edge: a search limited to one tile can't see
    # that a pass's tiles together cover the AOI, and it would prefer a newer pass that leaves part of it blank.
    if pin is not None and pin["collection"] == sensor.collection and stac.covers(pin.get("geometry"), bbox):
        pinned = run({**query, **stac.tile_query(pin)})
        if pinned:
            return pinned
    return run(query)


def find_scene(
    label: str,
    bbox: stac.BBox,
    window: Window | None,
    max_cloud_pct: float,
    sensor: Sensor,
    choice: SceneChoice | None = None,
    pin: dict | None = None,
    earliest: bool = False,
) -> tuple[Pick | None, list[str]]:
    """Scene for one window, plus notes for the result's warnings. `choice` = scene named in the job;
    `pin` = after item whose tile the before should share; `earliest` = prefer the first clear scene in the window
    instead of the latest. Falls back from Sentinel-2 to Landsat when the window has no Sentinel-2 scene at all."""
    notes: list[str] = []
    if choice is not None:
        chosen_sensor = SENSORS.get(choice.collection, sensor)
        item = stac.get_item(chosen_sensor.collection, choice.item_id)
        if item is not None:
            return Pick(item, chosen_sensor, None), notes
        notes.append(f"The {label} scene {choice.item_id} was not found" + (f"; searched {window} instead." if window else "."))
    if window is None:
        return None, notes

    tried = (sensor, LANDSAT) if sensor is SENTINEL2 else (sensor,)
    for s in tried:
        cands = _search(s, bbox, window, max_cloud_pct, pin, earliest)
        if cands:
            break
    else:
        names = " or ".join(t.name for t in tried)
        return None, [*notes, f"No {names} scene covers the area in the {label} window {window}."]
    if s is not sensor:
        notes.append(f"Used {s.name} (30 m) for the {label} scene: no {sensor.name} scene in {window}.")

    need = min_clear(max_cloud_pct)
    screened = _screen_all(cands[:MAX_SCREEN], s, bbox)
    best = pick(screened, need)
    if best and best.clear < need and len(cands) > MAX_SCREEN:
        rest = sorted(cands[MAX_SCREEN:], key=_tile_cloud)[:EXTRA_SCREEN]
        screened += _screen_all(rest, s, bbox)
        screened.sort(key=lambda sc: sc.item["properties"]["datetime"], reverse=not earliest)
        best = pick(screened, need)
    if best is None:
        return None, notes
    hazy = [sc for sc in screened[: screened.index(best)] if sc.clear >= need]
    if hazy:
        notes.append(f"Skipped {len(hazy)} {'earlier' if earliest else 'newer'} {label} scene(s) that the cloud mask "
                     "calls clear but that look hazy.")
    if best.clear < need:
        notes.append(
            f"No clear {label} scene in {window}: used the clearest of {len(screened)} checked "
            f"({str(best.item['properties']['datetime'])[:10]}), with {100 * (1 - best.clear):.0f}% of the area "
            "under cloud, shadow or no data."
        )
    return Pick(best.item, s, best.clear), notes


def load_scene(item: dict, sensor: Sensor, grid: Grid, bands: tuple[str, ...]) -> Scene:
    """Parallel windowed reads of the bands + mask, converted to reflectance with nodata masked."""
    keys = list(dict.fromkeys([sensor.bands[b] for b in bands] + [sensor.mask_asset]))

    def read(key: str) -> np.ndarray:
        href = stac.sign(item["assets"][key]["href"], sensor.collection)
        coarser = sensor.native_m[key] < grid.res and key != sensor.mask_asset
        return read_on_grid(href, grid, Resampling.average if coarser else Resampling.nearest)

    with ThreadPoolExecutor(len(keys)) as ex:
        dn = dict(zip(keys, ex.map(read, keys)))
    refl = {b: sensor.reflectance(item["properties"], dn[sensor.bands[b]]) for b in bands}
    has_data = np.logical_and.reduce([np.isfinite(r) for r in refl.values()])
    return Scene(item, sensor, refl, sensor.clear(dn[sensor.mask_asset]) & has_data)


def load_pass(item: dict, sensor: Sensor, grid: Grid, bands: tuple[str, ...], bbox: stac.BBox) -> Scene:
    """load_scene, then fill the pixels `item` has no data for from the other tiles of the same satellite pass, so an
    AOI across a tile edge is read whole. `item` wins where tiles overlap; each tile uses its own reflectance scaling."""
    scene = load_scene(item, sensor, grid, bands)
    has = scene.has_data
    if has.all():
        return scene
    others = _other_tiles(item, sensor, bbox)
    scene.fill_failed = others is None
    for other in others or []:
        if has.all():
            break
        try:
            extra = load_scene(other, sensor, grid, bands)
        except FILL_ERRORS:
            scene.fill_failed = True
            continue
        fill = ~has & extra.has_data
        if not fill.any():
            continue
        for band in bands:
            scene.refl[band][fill] = extra.refl[band][fill]
        scene.clear[fill] = extra.clear[fill]
        has |= fill
        scene.tiles = (scene.tiles or [stac.tile_of(item) or item["id"]]) + [stac.tile_of(other) or other["id"]]
    return scene

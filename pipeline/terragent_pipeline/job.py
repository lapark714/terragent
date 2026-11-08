"""The job file written by the Analytics agent (docs/ARCHITECTURE.md §10), parsed and validated."""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

# Mirrors RECIPES in src/lib/domain.ts (tests/test_job.py checks they match).
RECIPES = (
    "true_color",
    "vegetation_health",
    "flood_extent",
    "burn_severity",
    "forest_loss",
    "mining_indicators",
    "change_detection",
)
COLLECTIONS = ("sentinel-2-l2a", "landsat-c2-l2")


class JobError(ValueError):
    """The job file is malformed; the message says which field."""


@dataclass(frozen=True)
class Window:
    """Inclusive date range. start/end are ISO dates ("2025-01-12") or full ISO datetimes."""

    start: str
    end: str

    def stac(self) -> str:
        """RFC 3339 interval for STAC `datetime`."""
        return f"{_stamp(self.start, 'T00:00:00Z')}/{_stamp(self.end, 'T23:59:59Z')}"

    @property
    def start_date(self) -> date:
        return date.fromisoformat(self.start[:10])

    @property
    def end_date(self) -> date:
        return date.fromisoformat(self.end[:10])

    def shifted(self, days: int) -> Window:
        return Window((self.start_date + timedelta(days)).isoformat(), (self.end_date + timedelta(days)).isoformat())

    def __str__(self) -> str:
        return f"{self.start[:10]}..{self.end[:10]}"


@dataclass(frozen=True)
class SceneChoice:
    """A scene the Orchestrator already picked (SceneRef in domain.ts); the pipeline then skips its own search."""

    collection: str
    item_id: str


@dataclass(frozen=True)
class Job:
    request_id: str
    recipe: str
    bbox: tuple[float, float, float, float]  # minLon, minLat, maxLon, maxLat
    after_window: Window
    before_window: Window | None
    after_scene: SceneChoice | None
    before_scene: SceneChoice | None
    max_cloud_pct: float
    h3_res: int
    collection: str


def load_job(path: str | Path) -> Job:
    try:
        data = json.loads(Path(path).read_text())
    except (OSError, json.JSONDecodeError) as e:
        raise JobError(f"cannot read job file {path}: {e}") from e
    return parse_job(data)


def parse_job(d: object) -> Job:
    if not isinstance(d, dict):
        raise JobError("job must be a JSON object")
    recipe = d.get("recipe")
    if recipe not in RECIPES:
        raise JobError(f"recipe must be one of {', '.join(RECIPES)}; got {recipe!r}")
    collection = d.get("collection") or COLLECTIONS[0]
    if collection not in COLLECTIONS:
        raise JobError(f"collection must be one of {', '.join(COLLECTIONS)}; got {collection!r}")
    after = _window(d.get("after_window"), "after_window")
    if after is None:
        raise JobError("after_window is required")
    max_cloud = _number(d.get("max_cloud_pct", 30), "max_cloud_pct")
    h3_res = d.get("h3_res", 8)
    if not isinstance(h3_res, int) or not 0 <= h3_res <= 15:
        raise JobError("h3_res must be an integer 0-15")
    return Job(
        request_id=str(d.get("request_id") or "local"),
        recipe=recipe,
        bbox=_bbox(d.get("bbox")),
        after_window=after,
        before_window=_window(d.get("before_window"), "before_window"),
        after_scene=_scene(d.get("after_scene")),
        before_scene=_scene(d.get("before_scene")),
        max_cloud_pct=min(max(max_cloud, 0.0), 100.0),
        h3_res=h3_res,
        collection=collection,
    )


def _stamp(s: str, time_suffix: str) -> str:
    return s if "T" in s else s + time_suffix


def _number(v: object, field: str) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise JobError(f"{field} must be a number")
    return float(v)


def _bbox(v: object) -> tuple[float, float, float, float]:
    if not isinstance(v, (list, tuple)) or len(v) != 4:
        raise JobError("bbox must be [minLon, minLat, maxLon, maxLat]")
    lo0, la0, lo1, la1 = (_number(x, "bbox") for x in v)
    if not (-180 <= lo0 < lo1 <= 180 and -90 <= la0 < la1 <= 90):
        raise JobError(f"bbox is not a valid [minLon, minLat, maxLon, maxLat]: {list(v)}")
    return (lo0, la0, lo1, la1)


def _window(v: object, field: str) -> Window | None:
    if v is None:
        return None
    if not isinstance(v, dict) or not isinstance(v.get("start"), str) or not isinstance(v.get("end"), str):
        raise JobError(f"{field} must be {{start, end}} ISO dates or null")
    w = Window(v["start"], v["end"])
    try:
        start, end = w.start_date, w.end_date
    except ValueError as e:
        raise JobError(f"{field} has an invalid date: {e}") from e
    if start > end:
        raise JobError(f"{field} starts after it ends")
    return w


def _scene(v: object) -> SceneChoice | None:
    if not isinstance(v, dict) or not v.get("item_id"):
        return None
    return SceneChoice(collection=str(v.get("collection") or COLLECTIONS[0]), item_id=str(v["item_id"]))

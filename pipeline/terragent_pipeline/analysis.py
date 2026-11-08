"""One job end to end: find scenes, read pixels, run the recipe, render, aggregate to H3 -> AnalysisResult."""
from __future__ import annotations

import math
import sys
import time
from collections.abc import Iterator
from typing import Any
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path

from . import render
from .grid import grid_for_bbox
from .h3agg import h3_metrics
from .job import Job
from .recipes import RECIPE_SPECS, Ctx, Outcome, default_before
from .scenes import Pick, Scene, find_scene, load_scene, min_clear
from .sensors import SENSORS, epsg_of


class Timer:
    def __init__(self) -> None:
        self.start = time.perf_counter()
        self.steps: dict[str, float] = {}

    @contextmanager
    def __call__(self, name: str) -> Iterator[None]:
        t0 = time.perf_counter()
        try:
            yield
        finally:
            self.steps[name] = round(self.steps.get(name, 0.0) + time.perf_counter() - t0, 3)

    def report(self) -> dict[str, float]:
        return {**self.steps, "total": round(time.perf_counter() - self.start, 3)}


def log(msg: str) -> None:
    print(f"[pipeline] {msg}", file=sys.stderr, flush=True)


def analyse(job: Job, out: Path) -> dict:
    """AnalysisResult (src/lib/domain.ts) for the job; images are written into `out`, paths relative to it."""
    timer, warnings = Timer(), []
    spec = RECIPE_SPECS[job.recipe]
    sensor = SENSORS[job.collection]

    before_window = job.before_window
    if before_window is None and spec.compare:
        before_window = default_before(spec, job.after_window)
        warnings.append(f"No before window was given; compared with {before_window}.")

    with timer("after_search"):
        after_pick, notes = find_scene("after", job.bbox, job.after_window, job.max_cloud_pct, sensor, job.after_scene,
                                       earliest=spec.earliest_after)
    warnings += notes
    if after_pick is None:
        return _result(job, None, None, Outcome(), [], [], timer, warnings)
    log(f"after: {after_pick.item['id']} (screened clear {after_pick.screened_clear})")

    before_pick = None
    if before_window or job.before_scene:
        with timer("before_search"):
            before_pick, notes = find_scene(
                "before", job.bbox, before_window, job.max_cloud_pct, sensor, job.before_scene, pin=after_pick.item
            )
        warnings += notes
        if before_pick:
            log(f"before: {before_pick.item['id']} (screened clear {before_pick.screened_clear})")
    if spec.compare and before_pick is None:
        warnings.append("No before scene, so there are no before/after comparison metrics; only the after scene is reported.")

    grid = grid_for_bbox(job.bbox, epsg_of(after_pick.item), after_pick.sensor.base_res_m)
    with timer("read"), ThreadPoolExecutor(2) as ex:
        fa = ex.submit(load_scene, after_pick.item, after_pick.sensor, grid, spec.bands)
        fb = ex.submit(load_scene, before_pick.item, before_pick.sensor, grid, spec.bands) if before_pick else None
        after, before = fa.result(), fb.result() if fb else None
    log(f"read {grid.width}x{grid.height} px at {grid.res:g} m (EPSG:{grid.epsg})")
    warnings += _coverage_warnings(job, (after_pick, after), (before_pick, before))

    ctx = Ctx(after, before, grid, out, render.stretch_for([(s.rgb, s.clear) for s in (after, before) if s]))
    with timer("analyse"):
        outcome = spec.analyse(ctx)
    with timer("render"):
        photos = [ctx.true_color_image(s, role) for s, role in ((before, "before"), (after, "after")) if s]
    with timer("h3"):
        cells = h3_metrics(grid, outcome.layers, job.h3_res)
    return _result(job, after, before, outcome, photos, cells, timer, warnings)


def _coverage_warnings(job: Job, after: tuple[Pick, Scene], before: tuple[Pick | None, Scene | None]) -> list[str]:
    """Cloud cover of scenes the job named (searched scenes were already reported by find_scene) and of the overlap."""
    need, out = min_clear(job.max_cloud_pct), []
    for label, (p, s) in (("after", after), ("before", before)):
        if p is not None and s is not None and p.screened_clear is None and s.clear_fraction < need:
            out.append(f"Only {100 * s.clear_fraction:.0f}% of the area is clear in the {label} scene ({s.date}).")
    after_scene, before_scene = after[1], before[1]
    if before_scene is not None:
        both = float((after_scene.clear & before_scene.clear).mean())
        if both < 0.5:
            out.append(f"Only {100 * both:.0f}% of the area is clear in both scenes; the comparison covers that part only.")
    return out


def _result(job: Job, after: Scene | None, before: Scene | None, o: Outcome, photos: list[dict], cells: list[dict],
            timer: Timer, warnings: list[str]) -> Any:
    return _finite(
        {
            "recipe": job.recipe,
            "bbox": list(job.bbox),
            "before": before.summary() if before else None,
            "after": after.summary() if after else None,
            "indices": o.indices,
            "images": photos + o.images,
            "h3_metrics": cells,
            "timings_s": timer.report(),
            "warnings": list(dict.fromkeys(warnings + o.warnings)),
        }
    )


def _finite(v: Any) -> Any:
    """JSON has no NaN/Infinity: any non-finite number becomes null."""
    if isinstance(v, float):
        return v if math.isfinite(v) else None
    if isinstance(v, dict):
        return {k: _finite(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_finite(x) for x in v]
    return v

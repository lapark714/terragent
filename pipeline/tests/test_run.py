"""The CLI end to end with the network stubbed: AnalysisResult shape, files, exit codes, the job deadline."""
import json
import threading
import time

import numpy as np
import pytest

from conftest import LA_BBOX, SHAPE, make_scene, refl
from terragent_pipeline import analysis, run
from terragent_pipeline.scenes import Pick
from terragent_pipeline.sensors import SENTINEL2

RESULT_KEYS = {"recipe", "bbox", "before", "after", "indices", "images", "h3_metrics", "timings_s", "warnings"}
SCENE_KEYS = {"collection", "item_id", "datetime", "cloud_pct", "clear_fraction"}
INDEX_KEYS = {"name", "before_mean", "after_mean", "delta", "unit", "affected_area_km2", "threshold"}


@pytest.fixture
def job_file(tmp_path):
    def write(**patch):
        job = {"request_id": "req_t", "recipe": "burn_severity", "bbox": list(LA_BBOX),
               "before_window": None, "after_window": {"start": "2025-01-12", "end": "2025-02-10"},
               "before_scene": None, "after_scene": None, "max_cloud_pct": 20, "h3_res": 8, "collection": "sentinel-2-l2a",
               **patch}
        path = tmp_path / "job.json"
        path.write_text(json.dumps(job))
        return str(path)

    return write


@pytest.fixture
def offline(monkeypatch):
    """Burned left half between a December and a February scene."""
    left = np.zeros(SHAPE, bool)
    left[:, : SHAPE[1] // 2] = True
    scenes = {
        "before": make_scene(refl(nir08=0.35, swir22=0.12), when="2024-12-28T18:00:00Z"),
        "after": make_scene(refl(nir08=np.where(left, 0.12, 0.35), swir22=np.where(left, 0.25, 0.12)),
                            when="2025-02-01T18:00:00Z"),
    }
    seen = {}

    def find_scene(label, bbox, window, max_cloud_pct, sensor, choice=None, pin=None, earliest=False):
        seen[label] = window
        return Pick(scenes[label].item, SENTINEL2, 1.0), []

    monkeypatch.setattr(analysis, "find_scene", find_scene)
    monkeypatch.setattr(analysis, "load_scene", lambda item, sensor, grid, bands: next(
        s for s in scenes.values() if s.item is item))
    return seen


def test_cli_prints_one_json_line_and_writes_result(job_file, offline, tmp_path, capsys):
    out = tmp_path / "out"
    assert run.main(["--job", job_file(), "--out", str(out)]) == 0
    lines = capsys.readouterr().out.splitlines()
    assert len(lines) == 1
    result = json.loads(lines[0])
    assert result == json.loads((out / "result.json").read_text())
    assert set(result) == RESULT_KEYS
    assert set(result["after"]) == SCENE_KEYS and set(result["before"]) == SCENE_KEYS
    assert all(set(r) == INDEX_KEYS for r in result["indices"])
    assert result["bbox"] == list(LA_BBOX)
    dnbr = next(r for r in result["indices"] if r["name"] == "dnbr")
    assert dnbr["affected_area_km2"] > 1.5
    assert [i["role"] for i in result["images"]] == ["before", "after", "index", "change"]
    assert all((out / i["path"]).is_file() for i in result["images"])
    assert {m["metric"] for m in result["h3_metrics"]} == {"nbr_mean", "dnbr_mean"}
    assert {"after_search", "before_search", "read", "analyse", "render", "h3", "total"} <= set(result["timings_s"])
    assert any("compared with 2024-11-13..2025-01-11" in w for w in result["warnings"])
    assert str(offline["before"]) == "2024-11-13..2025-01-11"


def test_no_scene_is_not_a_crash(job_file, monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(analysis, "find_scene", lambda *a, **k: (None, ["No Sentinel-2 or Landsat scene covers the area."]))
    assert run.main(["--job", job_file(recipe="true_color"), "--out", str(tmp_path / "o")]) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["after"] is None and result["indices"] == [] and result["images"] == []
    assert result["warnings"] == ["No Sentinel-2 or Landsat scene covers the area."]


def test_invalid_job_exits_2(job_file, tmp_path, capsys):
    assert run.main(["--job", job_file(recipe="nope"), "--out", str(tmp_path / "o")]) == 2
    assert "invalid job" in capsys.readouterr().err


def test_non_finite_numbers_become_null():
    assert analysis._finite({"a": [float("nan"), 1.5], "b": float("inf")}) == {"a": [None, 1.5], "b": None}


@pytest.fixture
def stuck(monkeypatch):
    """Planetary Computer hangs: the patched step blocks until the test ends."""
    release = threading.Event()
    exits = []
    monkeypatch.setattr(run, "_exit", exits.append)
    yield release, exits
    release.set()


def test_deadline_returns_an_empty_result_with_a_warning_and_exits_0(job_file, monkeypatch, tmp_path, capsys, stuck):
    release, exits = stuck
    monkeypatch.setattr(analysis, "find_scene", lambda *a, **k: release.wait(30) and (None, []))
    t0 = time.perf_counter()
    assert run.main(["--job", job_file(), "--out", str(tmp_path / "o"), "--deadline-s", "0.3"]) == 0
    assert time.perf_counter() - t0 < 5
    assert exits == [0]  # hard exit: the stuck read must not keep the process alive
    result = json.loads(capsys.readouterr().out)
    assert set(result) == RESULT_KEYS
    assert result["after"] is None and result["before"] is None and result["indices"] == [] and result["images"] == []
    assert result["timings_s"]["deadline_s"] == 0.3 and result["timings_s"]["after_search"] >= 0.25
    assert "compared with 2024-11-13..2025-01-11" in result["warnings"][0]  # warnings found before the deadline stay
    assert result["warnings"][-1].startswith("Stopped at the 0.3 s job deadline during the 'after_search' step")
    assert result == json.loads((tmp_path / "o" / "result.json").read_text())


def test_deadline_names_scenes_already_chosen(job_file, offline, monkeypatch, tmp_path, capsys, stuck):
    release, _ = stuck
    monkeypatch.setattr(analysis, "load_scene", lambda *a, **k: release.wait(30))
    assert run.main(["--job", job_file(), "--out", str(tmp_path / "o"), "--deadline-s", "0.3"]) == 0
    warning = json.loads(capsys.readouterr().out)["warnings"][-1]
    assert "during the 'read' step" in warning
    assert "after scene S2C_MSIL2A_20250201_TEST and before scene S2C_MSIL2A_20241228_TEST had been chosen" in warning


def test_finished_jobs_exit_normally(job_file, offline, tmp_path, stuck):
    _, exits = stuck
    assert run.main(["--job", job_file(), "--out", str(tmp_path / "o"), "--deadline-s", "30"]) == 0
    assert exits == []


def test_crashes_inside_the_job_still_raise(job_file, monkeypatch, tmp_path):
    monkeypatch.setattr(analysis, "find_scene", lambda *a, **k: 1 / 0)
    with pytest.raises(ZeroDivisionError):
        run.main(["--job", job_file(), "--out", str(tmp_path / "o")])


def test_deadline_from_flag_env_or_default(monkeypatch):
    monkeypatch.delenv(run.DEADLINE_ENV, raising=False)
    assert run.deadline_seconds() == 75
    monkeypatch.setenv(run.DEADLINE_ENV, "120")
    assert run.deadline_seconds() == 120
    assert run.deadline_seconds(10) == 10
    monkeypatch.setenv(run.DEADLINE_ENV, "soon")
    assert run.deadline_seconds() == 75

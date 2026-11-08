import json
import re
from pathlib import Path

import pytest

from terragent_pipeline.job import RECIPES, JobError, Window, load_job, parse_job

DOMAIN_TS = Path(__file__).resolve().parents[2] / "src" / "lib" / "domain.ts"

VALID = {
    "request_id": "req_1",
    "recipe": "burn_severity",
    "bbox": [-118.15, 34.17, -118.12, 34.2],
    "before_window": {"start": "2024-12-01", "end": "2025-01-06"},
    "after_window": {"start": "2025-01-12", "end": "2025-02-10"},
    "before_scene": None,
    "after_scene": {"collection": "sentinel-2-l2a", "item_id": "S2C_X", "datetime": "2025-02-01", "cloud_pct": 3},
    "max_cloud_pct": 20,
    "h3_res": 8,
    "collection": "sentinel-2-l2a",
}


def test_recipes_match_domain_ts():
    block = re.search(r"export const RECIPES = \[(.*?)\] as const", DOMAIN_TS.read_text(), re.S)
    assert block, "RECIPES not found in src/lib/domain.ts"
    assert tuple(re.findall(r'^\s*"([a-z_]+)",', block.group(1), re.M)) == RECIPES  # skips "quotes" in comments


def test_parses_the_architecture_contract(tmp_path):
    path = tmp_path / "job.json"
    path.write_text(json.dumps(VALID))
    job = load_job(path)
    assert job.recipe == "burn_severity"
    assert job.bbox == (-118.15, 34.17, -118.12, 34.2)
    assert job.before_window == Window("2024-12-01", "2025-01-06")
    assert job.after_scene and job.after_scene.item_id == "S2C_X"
    assert job.before_scene is None
    assert (job.max_cloud_pct, job.h3_res, job.collection) == (20.0, 8, "sentinel-2-l2a")


def test_defaults_for_optional_fields():
    job = parse_job({"recipe": "true_color", "bbox": [0, 0, 0.01, 0.01], "after_window": {"start": "2026-01-01", "end": "2026-02-01"}})
    assert job.request_id == "local"
    assert job.before_window is None and job.after_scene is None
    assert (job.max_cloud_pct, job.h3_res, job.collection) == (30.0, 8, "sentinel-2-l2a")


@pytest.mark.parametrize(
    "patch, message",
    [
        ({"recipe": "deposits"}, "recipe must be one of"),
        ({"bbox": [1, 2, 3]}, "bbox must be"),
        ({"bbox": [10, 0, 5, 1]}, "not a valid"),
        ({"after_window": None}, "after_window is required"),
        ({"after_window": {"start": "2025-03-01", "end": "2025-02-01"}}, "starts after it ends"),
        ({"before_window": {"start": "2025-02-30", "end": "2025-03-01"}}, "invalid date"),
        ({"h3_res": 16}, "h3_res"),
        ({"max_cloud_pct": "lots"}, "max_cloud_pct"),
        ({"collection": "planet"}, "collection must be"),
    ],
)
def test_rejects_bad_jobs(patch, message):
    with pytest.raises(JobError, match=message):
        parse_job({**VALID, **patch})


def test_unreadable_job_file(tmp_path):
    with pytest.raises(JobError, match="cannot read job file"):
        load_job(tmp_path / "missing.json")


def test_window_formats_stac_interval_and_shifts():
    assert Window("2025-01-12", "2025-02-10").stac() == "2025-01-12T00:00:00Z/2025-02-10T23:59:59Z"
    assert Window("2025-01-12T06:00:00Z", "2025-02-10").stac() == "2025-01-12T06:00:00Z/2025-02-10T23:59:59Z"
    assert Window("2025-01-12", "2025-02-10").shifted(-365) == Window("2024-01-13", "2024-02-11")

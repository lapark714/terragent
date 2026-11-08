"""CLI (docs/ARCHITECTURE.md §10):

    python -m terragent_pipeline.run --job job.json --out <dir> [--deadline-s 75]

Prints the AnalysisResult as one line of JSON on stdout and writes <dir>/result.json plus the PNGs.
Exit 0 on success, including "no clear scene" (then `warnings` explains); 2 for an invalid job; 1 for a crash.

The whole job has a wall-clock deadline (default 75 s; TERRAGENT_PIPELINE_DEADLINE_S or --deadline-s, 0 = none), so a
degraded Planetary Computer can't hang the Analytics agent: at the deadline the CLI prints a result with no
measurements and a warning that says why, exits 0 and abandons the stuck reads.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
from pathlib import Path
from typing import Any

from .analysis import Progress, analyse, deadline_result, log
from .job import Job, JobError, load_job

DEADLINE_ENV = "TERRAGENT_PIPELINE_DEADLINE_S"
DEFAULT_DEADLINE_S = 75.0

# Ends the process without joining threads still blocked in GDAL reads (tests replace it).
_exit = os._exit


def deadline_seconds(flag: float | None = None) -> float:
    """--deadline-s, else $TERRAGENT_PIPELINE_DEADLINE_S, else 75. 0 or less = no deadline; junk = the default."""
    if flag is not None:
        return flag
    raw = os.environ.get(DEADLINE_ENV, "").strip()
    try:
        return float(raw) if raw else DEFAULT_DEADLINE_S
    except ValueError:
        log(f"ignoring {DEADLINE_ENV}={raw!r} (not a number); deadline {DEFAULT_DEADLINE_S:g} s")
        return DEFAULT_DEADLINE_S


def run_job(job: Job, out: Path, deadline_s: float) -> tuple[Any, bool]:
    """(AnalysisResult, finished). The job runs in a daemon thread; past the deadline the partial result is returned
    and the thread is left behind. Errors inside the job are re-raised (exit 1, as before)."""
    progress, box = Progress(), {}

    def work() -> None:
        try:
            box["result"] = analyse(job, out, progress)
        except BaseException as e:  # noqa: BLE001 - handed to the main thread
            box["error"] = e

    worker = threading.Thread(target=work, name="terragent-job", daemon=True)
    worker.start()
    worker.join(deadline_s if deadline_s > 0 else None)
    if worker.is_alive():
        log(f"job deadline of {deadline_s:g} s reached during '{progress.timer.current or 'setup'}'; returning without measurements")
        return deadline_result(job, progress, deadline_s), False
    if "error" in box:
        raise box["error"]
    return box["result"], True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m terragent_pipeline.run", description="Run one Terragent imagery job.")
    parser.add_argument("--job", required=True, help="path to job.json")
    parser.add_argument("--out", required=True, help="output directory (created if missing)")
    parser.add_argument("--deadline-s", type=float, default=None,
                        help=f"wall-clock limit for the whole job (default ${DEADLINE_ENV} or {DEFAULT_DEADLINE_S:g}; 0 = none)")
    args = parser.parse_args(argv)
    try:
        job = load_job(args.job)
    except JobError as e:
        print(f"invalid job: {e}", file=sys.stderr)
        return 2
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    result, finished = run_job(job, out, deadline_seconds(args.deadline_s))
    (out / "result.json").write_text(json.dumps(result, indent=1) + "\n")
    sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")
    if not finished:
        # Threads stuck in network reads would keep a normal exit waiting; the answer is already out.
        sys.stdout.flush()
        sys.stderr.flush()
        _exit(0)
    return 0


if __name__ == "__main__":
    sys.exit(main())

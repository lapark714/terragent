"""CLI (docs/ARCHITECTURE.md §10):

    python -m terragent_pipeline.run --job job.json --out <dir>

Prints the AnalysisResult as one line of JSON on stdout and writes <dir>/result.json plus the PNGs.
Exit 0 on success, including "no clear scene" (then `warnings` explains); 2 for an invalid job; 1 for a crash.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .analysis import analyse
from .job import JobError, load_job


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m terragent_pipeline.run", description="Run one Terragent imagery job.")
    parser.add_argument("--job", required=True, help="path to job.json")
    parser.add_argument("--out", required=True, help="output directory (created if missing)")
    args = parser.parse_args(argv)
    try:
        job = load_job(args.job)
    except JobError as e:
        print(f"invalid job: {e}", file=sys.stderr)
        return 2
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    result = analyse(job, out)
    (out / "result.json").write_text(json.dumps(result, indent=1) + "\n")
    sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())

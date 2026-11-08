#!/usr/bin/env python3
"""Measure the numeric quality-bar items on a finished render and print a Markdown report.

Near-frozen means under 0.2% of pixels changed by more than 12/255 between frames 0.1 s apart.
Usage: quality.py IN.mp4 [MIX.wav]
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
BRAND = {"space": (10, 21, 35), "panel": (14, 28, 45), "text": (231, 238, 246), "accent": (127, 131, 240)}


def ff(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["npx", "remotion", "ffmpeg", "-hide_banner", *args], cwd=ROOT, capture_output=True, text=True)


def probe(src: Path) -> dict[str, str]:
    res = subprocess.run(
        ["npx", "remotion", "ffprobe", "-hide_banner", "-select_streams", "v:0", "-show_entries",
         "stream=width,height,r_frame_rate,nb_frames,duration", "-of", "default=nw=1", str(src)],
        cwd=ROOT, capture_output=True, text=True,
    )
    return dict(line.split("=", 1) for line in res.stdout.splitlines() if re.match(r"^[a-z_]+=", line))


def main() -> int:
    src = Path(sys.argv[1]).resolve()
    mix = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else None
    info = probe(src)
    print("## Spec\n")
    print(f"- Video stream: {info.get('width')}×{info.get('height')}, {info.get('r_frame_rate')} fps, "
          f"{info.get('nb_frames')} frames, duration {info.get('duration')} s\n")

    with tempfile.TemporaryDirectory() as d:
        res = ff("-loglevel", "error", "-i", str(src), "-r", "10", "-an", str(Path(d) / "f%04d.png"))
        files = sorted(Path(d).glob("f*.png"))
        if not files:
            raise RuntimeError(res.stderr[-800:])
        changed = []
        prev = None
        first = None
        for path in files:
            cur = np.asarray(Image.open(path).convert("RGB").resize((960, 540), Image.BILINEAR)).astype(np.int16)
            if first is None:
                first = cur
            if prev is not None:
                changed.append(float((np.abs(cur - prev).max(axis=2) > 12).mean() * 100))
            prev = cur
    frozen = [c < 0.2 for c in changed]
    runs: list[tuple[float, float]] = []
    start = None
    for i, value in enumerate(frozen + [False]):
        if value and start is None:
            start = i
        if not value and start is not None:
            if i - start >= 2:
                runs.append((start / 10, i / 10))
            start = None
    long_runs = [r for r in runs if r[1] - r[0] > 0.5]
    print("## Motion\n")
    print(f"- Near-frozen time, all runs of 0.2 s or more: {sum(b - a for a, b in runs):.1f} s (budget 2 s)")
    print(f"- Runs over 0.5 s: {', '.join(f'{a:.1f}–{b:.1f}' for a, b in long_runs) or 'none'}\n")

    print("## Colour\n")
    assert first is not None
    corners = first[20:60, 20:60].reshape(-1, 3).mean(axis=0)
    print(f"- Frame-one background sample: {tuple(int(round(x)) for x in corners)}, brand space {BRAND['space']}\n")

    if mix:
        res = ff("-nostats", "-i", str(mix), "-af", "loudnorm=I=-14:TP=-1:LRA=11:print_format=json", "-f", "wav", "-y", "/dev/null")
        data = json.loads(re.search(r"\{[^{}]*input_i[^{}]*\}", res.stderr + res.stdout, re.S).group(0))
        print("## Audio\n")
        print(f"- Integrated loudness {data['input_i']} LUFS (target about −14), true peak {data['input_tp']} dBTP (limit −1)\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())

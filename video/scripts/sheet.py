#!/usr/bin/env python3
"""Pull frames from a render and stitch a labelled contact sheet.

Usage: sheet.py IN.mp4 OUT.jpg --times 0,0.75,1.5 [--cols 3] [--width 640]
       sheet.py IN.mp4 OUT.jpg --every 0.5 [--start 30 --end 60] [--cols 6]
"""
from __future__ import annotations

import argparse
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent


def grab(src: Path, t: float, dest: Path) -> None:
    cmd = ["npx", "remotion", "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{t:.4f}", "-i", str(src),
           "-frames:v", "1", "-q:v", "3", str(dest)]
    subprocess.run(cmd, cwd=ROOT, check=True, capture_output=True)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("src", type=Path)
    p.add_argument("out", type=Path)
    p.add_argument("--times")
    p.add_argument("--every", type=float)
    p.add_argument("--start", type=float, default=0.0)
    p.add_argument("--end", type=float, default=60.0)
    p.add_argument("--cols", type=int, default=4)
    p.add_argument("--width", type=int, default=480)
    a = p.parse_args()
    if a.times:
        times = [float(x) for x in a.times.split(",")]
    else:
        count = int(round((a.end - a.start) / a.every))
        times = [round(a.start + i * a.every, 4) for i in range(count)]
    src, out = a.src.resolve(), a.out.resolve()
    with tempfile.TemporaryDirectory() as d:
        paths = [Path(d) / f"{i:04}.jpg" for i in range(len(times))]
        with ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(lambda x: grab(src, x[0], x[1]), zip(times, paths)))
        h = int(a.width * 9 / 16)
        rows = (len(times) + a.cols - 1) // a.cols
        sheet = Image.new("RGB", (a.cols * a.width, rows * h), (0, 0, 0))
        draw = ImageDraw.Draw(sheet)
        for i, (t, path) in enumerate(zip(times, paths)):
            x, y = (i % a.cols) * a.width, (i // a.cols) * h
            sheet.paste(Image.open(path).convert("RGB").resize((a.width, h), Image.LANCZOS), (x, y))
            draw.rectangle([x, y, x + 58, y + 14], fill=(0, 0, 0))
            draw.text((x + 3, y + 2), f"{t:.2f}s", fill=(255, 255, 0))
    sheet.save(out, quality=88)
    print(out, sheet.size)


if __name__ == "__main__":
    main()

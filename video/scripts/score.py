#!/usr/bin/env python3
"""Compose the Terragent film score and SFX in code; write stems and src/timing.json.

One event table drives audio and picture: every hit sits on a 0.25 s grid (15 frames at 60 fps at 120 BPM),
so sync is exact by construction. Deterministic: same seed, same file.

Usage: python3 -I scripts/score.py
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
AUDIO = ROOT / "public" / "audio"
SR = 48000
DUR = 60.0
FPS = 60
BPM = 120
BEAT = 60 / BPM
N = int(SR * DUR)
rng = np.random.default_rng(714)

TARGET_LUFS = -14.0
CEILING_DBTP = -1.2  # a little inside the -1 dBTP spec

# ---- Film structure -------------------------------------------------------------------------------------------
SCENES = [
    ("ask", 0.0, 3.0), ("signals", 3.0, 7.0), ("planner", 7.0, 11.0), ("routing", 11.0, 13.5),
    ("pricing", 13.5, 16.0), ("analysis", 16.0, 21.0), ("delivery", 21.0, 25.0), ("mission", 25.0, 30.0),
    ("flood", 30.0, 34.0), ("vineyard", 34.0, 37.5), ("fields", 37.5, 41.0), ("cocoa", 41.0, 44.5),
    ("mining", 44.5, 48.0), ("methane", 48.0, 51.0), ("factory", 51.0, 54.0), ("rapid", 54.0, 57.0),
    ("signoff", 57.0, 60.0),
]
MONTAGE = {"flood", "vineyard", "fields", "cocoa", "mining", "methane", "factory"}

E: list[tuple[float, str, str]] = [
    (0.5, "thud", "pin lands on globe"),
    (1.0, "whoosh", "email to pin"), (1.0, "tick", "email chip"),
    (1.5, "whoosh", "web tap to pin"), (1.5, "tick", "web chip"),
    (2.0, "whoosh", "api call to pin"), (2.0, "tick", "api chip"),
]
E += [(3.5 + i * 0.25, "tick", f"feed chip {i + 1}") for i in range(8)]
E += [
    (5.5, "whoosh", "signal to sourcing"), (5.5, "tick", "sourcing node"),
    (6.0, "whoosh", "sourcing to outreach"), (6.0, "tick", "outreach node"),
    (6.25, "click", "sample email in inbox"),
    (7.25, "tick", "planner opens"), (7.75, "tick", "spec area"), (8.25, "tick", "spec dates"),
    (8.75, "tick", "spec sensor"), (9.25, "tick", "spec method"), (9.75, "pass", "index hit: already known"),
    (10.5, "whoosh", "planner to acquisition"),
    (11.25, "tick", "acquisition opens"),
    (11.5, "whoosh", "route sentinel-2"), (11.75, "whoosh", "route landsat"), (12.0, "whoosh", "route sentinel-1"),
    (12.5, "whoosh", "route paid optical"), (12.75, "whoosh", "route paid radar"), (13.0, "whoosh", "route thermal"),
    (13.75, "tick", "option A"), (14.0, "tick", "option B"), (14.25, "tick", "option C"),
    (14.75, "click", "customer accepts"), (15.25, "chime", "payment confirmed"),
    (16.25, "tick", "analytics opens"),
    (18.25, "whoosh", "analytics to interpreter"), (18.5, "tick", "interpreter"),
    (19.0, "whoosh", "interpreter to verifier"), (19.25, "buzz", "verifier rejects"),
    (19.75, "whoosh", "loop back"), (20.25, "pass", "verifier passes 92/100"),
    (21.5, "tick", "report answer"), (21.75, "tick", "report imagery"), (22.0, "tick", "report confidence"),
    (22.25, "tick", "report sources"), (23.0, "click", "report emailed"), (23.5, "whoosh", "hex joins index"),
]
E += [(25.25 + i * 0.25, "tick", f"agent {i + 1}") for i in range(12)]

for name, start, end in SCENES:
    if name not in MONTAGE:
        continue
    length = end - start
    pin, chip, sweep, answer = {4.0: (0.5, 0.75, 1.0, 1.75), 3.5: (0.5, 0.75, 1.0, 1.5), 3.0: (0.25, 0.5, 0.75, 1.25)}[length]
    E += [
        (start + pin, "thud", f"{name}: pin"), (start + chip, "tick", f"{name}: chip"),
        (start + sweep, "whoosh", f"{name}: sweep"), (start + answer, "click", f"{name}: answer"),
    ]
E += [(54.0 + i * 0.25, "tick", f"rapid tile {i + 1}") for i in range(5)]
E += [(57.5, "thud", "pin settles into lockup")]
E.sort()


# ---- Synthesis helpers ----------------------------------------------------------------------------------------
def t_arr(seconds: float) -> np.ndarray:
    return np.arange(int(seconds * SR)) / SR


def add(buf: np.ndarray, at: float, sig: np.ndarray, pan: float = 0.0, gain: float = 1.0) -> None:
    i = int(round(at * SR))
    if i >= buf.shape[0] or i < 0:
        return
    sig = sig[: buf.shape[0] - i]
    left, right = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    buf[i : i + len(sig), 0] += sig * gain * left * 1.414
    buf[i : i + len(sig), 1] += sig * gain * right * 1.414


def bandpass(sig: np.ndarray, lo: float, hi: float) -> np.ndarray:
    spec = np.fft.rfft(sig)
    f = np.fft.rfftfreq(len(sig), 1 / SR)
    edge = np.clip((f - lo) / (lo * 0.3 + 1), 0, 1) * np.clip((hi - f) / (hi * 0.3 + 1), 0, 1)
    return np.fft.irfft(spec * edge, len(sig))


def tone(freq: float, seconds: float, harmonics: int, rolloff: float = 1.0, detune: float = 0.0) -> np.ndarray:
    t = t_arr(seconds)
    out = np.zeros_like(t)
    for h in range(1, harmonics + 1):
        if freq * h > SR * 0.45:
            break
        out += np.sin(2 * np.pi * freq * h * (1 + detune) * t + h * 0.7) / h**rolloff
    return out


def env(n: int, attack: float, release: float) -> np.ndarray:
    t = np.arange(n) / SR
    a = np.clip(t / max(attack, 1e-4), 0, 1)
    r = np.exp(-t / release)
    return a * r


def midi(m: float) -> float:
    return 440.0 * 2 ** ((m - 69) / 12)


# ---- Music ----------------------------------------------------------------------------------------------------
D_MIN, B_FLAT, F_MAJ, C_MAJ = [50, 57, 62, 65, 69], [46, 53, 62, 65, 70], [41, 57, 60, 65, 69], [48, 55, 62, 64, 67]
PROG = [D_MIN, B_FLAT, F_MAJ, C_MAJ]
ROOTS = [38, 34, 41, 36]


def chord_at(bar: int) -> int:
    return (bar // 2) % 4 if bar < 15 else bar % 4


def build_music() -> tuple[np.ndarray, np.ndarray]:
    dry, send = np.zeros((N, 2)), np.zeros((N, 2))

    # Pad: long held chords, slow attack.
    for bar in range(0, 28):
        t0 = bar * 2.0
        if t0 >= 57:
            break
        if bar < 15 and bar % 2:
            continue
        length = 4.3 if bar < 15 else 2.2
        if t0 + length > 57.1:
            length = 57.1 - t0
        strength = 0.05 + 0.05 * min(t0 / 30, 1) if bar < 15 else 0.085
        for i, m in enumerate(PROG[chord_at(bar)]):
            s = tone(midi(m), length, 6, 1.6, 0.0012) + tone(midi(m), length, 6, 1.6, -0.0011)
            e = np.minimum(np.clip(t_arr(length) / 0.9, 0, 1), np.clip((length - t_arr(length)) / 0.6, 0, 1))
            add(send, t0, s * e, pan=(i - 2) * 0.28, gain=strength)

    # Half 1 pulse: a sine sub on eighths, swelling across the 30 s.
    for i in range(int(30 / (BEAT / 2))):
        t0 = i * BEAT / 2
        n = int(0.22 * SR)
        f = midi(ROOTS[chord_at(int(t0 // 2))])
        s = np.sin(2 * np.pi * f * t_arr(0.22)) + 0.25 * np.sin(4 * np.pi * f * t_arr(0.22))
        grow = 0.13 + 0.17 * (t0 / 30)
        accent = 1.0 if i % 2 == 0 else 0.62
        add(dry, t0, s * env(n, 0.006, 0.09), gain=grow * accent)

    # Arpeggio: enters at 7 s, opens brighter over time (more harmonics).
    pattern = [0, 2, 3, 4, 3, 2, 1, 3]
    for i in range(int(50 / 0.25)):
        t0 = 7.0 + i * 0.25
        if t0 >= 29.75 or (t0 >= 30 and t0 >= 57):
            break
        bar = int(t0 // 2)
        step = pattern[i % 8]
        m = PROG[chord_at(bar)][step] + 12
        harmonics = int(3 + 7 * (t0 / 30))
        n = int(0.3 * SR)
        add(send, t0, tone(midi(m), 0.3, harmonics, 1.2) * env(n, 0.003, 0.1), pan=np.sin(i * 0.7) * 0.5, gain=0.06)

    # Half 1 kit: hats from 8 s, soft kick from 16 s.
    for i in range(int(30 / (BEAT / 2))):
        t0 = i * BEAT / 2
        if t0 >= 8 and i % 2 == 1:
            noise = np.diff(rng.standard_normal(int(0.05 * SR) + 1))
            add(dry, t0, noise * env(len(noise), 0.001, 0.012), pan=0.2, gain=0.05 + 0.03 * (t0 / 30))
        if 16 <= t0 < 29.5 and i % 2 == 0:
            add(dry, t0, kick(0.8), gain=0.3 + 0.14 * ((t0 - 16) / 14))

    # Riser into the drop, with a held breath in the last eighth.
    rise_s = 3.0
    n = int(rise_s * SR)
    t = t_arr(rise_s)
    noise = bandpass(rng.standard_normal(n), 1800, 11000)
    shape = (t / rise_s) ** 3
    chirp = np.sin(2 * np.pi * (180 * t + (620 - 180) / (2 * rise_s) * t**2))
    gate = (t < rise_s - 0.25).astype(float)
    add(dry, 27.0, (noise * 0.26 + chirp * 0.1) * shape * gate, gain=0.75)

    # The drop.
    n = int(2.6 * SR)
    crash = bandpass(rng.standard_normal(n), 3000, 15000) * env(n, 0.002, 0.7)
    add(send, 30.0, crash, gain=0.16)
    boom = np.sin(2 * np.pi * 48 * t_arr(1.2) ** 0.92) * env(int(1.2 * SR), 0.003, 0.4)
    add(dry, 30.0, boom, gain=0.62)

    # Half 2: four-on-the-floor kick, off-beat bass, clap on 2 and 4, sixteenth arp.
    for i in range(int(27 / (BEAT / 4))):
        t0 = 30.0 + i * BEAT / 4
        if t0 >= 57:
            break
        beat_pos = i % 8
        bar = int(t0 // 2)
        root = ROOTS[chord_at(bar)]
        if i % 4 == 0:
            add(dry, t0, kick(1.0), gain=0.56)
        if i % 8 == 4:
            n2 = int(0.14 * SR)
            clap = bandpass(rng.standard_normal(n2), 900, 6500) * env(n2, 0.001, 0.04)
            add(send, t0, clap, gain=0.24)
        if beat_pos in (2, 3, 6, 7):
            n3 = int(0.12 * SR)
            add(dry, t0, tone(midi(root + 12), 0.12, 7, 1.15) * env(n3, 0.003, 0.05), gain=0.2)
        if i % 2 == 1:
            noise = np.diff(rng.standard_normal(int(0.04 * SR) + 1))
            add(dry, t0, noise * env(len(noise), 0.001, 0.01), pan=-0.2, gain=0.1)
        step = pattern[i % 8]
        m = PROG[chord_at(bar)][step] + 12 + (12 if t0 > 48 and i % 3 == 0 else 0)
        n4 = int(0.16 * SR)
        add(send, t0, tone(midi(m), 0.16, 9, 1.1) * env(n4, 0.002, 0.05), pan=np.sin(i * 0.9) * 0.6, gain=0.065)

    # Sidechain the sustained bus against the kick so the pulse reads.
    duck = np.ones(N)
    for i in range(int(27 / BEAT)):
        at = int((30.0 + i * BEAT) * SR)
        n5 = int(0.3 * SR)
        duck[at : at + n5] = np.minimum(duck[at : at + n5], 1 - 0.55 * np.exp(-np.arange(n5) / (0.08 * SR)))
    send[:, 0] *= duck
    send[:, 1] *= duck

    # The resolve at 57 s: a wide major chord that rings out before the tail.
    n = int(2.45 * SR)
    for i, m in enumerate([41, 53, 60, 65, 69, 72, 77]):
        s = tone(midi(m), 2.45, 7, 1.4, 0.0009) + tone(midi(m), 2.45, 7, 1.4, -0.0009)
        add(send, 57.0, s * env(n, 0.012, 0.85), pan=(i - 3) * 0.2, gain=0.1)
    add(dry, 57.0, np.sin(2 * np.pi * 43.65 * t_arr(1.6)) * env(int(1.6 * SR), 0.004, 0.5), gain=0.5)
    return dry, send


def kick(strength: float) -> np.ndarray:
    seconds = 0.26
    t = t_arr(seconds)
    phase = 2 * np.pi * (46 * t + (130 - 46) * 0.035 * (1 - np.exp(-t / 0.035)))
    click = np.exp(-t / 0.003) * 0.3
    return (np.sin(phase) * np.exp(-t / 0.085) + click) * strength


def reverb(sig: np.ndarray, seconds: float = 1.4) -> np.ndarray:
    n = int(seconds * SR)
    decay = np.exp(-np.arange(n) / (seconds * SR / 4.5))
    out = np.zeros_like(sig)
    size = sig.shape[0] + n
    for ch in range(2):
        ir = rng.standard_normal(n) * decay
        ir[: int(0.012 * SR)] = 0
        ir /= np.sqrt(np.sum(ir**2))
        out[:, ch] = np.fft.irfft(np.fft.rfft(sig[:, ch], size) * np.fft.rfft(ir, size), size)[: sig.shape[0]]
    return out


# ---- SFX: one frequency band each, so they sit above the music without masking each other --------------------
def sfx_voice(kind: str) -> np.ndarray:
    if kind == "tick":
        t = t_arr(0.05)
        return np.sin(2 * np.pi * 2750 * t) * np.exp(-t / 0.009) * 0.26
    if kind == "whoosh":
        n = int(0.2 * SR)
        s = bandpass(rng.standard_normal(n), 1100, 5200)
        return s * np.sin(np.pi * np.arange(n) / n) ** 2 * 0.15
    if kind == "thud":
        t = t_arr(0.3)
        phase = 2 * np.pi * (58 * t + 75 * 0.04 * (1 - np.exp(-t / 0.04)))
        return np.sin(phase) * np.exp(-t / 0.09) * 0.72
    if kind == "click":
        t = t_arr(0.03)
        return (np.sin(2 * np.pi * 1650 * t) + 0.3 * np.sin(2 * np.pi * 3300 * t)) * np.exp(-t / 0.007) * 0.42
    if kind == "chime":
        t = t_arr(0.9)
        return (np.sin(2 * np.pi * 1568 * t) + 0.75 * np.sin(2 * np.pi * 2349.3 * t) * (t > 0.09)) * np.exp(-t / 0.26) * 0.17
    if kind == "buzz":
        t = t_arr(0.34)
        return np.sign(np.sin(2 * np.pi * 123 * t)) * np.minimum(t / 0.008, 1) * np.exp(-t / 0.17) * 0.17
    if kind == "pass":
        t = t_arr(0.13)
        return (np.sin(2 * np.pi * 3520 * t) + 0.6 * np.sin(2 * np.pi * 5274 * t)) * np.exp(-t / 0.03) * 0.25
    raise ValueError(kind)


def build_sfx() -> np.ndarray:
    buf = np.zeros((N, 2))
    voices: dict[str, np.ndarray] = {}
    for t, kind, _ in E:
        voice = voices.setdefault(kind, sfx_voice(kind))
        add(buf, t, voice)
    return buf


# ---- Mastering ------------------------------------------------------------------------------------------------
def write_wav(path: Path, sig: np.ndarray) -> None:
    data = (np.clip(sig, -1, 1) * 8388607).astype(np.int32)
    raw = data.astype("<i4").tobytes()
    packed = bytearray(len(raw) // 4 * 3)
    packed[0::3], packed[1::3], packed[2::3] = raw[0::4], raw[1::4], raw[2::4]
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(3)
        w.setframerate(SR)
        w.writeframes(bytes(packed))


def true_peak_env(sig: np.ndarray, factor: int = 4) -> np.ndarray:
    n = sig.shape[0]
    out = np.zeros(n * factor)
    for ch in range(2):
        out = np.maximum(out, np.abs(np.fft.irfft(np.fft.rfft(sig[:, ch]), n * factor) * factor))
    return out


def measure(path: Path) -> dict[str, float]:
    cmd = ["npx", "remotion", "ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-af",
           "loudnorm=I=-14:TP=-1:LRA=11:print_format=json", "-f", "wav", "-y", "/dev/null"]
    res = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    match = re.search(r"\{[^{}]*input_i[^{}]*\}", res.stderr + res.stdout, re.S)
    if not match:
        raise RuntimeError("loudnorm gave no JSON:\n" + (res.stderr + res.stdout)[-1500:])
    data = json.loads(match.group(0))
    return {"lufs": float(data["input_i"]), "tp": float(data["input_tp"]), "lra": float(data["input_lra"])}


def limiter_gain(mix: np.ndarray, ceiling: float) -> np.ndarray:
    block = 48
    peaks = true_peak_env(mix)
    count = N // block
    blocks = peaks[: count * block * 4].reshape(count, block * 4).max(axis=1)
    need = np.minimum(1.0, ceiling / np.maximum(blocks, 1e-9))
    hold = 6
    pad = np.pad(need, hold, mode="edge")
    minimum = np.lib.stride_tricks.sliding_window_view(pad, 2 * hold + 1).min(axis=1)
    kernel = np.hanning(2 * hold + 3)
    kernel /= kernel.sum()
    smooth = np.convolve(minimum, kernel, mode="same")
    smooth = np.minimum(smooth, minimum + 0.0)
    return np.interp(np.arange(N), (np.arange(count) + 0.5) * block, smooth)


def timing() -> dict:
    frame = lambda t: int(round(t * FPS))
    return {
        "fps": FPS, "bpm": BPM, "durationInFrames": int(DUR * FPS),
        "beats": [frame(i * BEAT) for i in range(int(DUR / BEAT))],
        "drop": frame(30.0), "lockup": frame(57.0),
        "scenes": {name: {"from": frame(a), "to": frame(b)} for name, a, b in SCENES},
        "cuts": [frame(a) for name, a, b in SCENES],
        "events": [{"t": t, "frame": frame(t), "kind": k, "label": label} for t, k, label in E],
    }


def main() -> int:
    AUDIO.mkdir(parents=True, exist_ok=True)
    dry, send = build_music()
    music = dry + send * 0.82 + reverb(send) * 0.5
    sfx = build_sfx()

    # A short rise from silence, and a clean tail for the editor.
    fade = np.ones(N)
    rise = int(0.5 * SR)
    fade[:rise] = np.sin(np.linspace(0, np.pi / 2, rise)) ** 2
    tail_from, tail_to = int(59.3 * SR), int(59.95 * SR)
    fade[tail_from:tail_to] = np.cos(np.linspace(0, np.pi / 2, tail_to - tail_from)) ** 2
    fade[tail_to:] = 0
    music = (music.T * fade).T
    sfx_fade = fade.copy()
    sfx_fade[:rise] = 1  # the pin thud at 0.5 s must not be faded

    ceiling = 10 ** (CEILING_DBTP / 20)
    # Iterate: gain to the LUFS target, then limit, then re-measure. Stems share the same curve, so they still sum.
    gain = 1.0
    probe = AUDIO / "_probe.wav"
    for _ in range(4):
        mix = (music + sfx) * gain
        g = limiter_gain(mix, ceiling)
        limited = (mix.T * g).T
        write_wav(probe, limited)
        m = measure(probe)
        print(f"gain {gain:.3f} -> {m}", flush=True)
        if abs(m["lufs"] - TARGET_LUFS) < 0.25:
            break
        gain *= 10 ** ((TARGET_LUFS - m["lufs"]) / 20)
    probe.unlink()

    music_out = ((music * gain).T * g).T
    sfx_out = ((sfx * gain).T * g).T
    final = music_out + sfx_out
    write_wav(AUDIO / "mix.wav", final)
    write_wav(AUDIO / "music.wav", music_out)
    write_wav(AUDIO / "sfx.wav", sfx_out)
    tp_linear = true_peak_env(final).max()
    print(f"final true peak (4x): {20 * np.log10(tp_linear):.2f} dBTP")
    print("measured:", measure(AUDIO / "mix.wav"))
    (ROOT / "src" / "timing.json").write_text(json.dumps(timing(), indent=1) + "\n")
    print(f"{len(E)} events")
    return 0


if __name__ == "__main__":
    sys.exit(main())

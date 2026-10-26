"""Prepare ONLY the user-selected matucha recording; no download or synthesis.

First inspect `analyze input.wav`, then audition and specify short source ranges:
`build input.wav --cues reviewed-cues.json`. See docs/AUDIO.md.
Uses only Python's standard library (including on Windows).
"""
from __future__ import annotations

import argparse
from array import array
import hashlib
import json
import math
from pathlib import Path
import sys
import wave

SOURCE = "https://freesound.org/people/matucha/sounds/174056/"
LICENSE = "https://creativecommons.org/licenses/by-nc/4.0/"
ROOT = Path(__file__).resolve().parents[1]
MAX_LENGTH = {"flip": 0.12, "roll": 0.16, "stop": 0.18}


def read_pcm(path: Path) -> tuple[int, int, list[float]]:
    with wave.open(str(path), "rb") as audio:
        channels, width, rate, frames = audio.getparams()[:4]
        if channels not in (1, 2) or width not in (2, 3, 4):
            raise ValueError("Use the original 16/24/32-bit mono/stereo PCM WAV.")
        raw = audio.readframes(frames)
    scale = float(1 << (width * 8 - 1))
    values = [int.from_bytes(raw[i:i + width], "little", signed=True) / scale
              for i in range(0, len(raw), width)]
    if not values:
        raise ValueError("The recording is empty.")
    return rate, channels, values


def analyze(path: Path) -> dict:
    rate, channels, values = read_pcm(path)
    block = max(1, round(rate * 0.005))
    peaks = [max(abs(v) for v in values[i:i + block * channels])
             for i in range(0, len(values), block * channels)]
    threshold = max(peaks) * 0.25
    candidates: list[float] = []
    for i in range(1, len(peaks) - 1):
        time = i * block / rate
        if peaks[i] >= threshold and peaks[i] > peaks[i - 1] and peaks[i] >= peaks[i + 1]:
            if not candidates or time - candidates[-1] >= .05:
                candidates.append(round(time, 4))
    return {"duration": len(values) / channels / rate, "sample_rate": rate,
            "channels": channels, "block_seconds": block / rate,
            "peak_envelope": [round(v, 5) for v in peaks],
            "candidate_transients_seconds": candidates,
            "note": "Candidates only; audition and review ranges before building."}


def prepare_clip(values: list[float], channels: int, rate: int) -> list[float]:
    # Trim silence without cutting the initial transient; leave 1 ms of lead-in.
    frame_peaks = [max(abs(v) for v in values[i:i + channels]) for i in range(0, len(values), channels)]
    peak = max(frame_peaks, default=0)
    if peak < .0001:
        raise ValueError("A selected cue is silent.")
    active = [i for i, v in enumerate(frame_peaks) if v > max(.0001, peak * .012)]
    margin = max(1, round(rate * .001))
    first, last = max(0, active[0] - margin), min(len(frame_peaks), active[-1] + margin + 1)
    clip = values[first * channels:last * channels]
    # Match short-cue RMS while keeping true sample peaks below -3 dBFS.
    rms = math.sqrt(sum(v * v for v in clip) / len(clip))
    gain = min(.18 / rms, 10 ** (-3 / 20) / peak)
    frames = len(clip) // channels
    fade_in, fade_out = max(1, round(rate * .001)), max(1, round(rate * .005))
    for i in range(frames):
        envelope = min(1, i / fade_in, (frames - 1 - i) / fade_out)
        for channel in range(channels):
            index = i * channels + channel
            clip[index] *= gain * envelope
    return clip


def build(source: Path, ranges_path: Path, output: Path) -> dict:
    rate, channels, values = read_pcm(source)
    ranges = json.loads(ranges_path.read_text(encoding="utf-8"))
    if not isinstance(ranges, list) or len([c for c in ranges if c.get("kind") == "flip"]) < 3:
        raise ValueError("Select at least three flip variations and one roll and stop cue.")
    if not {"flip", "roll", "stop"}.issubset(c.get("kind") for c in ranges):
        raise ValueError("The reviewed ranges must include flip, roll and stop.")
    bank: list[float] = []
    cues = []
    duration = len(values) / channels / rate
    for cue in ranges:
        kind, start, end = cue["kind"], cue["start"], cue["end"]
        if kind not in MAX_LENGTH or not (0 <= start < end <= duration):
            raise ValueError(f"Invalid source range: {cue}")
        if end - start > MAX_LENGTH[kind] + .00001:
            raise ValueError(f"{kind} must be at most {MAX_LENGTH[kind]} seconds to follow the 160 ms leaves.")
        clip = prepare_clip(values[round(start * rate) * channels:round(end * rate) * channels], channels, rate)
        cues.append({"kind": kind, "offset": len(bank) / channels / rate,
                     "duration": len(clip) / channels / rate, "source_start": start, "source_end": end})
        bank.extend(clip)
        bank.extend([0.] * round(rate * .025) * channels)
    pcm = array("h", (round(max(-1., min(1., v)) * 32767) for v in bank))
    if sys.byteorder != "little":
        pcm.byteswap()
    output.mkdir(parents=True, exist_ok=True)
    with wave.open(str(output / "pragotron.wav"), "wb") as audio:
        audio.setparams((channels, 2, rate, 0, "NONE", "not compressed"))
        audio.writeframes(pcm.tobytes())
    manifest = {"version": 1, "file": "pragotron.wav", "cues": cues,
                "source": {"title": "pragotron_split-flap-display.wav", "author": "matucha",
                           "url": SOURCE, "license": "CC BY-NC 4.0", "license_url": LICENSE,
                           "sha256": hashlib.sha256(source.read_bytes()).hexdigest()},
                "processing": {"ranges": "reviewed source intervals in cues", "silence_trim": "relative -38 dB, 1 ms margins",
                               "fade_in_ms": 1, "fade_out_ms": 5, "target_rms": .18, "peak_ceiling_dbfs": -3,
                               "format": "16-bit PCM, original channel count and sample rate", "guard_ms": 25}}
    (output / "pragotron.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["analyze", "build"])
    parser.add_argument("source", type=Path)
    parser.add_argument("--cues", type=Path, help="JSON list of reviewed {kind,start,end} ranges in seconds")
    parser.add_argument("--output", type=Path, default=ROOT / "frontend/public/audio")
    args = parser.parse_args()
    try:
        if args.action == "analyze":
            result = analyze(args.source)
        else:
            if args.cues is None:
                parser.error("build requires --cues with auditioned source ranges")
            result = build(args.source, args.cues, args.output)
        print(json.dumps(result, indent=2, ensure_ascii=False))
    except (ValueError, OSError, wave.Error) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()

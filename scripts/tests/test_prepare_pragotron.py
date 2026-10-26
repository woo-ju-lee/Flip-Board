"""Processing checks use test-only impulses, never a substitute production recording."""
import importlib.util
import json
from pathlib import Path
import struct
import wave

import pytest

spec = importlib.util.spec_from_file_location("prepare_pragotron", Path(__file__).parents[1] / "prepare_pragotron.py")
audio = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audio)


def test_24_bit_stereo_preserves_polarity_and_channels(tmp_path):
    source = tmp_path / "test.wav"
    values = [0, 0, 4194304, -4194304, 8388607, -8388608]
    with wave.open(str(source), "wb") as wav:
        wav.setparams((2, 3, 44100, 0, "NONE", "not compressed"))
        wav.writeframes(b"".join(value.to_bytes(3, "little", signed=True) for value in values))
    rate, channels, decoded = audio.read_pcm(source)
    assert (rate, channels) == (44100, 2)
    assert decoded[2:4] == [.5, -.5]
    assert decoded[-1] == -1


def test_fades_trim_and_peak_headroom():
    result = audio.prepare_clip([0.] * 100 + [.9, -.9] * 100 + [0.] * 100, 1, 10000)
    assert len(result) < 400
    assert result[0] == result[-1] == 0
    assert max(abs(v) for v in result) <= 10 ** (-3 / 20)
    with pytest.raises(ValueError, match="silent"):
        audio.prepare_clip([0.] * 100, 1, 10000)


def test_sprite_offsets_license_and_source_hash_are_reproducible(tmp_path):
    source = tmp_path / "test-only.wav"
    with wave.open(str(source), "wb") as wav:
        wav.setparams((1, 2, 10000, 0, "NONE", "not compressed"))
        wav.writeframes(struct.pack("<10000h", *([10000, -10000] * 5000)))
    ranges = [{"kind": kind, "start": i * .1, "end": i * .1 + .05}
              for i, kind in enumerate(["flip", "flip", "flip", "roll", "stop"])]
    cue_file = tmp_path / "cues.json"
    cue_file.write_text(json.dumps(ranges))
    manifest = audio.build(source, cue_file, tmp_path / "out")
    assert manifest["source"]["author"] == "matucha"
    assert manifest["source"]["license"] == "CC BY-NC 4.0"
    assert len(manifest["source"]["sha256"]) == 64
    with wave.open(str(tmp_path / "out/pragotron.wav"), "rb") as wav:
        duration = wav.getnframes() / wav.getframerate()
        assert wav.getsampwidth() == 2
    for cue in manifest["cues"]:
        assert 0 <= cue["offset"] < cue["offset"] + cue["duration"] <= duration
    assert audio.build(source, cue_file, tmp_path / "other") == manifest
    ranges[-1]["end"] = 2
    cue_file.write_text(json.dumps(ranges))
    with pytest.raises(ValueError, match="Invalid source range"):
        audio.build(source, cue_file, tmp_path / "invalid")

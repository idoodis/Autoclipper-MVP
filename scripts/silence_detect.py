"""Energy-based deadspace detector that produces an editable timeline.

The previous implementation relied on WebRTC VAD which was fairly binary and
was prone to trimming useful low-energy speech.  This module analyses PCM16
audio using simple frame energy statistics combined with pause heuristics.  It
returns a timeline describing the alternating keep/drop regions so downstream
stages (ffmpeg, caption alignment, etc.) can consume the results programmatically.

The module is both CLI-friendly and importable for unit tests.
"""

from __future__ import annotations

import argparse
import json
import wave
from array import array
from dataclasses import dataclass
from typing import Iterable, List, Sequence


# Frame analysis constants.  The 30ms frame size matches the prior VAD and keeps
# the per-frame calculations inexpensive while still being sensitive to short
# pauses.  Durations are expressed in milliseconds for readability.
FRAME_MS = 30
MIN_SPEECH_MS = 200
MIN_PAUSE_MS = 350
PADDING_MS = 80


@dataclass
class Region:
    start: float
    end: float

    def clamp(self, floor: float, ceil: float) -> "Region":
        return Region(max(self.start, floor), min(self.end, ceil))


def read_pcm16(path: str) -> tuple[bytes, int]:
    """Read a mono PCM16 WAV file returning raw bytes and the sample rate."""

    with wave.open(path, "rb") as wav:
        if wav.getsampwidth() != 2 or wav.getnchannels() != 1:
            raise ValueError("Expected mono PCM16 WAV input")
        rate = wav.getframerate()
        audio = wav.readframes(wav.getnframes())
    return audio, rate


def _frame_energy(samples: Sequence[int]) -> float:
    if not samples:
        return 0.0
    return sum(sample * sample for sample in samples) / float(len(samples))


def _frame_generator(audio: bytes, rate: int, frame_samples: int) -> Iterable[Region]:
    pcm = array("h")
    pcm.frombytes(audio)
    total_samples = len(pcm)
    for index in range(0, total_samples, frame_samples):
        frame = pcm[index : index + frame_samples]
        if not frame:
            break
        start = index / rate
        duration = len(frame) / rate
        yield Region(start=start, end=start + duration)


def _compute_frame_energies(audio: bytes, rate: int) -> list[tuple[Region, float]]:
    frame_samples = max(1, int(rate * FRAME_MS / 1000))
    energies: list[tuple[Region, float]] = []
    pcm = array("h")
    pcm.frombytes(audio)
    for frame_index, region in enumerate(_frame_generator(audio, rate, frame_samples)):
        start_sample = frame_index * frame_samples
        frame = pcm[start_sample : start_sample + frame_samples]
        energies.append((region, _frame_energy(frame)))
    return energies


def _adaptive_threshold(energies: Sequence[float]) -> float:
    """Compute a simple adaptive energy threshold using distribution percentiles."""

    if not energies:
        return 0.0
    sorted_values = sorted(energies)
    if sorted_values[-1] <= 0:
        return 0.0
    def percentile(index: float) -> float:
        pos = int(len(sorted_values) * index)
        return sorted_values[min(max(pos, 0), len(sorted_values) - 1)]

    noise = percentile(0.2)
    speech = percentile(0.9)
    if speech <= noise:
        return max(noise * 0.6, noise + 1.0)
    return max(noise * 1.2, noise + (speech - noise) * 0.2)


def _detect_keep_regions(energies: List[tuple[Region, float]], threshold: float) -> list[Region]:
    speech_frames = max(1, int(MIN_SPEECH_MS / FRAME_MS))
    pause_frames = max(1, int(MIN_PAUSE_MS / FRAME_MS))
    pad = PADDING_MS / 1000.0

    keep: list[Region] = []
    in_speech = False
    speech_run = 0
    silence_run = 0
    region_start = 0.0

    for idx, (region, energy) in enumerate(energies):
        is_voiced = energy > threshold
        if is_voiced:
            speech_run += 1
            silence_run = 0
            if not in_speech and speech_run >= speech_frames:
                in_speech = True
                first_voiced_region = energies[idx - speech_frames + 1][0]
                region_start = max(0.0, first_voiced_region.start - pad)
        else:
            speech_run = 0
            if in_speech:
                silence_run += 1
                if silence_run >= pause_frames:
                    end_region = energies[idx - pause_frames][0]
                    keep.append(
                        Region(start=region_start, end=end_region.end + pad)
                    )
                    in_speech = False
                    silence_run = 0
        # No state changes if we're outside a voiced span.

    if in_speech and energies:
        last_region = energies[-1][0]
        keep.append(Region(start=region_start, end=last_region.end + pad))

    # Merge overlapping or adjacent regions that padding may have introduced.
    merged: list[Region] = []
    for region in keep:
        if not merged:
            merged.append(region)
            continue
        prev = merged[-1]
        if region.start <= prev.end + 0.02:  # allow tiny gaps
            merged[-1] = Region(start=prev.start, end=max(prev.end, region.end))
        else:
            merged.append(region)
    return merged


def _build_regions(keep: Sequence[Region], duration: float) -> list[dict[str, float | str]]:
    timeline: list[dict[str, float | str]] = []
    cursor = 0.0
    for region in keep:
        if region.start > cursor:
            drop_region = Region(start=cursor, end=region.start).clamp(0.0, duration)
            if drop_region.end - drop_region.start > 1e-3:
                timeline.append(
                    {
                        "type": "drop",
                        "start": round(drop_region.start, 3),
                        "end": round(drop_region.end, 3),
                    }
                )
        keep_region = region.clamp(0.0, duration)
        if keep_region.end - keep_region.start > 1e-3:
            timeline.append(
                {
                    "type": "keep",
                    "start": round(keep_region.start, 3),
                    "end": round(keep_region.end, 3),
                }
            )
        cursor = max(cursor, region.end)
    if cursor < duration:
        tail = Region(start=cursor, end=duration)
        if tail.end - tail.start > 1e-3:
            timeline.append(
                {
                    "type": "drop",
                    "start": round(tail.start, 3),
                    "end": round(tail.end, 3),
                }
            )
    return timeline


def analyze_pcm16(audio: bytes, rate: int) -> dict:
    energies = _compute_frame_energies(audio, rate)
    threshold = _adaptive_threshold([energy for _, energy in energies])
    keep_regions = _detect_keep_regions(energies, threshold)
    duration = len(audio) / 2 / rate if rate else 0.0
    clamped_keep = [region.clamp(0.0, duration) for region in keep_regions]
    timeline = _build_regions(clamped_keep, duration)
    keep_payload = [
        {"start": round(region.start, 3), "end": round(region.end, 3)}
        for region in clamped_keep
        if region.end - region.start > 1e-3
    ]
    return {
        "frame_ms": FRAME_MS,
        "min_speech_ms": MIN_SPEECH_MS,
        "min_pause_ms": MIN_PAUSE_MS,
        "padding_ms": PADDING_MS,
        "threshold": threshold,
        "duration": round(duration, 3),
        "keep": keep_payload,
        "regions": timeline,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True, help="PCM16 mono WAV file")
    parser.add_argument("--out", required=True, help="Timeline JSON output path")
    args = parser.parse_args()

    audio, rate = read_pcm16(args.audio)
    timeline = analyze_pcm16(audio, rate)

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(timeline, f, indent=2)
    print("Wrote", args.out)


if __name__ == "__main__":
    main()

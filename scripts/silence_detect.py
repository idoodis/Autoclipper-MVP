import argparse
import audioop
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List

import wave


DEFAULT_FRAME_MS = 30
MAX_GAP_SECONDS = 0.45
SPEECH_PAD_SECONDS = 0.18
MIN_SEGMENT_SECONDS = 0.75
MAX_OUTPUT_SECONDS = 58.5
ENERGY_FLOOR = 300


@dataclass
class Frame:
    data: bytes
    timestamp: float
    duration: float
    energy: float


@dataclass
class Segment:
    start: float
    end: float
    score: float

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)


def read_pcm16(path: Path) -> tuple[bytes, int]:
    with wave.open(str(path), "rb") as w:
        if w.getsampwidth() != 2 or w.getnchannels() != 1:
            raise ValueError("Audio must be 16-bit mono PCM")
        rate = w.getframerate()
        frames = w.readframes(w.getnframes())
    return frames, rate


def generate_frames(audio: bytes, rate: int, frame_ms: int) -> Iterable[Frame]:
    frame_bytes = int(rate * frame_ms / 1000) * 2
    if frame_bytes <= 0:
        raise ValueError("Invalid frame size")

    for index in range(0, len(audio) - frame_bytes + 1, frame_bytes):
        chunk = audio[index : index + frame_bytes]
        timestamp = index / 2 / rate
        duration = frame_ms / 1000.0
        energy = audioop.rms(chunk, 2)
        yield Frame(data=chunk, timestamp=timestamp, duration=duration, energy=energy)


def compute_energy_threshold(frames: List[Frame]) -> float:
    if not frames:
        return 0.0

    energies = [frame.energy for frame in frames if frame.energy > 0]
    if not energies:
        return 0.0

    sorted_energies = sorted(energies)
    percentile_index = max(0, min(len(sorted_energies) - 1, int(len(sorted_energies) * 0.2)))
    noise_floor = sorted_energies[percentile_index]
    max_energy = sorted_energies[-1]
    threshold = max(noise_floor * 2.5, max_energy * 0.12, ENERGY_FLOOR)
    return threshold


def collect_segments(frames: List[Frame], energy_threshold: float) -> List[Segment]:
    segments: List[Segment] = []
    current_start = None
    current_energy = 0.0
    current_frames = 0
    last_voice_time = None
    gap = 0.0

    for frame in frames:
        is_voiced = frame.energy >= energy_threshold
        if is_voiced:
            if current_start is None:
                current_start = frame.timestamp
            gap = 0.0
            last_voice_time = frame.timestamp + frame.duration
            current_energy += frame.energy
            current_frames += 1
        else:
            if current_start is None:
                continue
            gap += frame.duration
            if gap < MAX_GAP_SECONDS:
                continue

            end_time = last_voice_time if last_voice_time is not None else frame.timestamp
            duration = max(0.0, end_time - current_start)
            if duration >= MIN_SEGMENT_SECONDS:
                avg_energy = current_energy / max(1, current_frames)
                segments.append(Segment(start=current_start, end=end_time, score=avg_energy))
            current_start = None
            current_energy = 0.0
            current_frames = 0
            last_voice_time = None
            gap = 0.0

    if current_start is not None and last_voice_time is not None:
        duration = max(0.0, last_voice_time - current_start)
        if duration >= MIN_SEGMENT_SECONDS:
            avg_energy = current_energy / max(1, current_frames)
            segments.append(Segment(start=current_start, end=last_voice_time, score=avg_energy))

    return segments


def apply_padding(segments: Iterable[Segment], audio_duration: float) -> List[Segment]:
    padded: List[Segment] = []
    for seg in segments:
        start = max(0.0, seg.start - SPEECH_PAD_SECONDS)
        end = min(audio_duration, seg.end + SPEECH_PAD_SECONDS)
        padded.append(Segment(start=start, end=end, score=seg.score))
    return merge_segments(padded)


def merge_segments(segments: Iterable[Segment]) -> List[Segment]:
    sorted_segments = sorted(segments, key=lambda s: s.start)
    if not sorted_segments:
        return []

    merged: List[Segment] = [sorted_segments[0]]
    for seg in sorted_segments[1:]:
        prev = merged[-1]
        if seg.start <= prev.end + 0.2:
            combined_duration = max(prev.end, seg.end) - prev.start
            combined_score = max(prev.score, seg.score)
            merged[-1] = Segment(start=prev.start, end=max(prev.end, seg.end), score=combined_score)
        else:
            merged.append(seg)
    return merged


def select_highlights(segments: Iterable[Segment]) -> List[Segment]:
    ranked = sorted(segments, key=lambda s: (s.score, s.duration), reverse=True)
    selected: List[Segment] = []
    used = 0.0
    for seg in ranked:
        if seg.duration < MIN_SEGMENT_SECONDS:
            continue
        if used >= MAX_OUTPUT_SECONDS:
            break
        remaining = MAX_OUTPUT_SECONDS - used
        if seg.duration <= remaining:
            selected.append(seg)
            used += seg.duration
        else:
            selected.append(Segment(start=seg.start, end=seg.start + remaining, score=seg.score))
            used = MAX_OUTPUT_SECONDS
            break

    selected.sort(key=lambda s: s.start)
    return selected


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--frame-ms", type=int, default=DEFAULT_FRAME_MS)
    args = parser.parse_args()

    audio_path = Path(args.audio)
    out_path = Path(args.out)
    audio, rate = read_pcm16(audio_path)
    duration = len(audio) / 2 / rate

    frames = list(generate_frames(audio, rate, args.frame_ms))
    energy_threshold = compute_energy_threshold(frames)
    raw_segments = collect_segments(frames, energy_threshold)
    padded_segments = apply_padding(raw_segments, duration)
    keep_segments = select_highlights(padded_segments)
    if not keep_segments and padded_segments:
        keep_segments = [padded_segments[0]]

    timeline = {
        "duration": duration,
        "keep": [
            {
                "start": round(seg.start, 3),
                "end": round(seg.end, 3),
                "score": round(seg.score, 3),
            }
            for seg in keep_segments
        ],
        "candidates": [
            {
                "start": round(seg.start, 3),
                "end": round(seg.end, 3),
                "score": round(seg.score, 3),
            }
            for seg in padded_segments
        ],
        "parameters": {
            "frame_ms": args.frame_ms,
            "max_gap_seconds": MAX_GAP_SECONDS,
            "speech_pad_seconds": SPEECH_PAD_SECONDS,
            "max_output_seconds": MAX_OUTPUT_SECONDS,
        },
    }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(timeline, indent=2), encoding="utf-8")
    print("Wrote", out_path)


if __name__ == "__main__":
    main()

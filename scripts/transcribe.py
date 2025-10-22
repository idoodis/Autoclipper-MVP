import argparse
import audioop
import statistics
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Optional

try:
    from faster_whisper import WhisperModel  # type: ignore
except ImportError:  # pragma: no cover - optional dependency
    WhisperModel = None


DEFAULT_MODEL_NAME = "base"


@dataclass
class CaptionSegment:
    index: int
    start: float
    end: float
    text: str


def format_timestamp(value: float) -> str:
    total_ms = int(round(value * 1000))
    hours, remainder = divmod(total_ms, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds, milliseconds = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{milliseconds:03d}"


def write_srt(path: Path, segments: Iterable[CaptionSegment]) -> None:
    lines = []
    for seg in segments:
        text = seg.text.strip()
        if not text:
            continue
        start_ts = format_timestamp(seg.start)
        end_ts = format_timestamp(seg.end)
        lines.append(f"{seg.index}")
        lines.append(f"{start_ts} --> {end_ts}")
        lines.append(text)
        lines.append("")

    data = "\n".join(lines).strip() + "\n"
    path.write_text(data, encoding="utf-8")


def read_pcm_frames(path: Path, frame_ms: int = 30) -> tuple[List[bytes], int]:
    with wave.open(str(path), "rb") as wav:
        if wav.getsampwidth() != 2 or wav.getnchannels() != 1:
            raise ValueError("Audio must be 16-bit mono PCM for fallback transcription")
        rate = wav.getframerate()
        frame_count = int(rate * frame_ms / 1000)
        frame_bytes = frame_count * wav.getsampwidth()
        frames: List[bytes] = []
        raw = wav.readframes(wav.getnframes())
        for index in range(0, len(raw) - frame_bytes + 1, frame_bytes):
            frames.append(raw[index : index + frame_bytes])
    return frames, rate


def describe_energy(level: float, variance: float) -> str:
    if level > 0.85:
        return "Explosive moment"
    if level > 0.65:
        return "High-energy highlight"
    if level > 0.45:
        return "Energetic beat"
    if level > 0.3:
        return "Spoken passage"
    if variance > 0.08:
        return "Dynamic ambience"
    return "Quiet ambience"


def fallback_transcribe(audio_path: Path) -> list[CaptionSegment]:
    frames, rate = read_pcm_frames(audio_path)
    if not frames:
        return []

    energies = [audioop.rms(frame, 2) for frame in frames]
    max_energy = max(energies) or 1
    mean_energy = statistics.fmean(energies)
    stdev_energy = statistics.pstdev(energies) if len(energies) > 1 else 0.0
    threshold = max(int(mean_energy * 0.75), int(max_energy * 0.18), 180)

    segments: list[CaptionSegment] = []
    frame_duration = len(frames[0]) / 2 / rate
    start_idx: Optional[int] = None
    accumulator: List[int] = []

    for idx, energy in enumerate(energies):
        if energy >= threshold:
            if start_idx is None:
                start_idx = idx
                accumulator = []
            accumulator.append(energy)
        else:
            if start_idx is not None:
                end_idx = idx
                start_time = start_idx * frame_duration
                end_time = end_idx * frame_duration
                if end_time - start_time >= 0.45:
                    local_mean = statistics.fmean(accumulator) if accumulator else mean_energy
                    level = min(1.0, local_mean / max_energy)
                    variance = stdev_energy / max(mean_energy, 1e-6)
                    text = describe_energy(level, variance)
                    segments.append(
                        CaptionSegment(
                            index=len(segments) + 1,
                            start=start_time,
                            end=end_time,
                            text=text,
                        )
                    )
                start_idx = None
                accumulator = []

    if start_idx is not None:
        start_time = start_idx * frame_duration
        end_time = len(frames) * frame_duration
        if end_time - start_time >= 0.45:
            local_mean = statistics.fmean(accumulator) if accumulator else mean_energy
            level = min(1.0, local_mean / max_energy)
            variance = stdev_energy / max(mean_energy, 1e-6)
            text = describe_energy(level, variance)
            segments.append(
                CaptionSegment(
                    index=len(segments) + 1,
                    start=start_time,
                    end=end_time,
                    text=text,
                )
            )

    if not segments:
        text = describe_energy(min(1.0, mean_energy / max_energy), stdev_energy / max(mean_energy, 1e-6))
        segments.append(
            CaptionSegment(index=1, start=0.0, end=len(frames) * frame_duration, text=text)
        )

    return segments


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--srt", required=True)
    parser.add_argument("--model", default=DEFAULT_MODEL_NAME)
    parser.add_argument("--device", default="cpu")
    args = parser.parse_args()

    captions: list[CaptionSegment]

    if WhisperModel is None:
        print(
            "Warning: faster-whisper not available, using energy-based descriptive captions. Install faster-whisper for speech-to-text.",
        )
        captions = fallback_transcribe(Path(args.audio))
    else:
        model = WhisperModel(
            args.model,
            device=args.device,
            compute_type="int8" if args.device == "cpu" else "float16",
        )
        segments, _ = model.transcribe(
            args.audio,
            vad_filter=True,
            without_timestamps=False,
        )

        captions = [
            CaptionSegment(index=i + 1, start=segment.start, end=segment.end, text=segment.text or "")
            for i, segment in enumerate(segments)
        ]

    srt_path = Path(args.srt)
    srt_path.parent.mkdir(parents=True, exist_ok=True)
    write_srt(srt_path, captions)
    print("Wrote", srt_path)


if __name__ == "__main__":
    main()

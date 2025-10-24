import argparse
import json
import math
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List

try:
    from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer  # type: ignore
except ImportError:  # pragma: no cover - optional dependency
    SentimentIntensityAnalyzer = None

EXCITED_WORDS = {
    "amazing",
    "awesome",
    "crazy",
    "epic",
    "excited",
    "fantastic",
    "huge",
    "incredible",
    "insane",
    "massive",
    "shocking",
    "unbelievable",
    "wild",
    "wow",
}

HOOK_PHRASES = {
    "how to",
    "here's",
    "listen",
    "the secret",
    "this is why",
    "did you know",
    "let me tell",
    "you won't believe",
    "step by step",
}

EMPHASIS_WORDS = {
    "must",
    "need",
    "critical",
    "perfect",
    "professional",
    "viral",
    "breakthrough",
    "pro tip",
    "story",
    "insight",
    "strategy",
    "hook",
}

STOP_WORDS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "but",
    "by",
    "for",
    "from",
    "i",
    "in",
    "is",
    "it",
    "of",
    "on",
    "or",
    "so",
    "that",
    "the",
    "this",
    "to",
    "we",
    "you",
}


@dataclass
class Caption:
    start: float
    end: float
    text: str

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)


@dataclass
class Segment:
    start: float
    end: float
    energy: float
    score: float = 0.0
    reasons: dict | None = None

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)


def parse_timestamp(value: str) -> float:
    hours, minutes, rest = value.split(':')
    seconds, millis = rest.split(',')
    return int(hours) * 3600 + int(minutes) * 60 + int(seconds) + int(millis) / 1000


def load_captions(path: Path) -> List[Caption]:
    if not path.exists():
        return []
    content = path.read_text(encoding="utf-8", errors="ignore")
    lines = [line.strip() for line in content.splitlines() if line.strip()]
    captions: List[Caption] = []
    i = 0
    while i < len(lines):
        if '-->' in lines[i]:
            start_str, end_str = [part.strip() for part in lines[i].split('-->')]
            start = parse_timestamp(start_str)
            end = parse_timestamp(end_str)
            i += 1
            text_lines: List[str] = []
            while i < len(lines) and '-->' not in lines[i] and not lines[i].isdigit():
                text_lines.append(lines[i])
                i += 1
            captions.append(Caption(start=start, end=end, text=' '.join(text_lines)))
        else:
            i += 1
    return captions


def collect_words(text: str) -> List[str]:
    cleaned = ''.join(ch.lower() if ch.isalnum() else ' ' for ch in text)
    words = [word for word in cleaned.split() if word and word not in STOP_WORDS]
    return words


def overlap(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    return max(0.0, min(a_end, b_end) - max(a_start, b_start))


def captions_for_segment(segment: Segment, captions: Iterable[Caption]) -> List[Caption]:
    window = []
    for caption in captions:
        if caption.end < segment.start - 0.25:
            continue
        if caption.start > segment.end + 0.25:
            break
        if overlap(segment.start, segment.end, caption.start, caption.end) > 0:
            window.append(caption)
    return window


def normalize(value: float, values: List[float]) -> float:
    if not values:
        return 0.0
    max_value = max(values)
    min_value = min(values)
    if math.isclose(max_value, min_value):
        return 0.0
    return (value - min_value) / max(1e-6, max_value - min_value)


def refine_segment(segment: Segment, captions: List[Caption]) -> Segment:
    if not captions:
        return segment
    start = min(caption.start for caption in captions)
    end = max(caption.end for caption in captions)
    start = max(0.0, start - 0.15)
    end = max(start + 0.1, end + 0.15)
    return Segment(start=start, end=end, energy=segment.energy)


def score_segments(
    segments: List[Segment], captions: List[Caption], max_duration: float
) -> tuple[List[Segment], List[Segment]]:
    if not segments:
        return [], []

    energy_values = [segment.energy for segment in segments]
    analyzer = SentimentIntensityAnalyzer() if SentimentIntensityAnalyzer else None

    windows: List[tuple[Segment, Segment, List[Caption], str, List[str], Counter[str]]] = []
    document_frequency: Counter[str] = Counter()
    for segment in segments:
        window = captions_for_segment(segment, captions)
        refined = refine_segment(segment, window)
        text = ' '.join(caption.text for caption in window).strip()
        words = collect_words(text)
        word_counts: Counter[str] = Counter(words)
        if word_counts:
            document_frequency.update(word_counts.keys())
        windows.append((segment, refined, window, text, words, word_counts))

    total_docs = max(len(windows), 1)
    tfidf_totals: List[float] = []
    for _, _, _, _, words, counts in windows:
        if not counts:
            tfidf_totals.append(0.0)
            continue
        total_words = max(len(words), 1)
        score = 0.0
        for word, count in counts.items():
            idf = math.log((total_docs + 1) / (document_frequency[word] + 1)) + 1.0
            score += (count / total_words) * idf
        tfidf_totals.append(score)

    word_sets = [set(words) for _, _, _, _, words, _ in windows]
    context_overlap: List[float] = []
    for index, current in enumerate(word_sets):
        if not current:
            context_overlap.append(0.0)
            continue
        neighbors = []
        if index > 0:
            neighbors.append(word_sets[index - 1])
        if index + 1 < len(word_sets):
            neighbors.append(word_sets[index + 1])
        if not neighbors:
            context_overlap.append(0.8)
            continue
        combined = set().union(*neighbors)
        if not combined:
            context_overlap.append(0.8)
            continue
        overlap = len(current & combined) / max(len(current | combined), 1)
        context_overlap.append(overlap)

    scored: List[Segment] = []
    for idx, (segment, refined, window, text, words, counts) in enumerate(windows):
        unique_words = set(words)
        speech_duration = sum(caption.duration for caption in window)
        coverage = speech_duration / max(refined.duration, 1e-6)
        words_per_second = len(words) / max(refined.duration, 1e-6)
        lexical_density = len(unique_words) / max(len(words), 1) if words else 0.0
        excitement_hits = sum(1 for word in words if word in EXCITED_WORDS)
        emphasis_hits = sum(1 for phrase in EMPHASIS_WORDS if phrase in text.lower())
        hook_hits = sum(1 for phrase in HOOK_PHRASES if phrase in text.lower())
        is_question = text.strip().endswith('?')
        sentiment = analyzer.polarity_scores(text)['compound'] if analyzer and text else 0.0
        punctuation = text.count('!') * 0.15 + text.count('?') * 0.1
        energy_component = normalize(segment.energy, energy_values)
        pacing_component = min(words_per_second / 3.0, 1.2)
        lexical_component = min(lexical_density + 0.2, 1.2)
        tfidf_component = min(normalize(tfidf_totals[idx], tfidf_totals) + 0.05, 1.3)
        context_component = min(0.5 + context_overlap[idx] * 0.4, 1.1)
        impact_component = min(excitement_hits * 0.25 + emphasis_hits * 0.2 + punctuation, 1.3)
        excitement_multiplier = 1.0 + min(excitement_hits * 0.18 + emphasis_hits * 0.12 + punctuation, 1.6)
        sentiment_multiplier = 1.0 + min(abs(sentiment) * 0.6, 0.6)
        novelty_multiplier = 1.0 + min(tfidf_component * 0.25, 0.4)
        hook_boost = min(hook_hits * 0.25 + (0.2 if is_question else 0.0), 0.8)
        storytelling_component = min(coverage * 0.6 + hook_boost + lexical_component * 0.3, 1.5)
        coverage_component = min(coverage + 0.1, 1.3)
        base_score = (
            energy_component * 0.35
            + coverage_component * 0.2
            + lexical_component * 0.1
            + pacing_component * 0.1
            + storytelling_component * 0.08
            + tfidf_component * 0.06
            + context_component * 0.06
            + impact_component * 0.05
        )
        final_score = (
            base_score * excitement_multiplier * sentiment_multiplier * novelty_multiplier
            + hook_boost * 0.5
        )
        scored.append(
            Segment(
                start=refined.start,
                end=min(refined.end, refined.start + max_duration),
                energy=segment.energy,
                score=final_score,
                reasons={
                    "energy": round(energy_component, 3),
                    "coverage": round(coverage_component, 3),
                    "lexical_density": round(lexical_component, 3),
                    "pacing": round(pacing_component, 3),
                    "tfidf": round(tfidf_component, 3),
                    "context": round(context_component, 3),
                    "impact": round(impact_component, 3),
                    "excitement_multiplier": round(excitement_multiplier, 3),
                    "novelty_multiplier": round(novelty_multiplier, 3),
                    "sentiment": round(sentiment, 3),
                    "storytelling": round(storytelling_component, 3),
                    "hook_boost": round(hook_boost, 3),
                    "words": len(words),
                },
            )
        )

    ranked = sorted(scored, key=lambda seg: seg.score, reverse=True)
    selected: List[Segment] = []
    total = 0.0
    for segment in ranked:
        if segment.duration < 0.4:
            continue
        remaining = max_duration - total
        if remaining <= 0:
            break
        if segment.duration <= remaining + 0.05:
            selected.append(segment)
            total += segment.duration
        else:
            selected.append(
                Segment(
                    start=segment.start,
                    end=segment.start + remaining,
                    energy=segment.energy,
                    score=segment.score,
                    reasons=segment.reasons,
                )
            )
            total = max_duration
            break

    selected.sort(key=lambda seg: seg.start)
    return selected, ranked


def build_variants(ranked: List[Segment], max_duration: float, limit: int) -> List[List[Segment]]:
    variants: List[List[Segment]] = []
    if limit <= 0:
        return variants

    used_keys: set[tuple[float, float]] = set()
    for anchor_idx, anchor in enumerate(ranked):
        if anchor.duration < 0.4:
            continue
        timeline: List[Segment] = []
        total = 0.0
        for candidate in ranked[anchor_idx:]:
            if candidate.duration < 0.35:
                continue
            if (round(candidate.start, 2), round(candidate.end, 2)) in used_keys and candidate is not anchor:
                continue
            remaining = max_duration - total
            if remaining <= 0:
                break
            if candidate.duration <= remaining + 0.05:
                clipped = candidate
                total += candidate.duration
            else:
                clipped = Segment(
                    start=candidate.start,
                    end=candidate.start + remaining,
                    energy=candidate.energy,
                    score=candidate.score,
                    reasons=candidate.reasons,
                )
                total = max_duration
            timeline.append(clipped)
            used_keys.add((round(clipped.start, 2), round(clipped.end, 2)))
            if total >= max_duration - 0.05:
                break

        if timeline:
            variants.append(sorted(timeline, key=lambda seg: seg.start))
        if len(variants) >= limit:
            break

    return variants


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--timeline', required=True)
    parser.add_argument('--captions', required=True)
    parser.add_argument('--out', default=None)
    parser.add_argument('--max-duration', type=float, default=59.0)
    parser.add_argument('--max-variants', type=int, default=3)
    args = parser.parse_args()

    timeline_path = Path(args.timeline)
    out_path = Path(args.out) if args.out else timeline_path
    if not timeline_path.exists():
        raise FileNotFoundError(f'Timeline not found at {timeline_path}')

    data = json.loads(timeline_path.read_text(encoding='utf-8'))
    raw_segments = data.get('candidates') or data.get('keep') or []
    segments = [
        Segment(
            start=float(segment.get('start', 0.0)),
            end=float(segment.get('end', 0.0)),
            energy=float(segment.get('score', 0.0)),
        )
        for segment in raw_segments
        if segment.get('end', 0.0) > segment.get('start', 0.0)
    ]

    captions = load_captions(Path(args.captions))
    selected, ranked = score_segments(segments, captions, max_duration=float(args.max_duration))

    if not selected and segments:
        selected = segments[:1]

    def serialize(segment: Segment) -> dict:
        return {
            'start': round(segment.start, 3),
            'end': round(segment.end, 3),
            'score': round(segment.score, 3),
            'energy': round(segment.energy, 3),
            'reasons': segment.reasons,
        }

    combined_candidates = { (round(seg.start, 3), round(seg.end, 3)): seg for seg in segments }
    for seg in selected:
        combined_candidates[(round(seg.start, 3), round(seg.end, 3))] = seg

    variant_sequences = build_variants(ranked, max_duration=float(args.max_duration), limit=max(1, int(args.max_variants)))

    serialized_variants = []
    for index, seq in enumerate(variant_sequences, start=1):
        serialized_variants.append(
            {
                'id': f'variant-{index}',
                'score': round(sum(seg.score for seg in seq) / max(len(seq), 1), 3),
                'duration': round(sum(seg.duration for seg in seq), 3),
                'keep': [serialize(seg) for seg in seq],
            }
        )

    output = {
        **data,
        'keep': [serialize(seg) for seg in selected],
        'candidates': [serialize(seg) for seg in sorted(combined_candidates.values(), key=lambda s: s.start)],
        'parameters': {
            **(data.get('parameters') or {}),
            'highlight_ranking': {
                'max_duration': float(args.max_duration),
                'caption_count': len(captions),
                'variants': len(serialized_variants),
            },
        },
        'variants': serialized_variants,
    }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(output, indent=2), encoding='utf-8')
    print('Refined timeline saved to', out_path)


if __name__ == '__main__':
    main()

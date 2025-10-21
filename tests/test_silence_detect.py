import unittest
from array import array

from scripts.silence_detect import (
    MIN_PAUSE_MS,
    PADDING_MS,
    analyze_pcm16,
)


SAMPLE_RATE = 16000


def build_sectioned_audio(sections):
    pcm = array("h")
    for duration, amplitude in sections:
        samples = int(duration * SAMPLE_RATE)
        pcm.extend(int(amplitude) for _ in range(samples))
    return pcm.tobytes()


class SilenceDetectTests(unittest.TestCase):
    def test_detects_primary_keep_region(self):
        audio = build_sectioned_audio([
            (0.5, 0),
            (1.0, 2000),
            (0.5, 0),
        ])
        timeline = analyze_pcm16(audio, SAMPLE_RATE)
        keep = timeline["keep"]
        self.assertEqual(len(keep), 1)
        expected_start = 0.5 - PADDING_MS / 1000.0
        expected_end = 1.5 + PADDING_MS / 1000.0
        self.assertAlmostEqual(keep[0]["start"], expected_start, delta=0.1)
        self.assertAlmostEqual(keep[0]["end"], expected_end, delta=0.1)

    def test_merges_short_pause_into_single_region(self):
        short_pause = (MIN_PAUSE_MS / 1000.0) * 0.6
        audio = build_sectioned_audio([
            (0.4, 0),
            (0.6, 2500),
            (short_pause, 0),
            (0.6, 2500),
            (0.4, 0),
        ])
        timeline = analyze_pcm16(audio, SAMPLE_RATE)
        keep = timeline["keep"]
        self.assertEqual(len(keep), 1)

    def test_creates_multiple_regions_for_long_pauses(self):
        long_pause = (MIN_PAUSE_MS / 1000.0) * 2
        audio = build_sectioned_audio([
            (0.4, 0),
            (0.6, 2600),
            (long_pause, 0),
            (0.6, 2600),
            (0.4, 0),
        ])
        timeline = analyze_pcm16(audio, SAMPLE_RATE)
        keep = timeline["keep"]
        self.assertEqual(len(keep), 2)

        duration = sum(duration for duration, _ in [
            (0.4, 0),
            (0.6, 2600),
            (long_pause, 0),
            (0.6, 2600),
            (0.4, 0),
        ])
        self.assertAlmostEqual(timeline["duration"], round(duration, 3))
        regions = timeline["regions"]
        self.assertEqual(regions[0]["type"], "drop")
        self.assertEqual(regions[-1]["type"], "drop")


if __name__ == "__main__":
    unittest.main()

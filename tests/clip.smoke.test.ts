import fs from 'node:fs';
import path from 'node:path';
import { path as ffmpegPath } from '@ffmpeg-installer/ffmpeg';
import { execa } from 'execa';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const SAMPLE_PATH = path.join(ROOT, 'samples', 'vod.mp4');
const OUT_DIR = path.join(ROOT, 'out');

beforeAll(async () => {
  await fs.promises.rm(OUT_DIR, { recursive: true, force: true });

  if (!fs.existsSync(SAMPLE_PATH)) {
    await execa('node', ['scripts/create_sample.mjs'], {
      stdio: 'inherit',
      cwd: ROOT,
    });
  }
});

describe('clip smoke test', () => {
  it('renders a polished vertical clip from the sample VOD', async () => {
    await execa('make', ['clip'], {
      stdio: 'inherit',
      cwd: ROOT,
    });

    const clipPath = path.join(OUT_DIR, 'clip.mp4');
    const captionsPath = path.join(OUT_DIR, 'captions.srt');
    const timelinePath = path.join(OUT_DIR, 'timeline.json');

    expect(fs.existsSync(clipPath)).toBe(true);
    expect(fs.existsSync(captionsPath)).toBe(true);
    expect(fs.existsSync(timelinePath)).toBe(true);

    const timeline = JSON.parse(fs.readFileSync(timelinePath, 'utf8')) as {
      keep: Array<{ start: number; end: number }>;
    };

    expect(timeline.keep.length).toBeGreaterThan(0);
    const totalKeep = timeline.keep.reduce((sum, region) => sum + (region.end - region.start), 0);
    expect(totalKeep).toBeLessThanOrEqual(59);

    const probe = await execa(ffmpegPath, ['-hide_banner', '-i', clipPath], {
      cwd: ROOT,
      reject: false,
    });
    const streamLine = probe.stderr
      .split(/\r?\n/)
      .find((line) => line.includes('Video:'));
    expect(streamLine).toBeTruthy();
    const resolutionMatch = streamLine?.match(/(\d{3,4})x(\d{3,4})/);
    expect(resolutionMatch?.[1]).toBe('1080');
    expect(resolutionMatch?.[2]).toBe('1920');

    const durationLine = probe.stderr
      .split(/\r?\n/)
      .find((line) => line.trim().startsWith('Duration:'));
    expect(durationLine).toBeTruthy();
    const durationMatch = durationLine?.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
    expect(durationMatch).toBeTruthy();
    if (durationMatch) {
      const hours = Number(durationMatch[1]);
      const minutes = Number(durationMatch[2]);
      const seconds = Number(durationMatch[3]);
      const totalSeconds = hours * 3600 + minutes * 60 + seconds;
      expect(totalSeconds).toBeLessThanOrEqual(59.1);
    }

    const captions = fs.readFileSync(captionsPath, 'utf8').split(/\r?\n/);
    const timingLine = captions.find((line) => line.includes(' --> '));
    expect(timingLine).toMatch(/^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/);
  });
});

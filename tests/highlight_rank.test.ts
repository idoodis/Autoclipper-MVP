import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'highlight_rank.py');

describe('highlight_rank.py', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'highlight-test-'));
  });

  afterAll(async () => {
    if (tmpDir) {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('scores segments and emits multiple variants', async () => {
    const timelinePath = path.join(tmpDir, 'timeline.json');
    const captionsPath = path.join(tmpDir, 'captions.srt');

    const timeline = {
      duration: 120,
      candidates: [
        { start: 5, end: 20, score: 0.6 },
        { start: 25, end: 40, score: 0.9 },
        { start: 45, end: 60, score: 0.7 },
        { start: 62, end: 78, score: 0.8 },
        { start: 80, end: 95, score: 0.65 },
      ],
    };
    await fs.promises.writeFile(timelinePath, JSON.stringify(timeline), 'utf8');

    const captions = `1\n00:00:04,000 --> 00:00:20,000\nThis is an amazing story about resilience and grit!\n\n2\n00:00:25,000 --> 00:00:40,000\nYou will not believe what happened next?\n\n3\n00:00:45,000 --> 00:00:60,000\nHere is the strategy that changed everything.\n\n4\n00:01:02,000 --> 00:01:18,000\nWe absolutely must talk about this pro tip right now!\n\n5\n00:01:20,000 --> 00:01:34,000\nFinally, let me tell you why this matters.`;
    await fs.promises.writeFile(captionsPath, captions, 'utf8');

    await execa('python3', [
      SCRIPT,
      '--timeline',
      timelinePath,
      '--captions',
      captionsPath,
      '--max-duration',
      '45',
      '--max-variants',
      '3',
    ]);

    const refined = JSON.parse(fs.readFileSync(timelinePath, 'utf8')) as {
      keep: Array<{ start: number; end: number; score: number }>;
      variants?: Array<{ id: string; keep: Array<{ start: number; end: number }> }>;
    };

    expect(refined.keep.length).toBeGreaterThan(0);
    expect(refined.variants?.length).toBeGreaterThanOrEqual(1);
    const uniqueVariantExports = new Set(refined.variants?.map((variant) => variant.id));
    expect(uniqueVariantExports.size).toBe(refined.variants?.length);
    const durations = refined.variants?.map((variant) =>
      variant.keep.reduce((sum, region) => sum + (region.end - region.start), 0),
    );
    durations?.forEach((duration) => {
      expect(duration).toBeLessThanOrEqual(45.5);
    });
  });
});

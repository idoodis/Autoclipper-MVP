import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');

function writeSrt(filePath, segments) {
  const lines = [];
  for (const seg of segments) {
    const start = new Date(seg.start * 1000).toISOString().substr(11, 12).replace('.', ',');
    const end = new Date(seg.end * 1000).toISOString().substr(11, 12).replace('.', ',');
    lines.push(String(seg.index));
    lines.push(`${start} --> ${end}`);
    lines.push(seg.text);
    lines.push('');
  }
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
}

describe('highlight ranking', () => {
  let tmpDir;
  let timelinePath;
  let captionsPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'highlight-test-'));
    timelinePath = path.join(tmpDir, 'timeline.json');
    captionsPath = path.join(tmpDir, 'captions.srt');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('promotes segments with stronger language', async () => {
    const timeline = {
      duration: 120,
      keep: [
        { start: 5, end: 15, score: 0.5 },
        { start: 20, end: 32, score: 0.7 },
        { start: 35, end: 50, score: 0.6 },
      ],
    };
    fs.writeFileSync(timelinePath, JSON.stringify(timeline, null, 2));
    writeSrt(captionsPath, [
      { index: 1, start: 5, end: 15, text: 'This part is fine and pretty calm.' },
      { index: 2, start: 20, end: 32, text: 'This moment is absolutely unbelievable and insane!' },
      { index: 3, start: 35, end: 50, text: 'Wrapping things up here.' },
    ]);

    await execa('python3', [
      path.join(ROOT, 'scripts', 'highlight_rank.py'),
      '--timeline',
      timelinePath,
      '--captions',
      captionsPath,
      '--max-duration',
      '25',
    ]);

    const updated = JSON.parse(fs.readFileSync(timelinePath, 'utf8'));

    expect(updated.keep.length).toBeGreaterThan(0);
    const topSegment = updated.keep[0];
    expect(topSegment.start).toBeCloseTo(20, 0);
    expect(topSegment.score).toBeGreaterThan(0.5);
  });
});

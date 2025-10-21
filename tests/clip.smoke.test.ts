import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const SAMPLE_PATH = path.join(ROOT, 'samples', 'vod.mp4');
const OUT_DIR = path.join(ROOT, 'out');

beforeAll(async () => {
  await fs.promises.rm(OUT_DIR, { recursive: true, force: true });

  if (!fs.existsSync(SAMPLE_PATH)) {
    await execa('pnpm', ['tsx', 'scripts/create_sample.ts'], {
      stdio: 'inherit',
      cwd: ROOT,
    });
  }
});

describe('clip smoke test', () => {
  it('renders a clip from the sample VOD', async () => {
    await execa('make', ['clip'], {
      stdio: 'inherit',
      cwd: ROOT,
    });

    const clipPath = path.join(OUT_DIR, 'clip.mp4');
    expect(fs.existsSync(clipPath)).toBe(true);
  });
});

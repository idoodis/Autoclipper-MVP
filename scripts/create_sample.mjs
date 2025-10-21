import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { path as ffmpegPath } from '@ffmpeg-installer/ffmpeg';

const SAMPLE_DIR = path.resolve('samples');
const SAMPLE_PATH = path.join(SAMPLE_DIR, 'vod.mp4');

async function ensureSample() {
  if (!fs.existsSync(SAMPLE_DIR)) {
    fs.mkdirSync(SAMPLE_DIR, { recursive: true });
  }

  if (fs.existsSync(SAMPLE_PATH)) {
    return;
  }

  await execa(
    ffmpegPath,
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=640x360:d=6',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=44100:duration=6',
      '-shortest',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      SAMPLE_PATH,
    ],
    { stdio: 'inherit' }
  );
}

ensureSample().catch((err) => {
  console.error('Failed to generate sample clip:', err);
  process.exitCode = 1;
});

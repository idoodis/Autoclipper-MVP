#!/usr/bin/env -S node --enable-source-maps
import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { path as ffmpegPath } from '@ffmpeg-installer/ffmpeg';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { buildConcatFilter } from './lib/filterGraph.mjs';
import { clampKeepRegions, loadTimeline, saveTimeline, totalDuration } from './lib/timeline.mjs';

const MAX_CLIP_DURATION = 59;

async function run(cmd, args, cwd) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  await execa(cmd, args, { stdio: 'inherit', cwd });
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option('vod', { type: 'string', demandOption: true })
    .option('out', { type: 'string', default: 'out' })
    .strict()
    .parseAsync();

  const outDir = typeof argv.out === 'string' ? argv.out : 'out';
  const vodPath = String(argv.vod);
  ensureDir(outDir);

  const tmpAudioPath = path.join(outDir, 'audio.wav');
  await run(ffmpegPath, ['-y', '-i', vodPath, '-vn', '-ac', '1', '-ar', '16000', tmpAudioPath]);

  const timelinePath = path.join(outDir, 'timeline.json');
  await run('python3', ['scripts/silence_detect.py', '--audio', tmpAudioPath, '--out', timelinePath], process.cwd());

  const captionsPath = path.join(outDir, 'captions.srt');
  await run('python3', ['scripts/transcribe.py', '--audio', tmpAudioPath, '--srt', captionsPath], process.cwd());

  const timeline = loadTimeline(timelinePath);
  const clippedKeep = clampKeepRegions(timeline.keep, MAX_CLIP_DURATION);

  if (clippedKeep.length === 0) {
    throw new Error('Timeline did not produce any valid keep regions');
  }

  const filterGraph = buildConcatFilter(clippedKeep, captionsPath);

  const finalTimeline = { ...timeline, keep: clippedKeep };
  saveTimeline(timelinePath, finalTimeline);

  const clipOut = path.join(outDir, 'clip.mp4');
  const totalKeepDuration = totalDuration(clippedKeep).toFixed(3);
  await run(ffmpegPath, [
    '-y',
    '-i',
    vodPath,
    '-filter_complex',
    filterGraph,
    '-map',
    '[outv]',
    '-map',
    '[outa]',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-profile:v',
    'high',
    '-level',
    '4.1',
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-movflags',
    '+faststart',
    '-t',
    totalKeepDuration,
    clipOut,
  ]);

  console.log('Clip duration', totalKeepDuration, 'seconds');
  console.log('Done →', clipOut);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

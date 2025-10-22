#!/usr/bin/env -S node --enable-source-maps
import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { path as ffmpegPath } from '@ffmpeg-installer/ffmpeg';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { buildConcatFilter } from './lib/filterGraph.mjs';
import { clampKeepRegions, loadTimeline, saveTimeline, totalDuration } from './lib/timeline.mjs';

const DEFAULT_MAX_DURATION_SECONDS = 59;

async function run(cmd, args, cwd) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  await execa(cmd, args, { stdio: 'inherit', cwd });
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export async function createClip(options) {
  const {
    vodPath,
    outDir,
    projectRoot = process.cwd(),
    maxDurationSeconds = DEFAULT_MAX_DURATION_SECONDS,
    watermarkText = 'AutoClipper',
    silenceScript = path.join(projectRoot, 'scripts', 'silence_detect.py'),
    transcriptionScript = path.join(projectRoot, 'scripts', 'transcribe.py'),
    highlightScript = path.join(projectRoot, 'scripts', 'highlight_rank.py'),
    captionsModel,
    transcriptionDevice,
  } = options;

  ensureDir(outDir);

  const tmpAudioPath = path.join(outDir, 'audio.wav');
  await run(ffmpegPath, ['-y', '-i', vodPath, '-vn', '-ac', '1', '-ar', '16000', tmpAudioPath]);

  const timelinePath = path.join(outDir, 'timeline.json');
  await run('python3', [silenceScript, '--audio', tmpAudioPath, '--out', timelinePath], projectRoot);

  const captionsPath = path.join(outDir, 'captions.srt');
  const transcriptionArgs = ['--audio', tmpAudioPath, '--srt', captionsPath];
  if (captionsModel) {
    transcriptionArgs.push('--model', captionsModel);
  }
  if (transcriptionDevice) {
    transcriptionArgs.push('--device', transcriptionDevice);
  }
  await run('python3', [transcriptionScript, ...transcriptionArgs], projectRoot);

  await run(
    'python3',
    [
      highlightScript,
      '--timeline',
      timelinePath,
      '--captions',
      captionsPath,
      '--max-duration',
      String(maxDurationSeconds),
    ],
    projectRoot,
  );

  const timeline = loadTimeline(timelinePath);
  const clippedKeep = clampKeepRegions(timeline.keep, maxDurationSeconds);

  if (clippedKeep.length === 0) {
    throw new Error('Timeline did not produce any valid keep regions');
  }

  const filterGraph = buildConcatFilter(clippedKeep, captionsPath, watermarkText);

  const finalTimeline = {
    ...timeline,
    keep: clippedKeep,
    parameters: {
      ...timeline.parameters,
      maxDurationSeconds,
      watermarkText,
    },
  };
  saveTimeline(timelinePath, finalTimeline);

  const clipOut = path.join(outDir, 'clip.mp4');
  const totalKeepDuration = totalDuration(clippedKeep);
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
    totalKeepDuration.toFixed(3),
    clipOut,
  ]);

  console.log('Clip duration', totalKeepDuration.toFixed(3), 'seconds');
  console.log('Done →', clipOut);

  return {
    clipPath: clipOut,
    captionsPath,
    timelinePath,
    timeline: finalTimeline,
    durationSeconds: totalKeepDuration,
  };
}

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option('vod', { type: 'string', demandOption: true })
    .option('out', { type: 'string', default: 'out' })
    .option('max-duration', { type: 'number' })
    .option('watermark-text', { type: 'string' })
    .option('model', { type: 'string' })
    .option('device', { type: 'string' })
    .strict()
    .parseAsync();

  const outDir = typeof argv.out === 'string' ? argv.out : 'out';
  const vodPath = String(argv.vod);

  await createClip({
    vodPath,
    outDir,
    maxDurationSeconds: typeof argv.maxDuration === 'number' ? argv.maxDuration : undefined,
    watermarkText: typeof argv.watermarkText === 'string' ? argv.watermarkText : undefined,
    captionsModel: typeof argv.model === 'string' ? argv.model : undefined,
    transcriptionDevice: typeof argv.device === 'string' ? argv.device : undefined,
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

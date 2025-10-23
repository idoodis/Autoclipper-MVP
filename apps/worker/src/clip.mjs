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
const DEFAULT_VARIANT_COUNT = 3;

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

async function run(cmd, args, cwd) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  await execa(cmd, args, { stdio: 'inherit', cwd });
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

async function renderVariant({ vodPath, keep, captionsPath, watermarkText, outPath }) {
  const duration = totalDuration(keep);
  if (duration <= 0) {
    throw new Error('Cannot render a clip with zero duration');
  }

  const filterGraph = buildConcatFilter(keep, {
    captionsPath,
    watermarkText,
    totalDurationSeconds: duration,
  });

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
    duration.toFixed(3),
    outPath,
  ]);

  return { path: outPath, duration };
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
    variantCount = DEFAULT_VARIANT_COUNT,
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
      '--max-variants',
      String(Math.max(1, variantCount)),
    ],
    projectRoot,
  );

  const timeline = loadTimeline(timelinePath);
  const clippedKeep = clampKeepRegions(timeline.keep, maxDurationSeconds);

  if (clippedKeep.length === 0) {
    throw new Error('Timeline did not produce any valid keep regions');
  }

  const variantPlans = [
    {
      id: 'primary',
      label: 'Primary highlight',
      score: undefined,
      keep: clippedKeep,
    },
    ...(Array.isArray(timeline.variants) ? timeline.variants : []),
  ]
    .slice(0, Math.max(1, variantCount))
    .map((variant, index) => {
      const keep = clampKeepRegions(variant.keep, maxDurationSeconds);
      const duration = totalDuration(keep);
      return {
        id: variant.id || (index === 0 ? 'primary' : `variant-${index}`),
        label: variant.label,
        score: variant.score,
        keep,
        duration,
      };
    })
    .filter((variant) => variant.keep.length > 0 && variant.duration > 0.2);

  if (variantPlans.length === 0) {
    throw new Error('No valid variants produced from highlight ranking');
  }

  const renderedVariants = [];

  for (let index = 0; index < variantPlans.length; index += 1) {
    const variant = variantPlans[index];
    const slug = slugify(index === 0 ? 'clip' : variant.id || `variant-${index}`) || `variant-${index}`;
    const fileName = index === 0 ? 'clip.mp4' : `clip_${slug}.mp4`;
    const outPath = path.join(outDir, fileName);
    console.log(`Rendering ${variant.label || variant.id || `variant ${index + 1}`} → ${fileName}`);
    const rendered = await renderVariant({
      vodPath,
      keep: variant.keep,
      captionsPath,
      watermarkText,
      outPath,
    });
    renderedVariants.push({
      ...variant,
      ...rendered,
      fileName,
    });
  }

  const finalTimeline = {
    ...timeline,
    keep: renderedVariants[0].keep,
    variants: renderedVariants.map(({ keep, id, label, score, duration, fileName }) => ({
      id,
      label,
      score,
      duration,
      keep,
      export: fileName,
    })),
    parameters: {
      ...timeline.parameters,
      maxDurationSeconds,
      watermarkText,
      variants: renderedVariants.map(({ id, fileName, duration }) => ({
        id,
        file: fileName,
        duration,
      })),
    },
  };

  saveTimeline(timelinePath, finalTimeline);

  const primary = renderedVariants[0];
  console.log('Primary clip duration', primary.duration.toFixed(3), 'seconds');
  console.log('Done →', renderedVariants.map((variant) => variant.path).join(', '));

  return {
    clipPath: primary.path,
    clipPaths: renderedVariants.map((variant) => variant.path),
    captionsPath,
    timelinePath,
    timeline: finalTimeline,
    durationSeconds: primary.duration,
    variants: renderedVariants,
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
    .option('variants', { type: 'number', default: DEFAULT_VARIANT_COUNT })
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
    variantCount: typeof argv.variants === 'number' ? argv.variants : undefined,
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

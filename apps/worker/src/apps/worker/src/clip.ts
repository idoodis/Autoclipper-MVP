#!/usr/bin/env -S node --enable-source-maps
import { execa } from 'execa';
import fs from 'node:fs';
import path from 'node:path';
import yargs from 'yargs';

type KeepRegion = { start: number; end: number };
type Timeline = {
  keep: KeepRegion[];
  duration: number;
};


const argv = yargs(process.argv.slice(2))
.option('vod', { type: 'string', demandOption: true })
.option('out', { type: 'string', default: 'out' })
.parseSync();


const OUT = argv.out;
fs.mkdirSync(OUT, { recursive: true });


async function run(cmd: string, args: string[]) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  await execa(cmd, args, { stdio: 'inherit' });
}

function loadTimeline(timelinePath: string): Timeline {
  const raw = JSON.parse(fs.readFileSync(timelinePath, 'utf8')) as Partial<Timeline> & {
    keep?: KeepRegion[];
  };
  const duration = typeof raw.duration === 'number' ? raw.duration : 0;
  const keepSegments = (raw.keep ?? []).filter(
    (region): region is KeepRegion =>
      typeof region?.start === 'number' && typeof region?.end === 'number' && region.end > region.start,
  );
  if (keepSegments.length > 0) {
    return { keep: keepSegments, duration };
  }
  return {
    keep: [{ start: 0, end: duration > 0 ? duration : 1 }],
    duration,
  };
}

function escapeFilterPath(input: string): string {
  return input
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/'/g, "\\'")
    .replace(/ /g, '\\ ');
}

function formatTime(value: number): string {
  return value.toFixed(3);
}

function buildConcatFilter(keep: KeepRegion[], captionsPath: string): string {
  if (keep.length === 0) {
    throw new Error('Timeline did not produce any keep regions');
  }
  const escapedCaptions = escapeFilterPath(captionsPath);
  const videoSplitOutputs = keep.map((_, idx) => `[vpre${idx}]`).join('');
  const audioSplitOutputs = keep.map((_, idx) => `[apre${idx}]`).join('');
  const videoFilters = `[0:v]scale=1080:-2,transpose=1,subtitles=${escapedCaptions},split=${keep.length}${videoSplitOutputs}`;
  const audioFilters = `[0:a]asplit=${keep.length}${audioSplitOutputs}`;
  const trims: string[] = [];
  keep.forEach((region, idx) => {
    const start = formatTime(region.start);
    const end = formatTime(region.end);
    trims.push(`[vpre${idx}]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${idx}]`);
    trims.push(`[apre${idx}]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${idx}]`);
  });
  const concatInputs = keep.map((_, idx) => `[v${idx}][a${idx}]`).join('');
  const concat = `${concatInputs}concat=n=${keep.length}:v=1:a=1[outv][outa]`;
  return [videoFilters, audioFilters, ...trims, concat].join(';');
}


(async () => {
const tmpWav = path.join(OUT, 'audio.wav');
await run('ffmpeg', ['-y', '-i', argv.vod, '-vn', '-ac', '1', '-ar', '16000', tmpWav]);


// 1) Deadspace detection (Python) → timeline.json
 const timelinePath = path.join(OUT, 'timeline.json');
 await run('python3', ['scripts/silence_detect.py', '--audio', tmpWav, '--out', timelinePath]);


// 2) Transcribe (Python) → captions.srt
 const captionsPath = path.join(OUT, 'captions.srt');
 await run('python3', ['scripts/transcribe.py', '--audio', tmpWav, '--srt', captionsPath]);

 const timeline = loadTimeline(timelinePath);
 const keepSegments = [...timeline.keep].sort((a, b) => a.start - b.start);
 const filterGraph = buildConcatFilter(keepSegments, captionsPath);


// 3) Render 9:16 with watermark + captions
const clipOut = path.join(OUT, 'clip.mp4');
await run('ffmpeg', [
'-y', '-i', argv.vod,
'-filter_complex', filterGraph,
'-map', '[outv]',
'-map', '[outa]',
'-c:v', 'libx264',
'-c:a', 'aac',
'-preset', 'veryfast',
'-t', '00:00:59',
clipOut
]);


console.log('Done →', clipOut);
})();

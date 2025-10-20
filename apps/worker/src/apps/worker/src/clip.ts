#!/usr/bin/env -S node --enable-source-maps
import { execa } from 'execa';
import fs from 'node:fs';
import path from 'node:path';
import yargs from 'yargs';


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


(async () => {
const tmpWav = path.join(OUT, 'audio.wav');
await run('ffmpeg', ['-y', '-i', argv.vod, '-vn', '-ac', '1', '-ar', '16000', tmpWav]);


// 1) Deadspace detection (Python) → timeline.json
await run('python3', ['scripts/silence_detect.py', '--audio', tmpWav, '--out', path.join(OUT, 'timeline.json')]);


// 2) Transcribe (Python) → captions.srt
await run('python3', ['scripts/transcribe.py', '--audio', tmpWav, '--srt', path.join(OUT, 'captions.srt')]);


// 3) Render 9:16 with watermark + captions
const clipOut = path.join(OUT, 'clip.mp4');
await run('ffmpeg', [
'-y', '-i', argv.vod,
'-i', path.join(OUT, 'captions.srt'),
'-vf', 'scale=1080:-2,transpose=1,subtitles=' + path.join(OUT, 'captions.srt').replace(/:/g, '\\:'),
'-c:v', 'libx264', '-preset', 'veryfast', '-t', '00:00:59', clipOut
]);


console.log('Done →', clipOut);
})();

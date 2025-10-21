import { formatTime } from './timeline.mjs';

function escapeFilterPath(input) {
  return input
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/'/g, "\\'")
    .replace(/ /g, '\\ ');
}

export function buildConcatFilter(keep, captionsPath) {
  if (keep.length === 0) {
    throw new Error('Timeline did not produce any keep regions');
  }

  const escapedCaptions = escapeFilterPath(captionsPath);
  const videoSplitOutputs = keep.map((_, idx) => `[vpre${idx}]`).join('');
  const audioSplitOutputs = keep.map((_, idx) => `[apre${idx}]`).join('');

  const watermark = "drawtext=text='AutoClipper':fontcolor=white:fontsize=48:box=1:boxcolor=0x00000090:x=40:y=40";
  const baseVideoFilter =
    `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,` +
    `subtitles=${escapedCaptions},${watermark},split=${keep.length}${videoSplitOutputs}`;
  const audioFilters = `[0:a]asplit=${keep.length}${audioSplitOutputs}`;

  const trims = [];
  keep.forEach((region, idx) => {
    const start = formatTime(region.start);
    const end = formatTime(region.end);
    trims.push(`[vpre${idx}]trim=start=${start}:end=${end},setpts=PTS-STARTPTS[v${idx}]`);
    trims.push(`[apre${idx}]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a${idx}]`);
  });

  const concatInputs = keep.map((_, idx) => `[v${idx}][a${idx}]`).join('');
  const concat = `${concatInputs}concat=n=${keep.length}:v=1:a=1[outv][outa]`;

  return [baseVideoFilter, audioFilters, ...trims, concat].join(';');
}

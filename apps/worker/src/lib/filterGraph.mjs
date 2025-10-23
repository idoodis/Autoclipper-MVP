import { formatTime } from './timeline.mjs';

function escapeFilterPath(input) {
  return input
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/'/g, "\\'")
    .replace(/ /g, '\\ ');
}

export function buildConcatFilter(keep, captionsOrOptions, legacyWatermarkText) {
  if (keep.length === 0) {
    throw new Error('Timeline did not produce any keep regions');
  }

  const options =
    typeof captionsOrOptions === 'string'
      ? {
          captionsPath: captionsOrOptions,
          watermarkText: legacyWatermarkText,
        }
      : captionsOrOptions || {};

  const {
    captionsPath,
    watermarkText = 'AutoClipper',
    safeMargin = 96,
    backgroundBlur = 28,
    overlayScale = 0.9,
    showProgressBar = false,
    progressColor = '0xffae00@0.9',
    progressTrackColor = 'white@0.35',
    totalDurationSeconds,
  } = options;

  if (!captionsPath) {
    throw new Error('captionsPath is required to render subtitles');
  }

  const overlayWidth = Math.max(540, Math.round(1080 * Math.min(Math.max(overlayScale, 0.6), 1)));
  const overlayHeight = Math.max(
    960,
    Math.round(1920 * Math.min(Math.max(overlayScale, 0.6), 1.02)),
  );
  const outputWidth = 1080;
  const outputHeight = 1920;

  const escapedCaptions = escapeFilterPath(captionsPath);
  const videoSplitOutputs = keep.map((_, idx) => `[vpre${idx}]`).join('');
  const audioSplitOutputs = keep.map((_, idx) => `[apre${idx}]`).join('');

  const escapedWatermark = watermarkText
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,')
    .replace(/'/g, "\\'");

  const watermark =
    `drawtext=text='${escapedWatermark}':fontcolor=0xffffff@0.98:fontsize=46:` +
    `box=1:boxcolor=0x000000@0.6:boxborderw=18:x=64:y=64`;

  const safeYOffset = Math.max(Math.round(safeMargin), 0);
  const progressFilters = showProgressBar
    ? `,drawbox=x=64:y=1810:w=952:h=10:color=${progressTrackColor}:t=fill` +
      `,drawbox=x=64:y=1810:w=952:h=6:color=${progressColor}:t=fill`
    : '';

  const overlayOffsetX = Math.max(0, Math.round((outputWidth - overlayWidth) / 2));
  const overlayOffsetY = Math.max(0, Math.round((outputHeight - overlayHeight) / 2 - safeYOffset));

  const baseFilters = [
    `[0:v]split=2[vbgsrc][vfgsrc]`,
    `[vbgsrc]scale=1080:1920:force_original_aspect_ratio=increase,` +
      `crop=${outputWidth}:${outputHeight},boxblur=${backgroundBlur}:1,setsar=1[bg]`,
    `[vfgsrc]scale=${overlayWidth}:-2:force_original_aspect_ratio=decrease,setsar=1,` +
      `pad=${overlayWidth}:${overlayHeight}:(ow-iw)/2:(oh-ih)/2,eq=contrast=1.05:saturation=1.1,format=yuv420p[vfocus]`,
    `[bg][vfocus]overlay=${overlayOffsetX}:${overlayOffsetY}` +
      `,drawbox=x=0:y=1700:w=1080:h=220:color=0x000000@0.66:t=fill` +
      `,subtitles=${escapedCaptions},${watermark}${progressFilters},format=yuv420p,split=${keep.length}${videoSplitOutputs}`,
  ];

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

  return [...baseFilters, audioFilters, ...trims, concat].join(';');
}

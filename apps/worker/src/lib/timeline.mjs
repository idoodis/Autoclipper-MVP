import fs from 'node:fs';

const MAX_CLIP_DURATION_SECONDS = 59;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function formatTime(value) {
  return value.toFixed(3);
}

export function normalizeRegions(regions) {
  return (regions || [])
    .filter((region) =>
      region &&
      isFiniteNumber(region.start) &&
      isFiniteNumber(region.end) &&
      region.end > region.start
    )
    .map((region) => ({
      start: Number(region.start),
      end: Number(region.end),
      score: typeof region.score === 'number' ? region.score : undefined,
    }))
    .sort((a, b) => a.start - b.start);
}

export function loadTimeline(timelinePath) {
  const rawData = fs.readFileSync(timelinePath, 'utf8');
  const data = JSON.parse(rawData);
  const duration = isFiniteNumber(data?.duration) ? data.duration : 0;
  const keep = normalizeRegions(Array.isArray(data?.keep) ? data.keep : []);

  if (keep.length > 0) {
    return {
      duration,
      keep,
      candidates: Array.isArray(data?.candidates) ? normalizeRegions(data.candidates) : undefined,
      parameters: data?.parameters,
    };
  }

  const fallbackEnd = duration > 0 ? Math.min(duration, MAX_CLIP_DURATION_SECONDS) : 1;
  return {
    duration,
    keep: [{ start: 0, end: fallbackEnd }],
    candidates: Array.isArray(data?.candidates) ? normalizeRegions(data.candidates) : undefined,
    parameters: data?.parameters,
  };
}

export function clampKeepRegions(keep, maxDuration) {
  const output = [];
  let accumulated = 0;

  for (const region of keep) {
    if (accumulated >= maxDuration) {
      break;
    }
    const length = region.end - region.start;
    if (length <= 0) {
      continue;
    }
    const available = Math.min(length, maxDuration - accumulated);
    const end = region.start + available;
    output.push({ ...region, end });
    accumulated += available;
  }

  return output;
}

export function totalDuration(regions) {
  return regions.reduce((sum, region) => sum + Math.max(0, region.end - region.start), 0);
}

export function saveTimeline(timelinePath, timeline) {
  const formatted = {
    ...timeline,
    keep: timeline.keep.map((region) => ({
      ...region,
      start: Number(formatTime(region.start)),
      end: Number(formatTime(region.end)),
      score: typeof region.score === 'number' ? Number(formatTime(region.score)) : undefined,
    })),
  };
  fs.writeFileSync(timelinePath, JSON.stringify(formatted, null, 2));
}

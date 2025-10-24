import fs from 'node:fs';
import path from 'node:path';

class DistributionError extends Error {
  constructor(message, results) {
    super(message);
    this.name = 'DistributionError';
    this.results = results;
  }
}

function guessContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.mp4':
    case '.mov':
    case '.mkv':
      return 'video/mp4';
    case '.srt':
      return 'application/x-subrip';
    case '.json':
      return 'application/json';
    default:
      return 'application/octet-stream';
  }
}

function normalizeFilesystemTarget(target, index) {
  if (!target.directory) {
    return null;
  }
  return {
    type: 'filesystem',
    name: target.name || `filesystem-${index + 1}`,
    directory: path.resolve(target.directory),
    flatten: Boolean(target.flatten),
    publicBaseUrl:
      typeof target.publicBaseUrl === 'string' && target.publicBaseUrl.trim().length > 0
        ? target.publicBaseUrl.replace(/\/?$/, '')
        : null,
  };
}

function normalizeUploadEndpoint(endpoint, defaults = {}) {
  if (!endpoint || typeof endpoint.url !== 'string' || endpoint.url.trim().length === 0) {
    return null;
  }
  const headers = { ...(defaults.headers || {}), ...(endpoint.headers || {}) };
  return {
    url: endpoint.url,
    method: (endpoint.method || defaults.method || 'PUT').toUpperCase(),
    headers,
  };
}

function normalizePresignedTarget(target, index) {
  const artifacts = target.artifacts || {};
  const defaults = {
    method: target.method || 'PUT',
    headers: target.headers || {},
  };
  const normalized = {
    type: 'presigned',
    name: target.name || `presigned-${index + 1}`,
    clip: normalizeUploadEndpoint(artifacts.clip, defaults),
    captions: normalizeUploadEndpoint(artifacts.captions, defaults),
    timeline: normalizeUploadEndpoint(artifacts.timeline, defaults),
    variants: Array.isArray(artifacts.variants)
      ? artifacts.variants
          .map((entry) => normalizeUploadEndpoint(entry, defaults))
          .filter((entry) => entry)
      : [],
  };

  if (!normalized.clip && normalized.variants.length === 0 && !normalized.captions && !normalized.timeline) {
    return null;
  }
  return normalized;
}

export function normalizeTargets(rawTargets) {
  if (!Array.isArray(rawTargets)) {
    return [];
  }
  const normalized = [];
  rawTargets.forEach((target, index) => {
    if (!target || typeof target !== 'object') {
      return;
    }
    if (target.type === 'filesystem') {
      const normalizedFs = normalizeFilesystemTarget(target, index);
      if (normalizedFs) {
        normalized.push(normalizedFs);
      }
      return;
    }
    if (target.type === 'presigned') {
      const normalizedPresigned = normalizePresignedTarget(target, index);
      if (normalizedPresigned) {
        normalized.push(normalizedPresigned);
      }
    }
  });
  return normalized;
}

function createFileEntry(rootDir, fullPath, publicBaseUrl) {
  const entry = { path: fullPath };
  if (publicBaseUrl) {
    const relative = path.relative(rootDir, fullPath).split(path.sep).join('/');
    entry.publicUrl = `${publicBaseUrl}/${relative}`;
  }
  return entry;
}

async function deliverToFilesystem(target, job, artifacts) {
  const destinationRoot = target.flatten
    ? target.directory
    : path.join(target.directory, job.tenantId, job.id);
  await fs.promises.mkdir(destinationRoot, { recursive: true });

  const record = {
    type: 'filesystem',
    name: target.name,
    directory: destinationRoot,
    files: {
      clip: null,
      variants: [],
      captions: null,
      timeline: null,
    },
  };

  if (artifacts.clipPath) {
    const ext = path.extname(artifacts.clipPath) || '.mp4';
    const targetPath = path.join(destinationRoot, `clip${ext}`);
    await fs.promises.copyFile(artifacts.clipPath, targetPath);
    record.files.clip = createFileEntry(target.directory, targetPath, target.publicBaseUrl);
  }

  if (Array.isArray(artifacts.clipPaths)) {
    for (let i = 0; i < artifacts.clipPaths.length; i += 1) {
      const source = artifacts.clipPaths[i];
      if (!source) continue;
      const ext = path.extname(source) || '.mp4';
      const targetPath = path.join(destinationRoot, `variant-${i + 1}${ext}`);
      await fs.promises.copyFile(source, targetPath);
      record.files.variants.push(createFileEntry(target.directory, targetPath, target.publicBaseUrl));
    }
  }

  if (artifacts.captionsPath) {
    const ext = path.extname(artifacts.captionsPath) || '.srt';
    const targetPath = path.join(destinationRoot, `captions${ext}`);
    await fs.promises.copyFile(artifacts.captionsPath, targetPath);
    record.files.captions = createFileEntry(target.directory, targetPath, target.publicBaseUrl);
  }

  if (artifacts.timelinePath) {
    const ext = path.extname(artifacts.timelinePath) || '.json';
    const targetPath = path.join(destinationRoot, `timeline${ext}`);
    await fs.promises.copyFile(artifacts.timelinePath, targetPath);
    record.files.timeline = createFileEntry(target.directory, targetPath, target.publicBaseUrl);
  }

  return record;
}

async function uploadWithEndpoint(endpoint, filePath) {
  if (!endpoint) {
    return null;
  }
  const headers = { ...endpoint.headers };
  if (!('content-type' in Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])))) {
    headers['content-type'] = guessContentType(filePath);
  }
  const response = await fetch(endpoint.url, {
    method: endpoint.method,
    headers,
    body: fs.createReadStream(filePath),
    duplex: 'half',
  });
  const bodyText = await response.text().catch(() => '');
  if (!response.ok) {
    const suffix = bodyText ? `: ${bodyText.slice(0, 200)}` : '';
    throw new Error(`Upload to ${endpoint.url} failed with status ${response.status}${suffix}`);
  }
  return { url: endpoint.url, status: response.status };
}

async function deliverToPresigned(target, artifacts) {
  const record = {
    type: 'presigned',
    name: target.name,
    uploads: {
      clip: null,
      captions: null,
      timeline: null,
      variants: [],
    },
  };

  if (target.clip && artifacts.clipPath) {
    record.uploads.clip = await uploadWithEndpoint(target.clip, artifacts.clipPath);
  }
  if (target.captions && artifacts.captionsPath) {
    record.uploads.captions = await uploadWithEndpoint(target.captions, artifacts.captionsPath);
  }
  if (target.timeline && artifacts.timelinePath) {
    record.uploads.timeline = await uploadWithEndpoint(target.timeline, artifacts.timelinePath);
  }
  if (target.variants.length > 0 && Array.isArray(artifacts.clipPaths)) {
    for (let i = 0; i < Math.min(target.variants.length, artifacts.clipPaths.length); i += 1) {
      const endpoint = target.variants[i];
      const source = artifacts.clipPaths[i];
      if (!endpoint || !source) continue;
      const result = await uploadWithEndpoint(endpoint, source);
      record.uploads.variants.push(result);
    }
  }

  return record;
}

async function processTarget(target, job, artifacts) {
  if (target.type === 'filesystem') {
    return deliverToFilesystem(target, job, artifacts);
  }
  if (target.type === 'presigned') {
    return deliverToPresigned(target, artifacts);
  }
  throw new Error(`Unsupported distribution target type: ${target.type}`);
}

export async function distributeOutputs(rawTargets, job, artifacts) {
  const targets = normalizeTargets(rawTargets);
  if (targets.length === 0) {
    return [];
  }
  const results = [];
  for (const target of targets) {
    try {
      const summary = await processTarget(target, job, artifacts);
      results.push({ ...summary, ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ type: target.type, name: target.name, ok: false, error: message });
      throw new DistributionError(`Distribution failed for target "${target.name}": ${message}`, results);
    }
  }
  return results;
}

export { DistributionError };

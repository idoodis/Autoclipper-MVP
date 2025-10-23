import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { loadConfig } from '../config.mjs';
import { createClip } from './clip.mjs';
import {
  initState,
  takeNextQueuedJob,
  finalizeJob,
  requeueJob,
} from '../../packages/state/index.mjs';

const config = loadConfig();
await initState(config.stateFile);
await fs.promises.mkdir(config.storageRoot, { recursive: true });

const ALLOWED_REMOTE_TYPES = [
  /^video\//i,
  /^audio\//i,
  'application/octet-stream',
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function matchesAllowedType(contentType) {
  if (!contentType) return true;
  return ALLOWED_REMOTE_TYPES.some((rule) => {
    if (typeof rule === 'string') {
      return contentType.toLowerCase().startsWith(rule.toLowerCase());
    }
    return rule.test(contentType);
  });
}

function inferExtension(contentType) {
  if (!contentType) return '.mp4';
  const lower = contentType.toLowerCase();
  if (lower.includes('mp4')) return '.mp4';
  if (lower.includes('webm')) return '.webm';
  if (lower.includes('quicktime')) return '.mov';
  if (lower.includes('x-matroska') || lower.includes('matroska')) return '.mkv';
  if (lower.includes('mpeg')) return '.mpg';
  if (lower.includes('x-msvideo')) return '.avi';
  if (lower.includes('ogg')) return '.ogv';
  if (lower.startsWith('audio/')) return '.mp3';
  return '.mp4';
}

function createLimiter(maxBytes) {
  let total = 0;
  return new Transform({
    transform(chunk, encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        callback(new Error('Download exceeded configured limit'));
      } else {
        callback(null, chunk);
      }
    },
  });
}

async function streamResponseToFile(response, targetPath) {
  if (!response.body) {
    throw new Error('Remote response did not include a body');
  }
  const limiter = createLimiter(config.downloadMaxBytes);
  const writeStream = fs.createWriteStream(targetPath);
  const source = response.body instanceof Readable ? response.body : Readable.fromWeb(response.body);
  await pipeline(source, limiter, writeStream);
}

async function downloadRemote(job, jobDir) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.downloadTimeoutMs);
  try {
    const response = await fetch(job.sourceUri, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'AutoclipperWorker/1.0',
      },
    });
    if (!response.ok) {
      throw new Error(`Failed to download source: HTTP ${response.status}`);
    }
    const contentType = response.headers.get('content-type') || '';
    const contentLength = Number.parseInt(response.headers.get('content-length') || '', 10);
    if (!matchesAllowedType(contentType)) {
      throw new Error(`Unsupported content type: ${contentType || 'unknown'}`);
    }
    if (Number.isFinite(contentLength) && contentLength > config.downloadMaxBytes) {
      throw new Error('Remote file exceeds configured size limit');
    }
    const extension = inferExtension(contentType);
    const targetPath = path.join(jobDir, `source${extension}`);
    await streamResponseToFile(response, targetPath);
    return targetPath;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Download timed out');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadIfNeeded(job, jobDir) {
  if (job.sourceUri.startsWith('http://') || job.sourceUri.startsWith('https://')) {
    return downloadRemote(job, jobDir);
  }
  if (path.isAbsolute(job.sourceUri)) {
    const exists = await fs.promises
      .access(job.sourceUri, fs.constants.R_OK)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      throw new Error(`Source file not found: ${job.sourceUri}`);
    }
    return job.sourceUri;
  }
  const resolved = path.resolve(process.cwd(), job.sourceUri);
  const exists = await fs.promises
    .access(resolved, fs.constants.R_OK)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    throw new Error(`Source file not found: ${resolved}`);
  }
  return resolved;
}

async function processJob(job, workerId) {
  const jobDir = path.join(config.storageRoot, job.id);
  await fs.promises.mkdir(jobDir, { recursive: true });
  console.log(`[worker-${workerId}] Processing job ${job.id} (attempt ${job.attempts})`);
  const sourcePath = await downloadIfNeeded(job, jobDir);
  const result = await createClip({
    vodPath: sourcePath,
    outDir: jobDir,
    maxDurationSeconds: job.maxDurationSeconds,
    watermarkText: job.watermarkText,
    projectRoot: process.cwd(),
    variantCount: job.variantCount,
  });
  await finalizeJob(config.stateFile, job.id, {
    status: 'completed',
    availableAt: null,
    errorMessage: null,
    output: {
      clip: result.clipPath,
      clips: result.clipPaths,
      captions: result.captionsPath,
      timeline: result.timelinePath,
      durationSeconds: result.durationSeconds,
    },
    metadata: {
      ...(job.metadata || {}),
      timeline: result.timeline,
      variants: result.variants,
    },
  });
  console.log(`[worker-${workerId}] Job ${job.id} completed in ${result.durationSeconds.toFixed(2)}s of footage`);
}

function computeRetryDelay(attempt) {
  const exponent = Math.max(0, attempt - 1);
  const backoff = config.workerRetryBaseMs * 2 ** exponent;
  return Math.min(backoff, config.downloadTimeoutMs * 4);
}

async function handleJob(job, workerId) {
  try {
    await processJob(job, workerId);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const attempts = job.attempts || 1;
    const canRetry = attempts < config.workerMaxRetries + 1;
    if (canRetry) {
      const delay = computeRetryDelay(attempts);
      console.warn(`[worker-${workerId}] Job ${job.id} failed (attempt ${attempts}): ${message}. Retrying in ${delay}ms.`);
      await requeueJob(config.stateFile, job.id, delay, message);
    } else {
      console.error(`[worker-${workerId}] Job ${job.id} permanently failed: ${message}`);
      await finalizeJob(config.stateFile, job.id, {
        status: 'failed',
        availableAt: null,
        errorMessage: message,
      });
    }
    return false;
  }
}

async function processLoop(workerId) {
  let idleDelay = config.workerIdleBackoffMs;
  const maxDelay = Math.max(config.pollIntervalMs, idleDelay * 4);
  while (true) {
    const job = await takeNextQueuedJob(config.stateFile);
    if (!job) {
      await sleep(idleDelay);
      idleDelay = Math.min(maxDelay, idleDelay * 2);
      continue;
    }
    idleDelay = config.workerIdleBackoffMs;
    await handleJob(job, workerId);
  }
}

async function runWorker() {
  console.log(
    `Worker starting with concurrency=${config.workerConcurrency}, pollInterval=${config.pollIntervalMs}ms`,
  );
  await Promise.all(
    Array.from({ length: config.workerConcurrency }, (_, index) => processLoop(index + 1)),
  );
}

runWorker().catch((err) => {
  console.error('Worker crashed', err);
  process.exit(1);
});

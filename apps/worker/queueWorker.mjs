import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.mjs';
import { createClip } from './clip.mjs';
import { initState, takeNextQueuedJob, updateJob } from '../../packages/state/index.mjs';

const config = loadConfig();
initState(config.stateFile);

if (!fs.existsSync(config.storageRoot)) {
  fs.mkdirSync(config.storageRoot, { recursive: true });
}

async function downloadIfNeeded(job, jobDir) {
  if (job.sourceUri.startsWith('http://') || job.sourceUri.startsWith('https://')) {
    const response = await fetch(job.sourceUri);
    if (!response.ok) {
      throw new Error(`Failed to download source: ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const target = path.join(jobDir, 'source');
    await fs.promises.writeFile(target, Buffer.from(arrayBuffer));
    return target;
  }
  if (path.isAbsolute(job.sourceUri)) {
    if (!fs.existsSync(job.sourceUri)) {
      throw new Error(`Source file not found: ${job.sourceUri}`);
    }
    return job.sourceUri;
  }
  const resolved = path.resolve(process.cwd(), job.sourceUri);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Source file not found: ${resolved}`);
  }
  return resolved;
}

async function processOnce() {
  const job = takeNextQueuedJob(config.stateFile);
  if (!job) {
    return false;
  }

  const jobDir = path.join(config.storageRoot, job.id);
  await fs.promises.mkdir(jobDir, { recursive: true });

  try {
    const sourcePath = await downloadIfNeeded(job, jobDir);
    const result = await createClip({
      vodPath: sourcePath,
      outDir: jobDir,
      maxDurationSeconds: job.maxDurationSeconds,
      watermarkText: job.watermarkText,
      projectRoot: process.cwd(),
    });
    updateJob(config.stateFile, job.id, {
      status: 'completed',
      output: {
        clip: result.clipPath,
        captions: result.captionsPath,
        timeline: result.timelinePath,
        durationSeconds: result.durationSeconds,
      },
      metadata: {
        ...(job.metadata || {}),
        timeline: result.timeline,
      },
    });
    console.log(`Job ${job.id} completed`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateJob(config.stateFile, job.id, {
      status: 'failed',
      errorMessage: message,
    });
    console.error(`Job ${job.id} failed:`, message);
  }

  return true;
}

async function runWorker() {
  console.log('Worker running with poll interval', config.pollIntervalMs, 'ms');
  while (true) {
    const processed = await processOnce();
    if (!processed) {
      await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
    }
  }
}

runWorker().catch((err) => {
  console.error('Worker crashed', err);
  process.exit(1);
});

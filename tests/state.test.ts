import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  initState,
  createTenant,
  createJob,
  takeNextQueuedJob,
  requeueJob,
  finalizeJob,
  listJobs,
} from '../packages/state/index.mjs';

describe('state store', () => {
  let tmpDir;
  let stateFile;
  let tenantId;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclipper-state-'));
    stateFile = path.join(tmpDir, 'state.db');
    await initState(stateFile);
    const tenant = await createTenant(stateFile, 'Test Tenant');
    tenantId = tenant.id;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('handles concurrent job creation without collisions', async () => {
    const jobs = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        createJob(stateFile, {
          tenantId,
          sourceUri: `/tmp/source-${index}.mp4`,
          watermarkText: 'Brand',
          maxDurationSeconds: 45,
          metadata: { index },
        }),
      ),
    );

    const uniqueIds = new Set(jobs.map((job) => job.id));
    expect(uniqueIds.size).toBe(jobs.length);
    const listed = await listJobs(stateFile, tenantId, 20);
    expect(listed.length).toBe(jobs.length);
    expect(listed[0].variantCount).toBeGreaterThan(0);
  });

  it('requeues jobs with exponential backoff', async () => {
    const job = await createJob(stateFile, {
      tenantId,
      sourceUri: '/tmp/source.mp4',
      watermarkText: 'Brand',
      maxDurationSeconds: 30,
    });

    const first = await takeNextQueuedJob(stateFile);
    expect(first?.id).toBe(job.id);
    await requeueJob(stateFile, job.id, 100, 'temporary failure');

    const immediate = await takeNextQueuedJob(stateFile);
    expect(immediate).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 120));
    const retried = await takeNextQueuedJob(stateFile);
    expect(retried?.id).toBe(job.id);
    expect(retried?.attempts).toBe(2);

    await finalizeJob(stateFile, job.id, { status: 'failed', errorMessage: 'boom' });
    const after = await takeNextQueuedJob(stateFile);
    expect(after).toBeNull();
  });

  it('honors sub-second requeue delays', async () => {
    const job = await createJob(stateFile, {
      tenantId,
      sourceUri: '/tmp/source-subsecond.mp4',
      watermarkText: 'Brand',
      maxDurationSeconds: 15,
    });

    const active = await takeNextQueuedJob(stateFile);
    expect(active?.id).toBe(job.id);
    await requeueJob(stateFile, job.id, 50, 'retry soon');

    const immediate = await takeNextQueuedJob(stateFile);
    expect(immediate).toBeNull();

    const start = Date.now();
    let ready;
    while (!ready) {
      ready = await takeNextQueuedJob(stateFile);
      if (!ready) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }

    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(ready?.id).toBe(job.id);
    expect(ready?.attempts).toBe(2);
  });
});

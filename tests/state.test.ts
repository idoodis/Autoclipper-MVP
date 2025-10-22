import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  initState,
  createJob,
  takeNextQueuedJob,
  requeueJob,
  finalizeJob,
  listJobs,
} from '../packages/state/index.mjs';

const TENANT_ID = 'tenant-test';

describe('state store', () => {
  let tmpDir;
  let stateFile;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclipper-state-'));
    stateFile = path.join(tmpDir, 'state.json');
    await initState(stateFile);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('handles concurrent job creation without collisions', async () => {
    const jobs = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        createJob(stateFile, {
          tenantId: TENANT_ID,
          sourceUri: `/tmp/source-${index}.mp4`,
          watermarkText: 'Brand',
          maxDurationSeconds: 45,
          metadata: { index },
        }),
      ),
    );

    const uniqueIds = new Set(jobs.map((job) => job.id));
    expect(uniqueIds.size).toBe(jobs.length);
    const listed = await listJobs(stateFile, TENANT_ID, 20);
    expect(listed.length).toBe(jobs.length);
  });

  it('requeues jobs with exponential backoff', async () => {
    const job = await createJob(stateFile, {
      tenantId: TENANT_ID,
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
});

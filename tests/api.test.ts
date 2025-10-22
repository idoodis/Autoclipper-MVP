import { createTenant } from '../packages/state/index.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

const ADMIN_TOKEN = 'test-admin-token';

describe('API server', () => {
  let tmpDir;
  let server;
  let baseUrl;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoclipper-test-'));
    process.env.ADMIN_TOKEN = ADMIN_TOKEN;
    process.env.STATE_FILE = path.join(tmpDir, 'state.json');
    process.env.STORAGE_ROOT = path.join(tmpDir, 'jobs');
    process.env.PORT = '0';
    const module = await import('../apps/api/server.mjs');
    server = module.createApiServer();
    await new Promise((resolve) => server.listen(0, resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates tenants and queues jobs', async () => {
    const tenantRes = await fetch(`${baseUrl}/v1/tenants`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-token': ADMIN_TOKEN,
      },
      body: JSON.stringify({ name: 'Test Creator' }),
    });
    expect(tenantRes.status).toBe(201);
    const tenantBody = await tenantRes.json();
    expect(tenantBody.tenant.name).toBe('Test Creator');
    const apiKey = tenantBody.apiKey;

    const jobRes = await fetch(`${baseUrl}/v1/jobs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({ sourceUri: path.join(process.cwd(), 'samples', 'vod.mp4'), watermarkText: 'Brand' }),
    });
    expect(jobRes.status).toBe(202);
    const jobBody = await jobRes.json();
    expect(jobBody.job.status).toBe('queued');

    const listRes = await fetch(`${baseUrl}/v1/jobs`, {
      headers: { 'x-api-key': apiKey },
    });
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.jobs.length).toBe(1);

    const jobId = jobBody.job.id;
    const getRes = await fetch(`${baseUrl}/v1/jobs/${jobId}`, {
      headers: { 'x-api-key': apiKey },
    });
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.job.id).toBe(jobId);
  });

  it('enforces authentication', async () => {
    const tenantRes = await fetch(`${baseUrl}/v1/tenants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Nope' }),
    });
    expect(tenantRes.status).toBe(401);

    const seeded = await createTenant(process.env.STATE_FILE, 'Tenant');
    const apiKey = seeded.apiKey;

    const unauthorizedJob = await fetch(`${baseUrl}/v1/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourceUri: 'foo' }),
    });
    expect(unauthorizedJob.status).toBe(401);

    const badJob = await fetch(`${baseUrl}/v1/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ sourceUri: 123 }),
    });
    expect(badJob.status).toBe(400);
  });
});

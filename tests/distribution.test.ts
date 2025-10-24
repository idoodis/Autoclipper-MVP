import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { distributeOutputs } from '../packages/distribution/index.mjs';

describe('distribution targets', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'distribution-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createArtifacts() {
    const clipPath = path.join(tmpDir, 'clip.mp4');
    const variantPath = path.join(tmpDir, 'clip-alt.mp4');
    const captionsPath = path.join(tmpDir, 'captions.srt');
    const timelinePath = path.join(tmpDir, 'timeline.json');
    fs.writeFileSync(clipPath, 'clip');
    fs.writeFileSync(variantPath, 'clip-variant');
    fs.writeFileSync(captionsPath, 'captions');
    fs.writeFileSync(timelinePath, JSON.stringify({}));
    return { clipPath, variantPath, captionsPath, timelinePath };
  }

  it('writes artifacts to filesystem targets and reports urls', async () => {
    const { clipPath, variantPath, captionsPath, timelinePath } = createArtifacts();
    const destination = path.join(tmpDir, 'out');
    const targets = [
      {
        type: 'filesystem',
        directory: destination,
        publicBaseUrl: 'https://cdn.example.com/media',
      },
    ];
    const results = await distributeOutputs(targets, { tenantId: 'tenant', id: 'job-123' }, {
      clipPath,
      clipPaths: [clipPath, variantPath],
      captionsPath,
      timelinePath,
    });

    expect(results).toHaveLength(1);
    const record = results[0];
    expect(record.ok).toBe(true);
    expect(record.files.clip?.publicUrl).toContain('cdn.example.com');
    const variantFiles = record.files.variants || [];
    expect(variantFiles.length).toBeGreaterThan(0);
    variantFiles.forEach((file) => {
      expect(fs.existsSync(file.path)).toBe(true);
    });
  });

  it('streams uploads to presigned endpoints', async () => {
    const { clipPath, captionsPath, timelinePath } = createArtifacts();
    const received: Record<string, number> = {};
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        received[req.url || '/'] = body.length;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address !== 'object') {
      throw new Error('Failed to start test server');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const targets = [
      {
        type: 'presigned',
        name: 'local',
        artifacts: {
          clip: { url: `${baseUrl}/clip` },
          captions: { url: `${baseUrl}/captions` },
          timeline: { url: `${baseUrl}/timeline` },
        },
      },
    ];

    try {
      const results = await distributeOutputs(targets, { tenantId: 'tenant', id: 'job-234' }, {
        clipPath,
        clipPaths: [clipPath],
        captionsPath,
        timelinePath,
      });
      expect(results[0].uploads.clip?.status).toBe(200);
      expect(received['/clip']).toBeGreaterThan(0);
      expect(received['/captions']).toBeGreaterThan(0);
      expect(received['/timeline']).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

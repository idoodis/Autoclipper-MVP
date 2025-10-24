import http from 'node:http';
import { parse } from 'node:url';

import { loadConfig } from '../config.mjs';
import {
  initState,
  createTenant,
  findTenantByApiKey,
  createJob,
  listJobs,
  getJob,
} from '../../packages/state/index.mjs';

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type,x-api-key,x-admin-token',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    return null;
  }
}

export function createApiServer(config = loadConfig()) {
  const stateReady = initState(config.stateFile);
  const server = http.createServer(async (req, res) => {
    await stateReady;
    const { pathname } = parse(req.url || '/', true);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type,x-api-key,x-admin-token',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
      });
      return res.end();
    }

    if (pathname === '/healthz' && req.method === 'GET') {
      return sendJson(res, 200, { status: 'ok' });
    }

    if (pathname === '/v1/tenants' && req.method === 'POST') {
      if (req.headers['x-admin-token'] !== config.adminToken) {
        return sendJson(res, 401, { error: 'Missing or invalid admin token' });
      }
      const body = (await readBody(req)) || {};
      if (!body.name || typeof body.name !== 'string') {
        return sendJson(res, 400, { error: 'name is required' });
      }
      const tenant = await createTenant(config.stateFile, body.name.trim());
      return sendJson(res, 201, {
        tenant: { id: tenant.id, name: tenant.name, createdAt: tenant.createdAt },
        apiKey: tenant.apiKey,
      });
    }

    if (pathname === '/v1/jobs' && req.method === 'POST') {
      const apiKey = req.headers['x-api-key'];
      const tenant =
        typeof apiKey === 'string' ? await findTenantByApiKey(config.stateFile, apiKey) : null;
      if (!tenant) {
        return sendJson(res, 401, { error: 'Invalid API key' });
      }
      const body = (await readBody(req)) || {};
      if (!body.sourceUri || typeof body.sourceUri !== 'string') {
        return sendJson(res, 400, { error: 'sourceUri is required' });
      }
      const watermarkText =
        typeof body.watermarkText === 'string' && body.watermarkText.trim().length > 0
          ? body.watermarkText.trim()
          : tenant.name;
      const maxDuration = Number.isFinite(body.maxDurationSeconds)
        ? Math.max(5, Math.min(120, Number(body.maxDurationSeconds)))
        : 59;
      const variantCount = Number.isFinite(body.variantCount)
        ? Math.max(1, Math.min(5, Number(body.variantCount)))
        : undefined;
      const job = await createJob(config.stateFile, {
        tenantId: tenant.id,
        sourceUri: body.sourceUri,
        watermarkText,
        maxDurationSeconds: maxDuration,
        metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
        variantCount,
      });
      return sendJson(res, 202, { job });
    }

    if (pathname === '/v1/jobs' && req.method === 'GET') {
      const apiKey = req.headers['x-api-key'];
      const tenant =
        typeof apiKey === 'string' ? await findTenantByApiKey(config.stateFile, apiKey) : null;
      if (!tenant) {
        return sendJson(res, 401, { error: 'Invalid API key' });
      }
      const jobs = await listJobs(config.stateFile, tenant.id);
      return sendJson(res, 200, { jobs });
    }

    if (pathname && pathname.startsWith('/v1/jobs/') && req.method === 'GET') {
      const apiKey = req.headers['x-api-key'];
      const tenant =
        typeof apiKey === 'string' ? await findTenantByApiKey(config.stateFile, apiKey) : null;
      if (!tenant) {
        return sendJson(res, 401, { error: 'Invalid API key' });
      }
      const jobId = pathname.split('/').pop();
      const job = jobId ? await getJob(config.stateFile, jobId) : null;
      if (!job || job.tenantId !== tenant.id) {
        return sendJson(res, 404, { error: 'Job not found' });
      }
      return sendJson(res, 200, { job });
    }

    sendJson(res, 404, { error: 'Not found' });
  });
  server.keepAliveTimeout = 0;
  server.headersTimeout = Math.max(server.headersTimeout, 60_000);
  return server;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const config = loadConfig();
  const server = createApiServer(config);
  server.listen(config.port, () => {
    console.log(`API server listening on http://localhost:${config.port}`);
  });
}

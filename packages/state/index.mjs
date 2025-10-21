import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function defaultState() {
  return { tenants: [], jobs: [] };
}

function loadState(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return defaultState();
    }
    throw error;
  }
}

function saveState(filePath, state) {
  ensureDir(filePath);
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
  fs.renameSync(tmpPath, filePath);
}

function withState(filePath, updater) {
  const state = loadState(filePath);
  const result = updater(state);
  saveState(filePath, state);
  return result;
}

export function initState(filePath) {
  ensureDir(filePath);
  if (!fs.existsSync(filePath)) {
    saveState(filePath, defaultState());
  }
}

export function createTenant(filePath, name) {
  const createdAt = new Date().toISOString();
  const tenant = {
    id: crypto.randomUUID(),
    name,
    apiKey: crypto.randomUUID().replace(/-/g, ''),
    createdAt,
  };
  return withState(filePath, (state) => {
    state.tenants.push(tenant);
    return tenant;
  });
}

export function listTenants(filePath) {
  const state = loadState(filePath);
  return state.tenants.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function findTenantByApiKey(filePath, apiKey) {
  const state = loadState(filePath);
  return state.tenants.find((tenant) => tenant.apiKey === apiKey) || null;
}

export function createJob(filePath, jobInput) {
  const createdAt = new Date().toISOString();
  const job = {
    id: crypto.randomUUID(),
    tenantId: jobInput.tenantId,
    sourceUri: jobInput.sourceUri,
    watermarkText: jobInput.watermarkText,
    maxDurationSeconds: jobInput.maxDurationSeconds,
    status: 'queued',
    createdAt,
    updatedAt: createdAt,
    metadata: jobInput.metadata || {},
  };
  return withState(filePath, (state) => {
    state.jobs.push(job);
    return job;
  });
}

export function listJobs(filePath, tenantId, limit = 50) {
  const state = loadState(filePath);
  return state.jobs
    .filter((job) => job.tenantId === tenantId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, limit);
}

export function getJob(filePath, jobId) {
  const state = loadState(filePath);
  return state.jobs.find((job) => job.id === jobId) || null;
}

export function updateJob(filePath, jobId, patch) {
  return withState(filePath, (state) => {
    const job = state.jobs.find((item) => item.id === jobId);
    if (!job) {
      return null;
    }
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    return job;
  });
}

export function takeNextQueuedJob(filePath) {
  let result = null;
  withState(filePath, (state) => {
    const job = state.jobs.find((item) => item.status === 'queued');
    if (job) {
      job.status = 'processing';
      job.updatedAt = new Date().toISOString();
      result = { ...job };
    }
    return null;
  });
  return result;
}

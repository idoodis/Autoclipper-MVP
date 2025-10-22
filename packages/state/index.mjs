import crypto from 'node:crypto';
import path from 'node:path';

import { initStore, withStore, loadStore } from '../storage/jsonStore.mjs';

const DEFAULT_STATE = { tenants: [], jobs: [] };

function normalizePath(filePath) {
  return path.resolve(filePath);
}

export async function initState(filePath) {
  const resolved = normalizePath(filePath);
  await initStore(resolved, DEFAULT_STATE);
}

async function mutateState(filePath, mutator) {
  const resolved = normalizePath(filePath);
  return withStore(resolved, DEFAULT_STATE, mutator);
}

async function readState(filePath) {
  const resolved = normalizePath(filePath);
  return loadStore(resolved, DEFAULT_STATE);
}

export async function createTenant(filePath, name) {
  const createdAt = new Date().toISOString();
  const tenant = {
    id: crypto.randomUUID(),
    name,
    apiKey: crypto.randomUUID().replace(/-/g, ''),
    createdAt,
  };
  await mutateState(filePath, (state) => {
    state.tenants.push(tenant);
  });
  return tenant;
}

export async function listTenants(filePath) {
  const state = await readState(filePath);
  return state.tenants.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function findTenantByApiKey(filePath, apiKey) {
  const state = await readState(filePath);
  return state.tenants.find((tenant) => tenant.apiKey === apiKey) || null;
}

export async function createJob(filePath, jobInput) {
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
    availableAt: createdAt,
    attempts: 0,
    errorMessage: null,
    metadata: jobInput.metadata || {},
  };
  await mutateState(filePath, (state) => {
    state.jobs.push(job);
  });
  return job;
}

export async function listJobs(filePath, tenantId, limit = 50) {
  const state = await readState(filePath);
  return state.jobs
    .filter((job) => job.tenantId === tenantId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, limit);
}

export async function getJob(filePath, jobId) {
  const state = await readState(filePath);
  return state.jobs.find((job) => job.id === jobId) || null;
}

export async function updateJob(filePath, jobId, patch) {
  let updated = null;
  await mutateState(filePath, (state) => {
    const job = state.jobs.find((item) => item.id === jobId);
    if (!job) {
      return;
    }
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    updated = { ...job };
  });
  return updated;
}

function isJobReady(job) {
  if (job.status !== 'queued') {
    return false;
  }
  if (!job.availableAt) {
    return true;
  }
  return new Date(job.availableAt).getTime() <= Date.now();
}

export async function takeNextQueuedJob(filePath) {
  let result = null;
  await mutateState(filePath, (state) => {
    const job = state.jobs.find((item) => isJobReady(item));
    if (job) {
      job.status = 'processing';
      job.attempts = (job.attempts || 0) + 1;
      job.availableAt = null;
      job.updatedAt = new Date().toISOString();
      result = { ...job };
    }
  });
  return result;
}

export async function requeueJob(filePath, jobId, delayMs, errorMessage) {
  const retryAt = new Date(Date.now() + Math.max(0, delayMs || 0)).toISOString();
  return updateJob(filePath, jobId, {
    status: 'queued',
    availableAt: retryAt,
    errorMessage: errorMessage || null,
  });
}

export async function finalizeJob(filePath, jobId, statusPatch) {
  return updateJob(filePath, jobId, statusPatch);
}

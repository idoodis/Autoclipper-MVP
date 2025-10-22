import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function loadEnvFile() {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) {
    return;
  }
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.trim().startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile();

function ensureSecret(envKey, defaultBytes) {
  const current = (process.env[envKey] || '').trim();
  if (current.length >= 12) {
    return current;
  }
  const generated = crypto.randomBytes(defaultBytes).toString('hex');
  if (!process.env[envKey]) {
    process.env[envKey] = generated;
  }
  console.warn(`${envKey} was not set. Generated a temporary value. Override this in production.`);
  return generated;
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  return fallback;
}

export function loadConfig() {
  const port = parseInteger(process.env.PORT, 3000);
  const stateFile = process.env.STATE_FILE || path.join(process.cwd(), 'storage', 'state.json');
  const storageRoot = process.env.STORAGE_ROOT || path.join(process.cwd(), 'storage', 'jobs');
  const pollIntervalMs = Math.max(250, parseInteger(process.env.WORKER_POLL_MS, 2000));
  const workerConcurrency = Math.max(1, parseInteger(process.env.WORKER_CONCURRENCY, 2));
  const workerMaxRetries = Math.max(0, parseInteger(process.env.WORKER_MAX_RETRIES, 3));
  const workerRetryBaseMs = Math.max(1000, parseInteger(process.env.WORKER_RETRY_BASE_MS, 5000));
  const workerIdleBackoffMs = Math.max(250, parseInteger(process.env.WORKER_IDLE_BACKOFF_MS, 1000));
  const downloadMaxBytes = Math.max(1, parseInteger(process.env.WORKER_DOWNLOAD_MAX_BYTES, 1_500_000_000));
  const downloadTimeoutMs = Math.max(1000, parseInteger(process.env.WORKER_DOWNLOAD_TIMEOUT_MS, 120_000));

  const adminToken = ensureSecret('ADMIN_TOKEN', 24);

  return {
    port,
    adminToken,
    stateFile,
    storageRoot,
    pollIntervalMs,
    workerConcurrency,
    workerMaxRetries,
    workerRetryBaseMs,
    workerIdleBackoffMs,
    downloadMaxBytes,
    downloadTimeoutMs,
  };
}

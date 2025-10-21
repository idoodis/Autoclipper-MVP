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

export function loadConfig() {
  const port = Number.parseInt(process.env.PORT || '3000', 10) || 3000;
  const adminToken = process.env.ADMIN_TOKEN || 'dev-admin-token';
  const stateFile = process.env.STATE_FILE || path.join(process.cwd(), 'storage', 'state.json');
  const storageRoot = process.env.STORAGE_ROOT || path.join(process.cwd(), 'storage', 'jobs');
  const pollIntervalMs = Number.parseInt(process.env.WORKER_POLL_MS || '5000', 10) || 5000;

  return {
    port,
    adminToken,
    stateFile,
    storageRoot,
    pollIntervalMs,
  };
}

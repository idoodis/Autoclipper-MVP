import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveStorage(relativePath) {
  return path.resolve(path.join(__dirname, '../../', relativePath));
}

function ensureSecret(envKey, bytes) {
  const current = (process.env[envKey] || '').trim();
  if (current.length >= 12) {
    return current;
  }
  const generated = crypto.randomBytes(bytes).toString('hex');
  if (!process.env[envKey]) {
    process.env[envKey] = generated;
  }
  console.warn(`${envKey} was not set. Generated a temporary value. Override this in production.`);
  return generated;
}

export function loadDashboardConfig() {
  return {
    port: Number.parseInt(process.env.DASHBOARD_PORT || '4000', 10),
    apiBaseUrl: process.env.API_BASE_URL || 'http://localhost:3000',
    adminToken: process.env.ADMIN_TOKEN || '',
    stateFile:
      process.env.DASHBOARD_STATE_FILE || resolveStorage('storage/dashboard-users.json'),
    uploadDir: process.env.UPLOAD_ROOT || resolveStorage('storage/uploads'),
    sessionSecret: ensureSecret('SESSION_SECRET', 32),
    sessionStoreFile:
      process.env.SESSION_STORE_FILE || resolveStorage('storage/dashboard-sessions.json'),
  };
}

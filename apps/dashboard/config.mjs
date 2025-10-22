import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveStorage(relativePath) {
  return path.resolve(path.join(__dirname, '../../', relativePath));
}

export function loadDashboardConfig() {
  return {
    port: Number.parseInt(process.env.DASHBOARD_PORT || '4000', 10),
    apiBaseUrl: process.env.API_BASE_URL || 'http://localhost:3000',
    adminToken: process.env.ADMIN_TOKEN || '',
    stateFile:
      process.env.DASHBOARD_STATE_FILE || resolveStorage('storage/dashboard-users.json'),
    uploadDir: process.env.UPLOAD_ROOT || resolveStorage('storage/uploads'),
    sessionSecret: process.env.SESSION_SECRET || 'change-me',
  };
}

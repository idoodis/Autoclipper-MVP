import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import { loadDashboardConfig } from './config.mjs';
import { createUser, findUserByEmail, findUserById, initUserState, toPublicUser } from './state.mjs';
import {
  initSessionStore,
  createSession as createSessionRecord,
  getSession as getSessionRecord,
  deleteSession as deleteSessionRecord,
} from '../../packages/session/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(__dirname, 'public');

const config = loadDashboardConfig();

if (!config.adminToken) {
  console.warn('Warning: ADMIN_TOKEN not set. User registration will fail.');
}

await initUserState(config.stateFile);
await initSessionStore(config.sessionStoreFile);
fs.mkdirSync(config.uploadDir, { recursive: true });

const SESSION_TTL_MS = 1000 * 60 * 60 * 24;

function signSession(sessionId) {
  return crypto.createHmac('sha256', config.sessionSecret).update(sessionId).digest('hex');
}

function appendCookie(res, cookie) {
  const current = res.getHeader('Set-Cookie');
  if (!current) {
    res.setHeader('Set-Cookie', cookie);
  } else if (Array.isArray(current)) {
    res.setHeader('Set-Cookie', [...current, cookie]);
  } else {
    res.setHeader('Set-Cookie', [current, cookie]);
  }
}

async function createSession(res, userId) {
  const sessionId = await createSessionRecord(config.sessionStoreFile, userId, SESSION_TTL_MS);
  const cookieValue = `${sessionId}.${signSession(sessionId)}`;
  appendCookie(
    res,
    `sid=${cookieValue}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  );
}

async function destroySession(req, res) {
  const cookie = parseCookies(req).sid;
  if (cookie) {
    const [sessionId] = cookie.split('.');
    if (sessionId) {
      await deleteSessionRecord(config.sessionStoreFile, sessionId);
    }
  }
  appendCookie(res, 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  return header.split(';').reduce((acc, pair) => {
    const [name, ...rest] = pair.trim().split('=');
    if (name) {
      acc[name] = decodeURIComponent(rest.join('=') || '');
    }
    return acc;
  }, {});
}

async function getSessionUser(req) {
  const raw = parseCookies(req).sid;
  if (!raw) return null;
  const [sessionId, signature] = raw.split('.');
  if (!sessionId || !signature) return null;
  if (signSession(sessionId) !== signature) return null;
  const session = await getSessionRecord(config.sessionStoreFile, sessionId);
  if (!session) {
    return null;
  }
  const user = await findUserById(session.userId);
  if (!user) {
    await deleteSessionRecord(config.sessionStoreFile, sessionId);
    return null;
  }
  return user;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      resolve(buffer);
    });
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const buffer = await readRequestBody(req);
  if (!buffer.length) return {};
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    return null;
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function getContentType(filePath) {
  const ext = path.extname(filePath);
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.mp4':
      return 'video/mp4';
    case '.srt':
      return 'application/x-subrip';
    default:
      return 'application/octet-stream';
  }
}

function sanitizeFileName(name) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-').toLowerCase();
}

function saveUpload(upload) {
  const { filename, data } = upload;
  if (!data || typeof data !== 'string') {
    throw new Error('Invalid upload data');
  }
  const safeName = sanitizeFileName(filename || 'upload.mp4');
  const ext = path.extname(safeName) || '.mp4';
  const stem = path.basename(safeName, ext);
  const targetName = `${stem}-${Date.now()}${ext}`;
  const targetPath = path.join(config.uploadDir, targetName);
  const buffer = Buffer.from(data, 'base64');
  if (buffer.length === 0) {
    throw new Error('Upload payload was empty');
  }
  if (buffer.length > 1024 * 1024 * 800) {
    throw new Error('Upload exceeds 800MB limit');
  }
  fs.writeFileSync(targetPath, buffer);
  return targetPath;
}

async function ensureAuth(req, res) {
  const user = await getSessionUser(req);
  if (!user) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return null;
  }
  return user;
}

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(`${salt}:${derivedKey.toString('hex')}`);
    });
  });
}

function verifyPassword(password, hash) {
  return new Promise((resolve, reject) => {
    const [salt, keyHex] = (hash || '').split(':');
    if (!salt || !keyHex) return resolve(false);
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) return reject(err);
      const key = Buffer.from(keyHex, 'hex');
      if (key.length !== derivedKey.length) {
        return resolve(false);
      }
      resolve(crypto.timingSafeEqual(key, derivedKey));
    });
  });
}

async function handleRegister(req, res) {
  const body = await readJsonBody(req);
  if (!body) {
    return sendJson(res, 400, { error: 'Invalid JSON body' });
  }
  const { name, email, password } = body;
  if (!name || !email || !password) {
    return sendJson(res, 400, { error: 'Name, email, and password are required' });
  }
  if (typeof email !== 'string' || typeof password !== 'string' || typeof name !== 'string') {
    return sendJson(res, 400, { error: 'Invalid payload' });
  }
  try {
    const existing = await findUserByEmail(email);
    if (existing) {
      return sendJson(res, 409, { error: 'Email already registered' });
    }

    const passwordHash = await hashPassword(password);
    const response = await fetch(`${config.apiBaseUrl}/v1/tenants`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-token': config.adminToken,
      },
      body: JSON.stringify({ name: name.trim() }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      return sendJson(res, response.status, { error: body.error || 'Failed to create tenant' });
    }
    const { tenant, apiKey } = await response.json();
    const user = await createUser({
      name: name.trim(),
      email: email.toLowerCase(),
      passwordHash,
      tenantId: tenant.id,
      apiKey,
    });
    await createSession(res, user.id);
    return sendJson(res, 201, { user: toPublicUser(user) });
  } catch (error) {
    console.error('Registration failed', error);
    return sendJson(res, 500, { error: 'Unexpected error during registration' });
  }
}

async function handleLogin(req, res) {
  const body = await readJsonBody(req);
  if (!body) {
    return sendJson(res, 400, { error: 'Invalid JSON body' });
  }
  const { email, password } = body;
  if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
    return sendJson(res, 400, { error: 'Email and password are required' });
  }
  const user = await findUserByEmail(email);
  if (!user) {
    return sendJson(res, 401, { error: 'Invalid credentials' });
  }
  try {
    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      return sendJson(res, 401, { error: 'Invalid credentials' });
    }
    await createSession(res, user.id);
    return sendJson(res, 200, { user: toPublicUser(user) });
  } catch (error) {
    console.error('Login failed', error);
    return sendJson(res, 500, { error: 'Unexpected error during login' });
  }
}

async function handleCreateJob(req, res, user) {
  const body = await readJsonBody(req);
  if (!body) {
    return sendJson(res, 400, { error: 'Invalid JSON body' });
  }
  let sourceUri = null;
  if (body.upload && typeof body.upload === 'object') {
    try {
      sourceUri = saveUpload(body.upload);
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
  } else if (body.sourceUrl && typeof body.sourceUrl === 'string' && body.sourceUrl.startsWith('http')) {
    sourceUri = body.sourceUrl.trim();
  }
  if (!sourceUri) {
    return sendJson(res, 400, { error: 'Provide an upload or a valid source URL' });
  }

  const payload = { sourceUri };
  if (body.watermarkText && typeof body.watermarkText === 'string' && body.watermarkText.trim()) {
    payload.watermarkText = body.watermarkText.trim();
  }
  const maxDuration = Number.parseInt(body.maxDurationSeconds, 10);
  if (Number.isFinite(maxDuration)) {
    payload.maxDurationSeconds = maxDuration;
  }

  try {
    const response = await fetch(`${config.apiBaseUrl}/v1/jobs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': user.apiKey,
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const respBody = await response.json().catch(() => ({}));
      return sendJson(res, response.status, { error: respBody.error || 'Failed to queue job' });
    }
    const respBody = await response.json();
    return sendJson(res, 202, respBody);
  } catch (error) {
    console.error('Failed to create job', error);
    return sendJson(res, 500, { error: 'Unexpected error when submitting job' });
  }
}

async function proxyJobs(req, res, user, jobId, fileType) {
  try {
    const url = jobId ? `${config.apiBaseUrl}/v1/jobs/${jobId}` : `${config.apiBaseUrl}/v1/jobs`;
    const response = await fetch(url, {
      headers: {
        'x-api-key': user.apiKey,
      },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      return sendJson(res, response.status, { error: body.error || 'Failed to fetch jobs' });
    }
    if (fileType) {
      const job = await response.json();
      const target = job?.job;
      if (!target || !target.output || !target.output[fileType]) {
        return sendJson(res, 404, { error: 'Artifact not available yet' });
      }
      const artifactPath = target.output[fileType];
      if (!fs.existsSync(artifactPath)) {
        return sendJson(res, 404, { error: 'Artifact missing on disk' });
      }
      const stat = fs.statSync(artifactPath);
      res.writeHead(200, {
        'content-type': getContentType(artifactPath),
        'content-length': stat.size,
      });
      fs.createReadStream(artifactPath).pipe(res);
      return;
    }
    const body = await response.json();
    return sendJson(res, 200, body);
  } catch (error) {
    console.error('Proxy request failed', error);
    return sendJson(res, 500, { error: 'Unexpected proxy error' });
  }
}

function serveStatic(req, res) {
  const filePath = path.join(publicRoot, req.url === '/' ? 'index.html' : req.url.replace(/^\//, ''));
  if (!filePath.startsWith(publicRoot)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'content-type': getContentType(filePath) });
    res.end(data);
  });
}

export function createDashboardServer() {
  return http.createServer(async (req, res) => {
    const { url, method } = req;
    if (!url || !method) {
      res.writeHead(400);
      return res.end('Bad request');
    }

    if (url.startsWith('/api/')) {
      if (url === '/api/auth/register' && method === 'POST') {
        return handleRegister(req, res);
      }
      if (url === '/api/auth/login' && method === 'POST') {
        return handleLogin(req, res);
      }
      if (url === '/api/auth/logout' && method === 'POST') {
        await destroySession(req, res);
        return sendJson(res, 200, { success: true });
      }
      if (url === '/api/session' && method === 'GET') {
        const user = await getSessionUser(req);
        if (!user) {
          return sendJson(res, 401, { error: 'Unauthorized' });
        }
        return sendJson(res, 200, { user: toPublicUser(user) });
      }
      if (url === '/api/jobs' && method === 'POST') {
        const user = await ensureAuth(req, res);
        if (!user) return;
        return handleCreateJob(req, res, user);
      }
      if (url === '/api/jobs' && method === 'GET') {
        const user = await ensureAuth(req, res);
        if (!user) return;
        return proxyJobs(req, res, user);
      }
      if (url.startsWith('/api/jobs/') && method === 'GET') {
        const user = await ensureAuth(req, res);
        if (!user) return;
        const [, , , jobId, files, artifact] = url.split('/');
        if (files === 'files' && artifact) {
          return proxyJobs(req, res, user, jobId, artifact);
        }
        return proxyJobs(req, res, user, jobId);
      }
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    if (method === 'GET') {
      return serveStatic(req, res);
    }

    res.writeHead(405);
    res.end('Method not allowed');
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const server = createDashboardServer();
  server.listen(config.port, () => {
    console.log(`Dashboard listening on http://localhost:${config.port}`);
  });
}

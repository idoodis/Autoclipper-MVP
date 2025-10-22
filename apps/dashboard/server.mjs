import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import { loadDashboardConfig } from './config.mjs';
import { createUser, findUserByEmail, findUserById, initUserState, toPublicUser } from './state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(__dirname, 'public');

const config = loadDashboardConfig();

if (!config.adminToken) {
  console.warn('Warning: ADMIN_TOKEN not set. User registration will fail.');
}

initUserState(config.stateFile);
fs.mkdirSync(config.uploadDir, { recursive: true });

const sessions = new Map();

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

function createSession(res, userId) {
  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, { userId, createdAt: Date.now() });
  const cookieValue = `${sessionId}.${signSession(sessionId)}`;
  appendCookie(
    res,
    `sid=${cookieValue}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24}`,
  );
}

function destroySession(req, res) {
  const cookie = parseCookies(req).sid;
  if (cookie) {
    const [sessionId] = cookie.split('.');
    if (sessionId) {
      sessions.delete(sessionId);
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

function getSessionUser(req) {
  const raw = parseCookies(req).sid;
  if (!raw) return null;
  const [sessionId, signature] = raw.split('.');
  if (!sessionId || !signature) return null;
  if (signSession(sessionId) !== signature) return null;
  const session = sessions.get(sessionId);
  if (!session) return null;
  const user = findUserById(session.userId);
  if (!user) {
    sessions.delete(sessionId);
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

function ensureAuth(req, res) {
  const user = getSessionUser(req);
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
  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    return sendJson(res, 400, { error: 'Name must be at least 2 characters' });
  }
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return sendJson(res, 400, { error: 'Valid email is required' });
  }
  if (!password || typeof password !== 'string' || password.length < 8) {
    return sendJson(res, 400, { error: 'Password must be at least 8 characters' });
  }
  if (!config.adminToken) {
    return sendJson(res, 500, { error: 'Server missing ADMIN_TOKEN configuration' });
  }
  if (findUserByEmail(email)) {
    return sendJson(res, 409, { error: 'Email already registered' });
  }

  try {
    const tenantResponse = await fetch(`${config.apiBaseUrl}/v1/tenants`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-token': config.adminToken,
      },
      body: JSON.stringify({ name: name.trim() }),
    });
    if (!tenantResponse.ok) {
      const payload = await tenantResponse.json().catch(() => ({}));
      return sendJson(res, 502, {
        error: 'Failed to provision tenant',
        details: payload.error || tenantResponse.statusText,
      });
    }
    const { tenant, apiKey } = await tenantResponse.json();
    const passwordHash = await hashPassword(password);
    const user = createUser({
      name: name.trim(),
      email: email.toLowerCase(),
      passwordHash,
      tenantId: tenant.id,
      apiKey,
    });
    createSession(res, user.id);
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
  const user = findUserByEmail(email);
  if (!user) {
    return sendJson(res, 401, { error: 'Invalid credentials' });
  }
  try {
    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      return sendJson(res, 401, { error: 'Invalid credentials' });
    }
    createSession(res, user.id);
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
    if (!fileType) {
      const body = await response.json();
      return sendJson(res, 200, body);
    }
    const { job } = await response.json();
    if (!job || job.status !== 'completed' || !job.output) {
      return sendJson(res, 400, { error: 'Job is not completed yet' });
    }
    const filePath = job.output[fileType];
    if (!filePath || !fs.existsSync(filePath)) {
      return sendJson(res, 404, { error: 'File not found' });
    }
    const stream = fs.createReadStream(filePath);
    stream.on('open', () => {
      const stats = fs.statSync(filePath);
      res.writeHead(200, {
        'content-length': stats.size,
        'content-type': getContentType(filePath),
        'content-disposition': `attachment; filename="${path.basename(filePath)}"`,
      });
      stream.pipe(res);
    });
    stream.on('error', (err) => {
      console.error('Failed to read job file', err);
      sendJson(res, 500, { error: 'Error streaming file' });
    });
  } catch (error) {
    console.error('Failed to proxy jobs', error);
    return sendJson(res, 500, { error: 'Unexpected error when fetching jobs' });
  }
}

function serveStatic(req, res, pathname) {
  let filePath = path.normalize(path.join(publicRoot, pathname));
  if (pathname === '/' || pathname === '') {
    filePath = path.join(publicRoot, 'index.html');
  }
  if (!filePath.startsWith(publicRoot)) {
    return sendJson(res, 404, { error: 'Not found' });
  }
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      if (!pathname.startsWith('/api/')) {
        const fallback = path.join(publicRoot, 'index.html');
        fs.createReadStream(fallback)
          .on('open', () => {
            res.writeHead(200, { 'content-type': getContentType(fallback) });
          })
          .on('error', () => sendJson(res, 404, { error: 'Not found' }))
          .pipe(res);
      } else {
        sendJson(res, 404, { error: 'Not found' });
      }
      return;
    }
    const stream = fs.createReadStream(filePath);
    stream.on('open', () => {
      res.writeHead(200, { 'content-type': getContentType(filePath) });
      stream.pipe(res);
    });
    stream.on('error', () => sendJson(res, 500, { error: 'Failed to read file' }));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    });
    res.end();
    return;
  }

  if (pathname.startsWith('/api/')) {
    if (pathname === '/api/session' && req.method === 'GET') {
      const user = getSessionUser(req);
      return sendJson(res, 200, { user: toPublicUser(user) });
    }
    if (pathname === '/api/auth/register' && req.method === 'POST') {
      return handleRegister(req, res);
    }
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      return handleLogin(req, res);
    }
    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      destroySession(req, res);
      return sendJson(res, 200, { ok: true });
    }

    const user = ensureAuth(req, res);
    if (!user) {
      return;
    }

    if (pathname === '/api/jobs' && req.method === 'POST') {
      return handleCreateJob(req, res, user);
    }

    if (pathname === '/api/jobs' && req.method === 'GET') {
      return proxyJobs(req, res, user);
    }

    if (pathname.startsWith('/api/jobs/') && req.method === 'GET') {
      const parts = pathname.split('/').filter(Boolean);
      const jobId = parts[2];
      const fileTypeKey = parts[4];
      if (parts.length === 3) {
        return proxyJobs(req, res, user, jobId);
      }
      const mapping = { clip: 'clip', captions: 'captions', timeline: 'timeline' };
      if (!mapping[fileTypeKey]) {
        return sendJson(res, 400, { error: 'Unknown file type' });
      }
      return proxyJobs(req, res, user, jobId, mapping[fileTypeKey]);
    }

    return sendJson(res, 404, { error: 'Not found' });
  }

  serveStatic(req, res, pathname);
});

server.listen(config.port, () => {
  console.log(`Dashboard listening on http://localhost:${config.port}`);
});

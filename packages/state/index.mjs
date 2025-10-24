import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let createDatabase;

try {
  const { DatabaseSync } = require('node:sqlite');
  createDatabase = (filePath) => new DatabaseSync(filePath);
} catch (nodeSqliteError) {
  try {
    const BetterSqlite3 = require('better-sqlite3');
    createDatabase = (filePath) => new BetterSqlite3(filePath);
  } catch (betterSqliteError) {
    const error = new Error(
      'Failed to load SQLite bindings. Install Node.js 22+ or add better-sqlite3 as a dependency.',
      { cause: new AggregateError([nodeSqliteError, betterSqliteError]) },
    );
    throw error;
  }
}

const connections = new Map();

function resolvePath(filePath) {
  if (!filePath) {
    throw new Error('State database path was not provided');
  }
  return path.resolve(filePath);
}

function openDatabase(filePath) {
  const resolved = resolvePath(filePath);
  const cached = connections.get(resolved);
  if (cached) {
    return cached;
  }

  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  if (!createDatabase) {
    throw new Error('No SQLite driver available. Did initialization fail?');
  }
  const db = createDatabase(resolved);
  db.exec('PRAGMA journal_mode = wal;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      api_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      source_uri TEXT NOT NULL,
      watermark_text TEXT NOT NULL,
      max_duration_seconds INTEGER NOT NULL,
      variant_count INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      available_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      output TEXT,
      FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
    );
  `);
  migrateJobsAvailableAtColumn(db);
  db.exec('CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status, available_at, created_at);');
  db.exec('CREATE INDEX IF NOT EXISTS jobs_tenant_idx ON jobs(tenant_id, created_at DESC);');
  connections.set(resolved, db);
  return db;
}

function migrateJobsAvailableAtColumn(db) {
  const columns = db.prepare("PRAGMA table_info('jobs');").all();
  const availableAtColumn = columns.find((column) => column.name === 'available_at');
  if (!availableAtColumn) {
    return;
  }
  const columnType = (availableAtColumn.type || '').toUpperCase();
  if (columnType === 'INTEGER') {
    return;
  }

  db.exec('BEGIN IMMEDIATE;');
  try {
    db.exec('DROP TABLE IF EXISTS jobs_new;');
    db.exec(`
      CREATE TABLE jobs_new (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        source_uri TEXT NOT NULL,
        watermark_text TEXT NOT NULL,
        max_duration_seconds INTEGER NOT NULL,
        variant_count INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        available_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        output TEXT,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
      );
    `);
    const insert = db.prepare(`
      INSERT INTO jobs_new (
        id,
        tenant_id,
        source_uri,
        watermark_text,
        max_duration_seconds,
        variant_count,
        status,
        created_at,
        updated_at,
        available_at,
        attempts,
        error_message,
        metadata,
        output
      )
      VALUES (
        :id,
        :tenant_id,
        :source_uri,
        :watermark_text,
        :max_duration_seconds,
        :variant_count,
        :status,
        :created_at,
        :updated_at,
        :available_at,
        :attempts,
        :error_message,
        :metadata,
        :output
      );
    `);
    const rows = db.prepare('SELECT * FROM jobs;').all();
    for (const row of rows) {
      insert.run({
        ...row,
        available_at: coerceTimestamp(row.available_at),
        metadata: row.metadata ?? '{}',
        output: row.output ?? null,
      });
    }
    db.exec('DROP TABLE jobs;');
    db.exec('ALTER TABLE jobs_new RENAME TO jobs;');
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
}

function serializeTenant(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    apiKey: row.api_key,
    createdAt: row.created_at,
  };
}

function parseJsonColumn(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function coerceTimestamp(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') {
      return null;
    }
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return Math.trunc(numeric);
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return null;
}

function formatTimestamp(value) {
  const timestamp = coerceTimestamp(value);
  if (timestamp === null) {
    return null;
  }
  return new Date(timestamp).toISOString();
}

function serializeJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    sourceUri: row.source_uri,
    watermarkText: row.watermark_text,
    maxDurationSeconds: Number(row.max_duration_seconds) || 0,
    variantCount: Number(row.variant_count) || 0,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    availableAt: formatTimestamp(row.available_at),
    attempts: Number(row.attempts) || 0,
    errorMessage: row.error_message || null,
    metadata: parseJsonColumn(row.metadata, {}),
    output: parseJsonColumn(row.output, null),
  };
}

export async function initState(filePath) {
  openDatabase(filePath);
}

export async function createTenant(filePath, name) {
  const db = openDatabase(filePath);
  const createdAt = new Date().toISOString();
  const tenant = {
    id: crypto.randomUUID(),
    name: name.trim(),
    apiKey: crypto.randomUUID().replace(/-/g, ''),
    createdAt,
  };
  const insert = db.prepare(
    `INSERT INTO tenants (id, name, api_key, created_at) VALUES (:id, :name, :apiKey, :createdAt);`,
  );
  insert.run(tenant);
  return tenant;
}

export async function listTenants(filePath) {
  const db = openDatabase(filePath);
  const rows = db.prepare('SELECT * FROM tenants ORDER BY created_at DESC;').all();
  return rows.map(serializeTenant);
}

export async function findTenantByApiKey(filePath, apiKey) {
  const db = openDatabase(filePath);
  const stmt = db.prepare('SELECT * FROM tenants WHERE api_key = ? LIMIT 1;');
  return serializeTenant(stmt.get(apiKey));
}

function normalizeVariantCount(value) {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed)) {
    return 3;
  }
  return Math.min(5, Math.max(1, parsed));
}

export async function createJob(filePath, jobInput) {
  const db = openDatabase(filePath);
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const maxDuration = Number.isFinite(jobInput.maxDurationSeconds)
    ? Math.round(jobInput.maxDurationSeconds)
    : 59;
  const job = {
    id: crypto.randomUUID(),
    tenantId: jobInput.tenantId,
    sourceUri: jobInput.sourceUri,
    watermarkText: jobInput.watermarkText,
    maxDurationSeconds: maxDuration,
    variantCount: normalizeVariantCount(jobInput.variantCount),
    status: 'queued',
    createdAt,
    updatedAt: createdAt,
    availableAt: createdAt,
    attempts: 0,
    errorMessage: null,
    metadata: jobInput.metadata ? { ...jobInput.metadata } : {},
  };
  const insert = db.prepare(`
    INSERT INTO jobs (
      id,
      tenant_id,
      source_uri,
      watermark_text,
      max_duration_seconds,
      variant_count,
      status,
      created_at,
      updated_at,
      available_at,
      attempts,
      error_message,
      metadata
    )
    VALUES (
      :id,
      :tenantId,
      :sourceUri,
      :watermarkText,
      :maxDurationSeconds,
      :variantCount,
      :status,
      :createdAt,
      :updatedAt,
      :availableAt,
      :attempts,
      :errorMessage,
      :metadata
    );
  `);
  insert.run({ ...job, availableAt: now, metadata: JSON.stringify(job.metadata) });
  return { ...job, metadata: { ...job.metadata } };
}

export async function listJobs(filePath, tenantId, limit = 50) {
  const db = openDatabase(filePath);
  const rows = db
    .prepare(
      `SELECT * FROM jobs WHERE tenant_id = ? ORDER BY datetime(created_at) DESC LIMIT ?;`,
    )
    .all(tenantId, limit);
  return rows.map(serializeJob);
}

export async function getJob(filePath, jobId) {
  const db = openDatabase(filePath);
  const stmt = db.prepare('SELECT * FROM jobs WHERE id = ? LIMIT 1;');
  return serializeJob(stmt.get(jobId));
}

function buildUpdateStatement(patch) {
  const assignments = [];
  const params = {};

  if (patch.status !== undefined) {
    assignments.push('status = :status');
    params.status = patch.status;
  }
  if (patch.availableAt !== undefined) {
    assignments.push('available_at = :availableAt');
    if (patch.availableAt === null) {
      params.availableAt = null;
    } else {
      const timestamp = coerceTimestamp(patch.availableAt);
      if (timestamp === null) {
        throw new Error('Invalid availableAt value');
      }
      params.availableAt = timestamp;
    }
  }
  if (patch.errorMessage !== undefined) {
    assignments.push('error_message = :errorMessage');
    params.errorMessage = patch.errorMessage;
  }
  if (patch.metadata !== undefined) {
    assignments.push('metadata = :metadata');
    params.metadata = JSON.stringify(patch.metadata ?? {});
  }
  if (patch.output !== undefined) {
    assignments.push('output = :output');
    params.output = patch.output ? JSON.stringify(patch.output) : null;
  }
  if (patch.attempts !== undefined) {
    assignments.push('attempts = :attempts');
    params.attempts = patch.attempts;
  }
  if (patch.variantCount !== undefined) {
    assignments.push('variant_count = :variantCount');
    params.variantCount = normalizeVariantCount(patch.variantCount);
  }
  if (patch.maxDurationSeconds !== undefined) {
    assignments.push('max_duration_seconds = :maxDurationSeconds');
    params.maxDurationSeconds = Math.round(patch.maxDurationSeconds);
  }
  if (patch.sourceUri !== undefined) {
    assignments.push('source_uri = :sourceUri');
    params.sourceUri = patch.sourceUri;
  }
  if (patch.watermarkText !== undefined) {
    assignments.push('watermark_text = :watermarkText');
    params.watermarkText = patch.watermarkText;
  }

  return { assignments, params };
}

export async function updateJob(filePath, jobId, patch) {
  const db = openDatabase(filePath);
  const { assignments, params } = buildUpdateStatement(patch);
  if (assignments.length === 0) {
    return getJob(filePath, jobId);
  }
  const updatedAt = new Date().toISOString();
  const stmt = db.prepare(
    `UPDATE jobs SET ${assignments.join(', ')}, updated_at = :updatedAt WHERE id = :id;`,
  );
  stmt.run({ ...params, updatedAt, id: jobId });
  return getJob(filePath, jobId);
}

export async function takeNextQueuedJob(filePath) {
  const db = openDatabase(filePath);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  db.exec('BEGIN IMMEDIATE;');
  try {
    const row = db
      .prepare(
        `SELECT * FROM jobs
         WHERE status = 'queued'
           AND (available_at IS NULL OR available_at <= ?)
         ORDER BY datetime(created_at) ASC
         LIMIT 1;`,
      )
      .get(nowMs);
    if (!row) {
      db.exec('COMMIT;');
      return null;
    }
    const attempts = Number(row.attempts) + 1;
    db.prepare(
      `UPDATE jobs
       SET status = 'processing',
           attempts = :attempts,
           available_at = NULL,
           updated_at = :updatedAt
       WHERE id = :id;`,
    ).run({ id: row.id, attempts, updatedAt: nowIso });
    db.exec('COMMIT;');
    return serializeJob({ ...row, status: 'processing', attempts, available_at: null, updated_at: nowIso });
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
}

export async function requeueJob(filePath, jobId, delayMs, errorMessage) {
  const availableAt = Date.now() + Math.max(0, delayMs || 0);
  return updateJob(filePath, jobId, {
    status: 'queued',
    availableAt,
    errorMessage: errorMessage || null,
  });
}

export async function finalizeJob(filePath, jobId, statusPatch) {
  return updateJob(filePath, jobId, statusPatch);
}

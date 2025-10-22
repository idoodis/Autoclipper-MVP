import fs from 'node:fs';
import path from 'node:path';

const LOCK_SUFFIX = '.lock';
const BACKUP_SUFFIX = '.bak';
const LOCK_RETRY_MS = 50;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 60_000;

function resolveLockPath(filePath) {
  return `${filePath}${LOCK_SUFFIX}`;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function removeIfStale(lockPath) {
  try {
    const stats = await fs.promises.stat(lockPath);
    if (Date.now() - stats.mtimeMs > STALE_LOCK_MS) {
      await fs.promises.unlink(lockPath).catch(() => {});
    }
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
}

async function acquireLock(filePath) {
  const lockPath = resolveLockPath(filePath);
  const start = Date.now();
  while (true) {
    try {
      const handle = await fs.promises.open(lockPath, 'wx');
      await handle.write(`${process.pid}\n`);
      return { handle, lockPath };
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        if (Date.now() - start > LOCK_TIMEOUT_MS) {
          throw new Error(`Timed out acquiring lock for ${filePath}`);
        }
        await removeIfStale(lockPath);
        await sleep(LOCK_RETRY_MS);
        continue;
      }
      throw error;
    }
  }
}

async function releaseLock(lock) {
  try {
    await lock.handle.close();
  } catch (error) {
    // ignore close errors
  }
  await fs.promises.unlink(lock.lockPath).catch((error) => {
    if (!error || error.code !== 'ENOENT') {
      throw error;
    }
  });
}

export async function initStore(filePath, defaultValue) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      const data = JSON.stringify(defaultValue, null, 2);
      await fs.promises.writeFile(filePath, data, 'utf8');
      await fs.promises.writeFile(`${filePath}${BACKUP_SUFFIX}`, data, 'utf8');
    } else {
      throw error;
    }
  }
}

async function readRaw(filePath) {
  try {
    return await fs.promises.readFile(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function loadStore(filePath, defaultValue) {
  const raw = await readRaw(filePath);
  if (raw === null) {
    return defaultValue;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    const backupRaw = await readRaw(`${filePath}${BACKUP_SUFFIX}`);
    if (backupRaw) {
      try {
        return JSON.parse(backupRaw);
      } catch (backupError) {
        console.warn(`Failed to parse backup for ${filePath}:`, backupError);
      }
    }
    console.warn(`Corrupted store ${filePath}, resetting to default.`);
    return defaultValue;
  }
}

async function persist(filePath, data) {
  const payload = JSON.stringify(data, null, 2);
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmpPath, payload, 'utf8');
  await fs.promises.rename(tmpPath, filePath);
  await fs.promises.writeFile(`${filePath}${BACKUP_SUFFIX}`, payload, 'utf8');
}

export async function withStore(filePath, defaultValue, mutator) {
  const lock = await acquireLock(filePath);
  try {
    const state = await loadStore(filePath, defaultValue);
    const result = await mutator(state);
    await persist(filePath, state);
    return result;
  } finally {
    await releaseLock(lock);
  }
}

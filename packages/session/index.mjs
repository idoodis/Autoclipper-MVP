import crypto from 'node:crypto';

import { initStore, withStore, loadStore } from '../storage/jsonStore.mjs';

const DEFAULT_STATE = { sessions: {} };

function prune(state) {
  const now = Date.now();
  for (const [id, session] of Object.entries(state.sessions)) {
    if (!session || typeof session !== 'object') {
      delete state.sessions[id];
      continue;
    }
    if (Number.isFinite(session.expiresAt) && session.expiresAt <= now) {
      delete state.sessions[id];
    }
  }
}

export async function initSessionStore(filePath) {
  await initStore(filePath, DEFAULT_STATE);
  await withStore(filePath, DEFAULT_STATE, (state) => {
    prune(state);
  });
}

export async function createSession(filePath, userId, ttlMs) {
  const sessionId = crypto.randomUUID();
  const createdAt = Date.now();
  const expiresAt = createdAt + Math.max(60_000, ttlMs);
  await withStore(filePath, DEFAULT_STATE, (state) => {
    prune(state);
    state.sessions[sessionId] = { userId, createdAt, expiresAt };
  });
  return sessionId;
}

export async function getSession(filePath, sessionId) {
  const state = await loadStore(filePath, DEFAULT_STATE);
  const session = state.sessions[sessionId];
  if (!session) {
    return null;
  }
  if (!Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()) {
    await withStore(filePath, DEFAULT_STATE, (state) => {
      delete state.sessions[sessionId];
    });
    return null;
  }
  return session;
}

export async function deleteSession(filePath, sessionId) {
  await withStore(filePath, DEFAULT_STATE, (state) => {
    delete state.sessions[sessionId];
  });
}

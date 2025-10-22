import crypto from 'node:crypto';
import path from 'node:path';

import { initStore, loadStore, withStore } from '../../packages/storage/jsonStore.mjs';

const DEFAULT_STATE = { users: [] };

let stateFilePath = '';

function resolveStatePath(filePath) {
  if (!filePath) {
    throw new Error('Dashboard state file path is not set');
  }
  return path.resolve(filePath);
}

export async function initUserState(filePath) {
  stateFilePath = resolveStatePath(filePath);
  await initStore(stateFilePath, DEFAULT_STATE);
}

export async function createUser({ name, email, passwordHash, tenantId, apiKey }) {
  const now = new Date().toISOString();
  const user = {
    id: crypto.randomUUID(),
    name,
    email: email.toLowerCase(),
    passwordHash,
    tenantId,
    apiKey,
    createdAt: now,
    updatedAt: now,
  };
  await withStore(stateFilePath, DEFAULT_STATE, (state) => {
    state.users.push(user);
  });
  return user;
}

export async function findUserByEmail(email) {
  const state = await loadStore(stateFilePath, DEFAULT_STATE);
  return state.users.find((user) => user.email === email.toLowerCase()) || null;
}

export async function findUserById(id) {
  const state = await loadStore(stateFilePath, DEFAULT_STATE);
  return state.users.find((user) => user.id === id) || null;
}

export function toPublicUser(user) {
  if (!user) return null;
  const { passwordHash, apiKey, ...rest } = user;
  return rest;
}

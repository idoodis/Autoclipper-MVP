import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

let stateFilePath = '';
let state = { users: [] };

function persist() {
  if (!stateFilePath) {
    throw new Error('State not initialized');
  }
  fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2));
}

export function initUserState(filePath) {
  stateFilePath = filePath;
  fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
  if (fs.existsSync(stateFilePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
      if (data && Array.isArray(data.users)) {
        state = { users: data.users };
      } else {
        state = { users: [] };
        persist();
      }
    } catch (error) {
      console.warn('Failed to load dashboard state, starting fresh:', error);
      state = { users: [] };
      persist();
    }
  } else {
    state = { users: [] };
    persist();
  }
}

export function createUser({ name, email, passwordHash, tenantId, apiKey }) {
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
  state.users.push(user);
  persist();
  return user;
}

export function findUserByEmail(email) {
  return state.users.find((user) => user.email === email.toLowerCase()) || null;
}

export function findUserById(id) {
  return state.users.find((user) => user.id === id) || null;
}

export function toPublicUser(user) {
  if (!user) return null;
  const { passwordHash, apiKey, ...rest } = user;
  return rest;
}

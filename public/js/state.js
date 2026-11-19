import { api } from './api.js';

export const state = {
  info: null,
  collections: [],
  environments: [],
  globals: [],
  settings: {},
  presets: [],
  history: [],
  view: 'requests',
};

const listeners = new Map();
export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
  return () => listeners.get(evt).delete(fn);
}
export function emit(evt, data) {
  for (const fn of listeners.get(evt) || []) { try { fn(data); } catch (e) { console.error(e); } }
}

export async function loadWorkspace() {
  const ws = await api.get('/api/workspace');
  Object.assign(state, ws);
  emit('workspace');
}

export async function loadHistory() {
  state.history = await api.get('/api/history');
  emit('history');
}

export const activeEnvId = () => state.settings.activeEnvironmentId || null;
export const activeEnv = () => state.environments.find((e) => e.id === activeEnvId()) || null;
export const findCollection = (id) => state.collections.find((c) => c.id === id) || null;

export async function setActiveEnv(id) {
  state.settings = await api.put('/api/settings', { activeEnvironmentId: id || null });
  emit('env');
}

export async function saveSettings(patch) {
  state.settings = await api.put('/api/settings', patch);
  emit('settings');
}

/** Merged variable map used for hints: globals < collection < environment */
export function variableMap(collectionId) {
  const m = new Map();
  const add = (list, src) => { for (const v of list || []) if (v.enabled !== false && v.key) m.set(v.key, { value: v.value, src, secret: v.secret }); };
  add(state.globals, 'Globals');
  const c = findCollection(collectionId);
  if (c) add(c.variables, `Collection: ${c.name}`);
  const e = activeEnv();
  if (e) add(e.variables, `Environment: ${e.name}`);
  return m;
}

export async function saveCollection(col) {
  const saved = await api.put(`/api/collections/${col.id}`, col);
  const i = state.collections.findIndex((c) => c.id === col.id);
  if (i >= 0) state.collections[i] = saved; else state.collections.push(saved);
  emit('collections');
  return saved;
}

export async function saveEnvironment(env) {
  const saved = await api.put(`/api/environments/${env.id}`, env);
  const i = state.environments.findIndex((e) => e.id === env.id);
  if (i >= 0) state.environments[i] = saved;
  emit('environments');
  return saved;
}

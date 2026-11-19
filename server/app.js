import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Store } from './store.js';
import { readJson, sendJson, sendText, uuid, csvEscape, clone } from './util.js';
import { buildContext, prepareRequest, preparedContains, normalizeRequest, newRequest, effectiveAuth } from './prepare.js';
import { executeRequest, correlationValue, prepareOnly } from './pipeline.js';
import { SessionManager } from './protocols/sessions.js';
import { grpcInvoke, registryFor, findMethod, describeServices, encodeMessage, decodeMessage, normalizeTarget, closeAllGrpc } from './protocols/grpc.js';
import { MockManager, routesFromOpenApi } from './mocks.js';
import { parseStructured } from './converters/detect.js';
import { fromOpenApi, isOpenApi } from './converters/openapi.js';
import { applyChanges, newChanges, scriptsEnabled } from './scripting.js';
import { TokenStore, getOAuth2Token, startAuthorization, finishAuthorization, tokenInfo, oauthKey, JWT_ALGORITHMS } from './auth.js';
import { sendHttp, sharedAgents, selfHosts } from './http-client.js';
import { runAssertions, runExtract } from './assertions.js';
import { DYNAMIC_HELP, varsToObject, interpolate } from './template.js';
import { CallbackHub } from './callbacks.js';
import { ListenerManager } from './listeners.js';
import { Scheduler } from './scheduler.js';
import { describeCron, nextCronTimes } from './cron.js';
import { LoadRun, DEFAULT_RUN_CONFIG } from './runner.js';
import { toCurl } from './converters/curl.js';
import { parseCurl } from './converters/curl.js';
import { generateCode, CODEGEN_LANGS } from './converters/codegen.js';
import { toPostman, environmentToPostman } from './converters/postman.js';
import { toOpenApi } from './converters/openapi.js';
import { toK6 } from './converters/k6.js';
import { detectImport, freshIds, fetchImportText } from './converters/detect.js';
import { toYaml } from './yaml.js';
import { renderReport } from './report.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

export const DEFAULT_SETTINGS = {
  publicCallbackBase: '',
  historyLimit: 300,
  callbackWaitMs: 60000,
  activeEnvironmentId: null,
  maxConcurrentRuns: 10,
};

const httpError = (status, message) => Object.assign(new Error(message), { status });
const isLoopback = (h) => ['127.0.0.1', 'localhost', '::1'].includes(h);

/**
 * Start the web UI/API and the callback receiver.
 * opts: { port, host, cbPort, cbHost, dataDir, user, password, quiet }
 */
export async function startServer(opts = {}) {
  const PORT = Number(opts.port ?? 7070);
  const HOST = opts.host || '127.0.0.1';
  const CB_PORT = Number(opts.cbPort ?? 7071);
  const CB_HOST = opts.cbHost || '127.0.0.1';
  const DATA_DIR = path.resolve(opts.dataDir || path.join(ROOT, 'data'));
  const AUTH = opts.user && opts.password ? 'Basic ' + Buffer.from(`${opts.user}:${opts.password}`).toString('base64') : null;
  const log = opts.quiet ? () => {} : (...a) => console.log(...a);

  const store = new Store(DATA_DIR);
  const runsDir = path.join(DATA_DIR, 'runs');
  fs.mkdirSync(runsDir, { recursive: true });

  const settings = () => ({ ...DEFAULT_SETTINGS, ...store.get('settings', {}) });
  const collections = () => store.get('collections', []);
  const environments = () => store.get('environments', []);
  const globals = () => store.get('globals', []);
  const history = () => store.get('history', []);
  const presets = () => store.get('presets', []);
  const runsIndex = () => store.get('runs-index', []);

  /* -------------------------------------------------------------- seeding */
  if (!fs.existsSync(path.join(DATA_DIR, 'collections.json'))) {
    store.set('collections', [seedCollection(CB_PORT)], { immediate: true });
    const envId = uuid();
    store.set('environments', [{ id: envId, name: 'Local', variables: [{ key: 'baseUrl', value: 'https://httpbin.org', enabled: true }, { key: 'echo', value: `http://localhost:${CB_PORT}/cb/echo`, enabled: true }] }], { immediate: true });
    store.set('settings', { ...store.get('settings', {}), activeEnvironmentId: envId }, { immediate: true });
  }

  /* ------------------------------------------------------------------ SSE */
  const sseClients = new Set();
  const emit = (type, data) => {
    const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of sseClients) c.write(msg);
  };
  const pinger = setInterval(() => { for (const c of sseClients) c.write(': ping\n\n'); }, 15000);
  pinger.unref();

  /* ----------------------------------------------------- callbacks & ports */
  const hub = new CallbackHub({ store, emit });
  const tokens = new TokenStore(store);
  const primaryBase = () => (settings().publicCallbackBase || `http://localhost:${CB_PORT}`).replace(/\/$/, '');
  /** Which feature already uses a port (UI, receiver, listener, mock)? */
  const portTaken = (port, exceptId) => {
    if (port === PORT) return 'the ApiStorm UI';
    if (port === CB_PORT) return 'the primary callback receiver';
    const l = store.get('listeners', []).find((x) => x.port === port && x.id !== exceptId);
    if (l) return `listener "${l.name}"`;
    const m = store.get('mocks', []).find((x) => x.port === port && x.id !== exceptId);
    if (m) return `mock server "${m.name}"`;
    return null;
  };
  const listeners = new ListenerManager({ store, hub, emit, defaultHost: CB_HOST, reservedPorts: [PORT, CB_PORT], onChange: () => refreshSelfHosts(), portTaken });
  const mocks = new MockManager({ store, hub, emit, defaultHost: CB_HOST, portTaken });
  const sessions = new SessionManager({ emit });
  /** Base URL for {{$callbackUrl(bin)}}: a running listener dedicated to that bin wins over the primary receiver. */
  const callbackBaseFor = (bin) => { const l = listeners.forBin(bin); return l ? listeners.baseUrl(l) : primaryBase(); };

  function refreshSelfHosts() {
    selfHosts.clear();
    const ports = [CB_PORT, ...listeners.ports().map((l) => l.port), ...(typeof mocks !== 'undefined' ? mocks.ports() : [])];
    for (const p of ports) for (const h of ['localhost', '127.0.0.1', '[::1]']) selfHosts.add(`${h}:${p}`);
    for (const b of [primaryBase(), ...listeners.configs().map((l) => l.publicBase).filter(Boolean)]) { try { selfHosts.add(new URL(b).host.toLowerCase()); } catch { /* ignore */ } }
  }
  refreshSelfHosts();

  /* -------------------------------------------------------------- helpers */
  const findCollection = (id) => (id ? collections().find((c) => c.id === id) : null);
  const findEnvironment = (id) => (id ? environments().find((e) => e.id === id) : null);
  const contextFor = ({ environmentId, collectionId, runtime }) => {
    const environment = findEnvironment(environmentId);
    const collection = findCollection(collectionId);
    return { environment, collection, ctx: buildContext({ runtime, environment, collection, globals: globals(), callbackBase: callbackBaseFor }) };
  };
  const setVar = (list, key, value) => { const v = list.find((x) => x.key === key); if (v) { v.value = value; v.enabled = true; } else list.push({ key, value, enabled: true }); };
  const download = (res, filename, content, type = 'application/json') => {
    res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'content-disposition': `attachment; filename="${filename.replace(/[^\w.-]+/g, '_')}"`, 'cache-control': 'no-store' });
    res.end(content);
  };

  /* -------------------------------------------------------------- sending */
  const inflightSends = new Map();

  async function sendOnce(body, { tag } = {}) {
    const request = normalizeRequest(body.request);
    const environment = findEnvironment(body.environmentId);
    const collection = findCollection(body.collectionId);
    const scopes = { local: {}, data: {}, env: varsToObject(environment?.variables), collection: varsToObject(collection?.variables), globals: varsToObject(globals()) };
    const changes = newChanges();
    const ac = new AbortController();
    if (body.clientId) inflightSends.set(body.clientId, ac);
    let startedAt = performance.now();
    let corrId = null;
    const track = (id) => {
      corrId = id;
      hub.track(id, {
        sentAt: startedAt,
        timeoutMs: Number(settings().callbackWaitMs) || 60000,
        onMatch: (capture) => emit('callback-matched', { requestId: id, clientId: body.clientId, capture, latencyMs: Math.round((performance.now() - startedAt) * 100) / 100 }),
        onTimeout: () => emit('callback-timeout', { requestId: id, clientId: body.clientId }),
      });
    };
    let r;
    try {
      r = await executeRequest(request, {
        collection, scopes, changes, callbackBase: callbackBaseFor, tokens,
        scriptTimeoutMs: Number(settings().scriptTimeoutMs) || 5000,
        send: { signal: ac.signal, origin: 'send', maxBodyBytes: 50 * 1024 * 1024, captureBody: true },
        onPrepared: (prep, ctx) => {
          startedAt = performance.now();
          if (request.callback?.correlateBy !== 'response' && ctx.requestId && preparedContains(prep, ctx.requestId)) track(ctx.requestId);
        },
      });
    } finally { if (body.clientId) inflightSends.delete(body.clientId); }
    const res = r.res;
    if (res && !res.error && request.callback?.correlateBy === 'response') {
      const v = correlationValue(request, res, r.bodyText);
      if (v) track(v);
    }
    if (corrId && res?.error) hub.pending.delete(corrId);

    // persist variables changed by extraction rules and scripts
    let updated = null;
    const envs = environments();
    const env = envs.find((e) => e.id === body.environmentId);
    let envChanged = false, globalsChanged = false, colChanged = false;
    if (Object.keys(r.extracted || {}).length) {
      if (env) { for (const [k, v] of Object.entries(r.extracted)) setVar(env.variables, k, v); envChanged = true; }
      else { const g = globals(); for (const [k, v] of Object.entries(r.extracted)) setVar(g, k, v); store.set('globals', g); globalsChanged = true; }
    }
    if (env && applyChanges(env.variables, scopes.env, changes.env)) envChanged = true;
    if (!env && (changes.env.set.size || changes.env.unset.size)) (r.scripts.pre[0] || r.scripts.post[0])?.logs.push({ level: 'warn', text: 'pm.environment.set had no effect: no environment is selected', at: Date.now() });
    const g = globals();
    if (applyChanges(g, scopes.globals, changes.globals)) { store.set('globals', g); globalsChanged = true; }
    if (collection && (changes.collection.set.size || changes.collection.unset.size)) {
      const cols = collections();
      const c = cols.find((x) => x.id === collection.id);
      if (c) { c.variables ||= []; if (applyChanges(c.variables, scopes.collection, changes.collection)) { store.set('collections', cols); colChanged = true; } }
    }
    if (envChanged) { store.set('environments', envs); updated = { environment: env }; }
    if (globalsChanged) updated = { ...(updated || {}), globals: globals() };
    if (envChanged || globalsChanged) emit('workspace-changed', { what: envChanged ? 'environments' : 'globals' });
    if (colChanged) emit('workspace-changed', { what: 'all' });

    const scriptsOut = { pre: r.scripts.pre.map(slimScript), post: r.scripts.post.map(slimScript) };
    const prep = r.prep;
    const ct = res?.headers?.['content-type'] || '';
    const textual = res ? isTextual(ct, res.body) : true;
    const out = {
      requestId: corrId,
      waitingForCallback: !!corrId && !!res && !res.error,
      skipped: r.skipped || false,
      scripts: scriptsOut,
      prepared: prep ? {
        method: prep.method, url: prep.url, headers: prep.headers,
        body: prep.body ? (isTextual((prep.headers.find(([k]) => /content-type/i.test(k)) || [])[1], prep.body) ? prep.body.toString('utf8').slice(0, 200000) : `<${prep.body.length} bytes binary>`) : null,
        signing: prep.signing || null,
      } : null,
      response: r.skipped ? { error: 'Request skipped by pm.execution.skipRequest()', skipped: true, timings: {} }
        : !res ? { error: r.error || 'Request was not sent', timings: {} }
        : res.error ? { error: res.error, errorCode: res.errorCode, timings: res.timings } : {
          status: res.status, statusText: res.statusText, httpVersion: res.httpVersion,
          headers: res.headerPairs, timings: res.timings, size: res.bytesIn, bodySize: res.body?.length || 0,
          contentType: ct, truncated: res.truncated, redirects: res.redirects, finalUrl: res.finalUrl, reused: res.reused,
          body: textual ? r.bodyText : res.body.toString('base64'), bodyEncoding: textual ? 'text' : 'base64',
        },
      assertions: r.checks, extracted: r.extracted, updated,
    };
    const h = history();
    h.unshift({
      id: uuid(), at: new Date().toISOString(), environmentId: body.environmentId || null, collectionId: body.collectionId || null,
      request: { ...request, id: uuid() }, status: res && !res.error ? res.status : 0, error: res?.error || r.error || null,
      timeMs: res?.timings?.total ?? null, size: res?.bytesIn || 0, ...(tag ? { tag } : {}),
    });
    const lim = Math.max(10, Number(settings().historyLimit) || 300);
    if (h.length > lim) h.length = lim;
    store.set('history', h);
    emit('history-changed', {});
    return out;
  }

  /* -------------------------------------------------------------- imports */
  function applyImport(result, { mode = 'merge' } = {}) {
    const summary = { collections: [], environments: [], requests: 0, source: result.source || null };
    if (result.kind === 'collection') {
      const col = freshIds(result.collection);
      store.set('collections', [...collections(), col]);
      summary.collections.push(col.name); summary.requests += col.requests.length; summary.collectionId = col.id;
    } else if (result.kind === 'environment') {
      const env = { ...result.environment, id: uuid() };
      store.set('environments', [...environments(), env]);
      summary.environments.push(env.name);
    } else if (result.kind === 'workspace') {
      const d = result.data;
      const cols = (d.collections || []).map(freshIds);
      const envs = (d.environments || []).map((e) => ({ ...e, id: uuid() }));
      if (mode === 'replace') {
        store.set('collections', cols); store.set('environments', envs); store.set('globals', d.globals || []);
        if (d.presets) store.set('presets', d.presets);
      } else {
        store.set('collections', [...collections(), ...cols]);
        store.set('environments', [...environments(), ...envs]);
        const g = globals();
        for (const v of d.globals || []) if (!g.some((x) => x.key === v.key)) g.push(v);
        store.set('globals', g);
        if (d.presets) store.set('presets', [...presets(), ...d.presets.map((p) => ({ ...p, id: uuid() }))]);
      }
      for (const b of d.bins || []) { try { hub.createBin(b); } catch { /* exists */ } }
      // mock servers are restored stopped (their ports may be taken on this machine)
      for (const m of d.mocks || []) { mocks.create({ ...m, port: m.port, start: false }).catch(() => {}); }
      summary.collections = cols.map((c) => c.name);
      summary.environments = envs.map((e) => e.name);
      summary.requests = cols.reduce((a, c) => a + c.requests.length, 0);
    }
    emit('workspace-changed', { what: 'all' });
    return summary;
  }

  /* ----------------------------------------------------------------- runs */
  const activeRuns = new Map();

  function resolveTarget(target = {}) {
    if (target.type === 'request' && target.request && (target.request.protocol || 'http') !== 'http') throw httpError(400, 'Load tests support HTTP requests only (WebSocket, SSE and gRPC requests cannot be load tested yet)');
    if (target.type === 'collection') {
      const col = findCollection(target.collectionId);
      if (!col) throw httpError(404, 'Collection not found');
      let reqs = col.requests.filter((r) => (r.protocol || 'http') === 'http');
      if (Array.isArray(target.requestIds) && target.requestIds.length) reqs = target.requestIds.map((id) => col.requests.find((r) => r.id === id)).filter(Boolean);
      return { requests: reqs, collection: col, label: col.name };
    }
    if (target.type === 'request' && target.request) {
      return { requests: [target.request], collection: findCollection(target.collectionId), label: target.request.name };
    }
    throw httpError(400, 'Choose a request or collection to run');
  }

  function runSummary(r) {
    return {
      id: r.id, name: r.name, status: r.status, reason: r.reason, startedAt: r.startedAt, endedAt: r.endedAt, elapsedSec: r.elapsedSec,
      mode: r.config?.mode, target: r.target?.collection || r.target?.requests?.[0]?.name, environment: r.target?.environment, source: r.source || null,
      count: r.summary?.count, rps: r.summary?.rps, errorRate: r.summary?.errorRate, p50: r.summary?.latency?.p50, p95: r.summary?.latency?.p95, p99: r.summary?.latency?.p99,
      passed: r.passed, thresholds: (r.thresholds || []).length, callbacks: r.callbacks?.tracked ? r.callbacks : null,
    };
  }

  function saveRunResult(result) {
    try { fs.writeFileSync(path.join(runsDir, `${result.id}.json`), JSON.stringify(result)); } catch (e) { console.error('Failed to save run', e); }
    const idx = runsIndex().filter((r) => r.id !== result.id);
    idx.unshift(runSummary(result));
    if (idx.length > 500) for (const old of idx.splice(500)) { try { fs.unlinkSync(path.join(runsDir, `${old.id}.json`)); } catch { /* gone */ } }
    store.set('runs-index', idx);
    emit('runs-changed', {});
  }

  function loadRun(id) {
    if (activeRuns.has(id)) { const r = activeRuns.get(id); return { ...r.progress(true), config: r.publicConfig(), live: true }; }
    if (!/^[\w-]+$/.test(id)) throw httpError(400, 'bad id');
    try { return JSON.parse(fs.readFileSync(path.join(runsDir, `${id}.json`), 'utf8')); } catch { throw httpError(404, 'Run not found'); }
  }

  /** Start a load run. Returns { id, name, done: Promise<result> }. */
  function startRun(body, { source = null } = {}) {
    const max = Number(settings().maxConcurrentRuns) || 10;
    if (activeRuns.size >= max) throw httpError(429, `${activeRuns.size} load tests are already running (limit ${max}, change it in Settings)`);
    const { requests, collection, label } = resolveTarget(body.target);
    const environment = findEnvironment(body.environmentId);
    const config = { ...DEFAULT_RUN_CONFIG, ...(body.config || {}) };
    if (!config.name) config.name = `${label} @ ${config.mode === 'rate' ? (config.useStages ? 'stages' : `${config.tps} TPS`) : `${config.vus} VUs`}`;
    let resolveDone;
    const done = new Promise((r) => { resolveDone = r; });
    const run = new LoadRun({
      config, requests: clone(requests), collection, environment, globals: globals(), callbackBase: callbackBaseFor, hub, emit, source, tokens,
      onFinish: (result) => { activeRuns.delete(run.id); saveRunResult(result); resolveDone(result); },
    });
    activeRuns.set(run.id, run);
    run.start();
    return { id: run.id, name: config.name, done };
  }

  const runToCsv = (r) => {
    const cols = ['t', 'started', 'completed', 'failed', 'dropped', 'target', 'inFlight', 'avg', 'p50', 'p95', 'p99', 'max', 's2', 's3', 's4', 's5', 'err', 'bytesIn', 'bytesOut', 'cbReceived', 'cbP95'];
    return [cols.join(','), ...(r.timeline || []).map((p) => cols.map((c) => csvEscape(p[c])).join(','))].join('\n');
  };

  /* ------------------------------------------------------------ scheduler */
  const describeRun = (r) => `${r.summary.count} requests, ${r.summary.errorRate}% failed, p95 ${r.summary.latency.p95 ?? '–'} ms${r.thresholds?.length ? `, thresholds ${r.passed ? 'passed' : 'failed'}` : ''}`;
  const scheduler = new Scheduler({
    store, emit, log,
    actions: {
      sendRequest: async (s) => {
        const col = findCollection(s.request.collectionId);
        const req = col?.requests.find((r) => r.id === s.request.requestId);
        if (!req) throw new Error('The scheduled request no longer exists');
        const out = await sendOnce({ request: req, collectionId: col.id, environmentId: s.environmentId }, { tag: `schedule: ${s.name}` });
        const r = out.response;
        if (r.error) return { status: 'failed', summary: r.error };
        const failedChecks = out.assertions.filter((a) => !a.pass);
        const hasStatusCheck = req.assertions?.some((a) => a.enabled !== false && a.type === 'status');
        const ok = !failedChecks.length && (hasStatusCheck || r.status < 400);
        return { status: ok ? 'passed' : 'failed', summary: `${r.status} ${r.statusText} in ${r.timings.total} ms${out.assertions.length ? `, ${out.assertions.length - failedChecks.length}/${out.assertions.length} checks` : ''}`, details: { status: r.status, timeMs: r.timings.total, failedChecks } };
      },
      runBulk: async (s) => {
        const b = s.bulk;
        const { id, done } = startRun({
          target: { type: 'collection', collectionId: b.collectionId, requestIds: b.requestIds || [] },
          environmentId: s.environmentId,
          config: { name: `${s.name} (scheduled bulk)`, mode: 'vus', vus: Math.max(1, Number(b.concurrency) || 1), iterations: Math.max(1, Number(b.iterations) || 1), durationSec: 0, thinkTimeMs: Number(b.delayMs) || 0, thresholds: [{ metric: 'errorRate', op: '<=', value: Number(b.maxErrorRate) || 0 }] },
        }, { source: `schedule: ${s.name}` });
        const r = await done;
        return { status: r.passed && r.status === 'completed' ? 'passed' : 'failed', summary: describeRun(r), runId: id };
      },
      runLoad: async (s) => {
        let payload = s.loadtest;
        if (s.loadtest.presetId) {
          const p = presets().find((x) => x.id === s.loadtest.presetId);
          if (!p) throw new Error('The saved load test used by this schedule was deleted');
          payload = { config: p.config, target: p.target, environmentId: p.environmentId };
        }
        const { id, done } = startRun({ ...payload, environmentId: s.environmentId || payload.environmentId, config: { ...payload.config, name: `${s.name} (scheduled)` } }, { source: `schedule: ${s.name}` });
        const r = await done;
        return { status: r.passed && r.status === 'completed' ? 'passed' : 'failed', summary: describeRun(r), runId: id };
      },
    },
  });

  /* --------------------------------------------------------------- router */
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, handler });
  };

  route('GET', '/api/health', () => ({ ok: true, version: VERSION, activeRuns: activeRuns.size }));
  route('GET', '/api/info', () => ({
    version: VERSION, uiPort: PORT, callbackPort: CB_PORT, callbackHost: CB_HOST, callbackBase: primaryBase(), dataDir: DATA_DIR,
    dynamicVars: DYNAMIC_HELP, codegenLangs: CODEGEN_LANGS, runDefaults: DEFAULT_RUN_CONFIG, auth: !!AUTH, docker: !!process.env.APISTORM_DOCKER,
    scriptsEnabled: scriptsEnabled(), jwtAlgorithms: JWT_ALGORITHMS,
  }));
  route('GET', '/api/workspace', () => ({ collections: collections(), environments: environments(), globals: globals(), settings: settings(), presets: presets() }));
  route('PUT', '/api/settings', async (req) => { const s = { ...settings(), ...(await readJson(req)) }; store.set('settings', s); refreshSelfHosts(); return s; });

  // collections
  route('POST', '/api/collections', async (req) => {
    const b = await readJson(req);
    const col = { id: uuid(), name: b.name || 'New collection', description: b.description || '', variables: b.variables || [], auth: b.auth || { type: 'none' }, requests: (b.requests || []).map((r) => normalizeRequest({ ...r, id: r.id || uuid() })) };
    store.set('collections', [...collections(), col]);
    return col;
  });
  route('PUT', '/api/collections/:id', async (req, p) => {
    const b = await readJson(req);
    const list = collections();
    const i = list.findIndex((c) => c.id === p.id);
    if (i < 0) throw httpError(404, 'Collection not found');
    list[i] = { ...list[i], ...b, id: p.id, requests: (b.requests || list[i].requests).map(normalizeRequest) };
    store.set('collections', list);
    return list[i];
  });
  route('DELETE', '/api/collections/:id', (req, p) => { store.set('collections', collections().filter((c) => c.id !== p.id)); return { ok: true }; });
  route('POST', '/api/collections/:id/duplicate', (req, p) => {
    const c = findCollection(p.id);
    if (!c) throw httpError(404, 'Collection not found');
    const copy = { ...freshIds(clone(c)), name: c.name + ' (copy)' };
    store.set('collections', [...collections(), copy]);
    return copy;
  });
  route('PUT', '/api/collections/:id/requests/:rid', async (req, p) => {
    const b = await readJson(req);
    const list = collections();
    const c = list.find((x) => x.id === p.id);
    if (!c) throw httpError(404, 'Collection not found');
    const r = normalizeRequest({ ...b, id: p.rid });
    const i = c.requests.findIndex((x) => x.id === p.rid);
    if (i >= 0) c.requests[i] = r; else c.requests.push(r);
    store.set('collections', list);
    return r;
  });
  route('DELETE', '/api/collections/:id/requests/:rid', (req, p) => {
    const list = collections();
    const c = list.find((x) => x.id === p.id);
    if (!c) throw httpError(404, 'Collection not found');
    c.requests = c.requests.filter((r) => r.id !== p.rid);
    store.set('collections', list);
    return { ok: true };
  });

  // environments & globals
  route('POST', '/api/environments', async (req) => {
    const b = await readJson(req);
    const env = { id: uuid(), name: b.name || 'New environment', variables: b.variables || [] };
    store.set('environments', [...environments(), env]);
    return env;
  });
  route('PUT', '/api/environments/:id', async (req, p) => {
    const b = await readJson(req);
    const list = environments();
    const i = list.findIndex((e) => e.id === p.id);
    if (i < 0) throw httpError(404, 'Environment not found');
    list[i] = { ...list[i], ...b, id: p.id };
    store.set('environments', list);
    return list[i];
  });
  route('DELETE', '/api/environments/:id', (req, p) => { store.set('environments', environments().filter((e) => e.id !== p.id)); return { ok: true }; });
  route('PUT', '/api/globals', async (req) => { const b = await readJson(req); store.set('globals', Array.isArray(b) ? b : b.variables || []); return globals(); });

  // history
  route('GET', '/api/history', () => history());
  route('DELETE', '/api/history', () => { store.set('history', []); return { ok: true }; });
  route('DELETE', '/api/history/:id', (req, p) => { store.set('history', history().filter((h) => h.id !== p.id)); return { ok: true }; });

  // sending
  route('POST', '/api/send', async (req) => sendOnce(await readJson(req)));
  route('POST', '/api/send/cancel', async (req) => { const { clientId } = await readJson(req); inflightSends.get(clientId)?.abort(); return { ok: true }; });
  route('POST', '/api/preview', async (req) => {
    const b = await readJson(req);
    const { ctx, collection } = contextFor(b);
    const prep = prepareRequest(normalizeRequest(b.request), ctx, collection);
    return { method: prep.method, url: prep.url, headers: prep.headers, body: prep.body ? prep.body.toString('utf8').slice(0, 100000) : null };
  });

  // import / export / codegen
  route('POST', '/api/import', async (req) => {
    const b = await readJson(req);
    let { text, filename } = b;
    if (b.url) ({ text, filename } = await fetchImportText(b.url));
    const result = detectImport(text, filename);
    if (result.kind === 'request' && !b.saveTo) return { kind: 'request', request: result.request, errors: result.errors || [] };
    if (result.kind === 'request' && b.saveTo) {
      const list = collections();
      const c = list.find((x) => x.id === b.saveTo);
      if (!c) throw httpError(404, 'Collection not found');
      c.requests.push(result.request);
      store.set('collections', list);
      return { kind: 'request', request: result.request, saved: true };
    }
    return { kind: result.kind, summary: applyImport(result, { mode: b.mode }), errors: result.errors || [] };
  });
  route('POST', '/api/parse-curl', async (req) => parseCurl((await readJson(req)).text));
  route('POST', '/api/codegen', async (req) => {
    const b = await readJson(req);
    const request = normalizeRequest(b.request);
    const { ctx, collection } = contextFor(b);
    const prep = prepareRequest(request, b.resolve ? ctx : { raw: true }, collection);
    if (b.lang === 'k6') return { code: toK6({ name: request.name, requests: [request], collection, environment: findEnvironment(b.environmentId), globals: globals(), config: { mode: 'vus', vus: 1, iterations: 1 }, callbackBase: primaryBase() }) };
    return { code: generateCode(b.lang || 'curl-bash', prep, { insecure: request.settings.insecure }) };
  });
  route('POST', '/api/export/k6', async (req) => {
    const b = await readJson(req);
    const { requests, collection, label } = resolveTarget(b.target);
    return { script: toK6({ name: label, requests, collection, environment: findEnvironment(b.environmentId), globals: globals(), config: { ...DEFAULT_RUN_CONFIG, ...(b.config || {}) }, callbackBase: primaryBase() }) };
  });
  route('GET', '/api/export/collection/:id', (req, p, q, res) => {
    const c = findCollection(p.id);
    if (!c) throw httpError(404, 'Collection not found');
    const fmt = q.get('format') || 'native';
    if (fmt === 'postman') return download(res, `${c.name}.postman_collection.json`, JSON.stringify(toPostman(c), null, 2));
    if (fmt === 'openapi') return download(res, `${c.name}.openapi.json`, JSON.stringify(toOpenApi(c), null, 2));
    if (fmt === 'openapi-yaml') return download(res, `${c.name}.openapi.yaml`, toYaml(toOpenApi(c)) + '\n', 'application/yaml');
    if (fmt === 'yaml') return download(res, `${c.name}.apistorm.yaml`, toYaml({ format: 'apistorm-collection', version: 1, exportedAt: new Date().toISOString(), collection: c }) + '\n', 'application/yaml');
    if (fmt === 'curl') {
      const env = findEnvironment(q.get('environmentId'));
      const resolve = q.get('resolve') === '1';
      const text = c.requests.filter((r) => (r.protocol || 'http') === 'http').map((r) => {
        const ctx = resolve ? buildContext({ environment: env, collection: c, globals: globals(), callbackBase: callbackBaseFor }) : { raw: true };
        try { return `# ${r.name}\n${toCurl(prepareRequest(r, ctx, c))}`; } catch (e) { return `# ${r.name}\n# skipped: ${e.message}`; }
      }).join('\n\n');
      return download(res, `${c.name}.curl.sh`, text + '\n', 'text/plain');
    }
    if (fmt === 'k6') {
      const script = toK6({ name: c.name, requests: c.requests, collection: c, environment: findEnvironment(q.get('environmentId')), globals: globals(), config: { mode: 'vus', vus: 1, iterations: 1 }, callbackBase: primaryBase() });
      return download(res, `${c.name}.k6.js`, script, 'text/javascript');
    }
    return download(res, `${c.name}.apistorm.json`, JSON.stringify({ format: 'apistorm-collection', version: 1, exportedAt: new Date().toISOString(), collection: c }, null, 2));
  });
  route('GET', '/api/export/environment/:id', (req, p, q, res) => {
    const e = findEnvironment(p.id);
    if (!e) throw httpError(404, 'Environment not found');
    if (q.get('format') === 'postman') return download(res, `${e.name}.postman_environment.json`, JSON.stringify(environmentToPostman(e), null, 2));
    return download(res, `${e.name}.apistorm-env.json`, JSON.stringify({ format: 'apistorm-environment', version: 1, environment: e }, null, 2));
  });
  route('GET', '/api/export/workspace', (req, p, q, res) => download(res, `apistorm-workspace-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({
    format: 'apistorm-workspace', version: 1, exportedAt: new Date().toISOString(),
    collections: collections(), environments: environments(), globals: globals(), presets: presets(),
    bins: hub.list().map(({ count, ...b }) => b), listeners: listeners.configs(), mocks: mocks.configs(), schedules: scheduler.all().map(({ history: _h, state: _s, ...s }) => s),
  }, null, 2)));

  // load tests
  route('GET', '/api/runs', () => ({ active: [...activeRuns.values()].map((r) => ({ id: r.id, name: r.config.name, status: r.status, startedAt: r.startedAt, source: r.source })), runs: runsIndex() }));
  route('POST', '/api/runs', async (req) => { const { id, name } = startRun(await readJson(req)); return { id, name }; });
  route('DELETE', '/api/runs', () => {
    const idx = runsIndex();
    for (const r of idx) { try { fs.unlinkSync(path.join(runsDir, `${r.id}.json`)); } catch { /* gone */ } }
    store.set('runs-index', []);
    emit('runs-changed', {});
    return { ok: true, deleted: idx.length };
  });
  route('GET', '/api/runs/:id', (req, p) => loadRun(p.id));
  route('POST', '/api/runs/:id/stop', (req, p) => {
    const r = activeRuns.get(p.id);
    if (!r) throw httpError(404, 'Run is not active');
    r.stop();
    return { ok: true, status: r.status };
  });
  route('POST', '/api/runs/:id/reset', (req, p) => {
    const r = activeRuns.get(p.id);
    if (!r) throw httpError(404, 'Only running tests can be reset');
    r.resetStats();
    return { ok: true, resetAtSec: r.resetAtSec };
  });
  route('POST', '/api/runs/stop-all', () => { for (const r of activeRuns.values()) r.stop(); return { ok: true, stopped: activeRuns.size }; });
  route('DELETE', '/api/runs/:id', (req, p) => {
    if (activeRuns.has(p.id)) throw httpError(409, 'Stop the run first');
    if (!/^[\w-]+$/.test(p.id)) throw httpError(400, 'bad id');
    try { fs.unlinkSync(path.join(runsDir, `${p.id}.json`)); } catch { /* gone */ }
    store.set('runs-index', runsIndex().filter((r) => r.id !== p.id));
    return { ok: true };
  });
  route('GET', '/api/runs/:id/export', (req, p, q, res) => {
    const r = loadRun(p.id);
    const fmt = q.get('format') || 'json';
    const base = `run-${(r.name || r.id).slice(0, 40)}-${(r.startedAt || '').slice(0, 19).replace(/[:T]/g, '-')}`;
    if (fmt === 'csv') return download(res, `${base}.csv`, runToCsv(r), 'text/csv');
    if (fmt === 'html') return download(res, `${base}.html`, renderReport(r), 'text/html');
    return download(res, `${base}.json`, JSON.stringify(r, null, 2));
  });

  // presets
  route('GET', '/api/presets', () => presets());
  route('POST', '/api/presets', async (req) => { const b = await readJson(req); const pr = { ...b, id: uuid(), savedAt: new Date().toISOString() }; store.set('presets', [...presets(), pr]); return pr; });
  route('PUT', '/api/presets/:id', async (req, p) => {
    const b = await readJson(req);
    const list = presets();
    const i = list.findIndex((x) => x.id === p.id);
    if (i < 0) throw httpError(404, 'Preset not found');
    list[i] = { ...b, id: p.id, savedAt: new Date().toISOString() };
    store.set('presets', list);
    return list[i];
  });
  route('DELETE', '/api/presets/:id', (req, p) => { store.set('presets', presets().filter((x) => x.id !== p.id)); return { ok: true }; });
  route('POST', '/api/presets/:id/start', (req, p) => {
    const pr = presets().find((x) => x.id === p.id);
    if (!pr) throw httpError(404, 'Preset not found');
    const { id, name } = startRun({ config: pr.config, target: pr.target, environmentId: pr.environmentId });
    return { id, name };
  });

  // schedules
  route('GET', '/api/schedules', () => scheduler.list());
  route('POST', '/api/schedules', async (req) => scheduler.create(await readJson(req)));
  route('PUT', '/api/schedules/:id', async (req, p) => scheduler.update(p.id, await readJson(req)));
  route('DELETE', '/api/schedules/:id', (req, p) => { scheduler.remove(p.id); return { ok: true }; });
  route('POST', '/api/schedules/:id/run', (req, p) => { scheduler.get(p.id); scheduler.execute(p.id, { manual: true }).catch(() => {}); return { ok: true }; });
  route('DELETE', '/api/schedules/:id/history', (req, p) => { scheduler.clearHistory(p.id); return { ok: true }; });
  route('POST', '/api/cron/preview', async (req) => {
    const { cron } = await readJson(req);
    try { return { ok: true, description: describeCron(cron), next: nextCronTimes(cron, 5).map((d) => d.toISOString()) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  // OAuth 2.0
  const authCtx = (b) => {
    const { ctx, collection } = contextFor(b);
    const auth = b.auth?.type === 'inherit' ? collection?.auth : b.auth;
    if (!auth || auth.type !== 'oauth2') throw httpError(400, 'This request does not use OAuth 2.0');
    return { auth, interp: (s) => interpolate(s, ctx) };
  };
  route('POST', '/api/oauth2/token', async (req) => {
    const b = await readJson(req);
    const { auth, interp } = authCtx(b);
    if (b.peek) { const key = oauthKey({ ...Object.fromEntries(Object.entries(auth).map(([k, v]) => [k, typeof v === 'string' ? interp(v) : v])), grantType: auth.grantType || 'client_credentials' }); return { token: tokenInfo(tokens.get(key) ? { ...tokens.get(key), key } : null) }; }
    return { token: tokenInfo(await getOAuth2Token(auth, interp, tokens, { force: !!b.force })) };
  });
  route('POST', '/api/oauth2/authorize', async (req) => {
    const b = await readJson(req);
    const { auth, interp } = authCtx(b);
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const redirectUri = (interp(auth.redirectUri || '') || `${proto}://${req.headers.host}/oauth2/callback`);
    return { ...startAuthorization(auth, interp, redirectUri), redirectUri };
  });
  route('DELETE', '/api/oauth2/tokens', () => { tokens.clear(); return { ok: true }; });
  route('DELETE', '/api/oauth2/tokens/:key', (req, p) => { tokens.delete(p.key); return { ok: true }; });


  /* ---------------------------------------------------- realtime + gRPC */
  const scopesFor = (b) => {
    const environment = findEnvironment(b.environmentId);
    const collection = findCollection(b.collectionId);
    return { collection, scopes: { local: {}, data: {}, env: varsToObject(environment?.variables), collection: varsToObject(collection?.variables), globals: varsToObject(globals()) } };
  };
  route('GET', '/api/sessions', () => sessions.list());
  route('GET', '/api/sessions/:id', (req, p) => { const s = sessions.get(p.id); return { id: s.id, kind: s.kind, name: s.name, url: s.url, state: s.state, log: s.log, counts: s.counts }; });
  route('POST', '/api/sessions/:id/send', async (req, p) => {
    const b = await readJson(req);
    if (b.interpolate) {
      // resolve {{variables}} in outgoing WebSocket / gRPC stream messages
      const { scopes } = scopesFor(b);
      const ctx = { layers: [scopes.local, scopes.data, scopes.env, scopes.collection, scopes.globals], callbackBase: callbackBaseFor };
      if (typeof b.data === 'string') b.data = interpolate(b.data, ctx);
      if (typeof b.json === 'string') b.json = interpolate(b.json, ctx);
    }
    return sessions.send(p.id, b);
  });
  route('POST', '/api/sessions/:id/ping', (req, p) => sessions.ping(p.id));
  route('POST', '/api/sessions/:id/end', (req, p) => sessions.end(p.id));
  route('POST', '/api/sessions/:id/close', async (req, p) => sessions.close(p.id, await readJson(req)));
  route('POST', '/api/realtime/connect', async (req) => {
    const b = await readJson(req);
    const { collection, scopes } = scopesFor(b);
    const r = normalizeRequest(b.request);
    const { prep } = await prepareOnly(r, { collection, scopes, callbackBase: callbackBaseFor, tokens, scriptTimeoutMs: settings().scriptTimeoutMs });
    if (r.protocol === 'ws') {
      const protocols = String(r.ws?.subprotocols || '').split(',').map((x) => x.trim()).filter(Boolean);
      return sessions.openWebSocket({ url: prep.url, headers: prep.headers.filter(([k]) => !/^content-(type|length)$/i.test(k)), protocols, insecure: r.settings.insecure, name: r.name, clientId: b.clientId });
    }
    if (r.protocol === 'sse') return sessions.openSse({ prep, insecure: r.settings.insecure, name: r.name, clientId: b.clientId });
    throw httpError(400, 'Use protocol "ws" or "sse"');
  });

  /** Target, TLS and metadata for a gRPC request (headers + auth go out as metadata). */
  async function grpcSetup(b) {
    const { collection, scopes } = scopesFor(b);
    const r = normalizeRequest(b.request);
    const g = r.grpc || {};
    const shell = { ...r, protocol: 'http', url: 'http://grpc.local/', params: [], body: { mode: 'none', raw: '', form: [] } };
    const { prep, interp } = await prepareOnly(shell, { collection, scopes, callbackBase: callbackBaseFor, tokens, scriptTimeoutMs: settings().scriptTimeoutMs });
    const target = normalizeTarget(interp(g.target || ''));
    const metadata = prep.headers.filter(([k]) => !/^(content-type|content-length|host|user-agent|accept|accept-encoding)$/i.test(k)).map(([k, v]) => [k.toLowerCase(), v]);
    const tls = g.tls !== false;
    const reg = await registryFor(g, { target, tls, insecure: !!r.settings.insecure, metadata, refresh: !!b.refresh });
    return { r, g, target, tls, metadata, reg, interp };
  }
  route('POST', '/api/grpc/describe', async (req) => {
    const b = await readJson(req);
    const { reg } = await grpcSetup(b);
    return { services: describeServices(reg) };
  });
  route('POST', '/api/grpc/invoke', async (req) => {
    const b = await readJson(req);
    const { r, g, target, tls, metadata, reg, interp } = await grpcSetup(b);
    if (!g.service || !g.method) throw httpError(400, 'Choose a service and a method');
    const m = findMethod(reg, g.service, g.method);
    const path = `/${g.service}/${g.method}`;
    let msg;
    try { msg = JSON.parse(interp(g.message || '{}') || '{}'); } catch (e) { throw httpError(400, `The request message is not valid JSON: ${e.message}`); }
    let encoded;
    try { encoded = encodeMessage(reg, m.inputType, msg); } catch (e) { throw httpError(400, e.message); }
    if (m.clientStreaming) {
      return { streaming: true, ...sessions.openGrpcStream({ target, tls, insecure: !!r.settings.insecure, path, metadata, reg, method: m, timeoutMs: 0, name: r.name, clientId: b.clientId, firstMessage: b.sendFirst === false ? undefined : msg }) };
    }
    if (m.serverStreaming && b.live) {
      const out = sessions.openGrpcStream({ target, tls, insecure: !!r.settings.insecure, path, metadata, reg, method: m, timeoutMs: Number(r.settings.timeoutMs) || 0, name: r.name, clientId: b.clientId, firstMessage: msg });
      sessions.end(out.id);
      return { streaming: true, ...out };
    }
    const res = await grpcInvoke({ target, tls, insecure: !!r.settings.insecure, path, metadata, timeoutMs: Number(r.settings.timeoutMs) || 30000, request: encoded });
    const messages = res.messages.map((buf) => { try { return decodeMessage(reg, m.outputType, buf); } catch (e) { return { _decodeError: e.message }; } });
    return { code: res.code, status: res.status, message: res.message, headers: res.headers, trailers: res.trailers, timeMs: res.timeMs, messages, requestBytes: encoded.length, responseBytes: res.messages.reduce((a, x) => a + x.length, 0), metadata, target, tls, path };
  });

  /* ----------------------------------------------------------- mock servers */
  route('GET', '/api/mocks', () => mocks.list());
  route('POST', '/api/mocks', async (req) => mocks.create(await readJson(req)));
  route('POST', '/api/mocks/from-openapi', async (req) => {
    const b = await readJson(req);
    let { text } = b;
    if (b.url) ({ text } = await fetchImportText(b.url));
    const { value: spec } = parseStructured(text || '');
    if (!isOpenApi(spec)) throw httpError(400, 'This is not an OpenAPI 3 / Swagger 2 document');
    const routes = routesFromOpenApi(spec);
    const m = await mocks.create({ name: b.name || spec.info?.title || 'OpenAPI mock', port: b.port, routes, delayMs: b.delayMs, errorRate: b.errorRate, validate: b.validate });
    let collection = null;
    if (b.createCollection !== false) {
      const col = freshIds(fromOpenApi(spec));
      col.name = `${col.name} (mock)`;
      const base = routes.length ? '' : '';
      const v = col.variables.find((x) => x.key === 'baseUrl');
      let basePath = '';
      try { basePath = spec.swagger ? spec.basePath || '' : new URL((spec.servers || [])[0]?.url || '/', 'http://x').pathname.replace(/\/$/, ''); } catch { basePath = ''; }
      if (v) v.value = m.baseUrl + basePath + base; else col.variables.unshift({ key: 'baseUrl', value: m.baseUrl + basePath, enabled: true });
      store.set('collections', [...collections(), col]);
      emit('workspace-changed', { what: 'all' });
      collection = { id: col.id, name: col.name, requests: col.requests.length };
    }
    return { mock: m, collection };
  });
  route('PUT', '/api/mocks/:id', async (req, p) => mocks.update(p.id, await readJson(req)));
  route('DELETE', '/api/mocks/:id', async (req, p) => { await mocks.remove(p.id); return { ok: true }; });
  route('POST', '/api/mocks/:id/start', async (req, p) => { await mocks.start(p.id); return mocks.list().find((m) => m.id === p.id); });
  route('POST', '/api/mocks/:id/stop', async (req, p) => { await mocks.stop(p.id, { disable: true }); return mocks.list().find((m) => m.id === p.id); });

  // callback bins
  route('GET', '/api/bins', () => ({ bins: hub.list(), base: primaryBase(), pending: hub.pending.size, listeners: listeners.list() }));
  route('POST', '/api/bins', async (req) => hub.createBin(await readJson(req)));
  route('PUT', '/api/bins/:id', async (req, p) => hub.updateBin(decodeURIComponent(p.id), await readJson(req)));
  route('DELETE', '/api/bins/:id', (req, p) => { hub.deleteBin(decodeURIComponent(p.id)); return { ok: true }; });
  route('GET', '/api/bins/:id/items', (req, p) => hub.getItems(decodeURIComponent(p.id)));
  route('DELETE', '/api/bins/:id/items', (req, p) => { hub.clearItems(decodeURIComponent(p.id)); return { ok: true }; });
  route('POST', '/api/test-callback', async (req) => {
    const b = await readJson(req);
    const bin = String(b.bin || 'default');
    const pth = String(b.path || '/').startsWith('/') ? String(b.path || '/') : '/' + b.path;
    const l = listeners.forBin(bin);
    const target = l && b.viaListener ? `http://127.0.0.1:${l.port}${pth}` : `http://127.0.0.1:${CB_PORT}/cb/${encodeURIComponent(bin)}${pth}`;
    const r = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'ApiStorm test callback' }, body: b.body ?? '' });
    return { status: r.status, body: await r.text() };
  });

  // callback listeners (extra ports)
  route('GET', '/api/listeners', () => ({ primary: { port: CB_PORT, host: CB_HOST, base: primaryBase() }, listeners: listeners.list() }));
  route('POST', '/api/listeners', async (req) => listeners.create(await readJson(req)));
  route('PUT', '/api/listeners/:id', async (req, p) => listeners.update(p.id, await readJson(req)));
  route('DELETE', '/api/listeners/:id', async (req, p) => { await listeners.remove(p.id); return { ok: true }; });
  route('POST', '/api/listeners/:id/start', async (req, p) => { await listeners.update(p.id, { enabled: true }); await listeners.start(p.id); return listeners.list().find((l) => l.id === p.id); });
  route('POST', '/api/listeners/:id/stop', async (req, p) => { await listeners.update(p.id, { enabled: false }); return listeners.list().find((l) => l.id === p.id); });

  /* -------------------------------------------------------------- servers */
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
  function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC)) return sendText(res, 403, 'Forbidden');
    fs.readFile(file, (err, data) => {
      if (err) return sendText(res, 404, 'Not found');
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      res.end(data);
    });
  }

  const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
  const authOk = (req) => {
    if (!AUTH) return true;
    const got = Buffer.from(req.headers.authorization || '');
    const want = Buffer.from(AUTH);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  };

  const ui = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    // DNS-rebinding protection when bound to loopback without a password
    if (isLoopback(HOST) && !AUTH && req.headers.host && !ALLOWED_HOSTS.has(req.headers.host.toLowerCase())) return sendText(res, 403, 'Forbidden host');
    if (u.pathname !== '/api/health' && !authOk(req)) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="ApiStorm", charset="UTF-8"', 'content-type': 'text/plain' });
      return res.end('Authentication required');
    }
    if (u.pathname === '/oauth2/callback') {
      const page = (title, msg, ok) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:15px system-ui;padding:40px;background:#1a1a19;color:#f0efec"><h2>${ok ? '✔' : '✖'} ${title}</h2><p>${msg}</p><script>try{window.opener&&window.opener.postMessage({apistormOAuth:${ok}},'*')}catch(e){};${ok ? 'setTimeout(()=>window.close(),1200)' : ''}</script>`;
      const esc = (x) => String(x || '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
      if (u.searchParams.get('error')) return sendText(res, 400, page('Sign-in failed', esc(u.searchParams.get('error_description') || u.searchParams.get('error')), false), 'text/html; charset=utf-8');
      try {
        const t = await finishAuthorization(u.searchParams.get('state'), u.searchParams.get('code'), tokens);
        emit('oauth2-token', { key: t.key });
        return sendText(res, 200, page('Signed in', 'ApiStorm received the access token. You can close this window.', true), 'text/html; charset=utf-8');
      } catch (e) { return sendText(res, 400, page('Sign-in failed', esc(e.message), false), 'text/html; charset=utf-8'); }
    }
    if (!u.pathname.startsWith('/api/')) return serveStatic(req, res, u.pathname);
    if (u.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': connected\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(u.pathname);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
      try {
        const out = await r.handler(req, params, u.searchParams, res);
        if (!res.headersSent) sendJson(res, 200, out ?? { ok: true });
      } catch (e) {
        if (!e.status) console.error(e);
        if (!res.headersSent) sendJson(res, e.status || 500, { error: e.message || String(e) });
      }
      return;
    }
    sendJson(res, 404, { error: 'Not found' });
  });

  const cbServer = http.createServer((req, res) => {
    hub.handle(req, res).catch((e) => { if (!res.headersSent) { res.writeHead(500); res.end(e.message); } });
  });
  cbServer.keepAliveTimeout = 65000;

  const listen = (server, port, host, label, flag) => new Promise((resolve, reject) => {
    server.once('error', (e) => reject(e.code === 'EADDRINUSE' ? new Error(`Port ${port} (${label}) is already in use. Use ${flag} <other port> or stop the other process.`) : e));
    server.listen(port, host, resolve);
  });

  await listen(ui, PORT, HOST, 'UI', '--port');
  await listen(cbServer, CB_PORT, CB_HOST, 'callbacks', '--cb-port');
  const listenerErrors = await listeners.startAll();
  const mockErrors = await mocks.startAll();
  refreshSelfHosts();
  scheduler.start();

  const shownHost = HOST === '0.0.0.0' || HOST === '::' || isLoopback(HOST) ? 'localhost' : HOST;
  log(`
  ApiStorm ${VERSION}
  UI / API ............ http://${shownHost}:${PORT}${AUTH ? '  (password protected)' : ''}
  Callback receiver ... http://${CB_HOST === '0.0.0.0' ? 'localhost' : CB_HOST}:${CB_PORT}/cb/<bin>/...  (public base: ${primaryBase()})
  Extra listeners ..... ${listeners.ports().map((l) => `${l.name} :${l.port}`).join(', ') || 'none'}
  Mock servers ........ ${mocks.list().filter((m) => m.running).map((m) => `${m.name} :${m.port}`).join(', ') || 'none'}
  Scripts ............. ${scriptsEnabled() ? 'enabled' : 'disabled (APISTORM_SCRIPTS=off)'}
  Schedules ........... ${scheduler.all().filter((s) => s.enabled).length} active
  Data directory ...... ${DATA_DIR}
`);
  for (const e of listenerErrors) log(`  ! listener not started: ${e}`);
  for (const e of mockErrors) log(`  ! mock server not started: ${e}`);
  if (!isLoopback(HOST) && !AUTH) log('  ! The UI is reachable from the network without a password. Set APISTORM_USER and APISTORM_PASSWORD to protect it.\n');

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    scheduler.stop();
    for (const r of activeRuns.values()) r.stop('Server shutting down');
    clearInterval(pinger);
    clearInterval(hub.sweeper);
    for (const c of sseClients) c.end();
    await listeners.stopAll();
    await mocks.stopAll();
    sessions.closeAll();
    closeAllGrpc();
    await new Promise((r) => { ui.close(() => r()); ui.closeAllConnections?.(); });
    await new Promise((r) => { cbServer.close(() => r()); cbServer.closeAllConnections?.(); });
    store.flushAll();
  }

  return { close, store, hub, listeners, mocks, sessions, scheduler, ports: { ui: PORT, callbacks: CB_PORT }, dataDir: DATA_DIR };
}

function slimScript(r) { return { source: r.source, logs: r.logs, error: r.error, tests: r.tests, skipRequest: r.skipRequest }; }

function isTextual(ct, buf) {
  if (/json|xml|text|javascript|html|csv|yaml|x-www-form-urlencoded|graphql/i.test(ct || '')) return true;
  if (!buf || !buf.length) return true;
  const sample = buf.subarray(0, 4096);
  if (sample.includes(0)) return false;
  return !sample.toString('utf8').includes('�');
}

function seedCollection(cbPort) {
  return {
    id: uuid(), name: 'Getting started', description: 'Sample requests. {{baseUrl}} comes from the "Local" environment.', variables: [], auth: { type: 'none' },
    requests: [
      newRequest({ name: 'Get JSON', method: 'GET', url: '{{baseUrl}}/json', assertions: [{ type: 'status', op: 'eq', value: '200', enabled: true }], folder: 'httpbin' }),
      newRequest({
        name: 'Create user (POST JSON)', method: 'POST', url: '{{baseUrl}}/post', folder: 'httpbin',
        headers: [{ key: 'X-Trace-Id', value: '{{$uuid}}', enabled: true }],
        body: { mode: 'json', raw: '{\n  "name": "{{$randomFullName}}",\n  "email": "{{$randomEmail}}",\n  "age": {{$randomInt(18,70)}}\n}', form: [], graphql: { query: '', variables: '' } },
        assertions: [{ type: 'status', op: 'eq', value: '2xx', enabled: true }, { type: 'jsonPath', path: '$.json.name', op: 'exists', enabled: true }],
        extract: [{ var: 'lastUserName', from: 'json', path: '$.json.name', enabled: true }],
      }),
      newRequest({
        name: 'Local echo (mock bin)', method: 'POST', url: '{{echo}}/orders', folder: 'local',
        body: { mode: 'json', raw: '{\n  "orderId": "{{$uuid}}",\n  "amount": {{$randomFloat(1,500,2)}}\n}', form: [], graphql: { query: '', variables: '' } },
        assertions: [{ type: 'status', op: 'eq', value: '200', enabled: true }],
        description: `Hits the built-in callback receiver on port ${cbPort}, which works as a local mock server. Good for trying load tests without hammering a real API.`,
      }),
      newRequest({
        name: 'Async job with callback', method: 'POST', url: '{{echo}}/start-job', folder: 'local',
        body: { mode: 'json', raw: '{\n  "callbackUrl": "{{$callbackUrl(jobs)}}",\n  "payload": "hello"\n}', form: [], graphql: { query: '', variables: '' } },
        description: 'Any request that contains {{$callbackUrl}} or {{$requestId}} waits for the matching callback. Simulate it with "Send test callback" in the Callbacks tab, using the id from the sent body.',
      }),
    ],
  };
}

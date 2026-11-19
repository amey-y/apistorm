/*
 * Mock servers: each runs on its own port and answers with configured routes.
 * Routes can be generated from an OpenAPI spec (examples or schema samples), support path params,
 * response templates, latency, error injection and request-body validation against the schema.
 * Every request is recorded in the callback bin "mock-<id>" so it shows up in the Callbacks tab.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { readBody, shortId, sleep } from './util.js';
import { interpolate, requestExtra } from './template.js';
import { resolver, sample } from './converters/openapi.js';

const httpError = (status, message) => Object.assign(new Error(message), { status });
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

/* ------------------------------------------------------------ validation */

export function validateSchema(schema, value, path = '$', errors = [], depth = 0) {
  if (!schema || errors.length >= 10 || depth > 20) return errors;
  if (value === null) { if (!schema.nullable && schema.type && schema.type !== 'null' && !(Array.isArray(schema.type) && schema.type.includes('null'))) errors.push(`${path}: must not be null`); return errors; }
  if (schema.allOf) for (const s of schema.allOf) validateSchema(s, value, path, errors, depth + 1);
  if (schema.oneOf || schema.anyOf) {
    const opts = schema.oneOf || schema.anyOf;
    if (!opts.some((s) => !validateSchema(s, value, path, [], depth + 1).length)) errors.push(`${path}: does not match any allowed schema`);
  }
  let type = schema.type;
  if (Array.isArray(type)) type = type.find((t) => t !== 'null');
  if (!type && schema.properties) type = 'object';
  const actual = Array.isArray(value) ? 'array' : typeof value;
  if (type === 'integer') { if (!Number.isInteger(value)) errors.push(`${path}: must be an integer`); }
  else if (type === 'number') { if (typeof value !== 'number') errors.push(`${path}: must be a number`); }
  else if (type && type !== actual) { errors.push(`${path}: must be ${type === 'array' ? 'an array' : `a ${type}`}`); return errors; }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) errors.push(`${path}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength != null && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.pattern) { try { if (!new RegExp(schema.pattern).test(value)) errors.push(`${path}: does not match pattern ${schema.pattern}`); } catch { /* bad pattern */ } }
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path}: below minimum ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path}: above maximum ${schema.maximum}`);
  }
  if (actual === 'object' && value) {
    for (const r of schema.required || []) if (value[r] === undefined) errors.push(`${path}.${r}: is required`);
    for (const [k, s] of Object.entries(schema.properties || {})) if (value[k] !== undefined) validateSchema(s, value[k], `${path}.${k}`, errors, depth + 1);
    if (schema.additionalProperties === false) for (const k of Object.keys(value)) if (!(schema.properties || {})[k]) errors.push(`${path}.${k}: is not allowed`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) errors.push(`${path}: needs at least ${schema.minItems} items`);
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${path}: allows at most ${schema.maxItems} items`);
    if (schema.items) value.slice(0, 50).forEach((v, i) => validateSchema(schema.items, v, `${path}[${i}]`, errors, depth + 1));
  }
  return errors;
}

/** Replace $refs with their targets (depth-limited) so a schema can be stored on its own. */
function inline(schema, resolve, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 8) return schema;
  if (schema.$ref) return inline(resolve(schema), resolve, depth + 1);
  if (Array.isArray(schema)) return schema.map((s) => inline(s, resolve, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(schema)) out[k] = typeof v === 'object' ? inline(v, resolve, depth + 1) : v;
  return out;
}

/** OpenAPI 3 / Swagger 2 -> mock routes. */
export function routesFromOpenApi(spec) {
  const resolve = resolver(spec);
  let base = '';
  try {
    if (spec.swagger) base = spec.basePath || '';
    else base = new URL((spec.servers || [])[0]?.url || '/', 'http://x').pathname;
  } catch { base = ''; }
  base = base.replace(/\/$/, '');
  const routes = [];
  for (const [p, item0] of Object.entries(spec.paths || {})) {
    const item = resolve(item0);
    for (const m of METHODS) {
      const op = item[m];
      if (!op) continue;
      const codes = Object.keys(op.responses || {});
      const code = codes.find((c) => /^2\d\d$/.test(c)) || (codes.includes('default') ? 'default' : codes[0]) || '200';
      const resp = resolve(op.responses?.[code] || {});
      let body = '';
      let contentType = 'application/json';
      if (spec.swagger) {
        if (resp.examples?.['application/json'] !== undefined) body = JSON.stringify(resp.examples['application/json'], null, 2);
        else if (resp.schema) body = JSON.stringify(sample(resp.schema, resolve), null, 2);
      } else if (resp.content) {
        const ct = Object.keys(resp.content).find((t) => t.includes('json')) || Object.keys(resp.content)[0];
        contentType = ct;
        const c = resp.content[ct] || {};
        const ex = c.example ?? (c.examples ? resolve(Object.values(c.examples)[0])?.value : undefined);
        const v = ex !== undefined ? ex : c.schema ? sample(c.schema, resolve) : undefined;
        body = v === undefined ? '' : typeof v === 'string' && !ct.includes('json') ? v : JSON.stringify(v, null, 2);
      }
      let requestSchema = null;
      if (spec.swagger) { const bp = (op.parameters || []).map((x) => resolve(x)).find((x) => x.in === 'body'); if (bp?.schema) requestSchema = inline(bp.schema, resolve); }
      else { const rb = resolve(op.requestBody); const c = rb?.content?.['application/json'] || Object.entries(rb?.content || {}).find(([t]) => t.includes('json'))?.[1]; if (c?.schema) requestSchema = inline(c.schema, resolve); }
      routes.push({
        id: shortId(), enabled: true, method: m.toUpperCase(), path: base + p, name: op.summary || op.operationId || '',
        status: code === 'default' ? 200 : Number(code) || 200,
        headers: body ? [{ key: 'Content-Type', value: contentType, enabled: true }] : [],
        body, delayMs: 0, requestSchema,
      });
    }
  }
  return routes;
}

function compilePath(p) {
  const names = [];
  const src = String(p || '/').split('/').map((seg) => {
    if (seg === '*') return '.*';
    const m = /^\{(\w+)\}$/.exec(seg) || /^:(\w+)$/.exec(seg);
    if (m) { names.push(m[1]); return '([^/]+)'; }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{(\w+)\\\}/g, (_, n) => { names.push(n); return '([^/]+)'; });
  }).join('/');
  return { re: new RegExp(`^${src}/?$`), names, literal: String(p).split('/').filter((s) => s && !/^[{:*]/.test(s)).length };
}

/* ---------------------------------------------------------------- manager */

export class MockManager {
  constructor({ store, hub, emit = () => {}, defaultHost = '127.0.0.1', portTaken = () => null }) {
    this.store = store;
    this.hub = hub;
    this.emit = emit;
    this.defaultHost = defaultHost;
    this.portTaken = portTaken;
    this.servers = new Map();
    this.errors = new Map();
    this.compiled = new Map();
  }

  configs() { return this.store.get('mocks', []); }
  save(list) { this.store.set('mocks', list); this.compiled.clear(); this.emit('mocks-changed', {}); }
  baseUrl(m) { return (m.publicBase || `http://localhost:${m.port}`).replace(/\/$/, ''); }
  list() { return this.configs().map((m) => ({ ...m, running: this.servers.has(m.id), error: this.errors.get(m.id) || null, baseUrl: this.baseUrl(m), bin: `mock-${m.id}` })); }
  get(id) { const m = this.configs().find((x) => x.id === id); if (!m) throw httpError(404, 'Mock server not found'); return m; }
  ports() { return this.configs().filter((m) => this.servers.has(m.id)).map((m) => m.port); }

  validate(m) {
    const port = Number(m.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw httpError(400, 'Port must be between 1 and 65535');
    const taken = this.portTaken(port, m.id);
    if (taken) throw httpError(409, `Port ${port} is already used by ${taken}`);
    if (this.configs().some((x) => x.port === port && x.id !== m.id)) throw httpError(409, `Another mock already uses port ${port}`);
    return port;
  }

  async create(data) {
    const m = {
      id: shortId(), name: String(data.name || 'Mock server').slice(0, 80), port: 0, host: data.host || this.defaultHost,
      delayMs: Number(data.delayMs) || 0, jitterMs: Number(data.jitterMs) || 0, errorRate: Number(data.errorRate) || 0, errorStatus: Number(data.errorStatus) || 500,
      validate: data.validate !== false, cors: data.cors !== false, record: data.record !== false, publicBase: data.publicBase || '',
      routes: (data.routes || []).map((r) => ({ id: shortId(), enabled: true, method: 'GET', path: '/', status: 200, headers: [], body: '', delayMs: 0, ...r })),
      createdAt: new Date().toISOString(),
    };
    m.port = this.validate({ ...data, id: m.id });
    this.hub.ensureBin(`mock-${m.id}`);
    this.hub.updateBin(`mock-${m.id}`, { name: `Mock: ${m.name}` });
    this.save([...this.configs(), m]);
    if (data.start !== false) await this.start(m.id).catch(() => {});
    return this.list().find((x) => x.id === m.id);
  }

  async update(id, data) {
    const list = this.configs();
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) throw httpError(404, 'Mock server not found');
    const merged = { ...list[i], ...data, id };
    merged.port = this.validate(merged);
    merged.routes = (merged.routes || []).map((r) => ({ id: r.id || shortId(), ...r }));
    const restart = this.servers.has(id) && (merged.port !== list[i].port || merged.host !== list[i].host);
    list[i] = merged;
    this.save(list);
    if (merged.name !== list[i].name) this.hub.updateBin(`mock-${id}`, { name: `Mock: ${merged.name}` });
    if (restart) { await this.stop(id); await this.start(id).catch(() => {}); }
    return this.list().find((x) => x.id === id);
  }

  async remove(id) {
    await this.stop(id);
    this.save(this.configs().filter((x) => x.id !== id));
    try { this.hub.deleteBin(`mock-${id}`); } catch { /* ignore */ }
  }

  start(id) {
    const m = this.get(id);
    if (this.servers.has(id)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handle(id, req, res).catch((e) => { if (!res.headersSent) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end(e.message); } }));
      server.keepAliveTimeout = 65000;
      server.once('error', (e) => {
        const msg = e.code === 'EADDRINUSE' ? `Port ${m.port} is already in use` : e.message;
        this.errors.set(id, msg);
        this.emit('mocks-changed', {});
        reject(httpError(409, msg));
      });
      server.listen(m.port, m.host || this.defaultHost, () => {
        this.servers.set(id, server);
        this.errors.delete(id);
        const list = this.configs();
        const x = list.find((y) => y.id === id);
        if (x && !x.enabled) { x.enabled = true; this.save(list); } else this.emit('mocks-changed', {});
        resolve();
      });
    });
  }

  stop(id, { disable = false } = {}) {
    const s = this.servers.get(id);
    if (disable) { const list = this.configs(); const x = list.find((y) => y.id === id); if (x && x.enabled !== false) { x.enabled = false; this.save(list); } }
    if (!s) return Promise.resolve();
    this.servers.delete(id);
    this.emit('mocks-changed', {});
    return new Promise((r) => { s.close(() => r()); s.closeAllConnections?.(); });
  }

  async startAll() {
    const errs = [];
    for (const m of this.configs()) if (m.enabled !== false) await this.start(m.id).catch((e) => errs.push(`${m.name}: ${e.message}`));
    return errs;
  }
  async stopAll() { for (const id of [...this.servers.keys()]) await this.stop(id); }

  routesFor(m) {
    let c = this.compiled.get(m.id);
    if (!c) {
      c = m.routes.filter((r) => r.enabled !== false).map((r) => ({ r, ...compilePath(r.path) })).sort((a, b) => b.literal - a.literal || a.names.length - b.names.length);
      this.compiled.set(m.id, c);
    }
    return c;
  }

  async handle(id, req, res) {
    const m = this.configs().find((x) => x.id === id);
    if (!m) { res.writeHead(503); res.end(); return; }
    const u = new URL(req.url, 'http://x');
    const cors = m.cors !== false ? { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } : {};
    const buf = await readBody(req, 10 * 1024 * 1024).catch(() => Buffer.alloc(0));
    const bodyText = buf.toString('utf8');
    const headerPairs = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) headerPairs.push([req.rawHeaders[i], req.rawHeaders[i + 1]]);
    let matched = null, params = {};
    for (const c of this.routesFor(m)) {
      if (c.r.method !== req.method && !(c.r.method === 'ANY') && !(req.method === 'HEAD' && c.r.method === 'GET')) continue;
      const mm = c.re.exec(u.pathname);
      if (mm) { matched = c.r; c.names.forEach((n, i) => { params[n] = decodeURIComponent(mm[i + 1]); }); break; }
    }
    let status, headers = { ...cors }, body = '', note = '';
    if (req.method === 'OPTIONS' && m.cors !== false && !matched) { status = 204; note = 'CORS preflight'; }
    else if (!matched) {
      status = 404; headers['Content-Type'] = 'application/json';
      body = JSON.stringify({ error: 'No mock route matches this request', method: req.method, path: u.pathname, routes: m.routes.filter((r) => r.enabled !== false).map((r) => `${r.method} ${r.path}`) }, null, 2);
      note = 'no matching route';
    } else if (Number(m.errorRate) > 0 && crypto.randomInt(10000) < Number(m.errorRate) * 100) {
      status = Number(m.errorStatus) || 500; headers['Content-Type'] = 'application/json';
      body = JSON.stringify({ error: 'Injected error (mock error rate)', status });
      note = 'injected error';
    } else {
      let parsed;
      try { parsed = JSON.parse(bodyText); } catch { parsed = bodyText; }
      const errors = m.validate !== false && matched.requestSchema && !['GET', 'HEAD', 'DELETE'].includes(req.method)
        ? (typeof parsed === 'string' && bodyText.trim() ? ['$: request body is not valid JSON'] : validateSchema(matched.requestSchema, parsed === '' ? undefined : parsed))
        : [];
      if (errors.length) {
        status = 400; headers['Content-Type'] = 'application/json';
        body = JSON.stringify({ error: 'Request body does not match the schema', details: errors }, null, 2);
        note = 'validation failed';
      } else {
        const info = { method: req.method, path: u.pathname, params, query: Object.fromEntries(u.searchParams), headers: Object.fromEntries(headerPairs.map(([k, v]) => [k.toLowerCase(), v])), body: parsed };
        const ctx = { layers: [], extra: requestExtra(info) };
        status = Number(matched.status) || 200;
        for (const h of matched.headers || []) if (h.enabled !== false && h.key) headers[h.key] = interpolate(h.value ?? '', ctx);
        body = interpolate(matched.body ?? '', ctx);
      }
    }
    const delay = (matched && Number(matched.delayMs)) || Number(m.delayMs) || 0;
    const jitter = Number(m.jitterMs) || 0;
    const wait = delay + (jitter ? Math.random() * jitter : 0);
    if (m.record !== false && !(headerPairs.some(([k, v]) => k.toLowerCase() === 'x-apistorm-origin' && v === 'run'))) {
      this.hub.record(`mock-${id}`, {
        method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: headerPairs, body: bodyText.slice(0, 256 * 1024), size: buf.length, ip: req.socket.remoteAddress, port: m.port,
        mock: { route: matched ? `${matched.method} ${matched.path}` : null, status, note },
      });
    }
    if (wait > 0) await sleep(Math.min(wait, 120000));
    res.writeHead(status, headers);
    res.end(req.method === 'HEAD' || status === 204 || status === 304 ? undefined : body);
  }
}

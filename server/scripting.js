/*
 * Pre-request and post-response scripts with a Postman-compatible `pm` API.
 *
 * Scripts run in a separate V8 context (node:vm) with a CPU timeout. That keeps scripts from
 * accidentally touching the server's globals, but it is NOT a security boundary: anyone who can
 * edit scripts can run code with the server's privileges. Disable scripts on shared servers with
 * untrusted users by setting APISTORM_SCRIPTS=off.
 */
import vm from 'node:vm';
import crypto from 'node:crypto';
import util from 'node:util';
import { getPath } from './util.js';

export const scriptsEnabled = () => !/^(off|false|0|no)$/i.test(process.env.APISTORM_SCRIPTS || '');

const MAX_LOGS = 200;
const compiled = new Map();

function compile(code) {
  let s = compiled.get(code);
  if (s) return s;
  // parameters are bound synchronously at call time, so concurrent async scripts never mix up their `pm`
  s = new vm.Script(`(async (pm, postman, console, require, CryptoJS, tests, responseBody, responseCode, responseTime, responseHeaders, request, environment, globals, data, iteration, btoa, atob, setTimeout, sleep, utils) => {\n${code}\n})(...__apistorm_args)`, { filename: 'script.js', lineOffset: -1 });
  if (compiled.size > 500) compiled.delete(compiled.keys().next().value);
  compiled.set(code, s);
  return s;
}

/* -------------------------------------------------------- mini assertions */

export class AssertionError extends Error { constructor(m) { super(m); this.name = 'AssertionError'; } }

const show = (v) => {
  if (typeof v === 'string') return JSON.stringify(v.length > 80 ? v.slice(0, 80) + '…' : v);
  try { const s = util.inspect(v, { depth: 2, breakLength: Infinity }); return s.length > 120 ? s.slice(0, 120) + '…' : s; } catch { return String(v); }
};
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : v instanceof RegExp ? 'regexp' : v instanceof Date ? 'date' : typeof v);
export function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

class Assertion {
  constructor(obj, msg) { this._obj = obj; this._msg = msg; this._not = false; this._deep = false; this._nested = false; this._any = false; }
  _assert(cond, msg, negMsg) {
    if ((this._not ? !cond : cond)) return this;
    throw new AssertionError(`${this._msg ? this._msg + ': ' : ''}${this._not ? negMsg : msg}`);
  }
  equal(v) { return this._deep ? this.eql(v) : this._assert(this._obj === v, `expected ${show(this._obj)} to equal ${show(v)}`, `expected ${show(this._obj)} to not equal ${show(v)}`); }
  eql(v) { return this._assert(deepEqual(this._obj, v), `expected ${show(this._obj)} to deeply equal ${show(v)}`, `expected ${show(this._obj)} to not deeply equal ${show(v)}`); }
  above(n) { return this._assert(this._len() > n, `expected ${show(this._obj)} to be above ${n}`, `expected ${show(this._obj)} to be at most ${n}`); }
  below(n) { return this._assert(this._len() < n, `expected ${show(this._obj)} to be below ${n}`, `expected ${show(this._obj)} to be at least ${n}`); }
  least(n) { return this._assert(this._len() >= n, `expected ${show(this._obj)} to be at least ${n}`, `expected ${show(this._obj)} to be below ${n}`); }
  most(n) { return this._assert(this._len() <= n, `expected ${show(this._obj)} to be at most ${n}`, `expected ${show(this._obj)} to be above ${n}`); }
  within(a, b) { const v = this._len(); return this._assert(v >= a && v <= b, `expected ${show(this._obj)} to be within ${a}..${b}`, `expected ${show(this._obj)} to not be within ${a}..${b}`); }
  _len() { return this._lengthMode ? this._obj?.length : this._obj; }
  include(v) {
    const o = this._obj;
    let ok;
    if (typeof o === 'string') ok = o.includes(v);
    else if (Array.isArray(o)) ok = o.some((x) => (this._deep || typeof v === 'object' ? deepEqual(x, v) : x === v));
    else if (o && typeof o === 'object' && v && typeof v === 'object') ok = Object.entries(v).every(([k, x]) => deepEqual(o[k], x));
    else ok = false;
    return this._assert(ok, `expected ${show(o)} to include ${show(v)}`, `expected ${show(o)} to not include ${show(v)}`);
  }
  property(name, ...val) {
    const has = this._nested ? getPath(this._obj, name) !== undefined : this._obj != null && Object.prototype.hasOwnProperty.call(Object(this._obj), name) || (this._obj != null && name in Object(this._obj));
    const actual = this._nested ? getPath(this._obj, name) : this._obj?.[name];
    if (!val.length) { this._assert(has, `expected ${show(this._obj)} to have property ${show(name)}`, `expected ${show(this._obj)} to not have property ${show(name)}`); }
    else this._assert(has && (this._deep ? deepEqual(actual, val[0]) : actual === val[0]), `expected property ${show(name)} to be ${show(val[0])}, got ${show(actual)}`, `expected property ${show(name)} to not be ${show(val[0])}`);
    if (!this._not) { const next = new Assertion(actual, this._msg); return next; }
    return this;
  }
  lengthOf(n) { const l = this._obj?.length ?? (this._obj instanceof Map || this._obj instanceof Set ? this._obj.size : undefined); return this._assert(l === n, `expected ${show(this._obj)} to have length ${n} but got ${l}`, `expected ${show(this._obj)} to not have length ${n}`); }
  match(re) { return this._assert(new RegExp(re).test(String(this._obj)), `expected ${show(this._obj)} to match ${re}`, `expected ${show(this._obj)} not to match ${re}`); }
  a(type) { return this._assert(typeOf(this._obj) === String(type).toLowerCase(), `expected ${show(this._obj)} to be a ${type}`, `expected ${show(this._obj)} not to be a ${type}`); }
  oneOf(list) { return this._assert(list.some((x) => (this._deep ? deepEqual(x, this._obj) : x === this._obj)), `expected ${show(this._obj)} to be one of ${show(list)}`, `expected ${show(this._obj)} to not be one of ${show(list)}`); }
  keys(...ks) {
    ks = ks.flat();
    const own = Object.keys(this._obj || {});
    const ok = this._any ? ks.some((k) => own.includes(k)) : ks.every((k) => own.includes(k)) && own.length === ks.length;
    return this._assert(ok, `expected ${show(this._obj)} to have keys ${show(ks)}`, `expected ${show(this._obj)} to not have keys ${show(ks)}`);
  }
  members(list) {
    const o = this._obj || [];
    const ok = o.length === list.length && list.every((x) => o.some((y) => deepEqual(x, y)));
    return this._assert(ok, `expected ${show(o)} to have the same members as ${show(list)}`, `expected ${show(o)} to not have the same members as ${show(list)}`);
  }
  satisfy(fn) { return this._assert(!!fn(this._obj), `expected ${show(this._obj)} to satisfy the function`, `expected ${show(this._obj)} to not satisfy the function`); }
  string(s) { return this.include(s); }
  fail(msg) { throw new AssertionError(msg || 'assertion failed'); }
}
const alias = { equals: 'equal', eq: 'equal', eqls: 'eql', gt: 'above', greaterThan: 'above', lt: 'below', lessThan: 'below', gte: 'least', lte: 'most', includes: 'include', contain: 'include', contains: 'include', matches: 'match', an: 'a', key: 'keys', haveOwnProperty: 'property', ownProperty: 'property' };
for (const [a, b] of Object.entries(alias)) Assertion.prototype[a] = Assertion.prototype[b];
for (const w of ['to', 'be', 'been', 'is', 'that', 'which', 'and', 'has', 'have', 'with', 'at', 'of', 'same', 'but', 'does', 'still', 'also']) Object.defineProperty(Assertion.prototype, w, { get() { return this; } });
const flag = (name, key) => Object.defineProperty(Assertion.prototype, name, { get() { this[key] = name === 'not' ? !this[key] : true; return this; } });
flag('not', '_not'); flag('deep', '_deep'); flag('nested', '_nested'); flag('any', '_any'); flag('all', '_all'); flag('own', '_own');
// `length` works both as a method (have.length(3)) and as a chain (have.length.above(2))
Object.defineProperty(Assertion.prototype, 'length', {
  get() {
    const self = this;
    const fn = (n) => self.lengthOf(n);
    for (const m of ['above', 'below', 'least', 'most', 'within', 'gt', 'lt', 'gte', 'lte']) fn[m] = (...a) => { self._lengthMode = true; return self[m](...a); };
    return fn;
  },
});
const getterAssert = {
  ok: (o) => [!!o, `expected ${show(o)} to be truthy`, `expected ${show(o)} to be falsy`],
  true: (o) => [o === true, `expected ${show(o)} to be true`, `expected ${show(o)} to not be true`],
  false: (o) => [o === false, `expected ${show(o)} to be false`, `expected ${show(o)} to not be false`],
  null: (o) => [o === null, `expected ${show(o)} to be null`, `expected ${show(o)} to not be null`],
  undefined: (o) => [o === undefined, `expected ${show(o)} to be undefined`, `expected ${show(o)} to not be undefined`],
  exist: (o) => [o !== null && o !== undefined, `expected ${show(o)} to exist`, `expected ${show(o)} to not exist`],
  empty: (o) => [o == null || (typeof o === 'string' || Array.isArray(o) ? o.length === 0 : typeof o === 'object' ? Object.keys(o).length === 0 : false), `expected ${show(o)} to be empty`, `expected ${show(o)} to not be empty`],
  NaN: (o) => [Number.isNaN(o), `expected ${show(o)} to be NaN`, `expected ${show(o)} to not be NaN`],
};
for (const [name, fn] of Object.entries(getterAssert)) Object.defineProperty(Assertion.prototype, name, { get() { const [c, m, n] = fn(this._obj); return this._assert(c, m, n); } });

export const expect = (v, msg) => new Assertion(v, msg);

/* ----------------------------------------------------------- CryptoJS shim */

class WordArray {
  constructor(buf) { this.buf = Buffer.from(buf); this.sigBytes = this.buf.length; }
  toString(enc) { return (enc || CryptoJS.enc.Hex).stringify(this); }
  concat(w) { this.buf = Buffer.concat([this.buf, toBuf(w)]); this.sigBytes = this.buf.length; return this; }
}
const toBuf = (v) => (v instanceof WordArray ? v.buf : Buffer.isBuffer(v) ? v : Buffer.from(String(v ?? ''), 'utf8'));
const enc = (name) => ({ stringify: (w) => toBuf(w).toString(name), parse: (s) => new WordArray(Buffer.from(String(s), name)) });
const hash = (alg) => (msg) => new WordArray(crypto.createHash(alg).update(toBuf(msg)).digest());
const hmac = (alg) => (msg, key) => new WordArray(crypto.createHmac(alg, toBuf(key)).update(toBuf(msg)).digest());
export const CryptoJS = {
  enc: { Hex: enc('hex'), Base64: enc('base64'), Base64url: enc('base64url'), Utf8: enc('utf8'), Latin1: enc('latin1') },
  lib: { WordArray: { create: (b) => new WordArray(b || []), random: (n) => new WordArray(crypto.randomBytes(n)) } },
  MD5: hash('md5'), SHA1: hash('sha1'), SHA256: hash('sha256'), SHA384: hash('sha384'), SHA512: hash('sha512'),
  HmacMD5: hmac('md5'), HmacSHA1: hmac('sha1'), HmacSHA256: hmac('sha256'), HmacSHA384: hmac('sha384'), HmacSHA512: hmac('sha512'),
};

/** Helpers that are handy for API signing (exposed as `utils` in scripts). */
export const scriptUtils = {
  uuid: () => crypto.randomUUID(),
  hmac: (alg, key, data, encoding = 'hex') => crypto.createHmac(alg, toBuf(key)).update(toBuf(data)).digest(encoding),
  hash: (alg, data, encoding = 'hex') => crypto.createHash(alg).update(toBuf(data)).digest(encoding),
  base64: (s) => Buffer.from(String(s)).toString('base64'),
  unbase64: (s) => Buffer.from(String(s), 'base64').toString('utf8'),
  base64url: (s) => Buffer.from(String(s)).toString('base64url'),
  randomHex: (n = 16) => crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n),
  timestamp: () => Math.floor(Date.now() / 1000),
};

/* ------------------------------------------------------------- pm object */

function scope(obj, changes, name) {
  return {
    get: (k) => obj[k],
    set: (k, v) => { obj[k] = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); changes?.set.add(k); changes?.unset.delete(k); },
    unset: (k) => { delete obj[k]; changes?.unset.add(k); changes?.set.delete(k); },
    has: (k) => Object.prototype.hasOwnProperty.call(obj, k),
    clear: () => { for (const k of Object.keys(obj)) { delete obj[k]; changes?.unset.add(k); } },
    toObject: () => ({ ...obj }),
    replaceIn: undefined,
    name,
  };
}

function headerList(list, editable) {
  const find = (k) => list.findIndex((h) => h.key?.toLowerCase() === String(k).toLowerCase() && h.enabled !== false);
  return {
    get: (k) => { const i = find(k); return i >= 0 ? list[i].value : undefined; },
    has: (k, v) => { const i = find(k); return i >= 0 && (v === undefined || list[i].value === v); },
    add: (h) => { if (!editable) return; list.push({ key: h.key, value: String(h.value ?? ''), enabled: true }); },
    upsert: (h) => { if (!editable) return; const i = find(h.key); if (i >= 0) list[i].value = String(h.value ?? ''); else list.push({ key: h.key, value: String(h.value ?? ''), enabled: true }); },
    remove: (k) => { if (!editable) return; let i; while ((i = find(k)) >= 0) list.splice(i, 1); },
    toObject: () => Object.fromEntries(list.filter((h) => h.enabled !== false && h.key).map((h) => [h.key, h.value])),
    all: () => list.filter((h) => h.enabled !== false).map((h) => ({ key: h.key, value: h.value })),
    each: (fn) => list.filter((h) => h.enabled !== false).forEach((h) => fn({ key: h.key, value: h.value })),
    count: () => list.filter((h) => h.enabled !== false).length,
  };
}

function requestApi(req, editable) {
  const queryApi = {
    add: (p) => { if (editable) req.params.push({ key: p.key, value: String(p.value ?? ''), enabled: true }); },
    upsert: (p) => { if (!editable) return; const x = req.params.find((q) => q.key === p.key); if (x) x.value = String(p.value ?? ''); else req.params.push({ key: p.key, value: String(p.value ?? ''), enabled: true }); },
    remove: (k) => { if (editable) req.params = req.params.filter((q) => q.key !== k); },
    get: (k) => req.params.find((q) => q.key === k && q.enabled !== false)?.value,
    toObject: () => Object.fromEntries(req.params.filter((q) => q.enabled !== false && q.key).map((q) => [q.key, q.value])),
  };
  const urlObj = () => ({
    toString: () => req.url + (req.params.some((q) => q.enabled !== false && q.key) ? (req.url.includes('?') ? '&' : '?') + req.params.filter((q) => q.enabled !== false && q.key).map((q) => `${q.key}=${q.value ?? ''}`).join('&') : ''),
    query: queryApi,
    getHost: () => { try { return new URL(req.url).host; } catch { return ''; } },
    getPath: () => { try { return new URL(req.url).pathname; } catch { return req.url; } },
    addQueryParams: (ps) => (Array.isArray(ps) ? ps : [ps]).forEach((p) => queryApi.add(typeof p === 'string' ? { key: p.split('=')[0], value: p.split('=')[1] } : p)),
  });
  const body = {
    get mode() { return req.body.mode; }, set mode(m) { if (editable) req.body.mode = m; },
    get raw() { return req.body.raw; }, set raw(v) { if (editable) req.body.raw = String(v ?? ''); },
    update: (v) => { if (!editable) return; if (typeof v === 'string') req.body.raw = v; else if (v?.mode) Object.assign(req.body, v); },
    get urlencoded() { return headerList(req.body.form, editable); },
    get formdata() { return headerList(req.body.form, editable); },
    toString: () => req.body.raw || '',
  };
  return {
    get url() { return urlObj(); },
    set url(v) {
      if (!editable) return;
      const s = String(v);
      const i = s.indexOf('?');
      if (i < 0) { req.url = s; return; }
      req.url = s.slice(0, i);
      req.params = s.slice(i + 1).split('&').filter(Boolean).map((p) => { const e = p.indexOf('='); return { key: e < 0 ? p : p.slice(0, e), value: e < 0 ? '' : p.slice(e + 1), enabled: true }; });
    },
    get method() { return req.method; }, set method(m) { if (editable) req.method = String(m).toUpperCase(); },
    get name() { return req.name; },
    get id() { return req.id; },
    headers: headerList(req.headers, editable),
    addHeader: (h) => headerList(req.headers, editable).add(h),
    removeHeader: (k) => headerList(req.headers, editable).remove(k),
    upsertHeader: (h) => headerList(req.headers, editable).upsert(h),
    body,
  };
}

function responseApi(res, bodyText) {
  if (!res) return undefined;
  let json;
  const pairs = (res.headerPairs || []).map(([key, value]) => ({ key, value, enabled: true }));
  const r = {
    code: res.status, status: res.statusText || '', responseTime: res.timings?.total, responseSize: res.bytesIn,
    headers: headerList(pairs, false),
    text: () => bodyText,
    json: () => { if (json === undefined) { try { json = JSON.parse(bodyText); } catch (e) { throw new AssertionError(`Response body is not valid JSON: ${e.message}`); } } return json; },
    reason: () => res.statusText || '',
  };
  const exp = (msg) => expect(r, msg);
  r.to = {
    have: {
      status: (s) => (typeof s === 'number' ? expect(r.code, 'status code').to.equal(s) : expect(r.status, 'status text').to.equal(s)),
      header: (k, v) => { expect(r.headers.has(k), `header ${k}`).to.be.true; if (v !== undefined) expect(r.headers.get(k), `header ${k}`).to.equal(v); },
      body: (s) => (s === undefined ? expect(bodyText.length, 'body').to.be.above(0) : typeof s === 'string' ? expect(bodyText).to.equal(s) : expect(bodyText).to.match(s)),
      jsonBody: (path, v) => { const j = r.json(); if (path === undefined) return; expect(getPath(j, path), path).to.exist; if (v !== undefined) expect(getPath(j, path), path).to.eql(v); },
      responseTime: { below: (n) => expect(r.responseTime, 'response time').to.be.below(n), above: (n) => expect(r.responseTime, 'response time').to.be.above(n) },
    },
    be: {
      get ok() { return expect(r.code >= 200 && r.code < 300, `status ${r.code} to be 2xx`).to.be.true; },
      get success() { return expect(r.code >= 200 && r.code < 300, `status ${r.code} to be 2xx`).to.be.true; },
      get error() { return expect(r.code >= 400, `status ${r.code} to be an error`).to.be.true; },
      get clientError() { return expect(r.code >= 400 && r.code < 500, `status ${r.code} to be 4xx`).to.be.true; },
      get serverError() { return expect(r.code >= 500, `status ${r.code} to be 5xx`).to.be.true; },
      get notFound() { return expect(r.code, 'status').to.equal(404); },
      get unauthorized() { return expect(r.code, 'status').to.equal(401); },
      get forbidden() { return expect(r.code, 'status').to.equal(403); },
      get badRequest() { return expect(r.code, 'status').to.equal(400); },
      get json() { return expect(String(r.headers.get('content-type')), 'content-type').to.include('json'); },
    },
  };
  r.to.not = { have: { status: (s) => expect(r.code, 'status code').to.not.equal(s) } };
  void exp;
  return r;
}

/**
 * Run one script.
 * opts = {
 *   phase: 'pre' | 'post', request (mutable, normalized), response?, bodyText?,
 *   scopes: { local, data, env, collection, globals } (plain objects, mutated in place),
 *   changes: { env, collection, globals } each { set:Set, unset:Set } (optional, for persistence),
 *   info: { requestName, requestId, iteration, vu },
 *   interpolate(str) -> str, sendRequest(reqLike) -> Promise<{status, statusText, headerPairs, body, timings}>,
 *   timeoutMs, context (reusable vm context)
 * }
 * returns { tests:[{name, pass, error}], logs:[{level, text}], error, skipRequest, nextRequest }
 */
export async function runScript(code, opts) {
  const out = { tests: [], logs: [], error: null, skipRequest: false, nextRequest: undefined };
  if (!code || !code.trim()) return out;
  if (!scriptsEnabled()) { out.error = 'Scripts are disabled on this server (APISTORM_SCRIPTS=off)'; return out; }
  const { scopes, info = {}, phase } = opts;
  const changes = opts.changes || {};
  const log = (level) => (...args) => {
    if (out.logs.length >= MAX_LOGS) return;
    out.logs.push({ level, text: args.map((a) => (typeof a === 'string' ? a : util.inspect(a, { depth: 4, breakLength: 120 }))).join(' ').slice(0, 4000), at: Date.now() });
  };
  const consoleApi = { log: log('log'), info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug'), table: log('log'), dir: log('log') };
  const pending = [];
  const test = (name, fn) => {
    const record = (pass, err) => out.tests.push({ name: String(name), pass, error: err ? String(err.message || err) : null, source: 'script' });
    try {
      const r = typeof fn === 'function' ? fn() : undefined;
      if (r && typeof r.then === 'function') pending.push(r.then(() => record(true), (e) => record(false, e)));
      else record(true);
    } catch (e) { record(false, e); }
  };
  test.skip = (name) => out.tests.push({ name: String(name), pass: true, skipped: true, error: null, source: 'script' });

  const varsApi = {
    get: (k) => { for (const s of [scopes.local, scopes.data, scopes.env, scopes.collection, scopes.globals]) if (s && s[k] !== undefined) return s[k]; return undefined; },
    set: (k, v) => { scopes.local[k] = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); },
    unset: (k) => { delete scopes.local[k]; },
    has: (k) => varsApi.get(k) !== undefined,
    toObject: () => ({ ...scopes.globals, ...scopes.collection, ...scopes.env, ...scopes.data, ...scopes.local }),
    replaceIn: (s) => opts.interpolate(s),
  };
  const withReplace = (s) => ({ ...s, replaceIn: (str) => opts.interpolate(str) });
  const sendRequest = (reqLike, cb) => {
    const p = opts.sendRequest(reqLike).then((res) => {
      const text = res.body ? res.body.toString('utf8') : '';
      const api = res.error ? null : responseApi(res, text);
      if (res.error) throw new Error(res.error);
      return api;
    });
    if (typeof cb === 'function') { pending.push(p.then((r) => cb(null, r), (e) => cb(e, null))); return undefined; }
    return p;
  };
  const response = phase === 'post' ? responseApi(opts.response, opts.bodyText || '') : undefined;
  const pm = {
    info: { requestName: info.requestName, requestId: info.requestId, iteration: info.iteration ?? 0, eventName: phase === 'pre' ? 'prerequest' : 'test' },
    environment: withReplace(scope(scopes.env, changes.env, 'environment')),
    collectionVariables: withReplace(scope(scopes.collection, changes.collection, 'collection')),
    globals: withReplace(scope(scopes.globals, changes.globals, 'globals')),
    variables: varsApi,
    iterationData: { get: (k) => scopes.data?.[k], has: (k) => scopes.data?.[k] !== undefined, toObject: () => ({ ...(scopes.data || {}) }) },
    request: requestApi(opts.request, phase === 'pre'),
    response,
    test,
    expect,
    sendRequest,
    execution: {
      skipRequest: () => { out.skipRequest = true; },
      setNextRequest: (name) => { out.nextRequest = name; },
    },
    setNextRequest: (name) => { out.nextRequest = name; },
  };
  const legacyTests = {};
  const postman = {
    setEnvironmentVariable: (k, v) => pm.environment.set(k, v), getEnvironmentVariable: (k) => pm.environment.get(k), clearEnvironmentVariable: (k) => pm.environment.unset(k),
    setGlobalVariable: (k, v) => pm.globals.set(k, v), getGlobalVariable: (k) => pm.globals.get(k), clearGlobalVariable: (k) => pm.globals.unset(k),
    setNextRequest: (n) => { out.nextRequest = n; },
  };
  const req = opts.request;
  const legacyRequest = { url: req.url, method: req.method, headers: Object.fromEntries(req.headers.filter((h) => h.enabled !== false).map((h) => [h.key, h.value])), data: req.body?.raw };
  const requireFn = (name) => {
    if (name === 'crypto-js') return CryptoJS;
    if (name === 'uuid') return { v4: () => crypto.randomUUID() };
    if (name === 'crypto') return { createHmac: crypto.createHmac, createHash: crypto.createHash, randomUUID: crypto.randomUUID, randomBytes: crypto.randomBytes, randomInt: crypto.randomInt, createSign: crypto.createSign, sign: crypto.sign };
    if (name === 'chai') return { expect };
    throw new Error(`Module "${name}" is not available in ApiStorm scripts (available: crypto-js, crypto, uuid, chai)`);
  };
  const timers = [];
  const setTimeoutSafe = (fn, ms) => { const t = setTimeout(fn, Math.min(Number(ms) || 0, 30000)); timers.push(t); return t; };
  const args = [pm, postman, consoleApi, requireFn, CryptoJS, legacyTests,
    opts.bodyText ?? '', response ? { code: response.code, name: response.status, detail: response.status } : undefined, response?.responseTime,
    response ? response.headers.toObject() : undefined, legacyRequest,
    scopes.env, scopes.globals, scopes.data || {}, info.iteration ?? 0,
    (s) => Buffer.from(String(s), 'binary').toString('base64'), (s) => Buffer.from(String(s), 'base64').toString('binary'),
    setTimeoutSafe, (ms) => new Promise((r) => setTimeoutSafe(r, ms)), scriptUtils];

  const ctx = opts.context || createScriptContext();
  const limit = Number(opts.timeoutMs) || 5000;
  try {
    ctx.__apistorm_args = args;
    const promise = compile(code).runInContext(ctx, { timeout: limit, breakOnSigint: false });
    ctx.__apistorm_args = null;
    let timer;
    await Promise.race([promise, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`Script did not finish within ${limit} ms`)), limit); })]).finally(() => clearTimeout(timer));
    await Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, limit))]);
  } catch (e) {
    out.error = e?.message ? `${e.name && e.name !== 'Error' ? e.name + ': ' : ''}${e.message}` : String(e);
  } finally {
    for (const t of timers) clearTimeout(t);
  }
  for (const [name, v] of Object.entries(legacyTests)) out.tests.push({ name, pass: !!v, error: v ? null : 'tests[] value was falsy', source: 'script' });
  return out;
}

export function createScriptContext() {
  return vm.createContext({ __apistorm_args: null, URL, URLSearchParams, TextEncoder, TextDecoder, structuredClone }, { name: 'apistorm-script', codeGeneration: { strings: true, wasm: false } });
}

/** Merge variable changes made by a script back into a [{key,value,enabled}] list. */
export function applyChanges(list, obj, ch) {
  if (!ch) return false;
  let changed = false;
  for (const k of ch.set) {
    const v = list.find((x) => x.key === k);
    if (v) { if (v.value !== obj[k] || v.enabled === false) { v.value = obj[k]; v.enabled = true; changed = true; } }
    else { list.push({ key: k, value: obj[k], enabled: true }); changed = true; }
  }
  for (const k of ch.unset) { const i = list.findIndex((x) => x.key === k); if (i >= 0) { list.splice(i, 1); changed = true; } }
  return changed;
}

export const newChanges = () => ({ env: { set: new Set(), unset: new Set() }, collection: { set: new Set(), unset: new Set() }, globals: { set: new Set(), unset: new Set() } });

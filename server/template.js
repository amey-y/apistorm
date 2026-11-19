import crypto from 'node:crypto';
import { getPath } from './util.js';

const FIRST = ['James', 'Mary', 'Aarav', 'Priya', 'Liam', 'Emma', 'Noah', 'Olivia', 'Arjun', 'Sofia', 'Kenji', 'Amara', 'Lucas', 'Zara', 'Mateo', 'Isha'];
const LAST = ['Smith', 'Sharma', 'Garcia', 'Chen', 'Patel', 'Mueller', 'Kim', 'Okafor', 'Rossi', 'Silva', 'Novak', 'Ivanova', 'Tanaka', 'Khan'];
const CITIES = ['Mumbai', 'Pune', 'London', 'Berlin', 'Tokyo', 'Lagos', 'Austin', 'Sao Paulo', 'Sydney', 'Toronto'];
const WORDS = ['alpha', 'bravo', 'delta', 'echo', 'nova', 'orbit', 'pixel', 'quartz', 'river', 'solar', 'tango', 'vector'];
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

const rint = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const rstr = (n, set = ALNUM) => { let s = ''; for (let i = 0; i < n; i++) s += set[Math.floor(Math.random() * set.length)]; return s; };

/** Dynamic variables, used as {{$name}} or {{$name(arg1, arg2)}}. Each receives (args[], ctx). */
export const DYNAMIC = {
  uuid: () => crypto.randomUUID(),
  guid: () => crypto.randomUUID(),
  randomUUID: () => crypto.randomUUID(),
  requestId: (_, ctx) => ctx.requestId || (ctx.requestId = crypto.randomUUID()),
  callbackUrl: (a, ctx) => {
    const bin = a[0] || 'default';
    const id = DYNAMIC.requestId([], ctx);
    // callbackBase can be a string or a function(bin) (bins served by a dedicated listener port)
    const base = typeof ctx.callbackBase === 'function' ? ctx.callbackBase(bin) : ctx.callbackBase;
    return `${String(base || '').replace(/\/$/, '')}/cb/${encodeURIComponent(bin)}/${id}`;
  },
  timestamp: () => String(Math.floor(Date.now() / 1000)),
  timestampMs: () => String(Date.now()),
  isoTimestamp: () => new Date().toISOString(),
  date: () => new Date().toISOString().slice(0, 10),
  randomInt: (a) => String(a.length >= 2 ? rint(Number(a[0]), Number(a[1])) : rint(0, 1000)),
  randomFloat: (a) => (a.length >= 2 ? Number(a[0]) + Math.random() * (Number(a[1]) - Number(a[0])) : Math.random() * 1000).toFixed(Number(a[2] ?? 2)),
  randomString: (a) => rstr(Number(a[0] || 12)),
  randomAlpha: (a) => rstr(Number(a[0] || 8), 'abcdefghijklmnopqrstuvwxyz'),
  randomDigits: (a) => rstr(Number(a[0] || 6), '0123456789'),
  randomHex: (a) => crypto.randomBytes(Math.ceil(Number(a[0] || 16) / 2)).toString('hex').slice(0, Number(a[0] || 16)),
  randomBoolean: () => String(Math.random() < 0.5),
  randomFirstName: () => pick(FIRST),
  randomLastName: () => pick(LAST),
  randomFullName: () => `${pick(FIRST)} ${pick(LAST)}`,
  randomEmail: () => `${pick(FIRST).toLowerCase()}.${rstr(6, 'abcdefghijklmnopqrstuvwxyz0123456789')}@example.com`,
  randomPhone: () => `+1${rint(200, 999)}${rint(200, 999)}${rint(1000, 9999)}`,
  randomCity: () => pick(CITIES),
  randomWord: () => pick(WORDS),
  randomItem: (a) => (a.length ? pick(a) : ''),
  iteration: (_, ctx) => String(ctx.iteration ?? 0),
  vu: (_, ctx) => String(ctx.vu ?? 0),
  env: (a) => process.env[a[0]] ?? '',
};

export const DYNAMIC_HELP = {
  uuid: 'Random UUID v4', requestId: 'Per-request UUID (same value everywhere in one request; used for callback correlation)',
  callbackUrl: 'Callback URL that is auto-correlated to this request, e.g. {{$callbackUrl}} or {{$callbackUrl(orders)}}',
  timestamp: 'Unix seconds', timestampMs: 'Unix milliseconds', isoTimestamp: 'ISO-8601 now', date: 'YYYY-MM-DD',
  randomInt: '{{$randomInt}} or {{$randomInt(1,100)}}', randomFloat: '{{$randomFloat(1,10,2)}}', randomString: '{{$randomString(16)}}',
  randomAlpha: 'Lowercase letters', randomDigits: '{{$randomDigits(10)}}', randomHex: '{{$randomHex(32)}}', randomBoolean: 'true/false',
  randomFirstName: 'First name', randomLastName: 'Last name', randomFullName: 'Full name', randomEmail: 'Email at example.com',
  randomPhone: 'Phone number', randomCity: 'City', randomWord: 'Word', randomItem: '{{$randomItem(a,b,c)}}',
  iteration: 'Load-test iteration number', vu: 'Load-test virtual user number', env: '{{$env(NAME)}} OS environment variable',
};

const TOKEN = /\{\{\s*([^{}]+?)\s*\}\}/g;

function parseCall(expr) {
  const m = /^\$([A-Za-z_][\w]*)\s*(?:\((.*)\))?$/.exec(expr);
  if (!m) return null;
  const args = m[2] == null || m[2].trim() === '' ? [] : m[2].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
  return { name: m[1], args };
}

/**
 * ctx = { layers: [obj|Map ...] (first wins), requestId, iteration, vu, callbackBase, extra(name)=>value }
 */
export function lookup(name, ctx) {
  for (const layer of ctx.layers || []) {
    if (!layer) continue;
    const v = layer instanceof Map ? layer.get(name) : layer[name];
    if (v !== undefined && v !== null) return String(v);
  }
  if (ctx.extra) {
    const v = ctx.extra(name);
    if (v !== undefined) return v;
  }
  return undefined;
}

export function interpolate(str, ctx, depth = 0) {
  if (str == null) return str;
  str = String(str);
  if (ctx.raw || !str.includes('{{')) return str;
  const out = str.replace(TOKEN, (whole, expr) => {
    if (expr.startsWith('$')) {
      const call = parseCall(expr);
      if (call && DYNAMIC[call.name]) return DYNAMIC[call.name](call.args.map((x) => interpolate(x, ctx, depth + 1)), ctx);
      return whole;
    }
    const v = lookup(expr, ctx);
    return v === undefined ? whole : v;
  });
  // variables may reference other variables
  if (depth < 4 && out !== str && out.includes('{{')) return interpolate(out, ctx, depth + 1);
  return out;
}

/** Build a layer object from [{key,value,enabled}] */
export function varsToObject(list) {
  const o = {};
  for (const v of list || []) if (v && v.enabled !== false && v.key) o[v.key] = v.value ?? '';
  return o;
}

/** {{names}} that remain unresolved in a string (excluding dynamic ones). */
export function unresolved(str) {
  const out = new Set();
  String(str || '').replace(TOKEN, (_, e) => { if (!e.startsWith('$')) out.add(e); return ''; });
  return [...out];
}

/** Variables for a mock/callback response body: {{request.body.x}}, {{request.query.y}}, {{request.headers.z}} */
export function requestExtra(reqInfo) {
  return (name) => {
    if (!name.startsWith('request.')) return undefined;
    const v = getPath(reqInfo, name.slice(8));
    if (v === undefined) return undefined;
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  };
}

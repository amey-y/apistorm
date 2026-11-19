import { normalizeRequest } from '../prepare.js';
import { varsToObject } from '../template.js';
import { enabledPairs } from '../util.js';

/** Convert an ApiStorm template string into a JS template literal body. */
function tpl(str) {
  const s = String(str ?? '');
  let out = '';
  let last = 0;
  const re = /\{\{\s*([^{}]+?)\s*\}\}/g;
  const esc = (x) => x.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  let m;
  while ((m = re.exec(s))) {
    out += esc(s.slice(last, m.index));
    const expr = m[1];
    if (expr.startsWith('$')) {
      const mm = /^\$([A-Za-z_]\w*)\s*(?:\((.*)\))?$/.exec(expr);
      const args = mm?.[2] ? mm[2].split(',').map((a) => JSON.stringify(a.trim().replace(/^['"]|['"]$/g, ''))) : [];
      out += mm ? `\${dyn(${JSON.stringify(mm[1])}${args.length ? ', ' + args.join(', ') : ''})}` : esc(m[0]);
    } else out += `\${v[${JSON.stringify(expr)}] ?? ''}`;
    last = re.lastIndex;
  }
  out += esc(s.slice(last));
  return '`' + out + '`';
}

function scenario(cfg) {
  const pre = Math.max(1, Number(cfg.maxInFlight) || 100);
  if ((cfg.mode || 'rate') === 'rate') {
    let stages = [];
    if (cfg.useStages && cfg.stages?.length) stages = cfg.stages.map((s) => ({ duration: `${Number(s.durationSec) || 1}s`, target: Number(s.tps) || 0 }));
    else if (Number(cfg.rampUpSec) > 0) stages = [{ duration: `${cfg.rampUpSec}s`, target: Number(cfg.tps) || 1 }, { duration: `${Number(cfg.durationSec) || 1}s`, target: Number(cfg.tps) || 1 }];
    if (stages.length) return { executor: 'ramping-arrival-rate', startRate: Number(cfg.startTps) || 0, timeUnit: '1s', preAllocatedVUs: Math.min(pre, 50), maxVUs: pre, stages };
    return { executor: 'constant-arrival-rate', rate: Number(cfg.tps) || 1, timeUnit: '1s', duration: `${Number(cfg.durationSec) || 1}s`, preAllocatedVUs: Math.min(pre, 50), maxVUs: pre };
  }
  const vus = Math.max(1, Number(cfg.vus) || 1);
  if (Number(cfg.iterations) > 0) return { executor: 'shared-iterations', vus, iterations: Number(cfg.iterations), maxDuration: `${Math.max(60, Number(cfg.durationSec) || 600)}s` };
  if (Number(cfg.rampUpSec) > 0) return { executor: 'ramping-vus', startVUs: 0, stages: [{ duration: `${cfg.rampUpSec}s`, target: vus }, { duration: `${Number(cfg.durationSec) || 1}s`, target: vus }] };
  return { executor: 'constant-vus', vus, duration: `${Number(cfg.durationSec) || 1}s` };
}

function thresholds(cfg) {
  const out = {};
  const add = (k, v) => { (out[k] ||= []).push(v); };
  for (const t of cfg.thresholds || []) {
    const op = t.op || '<';
    if (/^p(\d+)$/.test(t.metric)) add('http_req_duration', `p(${t.metric.slice(1)})${op}${t.value}`);
    else if (t.metric === 'avg') add('http_req_duration', `avg${op}${t.value}`);
    else if (t.metric === 'max') add('http_req_duration', `max${op}${t.value}`);
    else if (t.metric === 'errorRate') add('http_req_failed', `rate${op}${Number(t.value) / 100}`);
    else if (t.metric === 'checkRate') add('checks', `rate${op}${Number(t.value) / 100}`);
    else if (t.metric === 'rps') add('http_reqs', `rate${op}${t.value}`);
  }
  return out;
}

function checkFn(a) {
  const val = JSON.stringify(String(a.value ?? ''));
  const jp = (p) => JSON.stringify(String(p || '').replace(/^\$\.?/, '').replace(/\[(\d+)\]/g, '.$1').replace(/^\./, ''));
  switch (a.type) {
    case 'status':
      if (/x/i.test(String(a.value))) return [`status ${a.value}`, `(r) => /^(${String(a.value).split(',').map((x) => x.trim().replace(/x/gi, '\\d')).join('|')})$/.test(String(r.status))`];
      return [`status ${a.op === 'neq' ? '!=' : 'is'} ${a.value}`, `(r) => ${a.op === 'neq' ? '!' : ''}[${String(a.value).split(',').map((x) => Number(x.trim())).join(', ')}].includes(r.status)`];
    case 'responseTime': return [`response time ${a.op || 'lt'} ${a.value}ms`, `(r) => r.timings.duration ${a.op === 'gt' ? '>' : a.op === 'lte' ? '<=' : a.op === 'gte' ? '>=' : '<'} ${Number(a.value) || 0}`];
    case 'bodyContains': return [`body contains ${a.value}`, `(r) => String(r.body).includes(${val})`];
    case 'header': return [`header ${a.path}`, a.op === 'eq' ? `(r) => r.headers[${JSON.stringify(canonHeader(a.path))}] === ${val}` : `(r) => r.headers[${JSON.stringify(canonHeader(a.path))}] !== undefined`];
    case 'jsonPath':
      if (a.op === 'exists') return [`${a.path} exists`, `(r) => { try { return r.json(${jp(a.path)}) !== undefined; } catch (e) { return false; } }`];
      if (a.op === 'contains') return [`${a.path} contains ${a.value}`, `(r) => { try { return String(r.json(${jp(a.path)})).includes(${val}); } catch (e) { return false; } }`];
      return [`${a.path} == ${a.value}`, `(r) => { try { return String(r.json(${jp(a.path)})) === ${val}; } catch (e) { return false; } }`];
    default: return null;
  }
}

function canonHeader(h) {
  return String(h || '').split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join('-');
}

function requestBlock(r0, i, collection) {
  const r = normalizeRequest(r0);
  const L = [];
  L.push(`  // ${i + 1}. ${r.name.replace(/\n/g, ' ')}`);
  L.push('  {');
  let url = tpl(r.url);
  const qs = enabledPairs(r.params).map((p) => `${encodeURIComponent(p.key)}=\${encodeURIComponent(${tpl(p.value)})}`);
  let auth = r.auth?.type === 'inherit' ? collection?.auth || { type: 'none' } : r.auth || { type: 'none' };
  if (auth.type === 'apikey' && auth.in === 'query' && auth.key) qs.push(`${encodeURIComponent(auth.key)}=\${encodeURIComponent(${tpl(auth.value)})}`);
  if (qs.length) url = url.slice(0, -1) + (r.url.includes('?') ? '&' : '?') + qs.join('&') + '`';
  L.push(`    const headers = {`);
  for (const h of enabledPairs(r.headers)) L.push(`      ${JSON.stringify(h.key)}: ${tpl(h.value)},`);
  if (auth.type === 'bearer') L.push(`      Authorization: \`${auth.prefix || 'Bearer'} \${${tpl(auth.token)}}\`,`);
  if (auth.type === 'basic') L.push(`      Authorization: 'Basic ' + encoding.b64encode(${tpl(auth.username)} + ':' + ${tpl(auth.password)}),`);
  if (auth.type === 'apikey' && auth.in !== 'query' && auth.key) L.push(`      ${JSON.stringify(auth.key)}: ${tpl(auth.value)},`);
  const hasCT = enabledPairs(r.headers).some((h) => h.key.toLowerCase() === 'content-type');
  const b = r.body || {};
  let body = 'null';
  if (['json', 'xml', 'text'].includes(b.mode)) {
    body = tpl(b.raw);
    if (!hasCT) L.push(`      'Content-Type': ${JSON.stringify(b.mode === 'json' ? 'application/json' : b.mode === 'xml' ? 'application/xml' : 'text/plain')},`);
  } else if (b.mode === 'urlencoded') {
    body = '{ ' + enabledPairs(b.form).map((f) => `${JSON.stringify(f.key)}: ${tpl(f.value)}`).join(', ') + ' }';
  } else if (b.mode === 'formdata') {
    body = '{ ' + enabledPairs(b.form).map((f) => f.type === 'file' ? `${JSON.stringify(f.key)}: http.file(open(${JSON.stringify(f.fileName || 'file')}, 'b'), ${JSON.stringify(f.fileName || 'file')})` : `${JSON.stringify(f.key)}: ${tpl(f.value)}`).join(', ') + ' }';
  } else if (b.mode === 'graphql') {
    body = `JSON.stringify({ query: ${tpl(b.graphql?.query)}, variables: JSON.parse(${tpl(b.graphql?.variables || '{}')} || '{}') })`;
    if (!hasCT) L.push(`      'Content-Type': 'application/json',`);
  }
  L.push('    };');
  L.push(`    const res = http.request(${JSON.stringify(r.method)}, ${url}, ${body}, { headers, tags: { name: ${JSON.stringify(r.name)} }, timeout: '${Math.round((r.settings?.timeoutMs || 30000) / 1000)}s', redirects: ${r.settings?.followRedirects === false ? 0 : 10} });`);
  const checks = (r.assertions || []).filter((a) => a.enabled !== false).map(checkFn).filter(Boolean);
  if (checks.length) L.push(`    check(res, {\n${checks.map(([n, f]) => `      ${JSON.stringify(n)}: ${f},`).join('\n')}\n    });`);
  for (const x of r.extract || []) {
    if (x.enabled === false || !x.var) continue;
    if (x.from === 'json') L.push(`    try { const val = res.json(${JSON.stringify(String(x.path || '').replace(/^\$\.?/, '').replace(/\[(\d+)\]/g, '.$1').replace(/^\./, ''))}); if (val !== undefined) v[${JSON.stringify(x.var)}] = typeof val === 'object' ? JSON.stringify(val) : String(val); } catch (e) {}`);
    else if (x.from === 'header') L.push(`    if (res.headers[${JSON.stringify(canonHeader(x.path))}] !== undefined) v[${JSON.stringify(x.var)}] = res.headers[${JSON.stringify(canonHeader(x.path))}];`);
    else if (x.from === 'regex') L.push(`    { const m = new RegExp(${JSON.stringify(x.path || '')}).exec(String(res.body)); if (m) v[${JSON.stringify(x.var)}] = m[1] ?? m[0]; }`);
    else if (x.from === 'status') L.push(`    v[${JSON.stringify(x.var)}] = String(res.status);`);
  }
  L.push('  }');
  return L.join('\n');
}

export function toK6({ name = 'ApiStorm export', requests: allRequests = [], collection, environment, globals, config = {}, callbackBase = '' }) {
  const requests = allRequests.filter((r) => (r.protocol || 'http') === 'http');
  const vars = { ...varsToObject(globals), ...varsToObject(collection?.variables), ...varsToObject(environment?.variables) };
  const usesBasic = requests.some((r) => (r.auth?.type === 'inherit' ? collection?.auth?.type : r.auth?.type) === 'basic');
  const hasData = config.data?.rows?.length > 0;
  const think = Number(config.thinkTimeMs) || 0;
  const jitter = Number(config.thinkJitterMs) || 0;
  const opts = {
    scenarios: { main: scenario(config) },
    thresholds: thresholds(config),
    insecureSkipTLSVerify: !!config.insecure || requests.some((r) => r.settings?.insecure),
    noConnectionReuse: config.keepAlive === false,
  };
  return `// ${name}
// Generated by ApiStorm on ${new Date().toISOString()}
// Run with:  k6 run script.js
import http from 'k6/http';
import { check, sleep } from 'k6';
${usesBasic ? "import encoding from 'k6/encoding';\n" : ''}${hasData ? "import { SharedArray } from 'k6/data';\n" : ''}
export const options = ${JSON.stringify(opts, null, 2)};

// Variables (environment + collection + globals, resolved at export time)
const VARS = ${JSON.stringify(vars, null, 2)};
const CALLBACK_BASE = ${JSON.stringify(callbackBase)};
${hasData ? `\nconst DATA = new SharedArray('data', () => ${JSON.stringify(config.data.rows)});\n` : ''}
function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
const rint = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const rstr = (n, set) => Array.from({ length: n }, () => set[Math.floor(Math.random() * set.length)]).join('');
let REQUEST_ID = '';
function dyn(name, ...a) {
  switch (name) {
    case 'uuid': case 'guid': case 'randomUUID': return uuidv4();
    case 'requestId': return REQUEST_ID || (REQUEST_ID = uuidv4());
    case 'callbackUrl': return \`\${CALLBACK_BASE}/cb/\${encodeURIComponent(a[0] || 'default')}/\${dyn('requestId')}\`;
    case 'timestamp': return String(Math.floor(Date.now() / 1000));
    case 'timestampMs': return String(Date.now());
    case 'isoTimestamp': return new Date().toISOString();
    case 'date': return new Date().toISOString().slice(0, 10);
    case 'randomInt': return String(a.length >= 2 ? rint(Number(a[0]), Number(a[1])) : rint(0, 1000));
    case 'randomFloat': return (a.length >= 2 ? Number(a[0]) + Math.random() * (Number(a[1]) - Number(a[0])) : Math.random() * 1000).toFixed(Number(a[2] || 2));
    case 'randomString': return rstr(Number(a[0] || 12), 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789');
    case 'randomAlpha': return rstr(Number(a[0] || 8), 'abcdefghijklmnopqrstuvwxyz');
    case 'randomDigits': return rstr(Number(a[0] || 6), '0123456789');
    case 'randomHex': return rstr(Number(a[0] || 16), '0123456789abcdef');
    case 'randomBoolean': return String(Math.random() < 0.5);
    case 'randomEmail': return \`user.\${rstr(8, 'abcdefghijklmnopqrstuvwxyz0123456789')}@example.com\`;
    case 'randomItem': return a[Math.floor(Math.random() * a.length)] || '';
    case 'iteration': return String(__ITER);
    case 'vu': return String(__VU);
    default: return uuidv4();
  }
}

export default function () {
  const v = Object.assign({}, VARS${hasData ? `, DATA[${config.data.mode === 'random' ? 'Math.floor(Math.random() * DATA.length)' : '(__ITER + (__VU - 1) * 1000) % DATA.length'}]` : ''});
${requests.map((r, i) => `  REQUEST_ID = '';\n${requestBlock(r, i, collection)}`).join('\n')}
${think || jitter ? `  sleep((${think} + Math.random() * ${jitter}) / 1000);` : ''}
}
`;
}

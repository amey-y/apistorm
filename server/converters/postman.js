import crypto from 'node:crypto';
import { newRequest, normalizeRequest } from '../prepare.js';

/* ------------------------------------------------------------------ import */

function kvFromPostman(list) {
  return (Array.isArray(list) ? list : []).map((x) => ({ key: x.key ?? x.name ?? '', value: x.value ?? '', enabled: !x.disabled, ...(x.description ? { description: typeof x.description === 'string' ? x.description : x.description.content } : {}) }));
}

function authFromPostman(a) {
  if (!a) return null;
  const get = (arr, key) => {
    if (Array.isArray(arr)) return arr.find((x) => x.key === key)?.value;
    if (arr && typeof arr === 'object') return arr[key];
    return undefined;
  };
  switch (a.type) {
    case 'noauth': return { type: 'none' };
    case 'bearer': return { type: 'bearer', token: get(a.bearer, 'token') ?? '' };
    case 'basic': return { type: 'basic', username: get(a.basic, 'username') ?? '', password: get(a.basic, 'password') ?? '' };
    case 'apikey': return { type: 'apikey', key: get(a.apikey, 'key') ?? '', value: get(a.apikey, 'value') ?? '', in: get(a.apikey, 'in') === 'query' ? 'query' : 'header' };
    case 'oauth2': {
      const g = get(a.oauth2, 'grant_type') || 'client_credentials';
      return {
        type: 'oauth2', grantType: g === 'authorization_code_with_pkce' ? 'authorization_code' : g === 'password_credentials' ? 'password' : g,
        tokenUrl: get(a.oauth2, 'accessTokenUrl') ?? '', authUrl: get(a.oauth2, 'authUrl') ?? '', clientId: get(a.oauth2, 'clientId') ?? '', clientSecret: get(a.oauth2, 'clientSecret') ?? '',
        scope: get(a.oauth2, 'scope') ?? '', username: get(a.oauth2, 'username') ?? '', password: get(a.oauth2, 'password') ?? '',
        clientAuth: get(a.oauth2, 'client_authentication') === 'body' ? 'body' : 'basic', redirectUri: get(a.oauth2, 'redirect_uri') ?? '',
      };
    }
    case 'jwt': return { type: 'jwt', algorithm: get(a.jwt, 'algorithm') || 'HS256', secret: get(a.jwt, 'secret') ?? '', secretBase64: !!get(a.jwt, 'isSecretBase64Encoded'), privateKey: get(a.jwt, 'privateKey') ?? '', payload: typeof get(a.jwt, 'payload') === 'string' ? get(a.jwt, 'payload') : JSON.stringify(get(a.jwt, 'payload') || {}), header: typeof get(a.jwt, 'header') === 'string' ? get(a.jwt, 'header') : JSON.stringify(get(a.jwt, 'header') || {}), addTo: get(a.jwt, 'addTokenTo') === 'queryParam' ? 'query' : 'header', prefix: get(a.jwt, 'headerPrefix') ?? 'Bearer', queryParam: get(a.jwt, 'queryParamKey') || 'token' };
    case 'awsv4': return { type: 'awsv4', accessKey: get(a.awsv4, 'accessKey') ?? '', secretKey: get(a.awsv4, 'secretKey') ?? '', region: get(a.awsv4, 'region') ?? 'us-east-1', service: get(a.awsv4, 'service') ?? '', sessionToken: get(a.awsv4, 'sessionToken') ?? '' };
    default: return { type: 'none', unsupported: a.type };
  }
}

/** Best-effort translation of common Postman test snippets into assertions/extractions. */
function scriptsToRules(events = []) {
  const assertions = [], extract = [];
  const scripts = {};
  for (const ev of events || []) {
    const code = Array.isArray(ev.script?.exec) ? ev.script.exec.join('\n') : (ev.script?.exec || '');
    if (!code.trim()) continue;
    scripts[ev.listen] = code;
    if (ev.listen !== 'test') continue;
    for (const m of code.matchAll(/pm\.response\.to\.have\.status\(\s*(\d{3})\s*\)/g)) assertions.push({ type: 'status', op: 'eq', value: m[1], enabled: true });
    for (const m of code.matchAll(/pm\.response\.to\.be\.(ok|success)\b/g)) assertions.push({ type: 'status', op: 'eq', value: m[1] === 'ok' ? '200' : '2xx', enabled: true });
    for (const m of code.matchAll(/pm\.expect\(\s*pm\.response\.responseTime\s*\)\.to\.be\.below\(\s*(\d+)\s*\)/g)) assertions.push({ type: 'responseTime', op: 'lt', value: m[1], enabled: true });
    for (const m of code.matchAll(/pm\.response\.to\.have\.header\(\s*["']([^"']+)["']\s*\)/g)) assertions.push({ type: 'header', path: m[1], op: 'exists', enabled: true });
    for (const m of code.matchAll(/pm\.expect\(\s*pm\.response\.text\(\)\s*\)\.to\.include\(\s*["']([^"']*)["']\s*\)/g)) assertions.push({ type: 'bodyContains', value: m[1], enabled: true });
    const re = /pm\.(?:environment|collectionVariables|globals|variables)\.set\(\s*["']([^"']+)["']\s*,\s*(?:pm\.response\.json\(\)|JSON\.parse\(\s*responseBody\s*\)|jsonData|json|response|res|data|body|responseJson)((?:\.[A-Za-z_$][\w$]*|\[\d+\]|\[["'][^"']+["']\])*)\s*\)/g;
    for (const m of code.matchAll(re)) extract.push({ var: m[1], from: 'json', path: '$' + m[2], enabled: true });
    for (const m of code.matchAll(/pm\.(?:environment|collectionVariables|globals|variables)\.set\(\s*["']([^"']+)["']\s*,\s*pm\.response\.headers\.get\(\s*["']([^"']+)["']\s*\)\s*\)/g)) extract.push({ var: m[1], from: 'header', path: m[2], enabled: true });
  }
  return { assertions, extract, scripts };
}

function urlFromPostman(url) {
  if (!url) return { url: '', params: [] };
  if (typeof url === 'string') {
    const i = url.indexOf('?');
    if (i < 0) return { url, params: [] };
    return {
      url: url.slice(0, i),
      params: url.slice(i + 1).split('&').filter(Boolean).map((p) => { const e = p.indexOf('='); return { key: e < 0 ? p : p.slice(0, e), value: e < 0 ? '' : p.slice(e + 1), enabled: true }; }),
    };
  }
  let raw = url.raw;
  if (!raw) {
    const host = Array.isArray(url.host) ? url.host.join('.') : url.host || '';
    const path = Array.isArray(url.path) ? url.path.join('/') : url.path || '';
    raw = `${url.protocol ? url.protocol + '://' : ''}${host}${url.port ? ':' + url.port : ''}${path ? '/' + path : ''}`;
  }
  const base = raw.split('?')[0];
  let params = kvFromPostman(url.query);
  if (!url.query && raw.includes('?')) params = urlFromPostman(raw).params;
  // path variables (:id) -> {{id}} with their values as defaults in description
  let out = base;
  for (const v of url.variable || []) if (v.key) out = out.replace(new RegExp(`:${v.key}(?=/|$)`), v.value ? v.value : `{{${v.key}}}`);
  return { url: out, params };
}

function bodyFromPostman(b) {
  if (!b || !b.mode) return { mode: 'none', raw: '', form: [] };
  if (b.disabled) return { mode: 'none', raw: '', form: [] };
  if (b.mode === 'raw') {
    const lang = b.options?.raw?.language;
    let mode = lang === 'json' ? 'json' : lang === 'xml' ? 'xml' : 'text';
    if (!lang && /^\s*[[{]/.test(b.raw || '')) mode = 'json';
    return { mode, raw: b.raw || '', form: [] };
  }
  if (b.mode === 'urlencoded') return { mode: 'urlencoded', raw: '', form: kvFromPostman(b.urlencoded) };
  if (b.mode === 'formdata') {
    return {
      mode: 'formdata', raw: '',
      form: (b.formdata || []).map((f) => f.type === 'file'
        ? { key: f.key, type: 'file', fileName: Array.isArray(f.src) ? String(f.src[0] || '').split(/[\\/]/).pop() : String(f.src || '').split(/[\\/]/).pop(), data: '', enabled: !f.disabled }
        : { key: f.key, value: f.value ?? '', type: 'text', enabled: !f.disabled }),
    };
  }
  if (b.mode === 'graphql') return { mode: 'graphql', raw: '', form: [], graphql: { query: b.graphql?.query || '', variables: b.graphql?.variables || '' } };
  return { mode: 'text', raw: b.raw || '', form: [] };
}

function requestFromItem(item, folder) {
  const r = typeof item.request === 'string' ? { url: item.request, method: 'GET' } : item.request || {};
  const { url, params } = urlFromPostman(r.url);
  const rules = scriptsToRules(item.event);
  const auth = authFromPostman(r.auth);
  const req = newRequest({
    name: item.name || `${r.method || 'GET'} ${url}`,
    method: (r.method || 'GET').toUpperCase(),
    url, params,
    headers: kvFromPostman(r.header),
    body: { ...newRequest().body, ...bodyFromPostman(r.body) },
    auth: auth || { type: 'inherit' },
    assertions: [],
    extract: [],
    scripts: { pre: rules.scripts.prerequest || '', post: rules.scripts.test || '' },
    folder,
    description: typeof r.description === 'string' ? r.description : r.description?.content || '',
  });
  return req;
}

export function isPostmanCollection(o) {
  return !!(o && o.info && Array.isArray(o.item) && (o.info.schema || o.info._postman_id || o.info.name));
}
export function isPostmanEnvironment(o) {
  return !!(o && Array.isArray(o.values) && (o._postman_variable_scope || o.name));
}

export function fromPostman(pm) {
  const requests = [];
  const walk = (items, path) => {
    for (const it of items || []) {
      if (Array.isArray(it.item)) walk(it.item, [...path, it.name || 'Folder']);
      else requests.push(requestFromItem(it, path.join(' / ')));
    }
  };
  walk(pm.item, []);
  const rules = scriptsToRules(pm.event);
  return {
    id: crypto.randomUUID(),
    name: pm.info?.name || 'Imported collection',
    description: typeof pm.info?.description === 'string' ? pm.info.description : pm.info?.description?.content || '',
    variables: kvFromPostman(pm.variable),
    auth: authFromPostman(pm.auth) || { type: 'none' },
    requests,
    scripts: { pre: rules.scripts.prerequest || '', post: rules.scripts.test || '' },
  };
}

export function environmentFromPostman(env) {
  return {
    id: crypto.randomUUID(),
    name: env.name || 'Imported environment',
    variables: (env.values || []).map((v) => ({ key: v.key, value: v.value ?? '', enabled: v.enabled !== false, secret: v.type === 'secret' })),
  };
}

/* ------------------------------------------------------------------ export */

function authToPostman(a) {
  if (!a || a.type === 'inherit') return undefined;
  if (a.type === 'none') return { type: 'noauth' };
  if (a.type === 'bearer') return { type: 'bearer', bearer: [{ key: 'token', value: a.token || '', type: 'string' }] };
  if (a.type === 'basic') return { type: 'basic', basic: [{ key: 'username', value: a.username || '', type: 'string' }, { key: 'password', value: a.password || '', type: 'string' }] };
  if (a.type === 'apikey') return { type: 'apikey', apikey: [{ key: 'key', value: a.key || '', type: 'string' }, { key: 'value', value: a.value || '', type: 'string' }, { key: 'in', value: a.in || 'header', type: 'string' }] };
  const kv = (o) => Object.entries(o).map(([key, value]) => ({ key, value, type: typeof value === 'boolean' ? 'boolean' : 'string' }));
  if (a.type === 'oauth2') return { type: 'oauth2', oauth2: kv({ grant_type: a.grantType === 'password' ? 'password_credentials' : a.grantType || 'client_credentials', accessTokenUrl: a.tokenUrl || '', authUrl: a.authUrl || '', clientId: a.clientId || '', clientSecret: a.clientSecret || '', scope: a.scope || '', username: a.username || '', password: a.password || '', client_authentication: a.clientAuth === 'body' ? 'body' : 'header', addTokenTo: 'header' }) };
  if (a.type === 'jwt') return { type: 'jwt', jwt: kv({ algorithm: a.algorithm || 'HS256', secret: a.secret || '', isSecretBase64Encoded: !!a.secretBase64, privateKey: a.privateKey || '', payload: a.payload || '{}', header: a.header || '{}', addTokenTo: a.addTo === 'query' ? 'queryParam' : 'header', headerPrefix: a.prefix ?? 'Bearer', queryParamKey: a.queryParam || 'token' }) };
  if (a.type === 'awsv4') return { type: 'awsv4', awsv4: kv({ accessKey: a.accessKey || '', secretKey: a.secretKey || '', region: a.region || '', service: a.service || '', sessionToken: a.sessionToken || '' }) };
  return undefined;
}

function rulesToScript(r) {
  const lines = [];
  for (const a of r.assertions || []) {
    if (a.enabled === false) continue;
    if (a.type === 'status' && /^\d{3}$/.test(String(a.value))) lines.push(`pm.test("Status is ${a.value}", () => pm.response.to.have.status(${a.value}));`);
    else if (a.type === 'status') lines.push(`pm.test("Status ${a.value}", () => pm.expect(String(pm.response.code)).to.match(/^${String(a.value).split(',')[0].replace(/x/gi, '\\d')}$/));`);
    else if (a.type === 'responseTime') lines.push(`pm.test("Response time < ${a.value}ms", () => pm.expect(pm.response.responseTime).to.be.below(${Number(a.value) || 0}));`);
    else if (a.type === 'bodyContains') lines.push(`pm.test("Body contains", () => pm.expect(pm.response.text()).to.include(${JSON.stringify(String(a.value ?? ''))}));`);
    else if (a.type === 'header') lines.push(`pm.test("Header ${a.path}", () => pm.response.to.have.header(${JSON.stringify(a.path || '')}));`);
    else if (a.type === 'jsonPath' && (a.op === 'exists' || !a.op || a.op === 'eq')) {
      const p = String(a.path || '').replace(/^\$\.?/, '');
      const expr = 'pm.response.json()' + (p ? (p.startsWith('[') ? p : '.' + p) : '');
      lines.push(a.op === 'exists'
        ? `pm.test("${a.path} exists", () => pm.expect(${expr}).to.exist);`
        : `pm.test("${a.path} equals", () => pm.expect(String(${expr})).to.eql(${JSON.stringify(String(a.value ?? ''))}));`);
    }
  }
  for (const x of r.extract || []) {
    if (x.enabled === false || !x.var) continue;
    if (x.from === 'json') { const p = String(x.path || '').replace(/^\$\.?/, ''); lines.push(`pm.environment.set(${JSON.stringify(x.var)}, pm.response.json()${p ? (p.startsWith('[') ? p : '.' + p) : ''});`); }
    if (x.from === 'header') lines.push(`pm.environment.set(${JSON.stringify(x.var)}, pm.response.headers.get(${JSON.stringify(x.path || '')}));`);
  }
  return lines;
}

function bodyToPostman(b) {
  if (!b || b.mode === 'none') return undefined;
  if (['json', 'xml', 'text'].includes(b.mode)) return { mode: 'raw', raw: b.raw || '', options: { raw: { language: b.mode === 'text' ? 'text' : b.mode } } };
  if (b.mode === 'urlencoded') return { mode: 'urlencoded', urlencoded: (b.form || []).map((f) => ({ key: f.key, value: f.value ?? '', disabled: f.enabled === false })) };
  if (b.mode === 'formdata') return { mode: 'formdata', formdata: (b.form || []).map((f) => f.type === 'file' ? { key: f.key, type: 'file', src: f.fileName || '', disabled: f.enabled === false } : { key: f.key, value: f.value ?? '', type: 'text', disabled: f.enabled === false }) };
  if (b.mode === 'graphql') return { mode: 'graphql', graphql: { query: b.graphql?.query || '', variables: b.graphql?.variables || '' } };
  return undefined;
}

function itemFromRequest(r) {
  r = normalizeRequest(r);
  const query = (r.params || []).map((p) => ({ key: p.key, value: p.value ?? '', disabled: p.enabled === false }));
  const enabledQs = (r.params || []).filter((p) => p.enabled !== false && p.key).map((p) => `${p.key}=${p.value ?? ''}`).join('&');
  const tests = rulesToScript(r);
  const events = [];
  const pre = r.scripts?.pre || r.postmanScripts?.prerequest || '';
  if (pre.trim()) events.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: pre.split('\n') } });
  const post = r.scripts?.post || r.postmanScripts?.test || '';
  const testExec = [...(post.trim() ? post.split('\n') : []), ...tests];
  if (testExec.length) events.push({ listen: 'test', script: { type: 'text/javascript', exec: testExec } });
  const item = {
    name: r.name,
    request: {
      method: r.method,
      header: (r.headers || []).map((h) => ({ key: h.key, value: h.value ?? '', disabled: h.enabled === false, type: 'text' })),
      url: { raw: r.url + (enabledQs ? '?' + enabledQs : ''), ...(query.length ? { query } : {}) },
      ...(r.description ? { description: r.description } : {}),
    },
    response: [],
  };
  const body = bodyToPostman(r.body);
  if (body) item.request.body = body;
  const auth = authToPostman(r.auth);
  if (auth) item.request.auth = auth;
  if (events.length) item.event = events;
  // also keep a raw URL breakdown Postman understands
  const raw = r.url;
  const m = /^(?:(https?):\/\/)?([^/]+)(\/.*)?$/i.exec(raw);
  if (m) {
    if (m[1]) item.request.url.protocol = m[1];
    item.request.url.host = m[2].startsWith('{{') ? [m[2]] : m[2].split('.');
    if (m[3]) item.request.url.path = m[3].slice(1).split('/');
  }
  return item;
}

export function toPostman(col) {
  const root = { item: [] };
  const folders = new Map();
  const folderNode = (path) => {
    if (!path) return root;
    if (folders.has(path)) return folders.get(path);
    const parts = path.split(' / ');
    const parent = folderNode(parts.slice(0, -1).join(' / '));
    const node = { name: parts[parts.length - 1], item: [] };
    parent.item.push(node);
    folders.set(path, node);
    return node;
  };
  for (const r of col.requests || []) if ((r.protocol || 'http') === 'http') folderNode(r.folder || '').item.push(itemFromRequest(r));
  const out = {
    info: { _postman_id: col.id || crypto.randomUUID(), name: col.name, description: col.description || '', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: root.item,
    variable: (col.variables || []).map((v) => ({ key: v.key, value: v.value ?? '', type: 'string', disabled: v.enabled === false })),
  };
  const auth = authToPostman(col.auth);
  if (auth && auth.type !== 'noauth') out.auth = auth;
  const ev = [];
  if (col.scripts?.pre?.trim()) ev.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: col.scripts.pre.split('\n') } });
  if (col.scripts?.post?.trim()) ev.push({ listen: 'test', script: { type: 'text/javascript', exec: col.scripts.post.split('\n') } });
  if (ev.length) out.event = ev;
  return out;
}

export function environmentToPostman(env) {
  return {
    id: env.id, name: env.name, _postman_variable_scope: 'environment', _postman_exported_using: 'ApiStorm/1.0',
    values: (env.variables || []).map((v) => ({ key: v.key, value: v.value ?? '', type: v.secret ? 'secret' : 'default', enabled: v.enabled !== false })),
  };
}

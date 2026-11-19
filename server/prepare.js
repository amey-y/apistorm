import crypto from 'node:crypto';
import { interpolate, varsToObject } from './template.js';
import { enabledPairs } from './util.js';
import { jwtFromAuth, applyHmac, applySigV4 } from './auth.js';

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export function newRequest(over = {}) {
  return {
    id: crypto.randomUUID(),
    name: 'New request',
    method: 'GET',
    url: '',
    params: [],
    headers: [],
    body: { mode: 'none', raw: '', form: [], graphql: { query: '', variables: '' } },
    auth: { type: 'inherit' },
    assertions: [],
    extract: [],
    settings: { timeoutMs: 30000, followRedirects: true, insecure: false },
    scripts: { pre: '', post: '' },
    callback: { correlateBy: 'auto', from: 'json', path: '' },
    protocol: 'http',
    folder: '',
    description: '',
    ...over,
  };
}

/** Normalise a request from the UI/imports so the rest of the code can rely on its shape. */
export function normalizeRequest(r = {}) {
  const base = newRequest();
  const out = { ...base, ...r };
  out.method = String(out.method || 'GET').toUpperCase();
  out.params = Array.isArray(out.params) ? out.params : [];
  out.headers = Array.isArray(out.headers) ? out.headers : [];
  out.body = { ...base.body, ...(r.body || {}) };
  out.body.form = Array.isArray(out.body.form) ? out.body.form : [];
  out.body.graphql = { query: '', variables: '', ...(out.body.graphql || {}) };
  out.auth = { ...base.auth, ...(r.auth || {}) };
  out.assertions = Array.isArray(out.assertions) ? out.assertions : [];
  out.extract = Array.isArray(out.extract) ? out.extract : [];
  out.settings = { ...base.settings, ...(r.settings || {}) };
  out.scripts = { ...base.scripts, ...(r.scripts || {}) };
  out.callback = { ...base.callback, ...(r.callback || {}) };
  out.protocol = r.protocol || 'http';
  if (!out.id) out.id = crypto.randomUUID();
  return out;
}

/** Variable context for a request. Layers are in priority order (first wins). */
export function buildContext({ runtime, dataRow, environment, collection, globals, callbackBase, iteration, vu, requestId }) {
  return {
    layers: [runtime, dataRow, varsToObject(environment?.variables), varsToObject(collection?.variables), varsToObject(globals)],
    callbackBase, iteration, vu, requestId,
  };
}

function hasHeader(headers, name) {
  const n = name.toLowerCase();
  return headers.some(([k]) => k.toLowerCase() === n);
}

function buildMultipart(fields, ctx) {
  const boundary = '----ApiStormBoundary' + crypto.randomBytes(12).toString('hex');
  const parts = [];
  for (const f of fields) {
    const key = interpolate(f.key, ctx).replace(/"/g, '%22');
    if (f.type === 'file') {
      const fname = (f.fileName || 'file').replace(/"/g, '');
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"; filename="${fname}"\r\nContent-Type: ${f.contentType || 'application/octet-stream'}\r\n\r\n`));
      parts.push(Buffer.from(f.data || '', 'base64'));
      parts.push(Buffer.from('\r\n'));
    } else {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${interpolate(f.value ?? '', ctx)}\r\n`));
    }
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

const badRequest = (msg) => Object.assign(new Error(msg), { status: 400 });

/**
 * Resolve a stored request into something sendable.
 * Returns { method, url, headers: [[k,v]...], body: Buffer|null }
 */
export function prepareRequest(req, ctx, collection) {
  req = normalizeRequest(req);
  const method = interpolate(req.method, ctx).toUpperCase();
  let url = interpolate(req.url, ctx).trim();
  if (ctx.raw) {
    // keep {{variables}} visible (used for exports / code generation)
    const keep = (x) => encodeURIComponent(x).replace(/%7B%7B/gi, '{{').replace(/%7D%7D/gi, '}}');
    const qs = enabledPairs(req.params).map((p) => `${keep(p.key)}=${keep(p.value ?? '')}`);
    if (req.auth?.type === 'apikey' && req.auth.in === 'query' && req.auth.key) qs.push(`${keep(req.auth.key)}=${keep(req.auth.value ?? '')}`);
    if (qs.length) url += (url.includes('?') ? '&' : '?') + qs.join('&');
    return finishPrepare(req, ctx, collection, method, url, true);
  }
  const ws = req.protocol === 'ws';
  if (url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = (ws ? 'ws://' : 'http://') + url;
  let u;
  try { u = new URL(url); } catch { throw badRequest(`Invalid URL: "${url || '(empty)'}"`); }
  if (!/^https?:$/.test(u.protocol) && !(ws && /^wss?:$/.test(u.protocol))) throw badRequest(ws ? 'WebSocket URLs must start with ws:// or wss://' : `Unsupported protocol ${u.protocol}`);
  const unres = /\{\{[^$][^}]*\}\}/.exec(decodeURIComponent(u.host));
  if (unres) throw badRequest(`Unresolved variable in host: ${unres[0]} (select an environment that defines it)`);
  for (const p of enabledPairs(req.params)) u.searchParams.append(interpolate(p.key, ctx), interpolate(p.value ?? '', ctx));
  let auth0 = req.auth || { type: 'none' };
  if (auth0.type === 'inherit') auth0 = collection?.auth || { type: 'none' };
  if (auth0.type === 'apikey' && auth0.in === 'query' && auth0.key) u.searchParams.append(interpolate(auth0.key, ctx), interpolate(auth0.value ?? '', ctx));
  return finishPrepare(req, ctx, collection, method, u.toString(), false);
}

function finishPrepare(req, ctx, collection, method, url, raw) {
  const headers = [];
  let basicAuth = null;
  for (const h of enabledPairs(req.headers)) headers.push([interpolate(h.key, ctx), interpolate(h.value ?? '', ctx)]);

  // auth, with collection-level inheritance
  let auth = req.auth || { type: 'none' };
  if (auth.type === 'inherit') auth = collection?.auth || { type: 'none' };
  const A = (v) => interpolate(v ?? '', ctx);
  if (auth.type === 'bearer' && !hasHeader(headers, 'authorization')) headers.push(['Authorization', `${auth.prefix || 'Bearer'} ${A(auth.token)}`]);
  else if (auth.type === 'basic' && !hasHeader(headers, 'authorization')) {
    if (raw) basicAuth = { username: auth.username || '', password: auth.password || '' };
    else headers.push(['Authorization', 'Basic ' + Buffer.from(`${A(auth.username)}:${A(auth.password)}`).toString('base64')]);
  }
  else if (auth.type === 'apikey' && auth.key) {
    if (auth.in !== 'query') headers.push([A(auth.key), A(auth.value)]);
  }

  // body
  let body = null;
  let mpFields = null;
  const mode = req.body?.mode || 'none';
  const setCT = (ct) => { if (!hasHeader(headers, 'content-type')) headers.push(['Content-Type', ct]); };
  if (mode === 'json') { body = Buffer.from(interpolate(req.body.raw, ctx)); setCT('application/json'); }
  else if (mode === 'xml') { body = Buffer.from(interpolate(req.body.raw, ctx)); setCT('application/xml'); }
  else if (mode === 'text') { body = Buffer.from(interpolate(req.body.raw, ctx)); setCT('text/plain'); }
  else if (mode === 'urlencoded') {
    const keep = (x) => encodeURIComponent(x).replace(/%20/g, '+').replace(/%7B%7B/gi, '{{').replace(/%7D%7D/gi, '}}');
    const pairs = enabledPairs(req.body.form).map((f) => [interpolate(f.key, ctx), interpolate(f.value ?? '', ctx)]);
    body = Buffer.from(raw ? pairs.map(([k, v]) => `${keep(k)}=${keep(v)}`).join('&') : new URLSearchParams(pairs).toString());
    setCT('application/x-www-form-urlencoded');
  } else if (mode === 'formdata') {
    const mp = raw ? { body: Buffer.from(''), contentType: 'multipart/form-data', fields: enabledPairs(req.body.form) } : buildMultipart(enabledPairs(req.body.form), ctx);
    if (raw) body = null;
    if (!raw) body = mp.body;
    else mpFields = mp.fields;
    const idx = headers.findIndex(([k]) => k.toLowerCase() === 'content-type');
    if (idx >= 0) headers.splice(idx, 1);
    if (!raw) headers.push(['Content-Type', mp.contentType]);
  } else if (mode === 'graphql') {
    let variables = {};
    const vtxt = interpolate(req.body.graphql?.variables || '', ctx).trim();
    if (vtxt) { try { variables = JSON.parse(vtxt); } catch { if (!raw) throw badRequest('GraphQL variables are not valid JSON'); variables = vtxt; } }
    body = Buffer.from(JSON.stringify({ query: interpolate(req.body.graphql?.query || '', ctx), variables }));
    setCT('application/json');
  }
  const prep = { method, url, headers, body, ...(mpFields ? { formFields: mpFields } : {}), ...(basicAuth ? { basicAuth } : {}) };
  applyAdvancedAuth(prep, auth, A, raw, ctx);
  return prep;
}

/** OAuth 2.0 (token fetched beforehand into ctx.oauth), JWT, HMAC and AWS SigV4 need the final URL/body. */
function applyAdvancedAuth(prep, auth, A, raw, ctx) {
  const t = auth?.type;
  if (!['oauth2', 'jwt', 'hmac', 'awsv4'].includes(t)) return;
  if (raw) {
    // exports/code generation: show where the credential goes without computing it
    const label = { oauth2: '<OAuth 2.0 access token>', jwt: '<JWT generated per request>', hmac: '<HMAC signature>', awsv4: '<AWS SigV4 signature>' }[t];
    if (t === 'hmac') prep.headers.push([auth.headerName || 'X-Signature', label]);
    else if (t === 'jwt' && auth.addTo === 'query') prep.url += (prep.url.includes('?') ? '&' : '?') + `${auth.queryParam || 'token'}=${label}`;
    else prep.headers.push([t === 'jwt' ? auth.headerName || 'Authorization' : 'Authorization', `${t === 'awsv4' ? '' : (auth.prefix ?? 'Bearer') + ' '}${label}`.trim()]);
    return;
  }
  if (t === 'oauth2') {
    if (!ctx.oauth?.accessToken) throw badRequest('OAuth 2.0: no access token (click "Get new token" in the Auth tab)');
    if (auth.addTo === 'query') { const u = new URL(prep.url); u.searchParams.set(auth.queryParam || 'access_token', ctx.oauth.accessToken); prep.url = u.toString(); }
    else setHeaderPair(prep.headers, auth.headerName || 'Authorization', `${auth.prefix ?? (ctx.oauth.tokenType && /bearer/i.test(ctx.oauth.tokenType) ? 'Bearer' : ctx.oauth.tokenType || 'Bearer')} ${ctx.oauth.accessToken}`.trim());
  } else if (t === 'jwt') {
    const token = jwtFromAuth(auth, A);
    if (auth.addTo === 'query') { const u = new URL(prep.url); u.searchParams.set(auth.queryParam || 'token', token); prep.url = u.toString(); }
    else setHeaderPair(prep.headers, auth.headerName || 'Authorization', `${auth.prefix ?? 'Bearer'} ${token}`.trim());
  } else if (t === 'hmac') applyHmac(prep, auth, A);
  else if (t === 'awsv4') applySigV4(prep, auth, A);
}

function setHeaderPair(headers, k, v) {
  const i = headers.findIndex(([h]) => h.toLowerCase() === k.toLowerCase());
  if (i >= 0) headers[i] = [k, v]; else headers.push([k, v]);
}

/** The auth config that applies to a request (resolving "inherit"). */
export function effectiveAuth(req, collection) {
  const a = req.auth || { type: 'none' };
  return a.type === 'inherit' ? collection?.auth || { type: 'none' } : a;
}

/** Does any part of the prepared request contain this string (used to detect callback correlation ids)? */
export function preparedContains(prep, needle) {
  if (!needle) return false;
  if (prep.url.includes(needle)) return true;
  if (prep.headers.some(([k, v]) => v.includes(needle))) return true;
  return !!prep.body && prep.body.includes(needle);
}

/*
 * Advanced auth: OAuth 2.0 (token fetch + cache + refresh), JWT generation, HMAC request signing
 * and AWS Signature V4. JWT/HMAC/SigV4 are applied synchronously while a request is prepared;
 * OAuth 2.0 needs an async token fetch beforehand (see resolveOAuth2).
 */
import crypto from 'node:crypto';
import { sendHttp } from './http-client.js';

const httpError = (status, message) => Object.assign(new Error(message), { status });

/* ================================================================ OAuth 2 */

export class TokenStore {
  constructor(store) {
    this.store = store;
    this.inflight = new Map();
    this.tokens = new Map(Object.entries(store?.get('oauth-tokens', {}) || {}));
  }
  persist() { this.store?.set('oauth-tokens', Object.fromEntries(this.tokens)); }
  get(key) { return this.tokens.get(key) || null; }
  set(key, t) { this.tokens.set(key, t); this.persist(); }
  delete(key) { this.tokens.delete(key); this.persist(); }
  clear() { this.tokens.clear(); this.persist(); }
}

/** Cache key: the token is shared by every request using the same server, client and scope. */
export function oauthKey(c) {
  // credentials are part of the key (hashed): changing a wrong secret must not reuse an old token
  return crypto.createHash('sha256').update(JSON.stringify([c.tokenUrl, c.clientId, c.clientSecret || '', c.grantType, c.scope || '', c.audience || '', c.username || '', c.password || ''])).digest('hex').slice(0, 24);
}

function interpCfg(cfg, interp) {
  const out = {};
  for (const [k, v] of Object.entries(cfg || {})) out[k] = typeof v === 'string' ? interp(v) : Array.isArray(v) ? v.map((x) => (x && typeof x === 'object' ? { ...x, key: interp(x.key || ''), value: interp(x.value || '') } : x)) : v;
  return out;
}

async function tokenRequest(c, form, { insecure } = {}) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) if (v !== undefined && v !== null && v !== '') body.append(k, v);
  for (const p of c.extraParams || []) if (p.key && p.enabled !== false) body.append(p.key, p.value ?? '');
  const headers = [['Content-Type', 'application/x-www-form-urlencoded'], ['Accept', 'application/json']];
  if ((c.clientAuth || 'basic') === 'basic' && c.clientId) headers.push(['Authorization', 'Basic ' + Buffer.from(`${encodeURIComponent(c.clientId)}:${encodeURIComponent(c.clientSecret || '')}`).toString('base64')]);
  else { if (c.clientId) body.append('client_id', c.clientId); if (c.clientSecret) body.append('client_secret', c.clientSecret); }
  if (!c.tokenUrl) throw httpError(400, 'OAuth 2.0: the token URL is empty');
  const res = await sendHttp({ method: 'POST', url: c.tokenUrl, headers, body: Buffer.from(body.toString()) }, { timeoutMs: 30000, insecure });
  if (res.error) throw httpError(502, `OAuth 2.0 token request failed: ${res.error}`);
  const text = res.body ? res.body.toString('utf8') : '';
  let data;
  try { data = JSON.parse(text); } catch { data = Object.fromEntries(new URLSearchParams(text)); }
  if (res.status >= 400 || !data.access_token) {
    const why = data.error_description || data.error || text.slice(0, 200) || `HTTP ${res.status}`;
    throw httpError(502, `OAuth 2.0 token request failed (${res.status}): ${why}`);
  }
  const now = Date.now();
  return {
    accessToken: data.access_token,
    tokenType: data.token_type || 'Bearer',
    refreshToken: data.refresh_token || null,
    idToken: data.id_token || null,
    scope: data.scope || c.scope || '',
    expiresAt: data.expires_in ? now + Number(data.expires_in) * 1000 : null,
    obtainedAt: now,
    grantType: c.grantType,
    tokenUrl: c.tokenUrl,
  };
}

/**
 * Get a valid access token for an oauth2 auth config, fetching or refreshing it when needed.
 * Concurrent callers (e.g. a load test) share one in-flight token request.
 */
export async function getOAuth2Token(cfg, interp, tokens, { force = false, insecure = false } = {}) {
  const c = interpCfg(cfg, interp);
  c.grantType ||= 'client_credentials';
  const key = oauthKey(c);
  const cached = tokens.get(key);
  const fresh = (t) => t && (!t.expiresAt || t.expiresAt - Date.now() > 30000);
  if (!force && fresh(cached)) return { ...cached, key };
  if (tokens.inflight.has(key)) return tokens.inflight.get(key);
  const p = (async () => {
    let t;
    if (cached?.refreshToken && c.grantType !== 'client_credentials') {
      try { t = await tokenRequest(c, { grant_type: 'refresh_token', refresh_token: cached.refreshToken, scope: c.scope }, { insecure }); }
      catch { t = null; }
      if (t && !t.refreshToken) t.refreshToken = cached.refreshToken;
    }
    if (!t) {
      if (c.grantType === 'client_credentials') t = await tokenRequest(c, { grant_type: 'client_credentials', scope: c.scope, audience: c.audience, resource: c.resource }, { insecure });
      else if (c.grantType === 'password') t = await tokenRequest(c, { grant_type: 'password', username: c.username, password: c.password, scope: c.scope, audience: c.audience }, { insecure });
      else if (c.grantType === 'authorization_code') throw httpError(401, 'OAuth 2.0: no valid token yet. Open the Auth tab and click "Get new token" to sign in.');
      else throw httpError(400, `OAuth 2.0 grant type "${c.grantType}" is not supported`);
    }
    tokens.set(key, t);
    return { ...t, key };
  })().finally(() => tokens.inflight.delete(key));
  tokens.inflight.set(key, p);
  return p;
}

/* Authorization-code flow (with PKCE): the UI opens authorizeUrl in a popup, the provider
 * redirects to /oauth2/callback on this server, which exchanges the code for a token. */
const pendingAuth = new Map(); // state -> { cfg, verifier, redirectUri, at }

export function startAuthorization(cfg, interp, redirectUri) {
  const c = interpCfg(cfg, interp);
  if (!c.authUrl) throw httpError(400, 'OAuth 2.0: the authorization URL is empty');
  const state = crypto.randomBytes(16).toString('hex');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  for (const [k, v] of pendingAuth) if (Date.now() - v.at > 15 * 60e3) pendingAuth.delete(k);
  pendingAuth.set(state, { cfg: { ...c, grantType: 'authorization_code' }, verifier, redirectUri, at: Date.now() });
  const u = new URL(c.authUrl);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', c.clientId || '');
  u.searchParams.set('redirect_uri', redirectUri);
  if (c.scope) u.searchParams.set('scope', c.scope);
  if (c.audience) u.searchParams.set('audience', c.audience);
  u.searchParams.set('state', state);
  if (c.pkce !== false) { u.searchParams.set('code_challenge', challenge); u.searchParams.set('code_challenge_method', 'S256'); }
  return { url: u.toString(), state };
}

export async function finishAuthorization(state, code, tokens) {
  const p = pendingAuth.get(state);
  if (!p) throw httpError(400, 'Unknown or expired sign-in attempt. Start again from the Auth tab.');
  pendingAuth.delete(state);
  const t = await tokenRequest(p.cfg, { grant_type: 'authorization_code', code, redirect_uri: p.redirectUri, code_verifier: p.cfg.pkce !== false ? p.verifier : undefined });
  const key = oauthKey(p.cfg);
  tokens.set(key, t);
  return { ...t, key };
}

export function tokenInfo(t) {
  if (!t) return null;
  return { key: t.key, tokenType: t.tokenType, accessToken: t.accessToken, expiresAt: t.expiresAt, obtainedAt: t.obtainedAt, hasRefreshToken: !!t.refreshToken, scope: t.scope, grantType: t.grantType };
}

/* ==================================================================== JWT */

const JWT_ALGS = {
  HS256: ['hmac', 'sha256'], HS384: ['hmac', 'sha384'], HS512: ['hmac', 'sha512'],
  RS256: ['rsa', 'sha256'], RS384: ['rsa', 'sha384'], RS512: ['rsa', 'sha512'],
  PS256: ['pss', 'sha256'], PS384: ['pss', 'sha384'], PS512: ['pss', 'sha512'],
  ES256: ['ec', 'sha256'], ES384: ['ec', 'sha384'], ES512: ['ec', 'sha512'],
  EdDSA: ['ed', null],
};
export const JWT_ALGORITHMS = Object.keys(JWT_ALGS);

export function signJwt({ algorithm = 'HS256', secret = '', secretBase64 = false, privateKey = '', header = {}, payload = {} }) {
  const alg = JWT_ALGS[algorithm];
  if (!alg) throw httpError(400, `JWT: unsupported algorithm ${algorithm}`);
  const h = { alg: algorithm, typ: 'JWT', ...header };
  const input = `${Buffer.from(JSON.stringify(h)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  let sig;
  try {
    if (alg[0] === 'hmac') sig = crypto.createHmac(alg[1], secretBase64 ? Buffer.from(secret, 'base64') : Buffer.from(secret, 'utf8')).update(input).digest();
    else {
      if (!privateKey.trim()) throw new Error('a PEM private key is required for this algorithm');
      const key = crypto.createPrivateKey(privateKey);
      if (alg[0] === 'rsa') sig = crypto.sign(alg[1], Buffer.from(input), key);
      else if (alg[0] === 'pss') sig = crypto.sign(alg[1], Buffer.from(input), { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST });
      else if (alg[0] === 'ec') sig = crypto.sign(alg[1], Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
      else sig = crypto.sign(null, Buffer.from(input), key);
    }
  } catch (e) { throw httpError(400, `JWT signing failed: ${e.message}`); }
  return `${input}.${sig.toString('base64url')}`;
}

const jwtCache = new Map();

/** Build the JWT for a jwt auth config (interpolated). Returns the token string. */
export function jwtFromAuth(a, interp) {
  let payload = {};
  let header = {};
  try { payload = JSON.parse(interp(a.payload || '{}') || '{}'); } catch (e) { throw httpError(400, `JWT payload is not valid JSON: ${e.message}`); }
  try { header = JSON.parse(interp(a.header || '{}') || '{}'); } catch (e) { throw httpError(400, `JWT header is not valid JSON: ${e.message}`); }
  const reuse = Number(a.reuseSeconds) || 0;
  const cacheKey = reuse ? JSON.stringify([a.algorithm, interp(a.secret || ''), payload, header]) : null;
  if (cacheKey) { const c = jwtCache.get(cacheKey); if (c && c.until > Date.now()) return c.token; }
  const now = Math.floor(Date.now() / 1000);
  if (a.addIat !== false && payload.iat === undefined) payload.iat = now;
  if (Number(a.expiresIn) > 0 && payload.exp === undefined) payload.exp = now + Number(a.expiresIn);
  if (a.addJti && payload.jti === undefined) payload.jti = crypto.randomUUID();
  const token = signJwt({ algorithm: a.algorithm || 'HS256', secret: interp(a.secret || ''), secretBase64: !!a.secretBase64, privateKey: interp(a.privateKey || ''), header, payload });
  if (cacheKey) {
    jwtCache.set(cacheKey, { token, until: Date.now() + reuse * 1000 });
    if (jwtCache.size > 1000) jwtCache.delete(jwtCache.keys().next().value);
  }
  return token;
}

/* =================================================================== HMAC */

export const HMAC_DEFAULTS = {
  algorithm: 'sha256',
  secret: '',
  secretEncoding: 'utf8',
  stringToSign: '{method}\n{pathAndQuery}\n{timestamp}\n{bodySha256}',
  outputEncoding: 'hex',
  headerName: 'X-Signature',
  headerValue: '{signature}',
  extraHeaders: [{ key: 'X-Timestamp', value: '{timestamp}', enabled: true }],
};

const fillSig = (tpl, vals) => String(tpl ?? '').replace(/\{(\w+)\}/g, (m, k) => (k in vals ? vals[k] : m));

/** Sign a prepared request in place (headers/url). */
export function applyHmac(prep, a, interp) {
  const c = { ...HMAC_DEFAULTS, ...a };
  const u = new URL(prep.url);
  const body = prep.body || Buffer.alloc(0);
  const now = new Date();
  const vals = {
    method: prep.method, url: prep.url, host: u.host, path: u.pathname, query: u.search.slice(1), pathAndQuery: u.pathname + u.search,
    body: body.toString('utf8'),
    bodySha256: crypto.createHash('sha256').update(body).digest('hex'),
    bodySha256Base64: crypto.createHash('sha256').update(body).digest('base64'),
    bodyMd5Base64: crypto.createHash('md5').update(body).digest('base64'),
    bodyMd5: crypto.createHash('md5').update(body).digest('hex'),
    timestamp: String(Math.floor(now.getTime() / 1000)), timestampMs: String(now.getTime()), isoTimestamp: now.toISOString(), httpDate: now.toUTCString(),
    nonce: crypto.randomBytes(16).toString('hex'),
    contentType: (prep.headers.find(([k]) => k.toLowerCase() === 'content-type') || [])[1] || '',
  };
  const extra = (c.extraHeaders || []).filter((h) => h.enabled !== false && h.key).map((h) => [interp(h.key), fillSig(interp(h.value), vals)]);
  for (const [k, v] of extra) vals[`header:${k.toLowerCase()}`] = v;
  const toSign = fillSig(interp(c.stringToSign).replace(/\\n/g, '\n'), vals);
  const secret = interp(c.secret || '');
  const key = c.secretEncoding === 'base64' ? Buffer.from(secret, 'base64') : c.secretEncoding === 'hex' ? Buffer.from(secret, 'hex') : Buffer.from(secret, 'utf8');
  let signature;
  try { signature = crypto.createHmac(c.algorithm || 'sha256', key).update(toSign).digest(c.outputEncoding === 'base64url' ? 'base64url' : c.outputEncoding === 'base64' ? 'base64' : 'hex'); }
  catch (e) { throw httpError(400, `HMAC signing failed: ${e.message}`); }
  if (c.uppercase) signature = signature.toUpperCase();
  for (const [k, v] of extra) setHeader(prep.headers, k, v);
  if (c.headerName) setHeader(prep.headers, interp(c.headerName), fillSig(interp(c.headerValue || '{signature}'), { ...vals, signature }));
  if (c.queryParam) {
    u.searchParams.set(interp(c.queryParam), signature);
    prep.url = u.toString();
  }
  prep.signing = { stringToSign: toSign, signature };
  return prep;
}

function setHeader(headers, k, v) {
  const i = headers.findIndex(([h]) => h.toLowerCase() === k.toLowerCase());
  if (i >= 0) headers[i] = [k, v]; else headers.push([k, v]);
}

/* ================================================================ AWS SigV4 */

const rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const sha256hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hmacRaw = (k, s) => crypto.createHmac('sha256', k).update(s).digest();

export function applySigV4(prep, a, interp, now = new Date()) {
  const accessKey = interp(a.accessKey || ''), secretKey = interp(a.secretKey || '');
  const region = interp(a.region || 'us-east-1'), service = interp(a.service || 'execute-api');
  const token = interp(a.sessionToken || '');
  if (!accessKey || !secretKey) throw httpError(400, 'AWS Signature: access key and secret key are required');
  const u = new URL(prep.url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const body = prep.body || Buffer.alloc(0);
  const payloadHash = a.unsignedPayload ? 'UNSIGNED-PAYLOAD' : sha256hex(body);
  setHeader(prep.headers, 'X-Amz-Date', amzDate);
  if (service === 's3') setHeader(prep.headers, 'X-Amz-Content-Sha256', payloadHash);
  if (token) setHeader(prep.headers, 'X-Amz-Security-Token', token);
  const signHeaders = new Map([['host', u.host]]);
  for (const [k, v] of prep.headers) {
    const lk = k.toLowerCase();
    if (lk === 'host' || lk === 'content-type' || lk.startsWith('x-amz-')) signHeaders.set(lk, String(v).trim().replace(/\s+/g, ' '));
  }
  const names = [...signHeaders.keys()].sort();
  const canonHeaders = names.map((n) => `${n}:${signHeaders.get(n)}\n`).join('');
  const signedHeaders = names.join(';');
  const segs = u.pathname.split('/').map((s) => { let d; try { d = decodeURIComponent(s); } catch { d = s; } return service === 's3' ? rfc3986(d).replace(/%2F/g, '/') : rfc3986(rfc3986(d)); });
  const canonUri = segs.join('/') || '/';
  const q = [...u.searchParams].map(([k, v]) => [rfc3986(k), rfc3986(v)]).sort((x, y) => (x[0] === y[0] ? (x[1] < y[1] ? -1 : 1) : x[0] < y[0] ? -1 : 1));
  const canonQuery = q.map(([k, v]) => `${k}=${v}`).join('&');
  const canonReq = [prep.method, canonUri, canonQuery, canonHeaders, signedHeaders, payloadHash].join('\n');
  const scopeStr = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scopeStr, sha256hex(canonReq)].join('\n');
  const kSigning = hmacRaw(hmacRaw(hmacRaw(hmacRaw(`AWS4${secretKey}`, day), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
  setHeader(prep.headers, 'Authorization', `AWS4-HMAC-SHA256 Credential=${accessKey}/${scopeStr}, SignedHeaders=${signedHeaders}, Signature=${signature}`);
  prep.signing = { canonicalRequest: canonReq, stringToSign: toSign, signature };
  return prep;
}

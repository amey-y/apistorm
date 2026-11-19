/*
 * One request, end to end:
 *   collection pre-script -> request pre-script -> OAuth 2.0 token -> prepare -> send
 *   -> checks + extraction -> collection post-script -> request post-script
 * Used by single sends, load tests, bulk sends and schedules so they all behave the same.
 */
import { prepareRequest, normalizeRequest, effectiveAuth, newRequest } from './prepare.js';
import { interpolate } from './template.js';
import { sendHttp } from './http-client.js';
import { runAssertions, runExtract, needsBody } from './assertions.js';
import { runScript } from './scripting.js';
import { getOAuth2Token } from './auth.js';
import { getPath } from './util.js';

export const hasScripts = (req, collection) => !!(req.scripts?.pre?.trim() || req.scripts?.post?.trim() || collection?.scripts?.pre?.trim() || collection?.scripts?.post?.trim());

export function needsBodyFor(req, collection) {
  return needsBody(req.assertions, req.extract) || !!(req.scripts?.post?.trim() || collection?.scripts?.post?.trim()) || req.callback?.correlateBy === 'response';
}

/** Turn what scripts pass to pm.sendRequest (URL string or Postman-style object) into a request. */
function requestFromScript(x) {
  if (typeof x === 'string') return newRequest({ url: x, auth: { type: 'none' } });
  const url = typeof x.url === 'string' ? x.url : x.url?.raw || x.url?.toString?.() || '';
  let headers = [];
  if (Array.isArray(x.header)) headers = x.header.map((h) => ({ key: h.key, value: String(h.value ?? ''), enabled: !h.disabled }));
  else if (x.header && typeof x.header === 'object') headers = Object.entries(x.header).map(([key, value]) => ({ key, value: String(value), enabled: true }));
  else if (x.headers && typeof x.headers === 'object') headers = Object.entries(x.headers).map(([key, value]) => ({ key, value: String(value), enabled: true }));
  const r = newRequest({ url, method: (x.method || 'GET').toUpperCase(), headers, auth: { type: 'none' } });
  const b = x.body;
  if (b?.mode === 'raw' || typeof b === 'string') { r.body.mode = /^\s*[[{]/.test(b.raw ?? b) ? 'json' : 'text'; r.body.raw = b.raw ?? b; }
  else if (b?.mode === 'urlencoded') { r.body.mode = 'urlencoded'; r.body.form = (b.urlencoded || []).map((p) => ({ key: p.key, value: String(p.value ?? ''), enabled: !p.disabled })); }
  else if (b?.mode === 'formdata') { r.body.mode = 'formdata'; r.body.form = (b.formdata || []).map((p) => ({ key: p.key, value: String(p.value ?? ''), type: 'text', enabled: !p.disabled })); }
  if (r.body.mode === 'json' && headers.some((h) => /content-type/i.test(h.key))) r.body.mode = 'text';
  return r;
}

/** Value used to correlate a delivery report / callback, taken from the response (e.g. a message id). */
export function correlationValue(req, res, bodyText) {
  const c = req.callback;
  if (c?.correlateBy !== 'response' || !c.path || res.error) return null;
  let v;
  if (c.from === 'header') v = res.headers?.[String(c.path).toLowerCase()];
  else if (c.from === 'regex') { try { const m = new RegExp(c.path).exec(bodyText || ''); v = m ? m[1] ?? m[0] : undefined; } catch { v = undefined; } }
  else { try { v = getPath(JSON.parse(bodyText || 'null'), c.path); } catch { v = undefined; } }
  if (Array.isArray(v)) v = v[0];
  return v === undefined || v === null || typeof v === 'object' ? null : String(v);
}

/** Run pre-request scripts, fetch an OAuth 2.0 token and build the request, without sending it. */
export async function prepareOnly(request, opts) {
  const req = normalizeRequest(structuredClone(request));
  const { collection, scopes } = opts;
  const ctx = { layers: [scopes.local, scopes.data, scopes.env, scopes.collection, scopes.globals], callbackBase: opts.callbackBase };
  const interp = (s) => interpolate(s, ctx);
  const logs = [];
  for (const [label, code] of [['collection', collection?.scripts?.pre], ['request', req.scripts?.pre]]) {
    if (!code?.trim()) continue;
    const r = await runScript(code, { scopes, changes: opts.changes, info: { requestName: req.name, requestId: req.id }, interpolate: interp, sendRequest: async () => { throw new Error('pm.sendRequest is not available here'); }, timeoutMs: opts.scriptTimeoutMs, phase: 'pre', request: req });
    logs.push({ source: label, ...r });
    if (r.error) throw Object.assign(new Error(`Pre-request script (${label}): ${r.error}`), { status: 400 });
  }
  const auth = effectiveAuth(req, collection);
  if (auth.type === 'oauth2') ctx.oauth = await getOAuth2Token(auth, interp, opts.tokens, { insecure: req.settings.insecure });
  const prep = prepareRequest(req, ctx, collection);
  return { req, ctx, prep, interp, scripts: logs };
}

/**
 * opts = {
 *   collection, scopes: { local, data, env, collection, globals }, changes,
 *   callbackBase, iteration, vu, tokens (TokenStore), scriptContext, scriptTimeoutMs,
 *   send: { timeoutMs, followRedirects, insecure, agents, origin, signal, maxBodyBytes, captureBody },
 *   onPrepared(prep, ctx) (sync, before sending: e.g. register callback correlation)
 * }
 * returns { skipped, prep, res, bodyText, checks, extracted, scripts: { pre: [], post: [] }, nextRequest, error, ctx }
 */
export async function executeRequest(request, opts) {
  const req = normalizeRequest(structuredClone(request));
  const { collection, scopes } = opts;
  const ctx = {
    layers: [scopes.local, scopes.data, scopes.env, scopes.collection, scopes.globals],
    callbackBase: opts.callbackBase, iteration: opts.iteration, vu: opts.vu,
  };
  const interp = (s) => interpolate(s, ctx);
  const out = { skipped: false, prep: null, res: null, bodyText: '', checks: [], extracted: {}, scripts: { pre: [], post: [] }, nextRequest: undefined, error: null, ctx, request: req };
  const info = { requestName: req.name, requestId: req.id, iteration: opts.iteration, vu: opts.vu };
  const scriptSend = async (x) => {
    const r2 = requestFromScript(x);
    const p2 = prepareRequest(r2, ctx, null);
    return sendHttp(p2, { timeoutMs: 30000, insecure: opts.send?.insecure, agents: opts.send?.agents, origin: opts.send?.origin });
  };
  const common = { scopes, changes: opts.changes, info, interpolate: interp, sendRequest: scriptSend, timeoutMs: opts.scriptTimeoutMs, context: opts.scriptContext };

  // pre-request scripts (collection first, then request)
  for (const [label, code] of [['collection', collection?.scripts?.pre], ['request', req.scripts?.pre]]) {
    if (!code?.trim()) continue;
    const r = await runScript(code, { ...common, phase: 'pre', request: req });
    out.scripts.pre.push({ source: label, ...r });
    out.checks.push(...r.tests);
    if (r.nextRequest !== undefined) out.nextRequest = r.nextRequest;
    if (r.error) { out.error = `Pre-request script (${label}): ${r.error}`; return out; }
    if (r.skipRequest) { out.skipped = true; return out; }
  }

  // OAuth 2.0 token (cached and shared, refreshed when it expires)
  const auth = effectiveAuth(req, collection);
  if (auth.type === 'oauth2') {
    if (!opts.tokens) throw new Error('OAuth 2.0 is not available here');
    try { ctx.oauth = await getOAuth2Token(auth, interp, opts.tokens, { insecure: req.settings.insecure }); }
    catch (e) { out.error = e.message; return out; }
  }

  out.prep = prepareRequest(req, ctx, collection);
  opts.onPrepared?.(out.prep, ctx, req);
  const send = opts.send || {};
  out.res = await sendHttp(out.prep, {
    timeoutMs: Number(send.timeoutMs) || Number(req.settings.timeoutMs) || 30000,
    followRedirects: send.followRedirects !== false && req.settings.followRedirects !== false,
    insecure: !!(send.insecure || req.settings.insecure),
    agents: send.agents, origin: send.origin, signal: send.signal,
    captureBody: send.captureBody !== false || needsBodyFor(req, collection),
    maxBodyBytes: send.maxBodyBytes,
  });
  const res = out.res;
  out.bodyText = res.body && send.textual !== false ? res.body.toString('utf8') : '';
  if (!res.error) {
    out.checks.unshift(...runAssertions(req.assertions, res, out.bodyText));
    out.extracted = runExtract(req.extract, res, out.bodyText);
    Object.assign(scopes.local, out.extracted);
    for (const [label, code] of [['collection', collection?.scripts?.post], ['request', req.scripts?.post]]) {
      if (!code?.trim()) continue;
      const r = await runScript(code, { ...common, phase: 'post', request: req, response: res, bodyText: out.bodyText });
      out.scripts.post.push({ source: label, ...r });
      out.checks.push(...r.tests);
      if (r.nextRequest !== undefined) out.nextRequest = r.nextRequest;
      if (r.error) out.checks.push({ name: `Post-response script (${label}) failed`, pass: false, error: r.error, source: 'script' });
    }
  }
  return out;
}

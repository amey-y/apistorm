import crypto from 'node:crypto';
import { parseCurl, splitCurls } from './curl.js';
import { fromPostman, isPostmanCollection, isPostmanEnvironment, environmentFromPostman } from './postman.js';
import { fromOpenApi, isOpenApi } from './openapi.js';
import { fromHar, isHar } from './har.js';
import { normalizeRequest } from '../prepare.js';
import { parseYaml, looksLikeYaml } from '../yaml.js';

const httpError = (status, message) => Object.assign(new Error(message), { status });

export const SUPPORTED = 'cURL command(s), Postman collection/environment v2.x, OpenAPI 3.x / Swagger 2.0 (JSON or YAML), HAR, ApiStorm export (JSON or YAML)';

/** Parse JSON, falling back to YAML. Returns { value, format } or throws. */
export function parseStructured(text) {
  const t = String(text).replace(/^﻿/, '').trim();
  try { return { value: JSON.parse(t), format: 'json' }; } catch (jsonErr) {
    if (!looksLikeYaml(t)) throw httpError(400, `Unrecognised format. Supported: ${SUPPORTED}.`);
    try { return { value: parseYaml(t), format: 'yaml' }; } catch (e) { throw httpError(400, e.message); }
  }
}

/**
 * Detect what a piece of text is and convert it.
 * Returns one of:
 *   { kind: 'request', request, errors }
 *   { kind: 'collection', collection, errors, source }
 *   { kind: 'environment', environment }
 *   { kind: 'workspace', data }
 */
export function detectImport(text, filename = '') {
  const t = String(text || '').replace(/^﻿/, '').trim();
  if (!t) throw httpError(400, 'Nothing to import');
  if (/^curl(\.exe)?\s/i.test(t) || /\ncurl(\.exe)?\s/i.test(t)) {
    const cmds = splitCurls(t);
    const reqs = [];
    const errors = [];
    for (const c of cmds) { try { reqs.push(parseCurl(c)); } catch (e) { errors.push(e.message); } }
    if (!reqs.length) throw httpError(400, errors[0] || 'Could not parse cURL');
    if (reqs.length === 1) return { kind: 'request', request: reqs[0], errors, source: 'curl' };
    return { kind: 'collection', collection: { id: crypto.randomUUID(), name: `Imported cURLs ${new Date().toLocaleString()}`, description: '', variables: [], auth: { type: 'none' }, requests: reqs }, errors, source: 'curl' };
  }
  const { value: o, format } = parseStructured(t);
  if (!o || typeof o !== 'object') throw httpError(400, `Unrecognised content${filename ? ` in ${filename}` : ''}. Supported: ${SUPPORTED}.`);
  if (o.format === 'apistorm-workspace') return { kind: 'workspace', data: o, source: 'apistorm' };
  if (o.format === 'apistorm-collection') return { kind: 'collection', collection: o.collection, source: 'apistorm' };
  if (o.format === 'apistorm-environment') return { kind: 'environment', environment: o.environment, source: 'apistorm' };
  if (isPostmanCollection(o)) return { kind: 'collection', collection: fromPostman(o), source: 'postman' };
  if (isOpenApi(o)) {
    const col = fromOpenApi(o);
    return { kind: 'collection', collection: col, source: `${o.openapi ? `OpenAPI ${o.openapi}` : `Swagger ${o.swagger}`} (${format.toUpperCase()})` };
  }
  if (isHar(o)) return { kind: 'collection', collection: fromHar(o), source: 'har' };
  if (isPostmanEnvironment(o)) return { kind: 'environment', environment: environmentFromPostman(o), source: 'postman' };
  if (o.method && o.url) return { kind: 'request', request: normalizeRequest({ ...o, id: crypto.randomUUID() }), source: 'apistorm' };
  throw httpError(400, `Unrecognised ${format.toUpperCase()}${filename ? ` in ${filename}` : ''}. Supported: ${SUPPORTED}.`);
}

/** Give a collection and its requests fresh ids (so imports never collide). */
export function freshIds(col) {
  return {
    ...col,
    id: crypto.randomUUID(),
    requests: (col.requests || []).map((r) => normalizeRequest({ ...r, id: crypto.randomUUID() })),
    variables: col.variables || [],
    auth: col.auth || { type: 'none' },
  };
}

/** Download a spec / collection from a URL (http/https, max 50 MB). */
export async function fetchImportText(url) {
  let u;
  try { u = new URL(url); } catch { throw httpError(400, 'Invalid URL'); }
  if (!/^https?:$/.test(u.protocol)) throw httpError(400, 'Only http(s) URLs can be imported');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30000);
  try {
    const res = await fetch(u, { signal: ac.signal, headers: { accept: 'application/json, application/yaml, text/yaml, */*' } });
    if (!res.ok) throw httpError(400, `Download failed: HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > 50 * 1024 * 1024) throw httpError(413, 'File is larger than 50 MB');
    const text = await res.text();
    return { text, filename: u.pathname.split('/').pop() || u.host };
  } catch (e) {
    if (e.status) throw e;
    throw httpError(400, `Download failed: ${e.name === 'AbortError' ? 'timed out' : e.message}`);
  } finally { clearTimeout(timer); }
}

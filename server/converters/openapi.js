import crypto from 'node:crypto';
import { newRequest } from '../prepare.js';

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

export function isOpenApi(o) {
  return !!(o && (o.openapi || o.swagger) && o.paths);
}

export function resolver(spec) {
  const cache = new Map();
  const resolve = (obj, seen = new Set()) => {
    if (!obj || typeof obj !== 'object' || !obj.$ref) return obj;
    const ref = obj.$ref;
    if (seen.has(ref)) return {};
    if (cache.has(ref)) return cache.get(ref);
    if (!ref.startsWith('#/')) return {};
    let cur = spec;
    for (const part of ref.slice(2).split('/')) cur = cur?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    seen.add(ref);
    const out = resolve(cur || {}, seen);
    cache.set(ref, out);
    return out;
  };
  return resolve;
}

export function sample(schema, resolve, depth = 0, seen = new Set()) {
  if (!schema) return null;
  if (schema.$ref) {
    if (seen.has(schema.$ref) || depth > 6) return {};
    const next = new Set(seen); next.add(schema.$ref);
    return sample(resolve(schema), resolve, depth + 1, next);
  }
  if (schema.example !== undefined) return schema.example;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (schema.allOf) return Object.assign({}, ...schema.allOf.map((s) => sample(s, resolve, depth + 1, seen)).filter((x) => x && typeof x === 'object'));
  if (schema.oneOf || schema.anyOf) return sample((schema.oneOf || schema.anyOf)[0], resolve, depth + 1, seen);
  let type = schema.type;
  if (Array.isArray(type)) type = type.find((t) => t !== 'null') || type[0];
  if (!type) type = schema.properties ? 'object' : schema.items ? 'array' : 'string';
  switch (type) {
    case 'object': {
      const o = {};
      if (depth > 6) return o;
      for (const [k, v] of Object.entries(schema.properties || {})) o[k] = sample(v, resolve, depth + 1, seen);
      return o;
    }
    case 'array': return depth > 6 ? [] : [sample(schema.items || {}, resolve, depth + 1, seen)];
    case 'integer': return schema.minimum ?? 0;
    case 'number': return schema.minimum ?? 0;
    case 'boolean': return true;
    default: {
      const f = schema.format;
      if (f === 'date-time') return '2026-01-01T00:00:00Z';
      if (f === 'date') return '2026-01-01';
      if (f === 'email') return 'user@example.com';
      if (f === 'uuid') return '{{$uuid}}';
      if (f === 'uri' || f === 'url') return 'https://example.com';
      return 'string';
    }
  }
}

const paramValue = (p, resolve) => {
  const v = p.example ?? (p.examples ? Object.values(p.examples)[0]?.value : undefined) ?? p.schema?.example ?? p.schema?.default ?? (p.schema?.enum ? p.schema.enum[0] : undefined) ?? p.default;
  if (v !== undefined) return typeof v === 'object' ? JSON.stringify(v) : String(v);
  return '';
};

export function fromOpenApi(spec) {
  const resolve = resolver(spec);
  const v2 = !!spec.swagger;
  let base = '';
  if (v2) base = `${(spec.schemes || ['https'])[0]}://${spec.host || 'localhost'}${spec.basePath || ''}`;
  else {
    const s = (spec.servers || [])[0];
    base = s?.url || '/';
    for (const [k, v] of Object.entries(s?.variables || {})) base = base.replace(`{${k}}`, v.default ?? '');
  }
  base = base.replace(/\/$/, '');
  const variables = [{ key: 'baseUrl', value: base, enabled: true }];
  const seenVars = new Set(['baseUrl']);

  // auth
  let auth = { type: 'none' };
  const schemes = v2 ? spec.securityDefinitions || {} : spec.components?.securitySchemes || {};
  for (const sch0 of Object.values(schemes)) {
    const sch = resolve(sch0);
    if ((sch.type === 'http' && sch.scheme === 'bearer') || sch.type === 'oauth2' || sch.type === 'openIdConnect') { auth = { type: 'bearer', token: '{{token}}' }; break; }
    if ((sch.type === 'http' && sch.scheme === 'basic') || sch.type === 'basic') { auth = { type: 'basic', username: '{{username}}', password: '{{password}}' }; break; }
    if (sch.type === 'apiKey') { auth = { type: 'apikey', key: sch.name, value: '{{apiKey}}', in: sch.in === 'query' ? 'query' : 'header' }; break; }
  }
  if (auth.type === 'bearer') variables.push({ key: 'token', value: '', enabled: true });
  if (auth.type === 'basic') variables.push({ key: 'username', value: '', enabled: true }, { key: 'password', value: '', enabled: true });
  if (auth.type === 'apikey') variables.push({ key: 'apiKey', value: '', enabled: true });

  const requests = [];
  for (const [path, item0] of Object.entries(spec.paths || {})) {
    const item = resolve(item0);
    for (const m of METHODS) {
      const op = item[m];
      if (!op) continue;
      const params = [...(item.parameters || []), ...(op.parameters || [])].map((p) => resolve(p));
      const req = newRequest({
        name: op.summary || op.operationId || `${m.toUpperCase()} ${path}`,
        method: m.toUpperCase(),
        url: '{{baseUrl}}' + path.replace(/\{([^}]+)\}/g, '{{$1}}'),
        folder: op.tags?.[0] || '',
        description: [op.description, op.operationId ? `operationId: ${op.operationId}` : ''].filter(Boolean).join('\n'),
        auth: { type: 'inherit' },
      });
      for (const p of params) {
        if (p.in === 'query') req.params.push({ key: p.name, value: paramValue(p, resolve), enabled: !!p.required || paramValue(p, resolve) !== '' });
        else if (p.in === 'header') req.headers.push({ key: p.name, value: paramValue(p, resolve), enabled: !!p.required });
        else if (p.in === 'path' && !seenVars.has(p.name)) { seenVars.add(p.name); variables.push({ key: p.name, value: paramValue(p, resolve) || '1', enabled: true }); }
        else if (v2 && p.in === 'body') { req.body.mode = 'json'; req.body.raw = JSON.stringify(sample(p.schema, resolve), null, 2); }
        else if (v2 && p.in === 'formData') { req.body.mode = p.type === 'file' ? 'formdata' : (req.body.mode === 'formdata' ? 'formdata' : 'urlencoded'); req.body.form.push({ key: p.name, value: '', type: p.type === 'file' ? 'file' : 'text', enabled: true }); }
      }
      const rb = resolve(op.requestBody);
      if (rb?.content) {
        const types = Object.keys(rb.content);
        const jsonType = types.find((t) => t.includes('json'));
        if (jsonType) {
          const c = rb.content[jsonType];
          const ex = c.example ?? (c.examples ? resolve(Object.values(c.examples)[0])?.value : undefined) ?? sample(c.schema, resolve);
          req.body.mode = 'json';
          req.body.raw = JSON.stringify(ex, null, 2);
        } else if (types.includes('application/x-www-form-urlencoded') || types.includes('multipart/form-data')) {
          const t = types.includes('multipart/form-data') ? 'multipart/form-data' : 'application/x-www-form-urlencoded';
          const schema = resolve(rb.content[t].schema) || {};
          req.body.mode = t.startsWith('multipart') ? 'formdata' : 'urlencoded';
          for (const [k, v] of Object.entries(schema.properties || {})) {
            const vv = resolve(v);
            const isFile = vv.format === 'binary';
            const s = sample(vv, resolve);
            req.body.form.push({ key: k, value: isFile ? '' : (typeof s === 'object' ? JSON.stringify(s) : String(s ?? '')), type: isFile ? 'file' : 'text', enabled: true });
          }
        } else if (types.some((t) => t.includes('xml'))) { req.body.mode = 'xml'; req.body.raw = ''; }
        else if (types.length) { req.body.mode = 'text'; }
      }
      // default assertion: first documented 2xx status
      const ok = Object.keys(op.responses || {}).find((c) => /^2\d\d$/.test(c));
      req.assertions.push({ type: 'status', op: 'eq', value: ok || '2xx', enabled: true });
      requests.push(req);
    }
  }
  return {
    id: crypto.randomUUID(),
    name: spec.info?.title || 'OpenAPI import',
    description: spec.info?.description || '',
    variables,
    auth,
    requests,
  };
}

/* ------------------------------------------------------------------ export */

function jsonSchemaOf(v) {
  if (v === null) return { nullable: true };
  if (Array.isArray(v)) return { type: 'array', items: v.length ? jsonSchemaOf(v[0]) : {} };
  if (typeof v === 'object') return { type: 'object', properties: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonSchemaOf(x)])) };
  if (typeof v === 'number') return { type: Number.isInteger(v) ? 'integer' : 'number' };
  if (typeof v === 'boolean') return { type: 'boolean' };
  return { type: 'string' };
}

/** Convert a collection into an OpenAPI 3.0.3 document. */
export function toOpenApi(col) {
  const vars = Object.fromEntries((col.variables || []).map((v) => [v.key, v.value]));
  const reqs = (col.requests || []).filter((r) => (r.protocol || 'http') === 'http');
  // server: prefer a leading {{variable}} (e.g. {{baseUrl}}), else the origin of the first absolute URL
  const lead = reqs.map((r) => /^\{\{\s*([\w.-]+)\s*\}\}/.exec(r.url)?.[1]).find(Boolean);
  let serverUrl = lead ? (vars[lead] || `{${lead}}`) : '';
  if (!lead) { for (const r of reqs) { const m = /^(https?:\/\/[^/{}]+)/i.exec(r.url); if (m) { serverUrl = m[1]; break; } } }
  const spec = {
    openapi: '3.0.3',
    info: { title: col.name || 'API', version: '1.0.0', ...(col.description ? { description: col.description } : {}) },
    servers: [{ url: serverUrl || '/', ...(lead && !vars[lead] ? { variables: { [lead]: { default: 'http://localhost' } } } : {}) }],
    paths: {},
  };
  const tags = new Set();
  const auth = col.auth || { type: 'none' };
  const schemes = {};
  const secFor = (a) => {
    if (!a || a.type === 'none') return null;
    if (a.type === 'bearer') { schemes.bearerAuth = { type: 'http', scheme: 'bearer' }; return 'bearerAuth'; }
    if (a.type === 'basic') { schemes.basicAuth = { type: 'http', scheme: 'basic' }; return 'basicAuth'; }
    if (a.type === 'apikey') { schemes.apiKeyAuth = { type: 'apiKey', in: a.in === 'query' ? 'query' : 'header', name: a.key || 'X-API-Key' }; return 'apiKeyAuth'; }
    return null;
  };
  const colSec = secFor(auth);
  if (colSec) spec.security = [{ [colSec]: [] }];
  for (const r of reqs) {
    let path = r.url.replace(/^\{\{\s*[\w.-]+\s*\}\}/, '').replace(/^https?:\/\/[^/]+/i, '').split('?')[0] || '/';
    const pathParams = [];
    path = path.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, n) => { pathParams.push(n); return `{${n}}`; }).replace(/\/:([\w-]+)/g, (_, n) => { pathParams.push(n); return `/{${n}}`; });
    if (!path.startsWith('/')) path = '/' + path;
    const method = String(r.method || 'GET').toLowerCase();
    spec.paths[path] ||= {};
    if (spec.paths[path][method]) continue; // one operation per path + method
    const op = { summary: r.name, operationId: (r.name || `${method}${path}`).replace(/[^\w]+(.)?/g, (_, c) => (c ? c.toUpperCase() : '')).replace(/^./, (c) => c.toLowerCase()) };
    if (r.description) op.description = r.description;
    if (r.folder) { op.tags = [r.folder]; tags.add(r.folder); }
    const params = [];
    for (const n of pathParams) params.push({ name: n, in: 'path', required: true, schema: { type: 'string' }, ...(vars[n] ? { example: vars[n] } : {}) });
    for (const p of r.params || []) if (p.key) params.push({ name: p.key, in: 'query', required: p.enabled !== false, schema: { type: 'string' }, ...(p.value && !/\{\{/.test(p.value) ? { example: p.value } : {}) });
    for (const h of r.headers || []) if (h.key && !/^(content-type|authorization|accept|user-agent|content-length)$/i.test(h.key)) params.push({ name: h.key, in: 'header', required: h.enabled !== false, schema: { type: 'string' } });
    if (params.length) op.parameters = params;
    const b = r.body || {};
    if (b.mode === 'json' || b.mode === 'graphql') {
      let ex;
      const raw = b.mode === 'graphql' ? JSON.stringify({ query: b.graphql?.query || '', variables: {} }) : b.raw || '';
      try { ex = JSON.parse(raw.replace(/\{\{[^{}]+\}\}/g, '0')); } catch { ex = undefined; }
      op.requestBody = { content: { 'application/json': ex !== undefined ? { schema: jsonSchemaOf(ex), example: ex } : { schema: { type: 'object' } } } };
    } else if (b.mode === 'urlencoded' || b.mode === 'formdata') {
      const props = {};
      for (const f of b.form || []) if (f.key) props[f.key] = f.type === 'file' ? { type: 'string', format: 'binary' } : { type: 'string' };
      op.requestBody = { content: { [b.mode === 'formdata' ? 'multipart/form-data' : 'application/x-www-form-urlencoded']: { schema: { type: 'object', properties: props } } } };
    } else if (b.mode === 'xml' || b.mode === 'text') {
      op.requestBody = { content: { [b.mode === 'xml' ? 'application/xml' : 'text/plain']: { schema: { type: 'string' }, ...(b.raw ? { example: b.raw } : {}) } } };
    }
    const st = (r.assertions || []).find((a) => a.type === 'status' && /^\d{3}$/.test(String(a.value)))?.value;
    op.responses = { [st || '200']: { description: 'Successful response' } };
    if (r.auth && r.auth.type !== 'inherit') {
      const s = secFor(r.auth);
      op.security = s ? [{ [s]: [] }] : [];
    }
    spec.paths[path][method] = op;
  }
  if (tags.size) spec.tags = [...tags].map((name) => ({ name }));
  if (Object.keys(schemes).length) spec.components = { securitySchemes: schemes };
  return spec;
}

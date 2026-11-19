import crypto from 'node:crypto';
import { newRequest } from '../prepare.js';

export function isHar(o) {
  return !!(o && o.log && Array.isArray(o.log.entries));
}

const SKIP = new Set(['content-length', 'host', 'connection', 'accept-encoding']);

export function fromHar(har, { onlyXhr = false } = {}) {
  const requests = [];
  for (const e of har.log.entries) {
    const r = e.request;
    if (!r?.url) continue;
    if (onlyXhr && e._resourceType && !['xhr', 'fetch'].includes(e._resourceType)) continue;
    const u = new URL(r.url);
    const req = newRequest({
      name: `${r.method} ${u.pathname}`.slice(0, 80),
      method: r.method,
      url: u.origin + u.pathname,
      params: (r.queryString || []).map((q) => ({ key: q.name, value: decodeSafe(q.value), enabled: true })),
      headers: (r.headers || []).filter((h) => !h.name.startsWith(':') && !SKIP.has(h.name.toLowerCase())).map((h) => ({ key: h.name, value: h.value, enabled: true })),
      folder: u.host,
      auth: { type: 'none' },
    });
    const pd = r.postData;
    if (pd) {
      const mt = (pd.mimeType || '').toLowerCase();
      if (mt.includes('json')) {
        req.body.mode = 'json';
        try { req.body.raw = JSON.stringify(JSON.parse(pd.text), null, 2); } catch { req.body.raw = pd.text || ''; }
      } else if (mt.includes('x-www-form-urlencoded')) {
        req.body.mode = 'urlencoded';
        req.body.form = (pd.params?.length ? pd.params.map((p) => ({ key: p.name, value: decodeSafe(p.value) })) : [...new URLSearchParams(pd.text || '')].map(([key, value]) => ({ key, value })))
          .map((x) => ({ ...x, enabled: true }));
      } else if (mt.includes('multipart')) {
        req.body.mode = 'formdata';
        req.body.form = (pd.params || []).map((p) => (p.fileName ? { key: p.name, type: 'file', fileName: p.fileName, data: '', enabled: true } : { key: p.name, value: p.value ?? '', type: 'text', enabled: true }));
      } else if (mt.includes('xml')) { req.body.mode = 'xml'; req.body.raw = pd.text || ''; }
      else if (pd.text) { req.body.mode = 'text'; req.body.raw = pd.text; }
      req.headers = req.headers.filter((h) => !(h.key.toLowerCase() === 'content-type' && req.body.mode === 'formdata'));
    }
    requests.push(req);
  }
  return { id: crypto.randomUUID(), name: 'HAR import', description: `Imported ${requests.length} requests from HAR`, variables: [], auth: { type: 'none' }, requests };
}

function decodeSafe(v) {
  try { return decodeURIComponent(String(v ?? '').replace(/\+/g, ' ')); } catch { return v; }
}

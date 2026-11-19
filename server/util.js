import crypto from 'node:crypto';

export const uuid = () => crypto.randomUUID();
export const shortId = () => crypto.randomBytes(5).toString('hex');
export const now = () => performance.now();
export const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

export function readBody(req, limit = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Payload too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON body'), { status: 400 }); }
}

export function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

export function sendText(res, status, text, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extra });
  res.end(text);
}

/** Get a value from an object by a lenient JSON path: $.a.b[0].c, a.b.0.c, [0].id, $['a-b'] */
export function getPath(obj, path) {
  if (path == null || path === '' || path === '$') return obj;
  const parts = [];
  String(path).replace(/^\$\.?/, '').replace(/\[(?:'([^']*)'|"([^"]*)"|(-?\d+))\]|([^.[\]]+)/g, (_, q1, q2, idx, key) => {
    parts.push(q1 ?? q2 ?? (idx !== undefined ? Number(idx) : key));
    return '';
  });
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    if (typeof p === 'number' && Array.isArray(cur) && p < 0) cur = cur[cur.length + p];
    else if (p === 'length' && Array.isArray(cur)) cur = cur.length;
    else cur = cur[p];
  }
  return cur;
}

export function clone(o) { return o == null ? o : structuredClone(o); }

export function enabledPairs(list) {
  return (list || []).filter((x) => x && x.enabled !== false && (x.key ?? '') !== '');
}

/** Parse CSV text to an array of row objects keyed by header. Handles quotes, escaped quotes, CRLF. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', i = 0, q = false;
  text = String(text || '').replace(/^﻿/, '');
  while (i < text.length) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { q = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { q = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const nonEmpty = rows.filter((r) => r.some((v) => v !== ''));
  if (!nonEmpty.length) return [];
  const head = nonEmpty[0].map((h) => h.trim());
  return nonEmpty.slice(1).map((r) => Object.fromEntries(head.map((h, j) => [h, r[j] ?? ''])));
}

export function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

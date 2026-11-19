import { interpolate, requestExtra } from './template.js';
import { readBody, shortId, sleep, getPath } from './util.js';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const BIN_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export function defaultBin(id, name) {
  return {
    id,
    name: name || id,
    response: { status: 200, headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }], body: '{"received": true, "id": "{{$uuid}}"}', delayMs: 0 },
    maxItems: 200,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Receives callbacks/webhooks on /cb/<bin>/<anything>, stores them per bin, answers with
 * the bin's configured mock response and correlates them with requests that are waiting
 * for a callback (matched by any UUID found in the URL, headers or body).
 */
export class CallbackHub {
  constructor({ store, emit }) {
    this.store = store;
    this.emit = emit;
    const saved = store.get('bins', null);
    this.bins = new Map();
    this.items = new Map(); // binId -> captures (newest first)
    for (const b of saved?.bins || [defaultBin('default', 'Default')]) this.bins.set(b.id, b);
    for (const [id, list] of Object.entries(saved?.items || {})) this.items.set(id, list);
    if (!this.bins.has('default')) this.bins.set('default', defaultBin('default', 'Default'));
    this.pending = new Map(); // correlation id -> {runId, sentAt, deadline, onMatch, onTimeout}
    this.recent = new Map();  // correlation value -> { capture, at }: callbacks that arrived before their request was tracked
    this.sweeper = setInterval(() => this.sweep(), 250);
    this.sweeper.unref?.();
  }

  persist() {
    this.store.set('bins', { bins: [...this.bins.values()], items: Object.fromEntries(this.items) });
  }

  list() {
    return [...this.bins.values()].map((b) => ({ ...b, count: (this.items.get(b.id) || []).length }));
  }

  ensureBin(id) {
    if (!BIN_RE.test(id)) throw Object.assign(new Error('Bin id may contain letters, digits, "-", "_" and "." only'), { status: 400 });
    if (!this.bins.has(id)) { this.bins.set(id, defaultBin(id)); this.persist(); this.emit('bins-changed', {}); }
    return this.bins.get(id);
  }

  createBin(data = {}) {
    const id = data.id || shortId();
    if (this.bins.has(id)) throw Object.assign(new Error(`Bin "${id}" already exists`), { status: 409 });
    const b = { ...this.ensureBin(id), ...data, id };
    this.bins.set(id, b);
    this.persist();
    return b;
  }

  updateBin(id, data) {
    const b = this.bins.get(id);
    if (!b) throw Object.assign(new Error('Bin not found'), { status: 404 });
    const nb = { ...b, ...data, id };
    this.bins.set(id, nb);
    this.trim(id);
    this.persist();
    return nb;
  }

  deleteBin(id) {
    this.bins.delete(id);
    this.items.delete(id);
    if (id === 'default') this.bins.set('default', defaultBin('default', 'Default'));
    this.persist();
  }

  getItems(id) { return this.items.get(id) || []; }

  /** Store a request received by something else (e.g. a mock server) in a bin. */
  record(binId, data) {
    const bin = this.ensureBin(binId);
    const capture = { id: shortId() + shortId(), at: new Date().toISOString(), ...data };
    const list = this.items.get(bin.id) || [];
    list.unshift(capture);
    this.items.set(bin.id, list);
    this.trim(bin.id);
    this.persist();
    this.emit('callback', { bin: bin.id, capture });
    return capture;
  }
  clearItems(id) { this.items.set(id, []); this.persist(); }

  trim(id) {
    const list = this.items.get(id);
    const max = Math.max(1, Number(this.bins.get(id)?.maxItems) || 200);
    if (list && list.length > max) list.length = max;
  }

  /* ---------------------------------------------------------- correlation */

  track(id, entry) {
    const key = normKey(id);
    // a delivery report can be faster than the submit response: match it from the recent buffer
    const early = this.recent.get(key);
    if (early) {
      this.recent.delete(key);
      setImmediate(() => { try { entry.onMatch?.({ ...early.capture, matchedRequestId: key, early: true }); } catch { /* ignore */ } });
      return;
    }
    this.pending.set(key, { ...entry, deadline: performance.now() + (entry.timeoutMs || 30000) });
  }

  untrackRun(runId) {
    for (const [id, e] of this.pending) if (e.runId === runId) { this.pending.delete(id); e.onTimeout?.(); }
  }

  sweep() {
    if (this.recent.size) {
      const old = Date.now() - 5 * 60e3;
      for (const [k, v] of this.recent) { if (v.at < old) this.recent.delete(k); else break; }
    }
    if (!this.pending.size) return;
    const t = performance.now();
    for (const [id, e] of this.pending) if (t > e.deadline) { this.pending.delete(id); e.onTimeout?.(); }
  }

  match(texts) {
    if (!this.pending.size) return null;
    for (const s of texts) {
      if (!s) continue;
      for (const m of String(s).matchAll(UUID_RE)) {
        const id = m[0].toLowerCase();
        const e = this.pending.get(id);
        if (e) { this.pending.delete(id); return { id, entry: e }; }
      }
    }
    return null;
  }

  /* ------------------------------------------------------------- receiver */

  /** opts.defaultBin: record requests that are not under /cb/<bin>/ into this bin (dedicated listener ports). */
  async handle(req, res, opts = {}) {
    const u = new URL(req.url, 'http://x');
    const parts = u.pathname.split('/').filter(Boolean);
    const routed = parts[0] === 'cb' && !!parts[1];
    if (!routed && !opts.defaultBin) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ApiStorm callback receiver.\nSend callbacks to /cb/<bin>/<anything>\n');
      return;
    }
    let bin;
    try { bin = this.ensureBin(routed ? decodeURIComponent(parts[1]) : opts.defaultBin); }
    catch (e) { res.writeHead(400, { 'content-type': 'text/plain' }); res.end(e.message); return; }

    const received = performance.now();
    const buf = await readBody(req, 10 * 1024 * 1024).catch(() => Buffer.alloc(0));
    const bodyText = buf.toString('utf8');
    const headerPairs = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) headerPairs.push([req.rawHeaders[i], req.rawHeaders[i + 1]]);
    const capture = {
      id: shortId() + shortId(),
      at: new Date().toISOString(),
      method: req.method,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      headers: headerPairs,
      body: bodyText.length > 256 * 1024 ? bodyText.slice(0, 256 * 1024) : bodyText,
      size: buf.length,
      ip: req.socket.remoteAddress,
      port: req.socket.localPort,
      ...(opts.listener ? { listener: opts.listener } : {}),
    };

    const origin = (headerPairs.find(([k]) => k.toLowerCase() === 'x-apistorm-origin') || [])[1];
    const selfSent = !!origin;
    let m = selfSent ? null : this.match([u.pathname + u.search, ...headerPairs.map(([, v]) => v), bodyText.slice(0, 65536)]);
    // bin-level field extraction: correlation value (e.g. messageId of a delivery report) and status
    if (bin.correlation?.path || bin.status?.path) {
      const info = { body: bodyText, query: capture.query, headers: headerPairs, contentType: (headerPairs.find(([k]) => k.toLowerCase() === 'content-type') || [])[1] || '' };
      if (bin.status?.path) { const st = extractField(info, bin.status); if (st != null) capture.cbStatus = st; }
      if (bin.correlation?.path && !selfSent) {
        const raw = extractField(info, bin.correlation);
        const v = raw == null ? null : normKey(raw);
        if (v != null) {
          capture.correlationValue = v;
          if (!m) {
            const e = this.pending.get(v);
            if (e) { this.pending.delete(v); m = { id: v, entry: e }; }
            else {
              this.recent.set(v, { capture, at: Date.now() });
              if (this.recent.size > 50000) this.recent.delete(this.recent.keys().next().value);
            }
          }
        }
      }
    }
    let fromRun = false;
    if (m) {
      capture.matchedRequestId = m.id;
      capture.latencyMs = Math.round((received - m.entry.sentAt) * 100) / 100;
      fromRun = !!m.entry.runId;
      try { m.entry.onMatch?.(capture); } catch { /* ignore */ }
    }

    // Callbacks belonging to load tests are counted by the run, not stored (they could be thousands).
    // Load-test traffic aimed at a mock bin is not recorded either (it would flood the inbox).
    if (!fromRun && origin !== 'run') {
      const list = this.items.get(bin.id) || [];
      list.unshift(capture);
      this.items.set(bin.id, list);
      this.trim(bin.id);
      this.persist();
      this.emit('callback', { bin: bin.id, capture });
    }

    // mock response
    const r = bin.response || {};
    if (Number(r.delayMs) > 0) await sleep(Math.min(Number(r.delayMs), 120000));
    let parsedBody;
    try { parsedBody = JSON.parse(bodyText); } catch { parsedBody = bodyText; }
    const reqInfo = { method: req.method, path: u.pathname, query: capture.query, headers: Object.fromEntries(headerPairs.map(([k, v]) => [k.toLowerCase(), v])), body: parsedBody };
    const ctx = { layers: [], extra: requestExtra(reqInfo), requestId: m?.id };
    const headers = {};
    for (const h of r.headers || []) if (h.enabled !== false && h.key) headers[h.key] = interpolate(h.value ?? '', ctx);
    headers['X-ApiStorm-Capture'] = capture.id;
    const body = interpolate(r.body ?? '', ctx);
    res.writeHead(Number(r.status) || 200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  }
}

/** Read a value from an incoming callback. spec = { from: json|query|form|header|regex|path, path } */
export function extractField(info, spec) {
  const p = String(spec.path || '');
  let v;
  try {
    switch (spec.from || 'json') {
      case 'query': v = info.query?.[p]; break;
      case 'header': v = (info.headers.find(([k]) => k.toLowerCase() === p.toLowerCase()) || [])[1]; break;
      case 'form': v = new URLSearchParams(info.body).get(p) ?? undefined; break;
      case 'regex': { const mm = new RegExp(p).exec(info.body); v = mm ? mm[1] ?? mm[0] : undefined; break; }
      default: {
        let j;
        try { j = JSON.parse(info.body); } catch { j = /x-www-form-urlencoded/i.test(info.contentType) ? Object.fromEntries(new URLSearchParams(info.body)) : undefined; }
        v = j === undefined ? undefined : getPath(j, p);
        if (Array.isArray(v)) v = v[0];
      }
    }
  } catch { v = undefined; }
  return v === undefined || v === null || typeof v === 'object' ? null : String(v);
}

const UUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** UUIDs are matched case-insensitively, other ids (message ids…) exactly. */
function normKey(id) { const s = String(id); return UUID_ONLY.test(s) ? s.toLowerCase() : s; }

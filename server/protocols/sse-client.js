/* Server-Sent Events client with custom method/headers/body (e.g. POST streaming endpoints). */
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';

export class SseConnection extends EventEmitter {
  constructor() { super(); this.closed = false; this.lastEventId = ''; }
  close() { if (this.closed) return; this.closed = true; this.req?.destroy(); this.emit('close', { reason: 'closed by user' }); }
}

/** prep = { method, url, headers: [[k,v]], body } (from prepareRequest). Resolves once response headers arrive. */
export function connectSse(prep, { insecure = false, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(prep.url);
    const secure = u.protocol === 'https:';
    const headers = [...prep.headers];
    const has = (n) => headers.some(([k]) => k.toLowerCase() === n);
    if (!has('accept')) headers.push(['Accept', 'text/event-stream']);
    if (!has('cache-control')) headers.push(['Cache-Control', 'no-cache']);
    if (!has('host')) headers.unshift(['Host', u.host]);
    if (prep.body && !has('content-length')) headers.push(['Content-Length', String(prep.body.length)]);
    const conn = new SseConnection();
    const t0 = performance.now();
    const req = (secure ? https : http).request({
      hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || (secure ? 443 : 80), path: u.pathname + u.search,
      method: prep.method || 'GET', headers: headers.flat(), rejectUnauthorized: !insecure,
    });
    conn.req = req;
    const timer = setTimeout(() => req.destroy(new Error(`No response within ${timeoutMs} ms`)), timeoutMs);
    req.on('response', (res) => {
      clearTimeout(timer);
      const pairs = [];
      for (let i = 0; i < res.rawHeaders.length; i += 2) pairs.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
      if (res.statusCode >= 300) {
        let body = '';
        res.on('data', (c) => { if (body.length < 4000) body += c; });
        res.on('end', () => reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage}${body ? ` - ${body.slice(0, 300)}` : ''}`)));
        return;
      }
      conn.info = { status: res.statusCode, headers: pairs, connectMs: Math.round((performance.now() - t0) * 100) / 100, contentType: res.headers['content-type'] || '' };
      resolve(conn);
      // read the body on the next tick so callers can attach 'event' listeners first
      setImmediate(() => readStream(res, conn));
    });
    req.on('error', (e) => {
      clearTimeout(timer);
      if (conn.info) { if (!conn.closed) { conn.closed = true; conn.emit('close', { reason: e.message }); } }
      else reject(new Error(e.code && !e.message.includes(e.code) ? `${e.code}: ${e.message}` : e.message));
    });
    if (prep.body) req.end(prep.body); else req.end();
  });
}

function readStream(res, conn) {
      let buf = '';
      let ev = { event: '', data: [], id: '' };
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.search(/\r\n|\n|\r/)) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(buf[i] === '\r' && buf[i + 1] === '\n' ? i + 2 : i + 1);
          if (line === '') {
            if (ev.data.length || ev.event) conn.emit('event', { event: ev.event || 'message', data: ev.data.join('\n'), id: ev.id || conn.lastEventId });
            ev = { event: '', data: [], id: '' };
            continue;
          }
          if (line.startsWith(':')) { conn.emit('comment', line.slice(1).trim()); continue; }
          const c = line.indexOf(':');
          const field = c < 0 ? line : line.slice(0, c);
          let value = c < 0 ? '' : line.slice(c + 1);
          if (value.startsWith(' ')) value = value.slice(1);
          if (field === 'data') ev.data.push(value);
          else if (field === 'event') ev.event = value;
          else if (field === 'id') { ev.id = value; conn.lastEventId = value; }
          else if (field === 'retry') conn.emit('retry', Number(value));
        }
      });
      res.on('end', () => { if (!conn.closed) { conn.closed = true; conn.emit('close', { reason: 'server ended the stream' }); } });
      res.on('error', (e) => conn.emit('error', e));
}

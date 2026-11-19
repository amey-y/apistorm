/*
 * Live connections opened from the UI: WebSocket, Server-Sent Events and gRPC streams.
 * The server holds the connection (so custom headers, auth and TLS options work) and forwards
 * every event to the browser over the app's event stream as `session` events.
 */
import { connectWebSocket } from './ws-client.js';
import { connectSse } from './sse-client.js';
import { GrpcCall, encodeMessage, decodeMessage } from './grpc.js';
import { shortId } from '../util.js';

const MAX_LOG = 1000;
const MAX_TEXT = 256 * 1024;

export class SessionManager {
  constructor({ emit }) {
    this.emit = emit;
    this.sessions = new Map();
  }

  list() {
    return [...this.sessions.values()].map((s) => ({ id: s.id, kind: s.kind, name: s.name, url: s.url, state: s.state, openedAt: s.openedAt, counts: s.counts }));
  }

  get(id) {
    const s = this.sessions.get(id);
    if (!s) throw Object.assign(new Error('Session not found (it may have been closed)'), { status: 404 });
    return s;
  }

  create(kind, name, url, clientId) {
    const s = { id: shortId() + shortId(), kind, name, url, clientId, state: 'connecting', openedAt: new Date().toISOString(), log: [], counts: { in: 0, out: 0 }, t0: performance.now() };
    this.sessions.set(s.id, s);
    return s;
  }

  push(s, ev) {
    const e = { at: new Date().toISOString(), t: Math.round(performance.now() - s.t0), ...ev };
    if (e.dir === 'in') s.counts.in++;
    if (e.dir === 'out') s.counts.out++;
    s.log.push(e);
    if (s.log.length > MAX_LOG) s.log.splice(0, s.log.length - MAX_LOG);
    this.emit('session', { id: s.id, clientId: s.clientId, state: s.state, event: e });
  }

  payload(buf, binary) {
    if (!binary) { const text = buf.toString('utf8'); return { data: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text, size: buf.length, truncated: text.length > MAX_TEXT }; }
    return { data: buf.subarray(0, MAX_TEXT).toString('base64'), binary: true, size: buf.length, truncated: buf.length > MAX_TEXT };
  }

  finish(s, state, extra = {}) {
    if (s.state === 'closed' || s.state === 'error') return;
    s.state = state;
    this.push(s, { type: state === 'error' ? 'error' : 'close', ...extra });
    // keep the log around for a while so the UI can still read it
    setTimeout(() => this.sessions.delete(s.id), 10 * 60e3).unref();
  }

  /* --------------------------------------------------------- WebSocket */

  async openWebSocket({ url, headers, protocols, insecure, name, clientId }) {
    const s = this.create('ws', name, url, clientId);
    try {
      const ws = await connectWebSocket(url, { headers, protocols, insecure });
      s.conn = ws;
      s.state = 'open';
      this.push(s, { type: 'open', info: ws.info });
      ws.on('message', ({ data, binary }) => this.push(s, { type: 'message', dir: 'in', ...this.payload(data, binary) }));
      ws.on('ping', () => this.push(s, { type: 'ping', dir: 'in' }));
      ws.on('pong', () => this.push(s, { type: 'pong', dir: 'in' }));
      ws.on('close', ({ code, reason }) => this.finish(s, 'closed', { code, reason }));
      ws.on('error', (e) => this.push(s, { type: 'error', message: e.message }));
      return { id: s.id, info: ws.info };
    } catch (e) {
      this.sessions.delete(s.id);
      throw Object.assign(e, { status: 502 });
    }
  }

  /* -------------------------------------------------------------- SSE */

  async openSse({ prep, insecure, name, clientId }) {
    const s = this.create('sse', name, prep.url, clientId);
    try {
      const conn = await connectSse(prep, { insecure });
      s.conn = conn;
      s.state = 'open';
      this.push(s, { type: 'open', info: conn.info });
      conn.on('event', (ev) => this.push(s, { type: 'message', dir: 'in', event: ev.event, id: ev.id, data: ev.data.length > MAX_TEXT ? ev.data.slice(0, MAX_TEXT) : ev.data, size: Buffer.byteLength(ev.data) }));
      conn.on('comment', (c) => this.push(s, { type: 'comment', dir: 'in', data: c }));
      conn.on('close', ({ reason }) => this.finish(s, 'closed', { reason }));
      conn.on('error', (e) => this.push(s, { type: 'error', message: e.message }));
      return { id: s.id, info: conn.info };
    } catch (e) {
      this.sessions.delete(s.id);
      throw Object.assign(e, { status: 502 });
    }
  }

  /* ------------------------------------------------------ gRPC stream */

  openGrpcStream({ target, tls, insecure, path, metadata, reg, method, timeoutMs, name, clientId, firstMessage }) {
    const s = this.create('grpc', name, `${tls ? 'grpcs' : 'grpc'}://${target}${path}`, clientId);
    const call = new GrpcCall({ target, tls, insecure, path, metadata, timeoutMs: timeoutMs || 0 });
    s.conn = call;
    s.grpc = { reg, method };
    s.state = 'open';
    this.push(s, { type: 'open', info: { method: path, clientStreaming: method.clientStreaming, serverStreaming: method.serverStreaming } });
    call.on('headers', (h) => this.push(s, { type: 'headers', headers: h }));
    call.on('message', (buf) => {
      let data;
      try { data = JSON.stringify(decodeMessage(reg, method.outputType, buf), null, 2); } catch (e) { data = `<undecodable message: ${e.message}>`; }
      this.push(s, { type: 'message', dir: 'in', data, size: buf.length });
    });
    call.on('end', (end) => this.finish(s, end.code === 0 ? 'closed' : 'error', { code: end.code, status: end.status, message: end.message, trailers: end.trailers, timeMs: end.timeMs }));
    call.on('error', (e) => this.push(s, { type: 'error', message: e.message }));
    if (firstMessage !== undefined) this.send(s.id, { json: firstMessage });
    return { id: s.id };
  }

  /* ------------------------------------------------------------ actions */

  send(id, { data, binary, json }) {
    const s = this.get(id);
    if (s.state !== 'open') throw Object.assign(new Error('The connection is not open'), { status: 409 });
    if (s.kind === 'ws') {
      const buf = binary ? Buffer.from(String(data || ''), 'base64') : Buffer.from(String(data ?? ''), 'utf8');
      s.conn.send(buf, { binary: !!binary });
      this.push(s, { type: 'message', dir: 'out', ...this.payload(buf, !!binary) });
      return { ok: true, size: buf.length };
    }
    if (s.kind === 'grpc') {
      let obj = json;
      if (typeof obj === 'string') { try { obj = JSON.parse(obj || '{}'); } catch (e) { throw Object.assign(new Error(`Message is not valid JSON: ${e.message}`), { status: 400 }); } }
      let buf;
      try { buf = encodeMessage(s.grpc.reg, s.grpc.method.inputType, obj); } catch (e) { throw Object.assign(new Error(e.message), { status: 400 }); }
      s.conn.write(buf);
      this.push(s, { type: 'message', dir: 'out', data: JSON.stringify(obj, null, 2), size: buf.length });
      return { ok: true, size: buf.length };
    }
    throw Object.assign(new Error('This connection is receive-only'), { status: 400 });
  }

  ping(id) {
    const s = this.get(id);
    if (s.kind !== 'ws' || s.state !== 'open') throw Object.assign(new Error('Ping is only available on open WebSockets'), { status: 400 });
    s.conn.ping('apistorm');
    this.push(s, { type: 'ping', dir: 'out' });
    return { ok: true };
  }

  end(id) {
    const s = this.get(id);
    if (s.kind !== 'grpc') throw Object.assign(new Error('Only gRPC streams can be half-closed'), { status: 400 });
    s.conn.end();
    this.push(s, { type: 'half-close', dir: 'out' });
    return { ok: true };
  }

  close(id, { code = 1000, reason = '' } = {}) {
    const s = this.sessions.get(id);
    if (!s) return { ok: true };
    if (s.state === 'open') {
      if (s.kind === 'ws') s.conn.close(code, reason);
      else if (s.kind === 'grpc') s.conn.cancel();
      else s.conn.close();
    }
    return { ok: true };
  }

  closeAll() { for (const id of [...this.sessions.keys()]) this.close(id); }
}

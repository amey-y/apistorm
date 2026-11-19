/* Minimal RFC 6455 WebSocket client (no dependencies): custom headers, subprotocols, TLS options, ping/pong. */
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 32 * 1024 * 1024;

export class WsConnection extends EventEmitter {
  constructor(socket, head, info) {
    super();
    this.socket = socket;
    this.info = info;
    this.buf = Buffer.alloc(0);
    this.frag = null; // { opcode, parts: [] }
    this.closed = false;
    socket.setNoDelay(true);
    socket.pause();
    socket.on('close', () => this.finish(1006, 'Connection closed'));
    socket.on('error', (e) => this.emit('error', e));
    // start reading on the next tick so callers can attach 'message' listeners first
    // (servers often send a greeting in the same packet as the handshake)
    setImmediate(() => {
      if (head?.length) this.onData(head);
      socket.on('data', (d) => this.onData(d));
      socket.resume();
    });
  }

  onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = !!(b0 & 0x80), opcode = b0 & 0x0f, masked = !!(b1 & 0x80);
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (len > MAX_MESSAGE) { this.close(1009, 'Message too big'); return; }
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < off + maskLen + len) return;
      let payload = this.buf.subarray(off + maskLen, off + maskLen + len);
      if (masked) { const m = this.buf.subarray(off, off + 4); payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3]; }
      this.buf = this.buf.subarray(off + maskLen + len);
      this.onFrame(fin, opcode, Buffer.from(payload));
    }
  }

  onFrame(fin, opcode, payload) {
    if (opcode === 0x8) { // close
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
      if (!this.closing) this.sendFrame(0x8, payload.subarray(0, 2));
      this.socket.end();
      this.finish(code, reason);
      return;
    }
    if (opcode === 0x9) { this.sendFrame(0xa, payload); this.emit('ping', payload); return; }
    if (opcode === 0xa) { this.emit('pong', payload); return; }
    if (opcode === 0x0) { // continuation
      if (!this.frag) return;
      this.frag.parts.push(payload);
      if (fin) { const { opcode: op, parts } = this.frag; this.frag = null; this.deliver(op, Buffer.concat(parts)); }
      return;
    }
    if (!fin) { this.frag = { opcode, parts: [payload] }; return; }
    this.deliver(opcode, payload);
  }

  deliver(opcode, data) {
    this.emit('message', { data, binary: opcode === 0x2 });
  }

  sendFrame(opcode, payload = Buffer.alloc(0)) {
    if (this.socket.destroyed) return;
    const len = payload.length;
    const head = [0x80 | opcode];
    let ext = Buffer.alloc(0);
    if (len < 126) head.push(0x80 | len);
    else if (len < 65536) { head.push(0x80 | 126); ext = Buffer.alloc(2); ext.writeUInt16BE(len); }
    else { head.push(0x80 | 127); ext = Buffer.alloc(8); ext.writeBigUInt64BE(BigInt(len)); }
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    this.socket.write(Buffer.concat([Buffer.from(head), ext, mask, masked]));
  }

  send(data, { binary = false } = {}) {
    if (this.closed) throw new Error('WebSocket is closed');
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    this.sendFrame(binary ? 0x2 : 0x1, buf);
    return buf.length;
  }

  ping(data = '') { this.sendFrame(0x9, Buffer.from(String(data))); }

  close(code = 1000, reason = '') {
    if (this.closed || this.closing) return;
    this.closing = true;
    const p = Buffer.alloc(2 + Buffer.byteLength(reason));
    p.writeUInt16BE(code);
    p.write(reason, 2);
    this.sendFrame(0x8, p);
    setTimeout(() => { this.socket.destroy(); this.finish(code, reason); }, 2000).unref();
  }

  finish(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', { code, reason });
  }
}

/** Connect. url: ws:// or wss://, headers: [[k,v]], protocols: ['a','b']. Resolves with a WsConnection. */
export function connectWebSocket(url, { headers = [], protocols = [], insecure = false, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { reject(new Error(`Invalid WebSocket URL: ${url}`)); return; }
    if (!/^wss?:$/.test(u.protocol)) { reject(new Error('WebSocket URLs must start with ws:// or wss://')); return; }
    const secure = u.protocol === 'wss:';
    const key = crypto.randomBytes(16).toString('base64');
    const hdrs = [['Host', u.host], ['Connection', 'Upgrade'], ['Upgrade', 'websocket'], ['Sec-WebSocket-Version', '13'], ['Sec-WebSocket-Key', key], ...headers.filter(([k]) => !/^(host|connection|upgrade|sec-websocket-(key|version))$/i.test(k))];
    if (protocols.length) hdrs.push(['Sec-WebSocket-Protocol', protocols.join(', ')]);
    if (!hdrs.some(([k]) => k.toLowerCase() === 'user-agent')) hdrs.push(['User-Agent', 'ApiStorm/1.2']);
    const t0 = performance.now();
    const req = (secure ? https : http).request({
      hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || (secure ? 443 : 80), path: u.pathname + u.search,
      method: 'GET', headers: hdrs.flat(), rejectUnauthorized: !insecure, servername: secure && !/^[\d.]+$|:/.test(u.hostname) ? u.hostname : undefined,
    });
    const timer = setTimeout(() => { req.destroy(new Error(`WebSocket handshake timed out after ${timeoutMs} ms`)); }, timeoutMs);
    req.on('upgrade', (res, socket, head) => {
      clearTimeout(timer);
      const expect = crypto.createHash('sha1').update(key + GUID).digest('base64');
      if (res.headers['sec-websocket-accept'] !== expect) { socket.destroy(); reject(new Error('Invalid Sec-WebSocket-Accept from server')); return; }
      const rawPairs = [];
      for (let i = 0; i < res.rawHeaders.length; i += 2) rawPairs.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
      resolve(new WsConnection(socket, head, { status: res.statusCode, headers: rawPairs, protocol: res.headers['sec-websocket-protocol'] || '', handshakeMs: Math.round((performance.now() - t0) * 100) / 100 }));
    });
    req.on('response', (res) => {
      clearTimeout(timer);
      let body = '';
      res.on('data', (c) => { if (body.length < 4000) body += c; });
      res.on('end', () => reject(new Error(`Server refused the WebSocket upgrade: HTTP ${res.statusCode} ${res.statusMessage}${body ? ` - ${body.slice(0, 300)}` : ''}`)));
    });
    req.on('error', (e) => { clearTimeout(timer); reject(new Error(e.code && !e.message.includes(e.code) ? `${e.code}: ${e.message}` : e.message)); });
    req.end();
  });
}

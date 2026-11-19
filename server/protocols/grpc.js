/* gRPC client over node:http2 (unary, server/client/bidi streaming) and server reflection. */
import http2 from 'node:http2';
import { EventEmitter } from 'node:events';
import { parseProtos, encodeMessage, decodeMessage, addFileDescriptors, newRegistry, withWellKnownTypes, describeServices } from './protobuf.js';

const STATUS = ['OK', 'CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND', 'ALREADY_EXISTS', 'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE', 'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS', 'UNAUTHENTICATED'];
export const grpcStatusName = (c) => STATUS[c] || `CODE_${c}`;

/* ------------------------------------------------------------ connections */

const sessions = new Map(); // key -> { session, timer }

function getSession(target, { tls = false, insecure = false } = {}) {
  const key = `${tls ? 's' : 'p'}|${insecure ? 'i' : 'v'}|${target}`;
  const cur = sessions.get(key);
  if (cur && !cur.session.closed && !cur.session.destroyed) { clearTimeout(cur.timer); cur.timer = setTimeout(() => close(key), 60000); cur.timer.unref(); return cur.session; }
  const authority = `${tls ? 'https' : 'http'}://${target}`;
  const session = http2.connect(authority, { rejectUnauthorized: !insecure, ...(tls ? { ALPNProtocols: ['h2'] } : {}) });
  session.on('error', () => sessions.delete(key));
  session.on('close', () => sessions.delete(key));
  const entry = { session, timer: setTimeout(() => close(key), 60000) };
  entry.timer.unref();
  sessions.set(key, entry);
  return session;
}
function close(key) { const e = sessions.get(key); if (e) { sessions.delete(key); e.session.close(); } }
export function closeAllGrpc() { for (const k of [...sessions.keys()]) close(k); }

export function normalizeTarget(t) {
  const s = String(t || '').trim().replace(/^grpcs?:\/\//, '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (!s) throw new Error('Enter the gRPC server address as host:port');
  return /:\d+$/.test(s) || s.startsWith('[') ? s : `${s}:443`;
}

/* ------------------------------------------------------------------ calls */

/**
 * Start a call. Messages are raw protobuf Buffers.
 * Emits: 'headers' (obj), 'message' (Buffer), 'end' ({ code, status, message, trailers, headers }), 'error'.
 */
export class GrpcCall extends EventEmitter {
  constructor({ target, tls, insecure, path, metadata = [], timeoutMs = 30000 }) {
    super();
    this.t0 = performance.now();
    const session = getSession(target, { tls, insecure });
    const headers = { ':method': 'POST', ':path': path, 'content-type': 'application/grpc', te: 'trailers', 'user-agent': 'ApiStorm/1.2 grpc-node-like' };
    if (timeoutMs) headers['grpc-timeout'] = `${Math.max(1, Math.round(timeoutMs))}m`;
    for (const [k, v] of metadata) {
      const lk = String(k).toLowerCase();
      if (!lk || lk.startsWith(':') || ['content-type', 'te', 'host', 'connection'].includes(lk)) continue;
      if (headers[lk] !== undefined && lk !== 'user-agent') headers[lk] = [].concat(headers[lk], v); else headers[lk] = v;
    }
    this.stream = session.request(headers, { endStream: false });
    let buf = Buffer.alloc(0);
    this.respHeaders = {};
    this.stream.on('response', (h) => { this.respHeaders = h; this.emit('headers', h); });
    this.stream.on('data', (d) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      while (buf.length >= 5) {
        const len = buf.readUInt32BE(1);
        if (buf.length < 5 + len) break;
        if (buf[0] === 1) { this.emit('error', new Error('Compressed gRPC messages are not supported')); this.cancel(); return; }
        this.emit('message', buf.subarray(5, 5 + len));
        buf = buf.subarray(5 + len);
      }
    });
    let trailers = null;
    this.stream.on('trailers', (t) => { trailers = t; });
    this.stream.on('close', () => {
      const src = trailers || this.respHeaders;
      let code = src['grpc-status'] !== undefined ? Number(src['grpc-status']) : this.stream.rstCode ? 1 : 2;
      let message = src['grpc-message'] ? decodeURIComponent(String(src['grpc-message'])) : '';
      if (src['grpc-status'] === undefined && this.respHeaders[':status'] && this.respHeaders[':status'] !== 200) { code = 14; message ||= `HTTP ${this.respHeaders[':status']} from server (is this a gRPC endpoint? is TLS set correctly?)`; }
      if (src['grpc-status'] === undefined && this.lastError && !this.cancelled) {
        const cause = this.lastError.cause || /caused by: ([^)]*)/.exec(this.lastError.message)?.[1] || this.lastError;
        code = 14; message = friendlyError(typeof cause === 'string' ? Object.assign(new Error(cause.trim()), { code: /wrong version number/.test(cause) ? 'ERR_SSL_WRONG_VERSION_NUMBER' : undefined }) : cause, target);
      }
      if (this.cancelled) { code = 1; message ||= 'Cancelled by user'; }
      this.emit('end', { code, status: grpcStatusName(code), message, trailers: trailers || {}, headers: this.respHeaders, timeMs: Math.round((performance.now() - this.t0) * 100) / 100 });
    });
    this.stream.on('error', (e) => { this.lastError = e; });
    session.once('error', (e) => { this.lastError = e; this.emit('error', e); });
  }
  write(msgBuf) {
    const frame = Buffer.alloc(5 + msgBuf.length);
    frame[0] = 0;
    frame.writeUInt32BE(msgBuf.length, 1);
    msgBuf.copy(frame, 5);
    this.stream.write(frame);
  }
  end() { this.stream.end(); }
  cancel() { this.cancelled = true; this.stream.close(http2.constants.NGHTTP2_CANCEL); }
}

/** Unary or server-streaming call; resolves when the call ends. */
export function grpcInvoke({ target, tls, insecure, path, metadata, timeoutMs, request }) {
  return new Promise((resolve, reject) => {
    const msgs = [];
    let call;
    try { call = new GrpcCall({ target, tls, insecure, path, metadata, timeoutMs }); } catch (e) { reject(e); return; }
    let failed = null;
    call.on('message', (m) => msgs.push(Buffer.from(m)));
    call.on('error', (e) => { failed = e; });
    call.on('end', (end) => {
      if (failed && end.code !== 0 && !msgs.length && !end.headers[':status']) { reject(new Error(friendlyError(failed, target))); return; }
      resolve({ ...end, messages: msgs });
    });
    call.write(request);
    call.end();
  });
}

function friendlyError(e, target) {
  if (e.code === 'ECONNREFUSED') return `Connection refused by ${target}`;
  if (e.code === 'ENOTFOUND') return `Host not found: ${target}`;
  if (/ERR_SSL|EPROTO|wrong version number/i.test(`${e.code} ${e.message}`)) return `TLS handshake with ${target} failed (${/wrong version number/i.test(e.message) ? 'the server does not speak TLS on this port' : e.message.split(String.fromCharCode(10))[0]}). Toggle "TLS" to match the server.`;
  if (e.code === 'ETIMEDOUT') return `Timed out connecting to ${target}`;
  return e.message;
}

/* ------------------------------------------------------------- reflection */

const REFLECTION_PROTO = (pkg) => `
syntax = "proto3";
package ${pkg};
service ServerReflection { rpc ServerReflectionInfo(stream ServerReflectionRequest) returns (stream ServerReflectionResponse); }
message ServerReflectionRequest { string host = 1; oneof message_request { string file_by_filename = 3; string file_containing_symbol = 4; string list_services = 7; } }
message ServerReflectionResponse { string valid_host = 1; ServerReflectionRequest original_request = 2; oneof message_response { FileDescriptorResponse file_descriptor_response = 4; ListServiceResponse list_services_response = 6; ErrorResponse error_response = 7; } }
message FileDescriptorResponse { repeated bytes file_descriptor_proto = 1; }
message ListServiceResponse { repeated ServiceResponse service = 1; }
message ServiceResponse { string name = 1; }
message ErrorResponse { int32 error_code = 1; string error_message = 2; }
`;

async function reflectWith(pkg, opts) {
  const rreg = parseProtos([{ name: 'reflection.proto', text: REFLECTION_PROTO(pkg) }], newRegistry());
  const reqType = `${pkg}.ServerReflectionRequest`, resType = `${pkg}.ServerReflectionResponse`;
  const call = new GrpcCall({ ...opts, path: `/${pkg}.ServerReflection/ServerReflectionInfo`, timeoutMs: opts.timeoutMs || 15000 });
  const queue = [];
  let waiter = null, ended = null, failure = null;
  call.on('message', (m) => { const d = decodeMessage(rreg, resType, m, { defaults: false }); if (waiter) { const w = waiter; waiter = null; w(d); } else queue.push(d); });
  call.on('end', (e) => { ended = e; if (waiter) { const w = waiter; waiter = null; w(null); } });
  call.on('error', (e) => { failure = e; });
  const ask = (req) => new Promise((resolve) => {
    call.write(encodeMessage(rreg, reqType, req));
    if (queue.length) resolve(queue.shift()); else if (ended) resolve(null); else waiter = resolve;
  });
  try {
    const list = await ask({ listServices: '*' });
    if (!list) throw new Error(ended?.code ? `${ended.status}: ${ended.message || 'reflection not available'}` : failure ? friendlyError(failure, opts.target) : 'No reflection response');
    if (list.errorResponse) throw new Error(list.errorResponse.errorMessage || 'Reflection error');
    const names = (list.listServicesResponse?.service || []).map((s) => s.name);
    const reg = withWellKnownTypes(newRegistry());
    const loaded = new Set();
    const addResp = (resp) => {
      if (!resp?.fileDescriptorResponse) return [];
      const bufs = (resp.fileDescriptorResponse.fileDescriptorProto || []).map((b) => Buffer.from(b, 'base64'));
      const files = addFileDescriptors(reg, bufs);
      for (const f of files) loaded.add(f.name);
      return files.flatMap((f) => f.dependencies);
    };
    let deps = [];
    for (const n of names) {
      if (n.startsWith('grpc.reflection.')) continue;
      deps.push(...addResp(await ask({ fileContainingSymbol: n })));
    }
    // fetch dependencies the server did not include (types used by the services)
    for (let guard = 0; guard < 50 && deps.some((d) => !loaded.has(d)); guard++) {
      const d = deps.find((x) => !loaded.has(x));
      loaded.add(d);
      if (d.startsWith('google/protobuf/')) continue; // built in
      deps.push(...addResp(await ask({ fileByFilename: d })));
    }
    return { reg, services: names };
  } finally {
    try { call.end(); } catch { /* ignore */ }
  }
}

/** Discover services with server reflection (tries v1, then v1alpha). */
export async function reflect(opts) {
  try { return await reflectWith('grpc.reflection.v1', opts); }
  catch (e1) {
    try { return await reflectWith('grpc.reflection.v1alpha', opts); }
    catch (e2) { throw new Error(`Server reflection failed: ${e2.message}${e1.message !== e2.message ? ` (v1: ${e1.message})` : ''}`); }
  }
}

/* ----------------------------------------------------- schema resolution */

const regCache = new Map(); // key -> { reg, at }

/** Registry for a gRPC request config: from .proto texts or reflection (cached for 5 minutes). */
export async function registryFor(g, { target, tls, insecure, metadata, refresh = false }) {
  if ((g.protoSource || 'proto') === 'reflection') {
    const key = `r|${target}|${tls}|${insecure}`;
    const c = regCache.get(key);
    if (!refresh && c && Date.now() - c.at < 5 * 60e3) return c.reg;
    const { reg } = await reflect({ target, tls, insecure, metadata });
    regCache.set(key, { reg, at: Date.now() });
    return reg;
  }
  const files = (g.protos || []).filter((p) => p.text?.trim());
  if (!files.length) throw new Error('Add a .proto file (or switch to server reflection)');
  const key = `p|${files.map((f) => f.name + ':' + f.text.length + ':' + hash(f.text)).join('|')}`;
  const c = regCache.get(key);
  if (c) return c.reg;
  const reg = parseProtos(files.map((f) => ({ name: f.name || 'service.proto', text: f.text })));
  regCache.set(key, { reg, at: Date.now() });
  if (regCache.size > 50) regCache.delete(regCache.keys().next().value);
  return reg;
}
function hash(s) { let x = 0; for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) | 0; return x; }

export function findMethod(reg, service, method) {
  const s = reg.services.get(service);
  if (!s) throw new Error(`Service "${service}" not found. Available: ${[...reg.services.keys()].filter((x) => !x.startsWith('grpc.reflection.')).join(', ') || 'none'}`);
  const m = s.methods.find((x) => x.name === method);
  if (!m) throw new Error(`Method "${method}" not found in ${service}. Available: ${s.methods.map((x) => x.name).join(', ')}`);
  return m;
}

export { describeServices, encodeMessage, decodeMessage };

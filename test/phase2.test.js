import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import http2 from 'node:http2';
import crypto from 'node:crypto';
import { connectWebSocket } from '../server/protocols/ws-client.js';
import { connectSse } from '../server/protocols/sse-client.js';
import { parseProtos, encodeMessage, decodeMessage, templateFor, descriptorRegistry, DESCRIPTOR_PROTO } from '../server/protocols/protobuf.js';
import { grpcInvoke, GrpcCall, reflect, closeAllGrpc, findMethod } from '../server/protocols/grpc.js';
import { MockManager, routesFromOpenApi, validateSchema } from '../server/mocks.js';
import { CallbackHub } from '../server/callbacks.js';
import { parseYaml } from '../server/yaml.js';

const memStore = () => { const m = new Map(); return { get: (k, d) => (m.has(k) ? m.get(k) : d), set: (k, v) => m.set(k, v) }; };

/* ------------------------------------------------------------- WebSocket */

function wsEchoServer() {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.on('upgrade', (req, sock) => {
      const acc = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\nSec-WebSocket-Protocol: chat\r\n\r\n`);
      const frame = (op, payload) => { const len = payload.length; const head = len < 126 ? Buffer.from([0x80 | op, len]) : Buffer.from([0x80 | op, 126, len >> 8, len & 255]); sock.write(Buffer.concat([head, payload])); };
      frame(1, Buffer.from(JSON.stringify({ hello: req.headers['x-token'] })));
      let buf = Buffer.alloc(0);
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 6) {
          const op = buf[0] & 15; let len = buf[1] & 127; let off = 2;
          if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
          if (buf.length < off + 4 + len) return;
          const mask = buf.subarray(off, off + 4);
          const p = Buffer.from(buf.subarray(off + 4, off + 4 + len)).map((b, i) => b ^ mask[i & 3]);
          buf = buf.subarray(off + 4 + len);
          if (op === 8) { frame(8, p.subarray(0, 2)); sock.end(); return; }
          if (op === 9) { frame(10, p); continue; }
          frame(op, Buffer.from(p)); // echo text/binary
        }
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

test('WebSocket client: headers, subprotocol, text/binary echo, ping and close', async () => {
  const { srv, port } = await wsEchoServer();
  const ws = await connectWebSocket(`ws://127.0.0.1:${port}/chat`, { headers: [['X-Token', 'abc']], protocols: ['chat'] });
  assert.equal(ws.info.protocol, 'chat');
  const msgs = [];
  const got = (n) => new Promise((r) => { const iv = setInterval(() => { if (msgs.length >= n) { clearInterval(iv); r(); } }, 5); });
  ws.on('message', (m) => msgs.push(m));
  await got(1);
  assert.equal(JSON.parse(msgs[0].data.toString()).hello, 'abc');
  ws.send('x'.repeat(300));
  ws.send(Buffer.from([1, 2, 3]), { binary: true });
  await got(3);
  assert.equal(msgs[1].data.toString(), 'x'.repeat(300));
  assert.deepEqual([...msgs[2].data], [1, 2, 3]);
  assert.equal(msgs[2].binary, true);
  const pong = new Promise((r) => ws.once('pong', r));
  ws.ping('p');
  await pong;
  const closed = new Promise((r) => ws.once('close', r));
  ws.close(1000, 'bye');
  assert.equal((await closed).code, 1000);
  srv.close();
});

test('SSE client parses events, ids and multi-line data', async () => {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(': hello\n\n');
    res.write('event: dlr\nid: 1\ndata: {"msgId":"A"}\n\n');
    res.write('data: line1\ndata: line2\n\n');
    setTimeout(() => res.end('id: 9\ndata: last\n\n'), 20);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const conn = await connectSse({ method: 'GET', url: `http://127.0.0.1:${srv.address().port}/events`, headers: [], body: null });
  const events = [];
  conn.on('event', (e) => events.push(e));
  await new Promise((r) => conn.on('close', r));
  srv.close();
  assert.deepEqual(events, [{ event: 'dlr', data: '{"msgId":"A"}', id: '1' }, { event: 'message', data: 'line1\nline2', id: '1' }, { event: 'message', data: 'last', id: '9' }]);
});

/* -------------------------------------------------------------- protobuf */

const PROTO = `
syntax = "proto3";
package sms.v1;
import "google/protobuf/timestamp.proto";
/* Bulk SMS API */
service Messaging {
  rpc Send (SendRequest) returns (SendResponse);
  rpc Track (TrackRequest) returns (stream DeliveryReport);
  rpc SendBatch (stream SendRequest) returns (BatchSummary);
  rpc Chat (stream SendRequest) returns (stream SendResponse) { option deprecated = true; }
}
enum Priority { NORMAL = 0; HIGH = 1; }
message SendRequest {
  string to = 1;
  string text = 2 [json_name = "body"];
  Priority priority = 3;
  repeated string tags = 4;
  map<string, string> meta = 5;
  int64 client_ref = 6;
  google.protobuf.Timestamp schedule_at = 7;
  oneof route { string sender_id = 8; int32 short_code = 9; }
  Nested nested = 10;
  message Nested { bool flash = 1; repeated sint32 deltas = 2; double cost = 3; bytes raw = 4; }
}
message SendResponse { string message_id = 1; Priority priority = 2; }
message TrackRequest { string message_id = 1; }
message DeliveryReport { string message_id = 1; string status = 2; uint32 seq = 3; }
message BatchSummary { uint32 accepted = 1; repeated string ids = 2; }
`;

test('protobuf: parse, encode/decode round trip with proto3 JSON mapping', () => {
  const reg = parseProtos([{ name: 'sms.proto', text: PROTO }]);
  assert.deepEqual([...reg.services.keys()], ['sms.v1.Messaging']);
  const send = findMethod(reg, 'sms.v1.Messaging', 'Track');
  assert.equal(send.serverStreaming, true);
  const msg = { to: '+15551234', body: 'hi', priority: 'HIGH', tags: ['a', 'b'], meta: { campaign: 'x' }, clientRef: '9007199254740993', scheduleAt: '2026-11-19T10:00:00.250Z', senderId: 'ACME', nested: { flash: true, deltas: [-1, 2, -300], cost: 0.25, raw: Buffer.from('hey').toString('base64') } };
  const buf = encodeMessage(reg, 'sms.v1.SendRequest', msg);
  const back = decodeMessage(reg, 'sms.v1.SendRequest', buf);
  assert.deepEqual(back, msg);
  // defaults are emitted for scalars, oneof members are not
  assert.deepEqual(decodeMessage(reg, 'sms.v1.SendRequest', Buffer.alloc(0)), { to: '', body: '', priority: 'NORMAL', tags: [], meta: {}, clientRef: '0' });
  assert.throws(() => encodeMessage(reg, 'sms.v1.SendRequest', { nope: 1 }), /unknown field "nope"/);
  assert.throws(() => encodeMessage(reg, 'sms.v1.SendRequest', { priority: 'URGENT' }), /not a value of enum/);
  const t = templateFor(reg, 'sms.v1.SendRequest');
  assert.ok('scheduleAt' in t && 'senderId' in t && !('shortCode' in t) && Array.isArray(t.tags));
  assert.throws(() => parseProtos([{ name: 'bad.proto', text: 'message A { Missing x = 1; }' }]), /Unknown type "Missing"/);
});

/* ------------------------------------------------------------------ gRPC */

function grpcServer(reg) {
  const fdBytes = encodeMessage(descriptorRegistry(), 'google.protobuf.FileDescriptorProto', {
    name: 'sms.proto', package: 'sms.v1', syntax: 'proto3',
    messageType: [
      { name: 'TrackRequest', field: [{ name: 'message_id', number: 1, label: 1, type: 9, jsonName: 'messageId' }] },
      { name: 'DeliveryReport', field: [{ name: 'message_id', number: 1, label: 1, type: 9, jsonName: 'messageId' }, { name: 'status', number: 2, label: 1, type: 9 }, { name: 'seq', number: 3, label: 1, type: 13 }] },
      { name: 'Labels', field: [{ name: 'values', number: 1, label: 3, type: 11, typeName: '.sms.v1.Labels.ValuesEntry' }], nestedType: [{ name: 'ValuesEntry', options: { mapEntry: true }, field: [{ name: 'key', number: 1, label: 1, type: 9 }, { name: 'value', number: 2, label: 1, type: 5 }] }] },
    ],
    service: [{ name: 'Messaging', method: [{ name: 'Track', inputType: '.sms.v1.TrackRequest', outputType: '.sms.v1.DeliveryReport', serverStreaming: true }] }],
  });
  const reflReg = parseProtos([{ name: 'r.proto', text: `syntax = "proto3"; package grpc.reflection.v1alpha;
    message ServerReflectionRequest { string host = 1; oneof message_request { string file_by_filename = 3; string file_containing_symbol = 4; string list_services = 7; } }
    message ServerReflectionResponse { oneof message_response { FileDescriptorResponse file_descriptor_response = 4; ListServiceResponse list_services_response = 6; } }
    message FileDescriptorResponse { repeated bytes file_descriptor_proto = 1; }
    message ListServiceResponse { repeated ServiceResponse service = 1; }
    message ServiceResponse { string name = 1; }` }]);
  const frame = (b) => { const f = Buffer.alloc(5 + b.length); f.writeUInt32BE(b.length, 1); b.copy(f, 5); return f; };
  const srv = http2.createServer();
  srv.on('stream', (stream, headers) => {
    const path = headers[':path'];
    let buf = Buffer.alloc(0);
    const msgs = [];
    const respond = () => stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
    const finish = (code = 0, message = '') => { stream.once('wantTrailers', () => stream.sendTrailers({ 'grpc-status': String(code), ...(message ? { 'grpc-message': encodeURIComponent(message) } : {}) })); stream.end(); };
    stream.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 5 && buf.length >= 5 + buf.readUInt32BE(1)) { msgs.push(buf.subarray(5, 5 + buf.readUInt32BE(1))); buf = buf.subarray(5 + buf.readUInt32BE(1)); }
      if (path.endsWith('ServerReflectionInfo')) {
        while (msgs.length) {
          const q = decodeMessage(reflReg, 'grpc.reflection.v1alpha.ServerReflectionRequest', msgs.shift(), { defaults: false });
          if (!stream.headersSent) respond();
          const r = q.listServices ? { listServicesResponse: { service: [{ name: 'sms.v1.Messaging' }] } } : { fileDescriptorResponse: { fileDescriptorProto: [fdBytes.toString('base64')] } };
          stream.write(frame(encodeMessage(reflReg, 'grpc.reflection.v1alpha.ServerReflectionResponse', r)));
        }
      }
    });
    stream.on('end', () => {
      if (path.endsWith('ServerReflectionInfo')) { if (!stream.headersSent) respond(); return finish(); }
      if (headers.authorization !== 'Bearer t0k') { stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '16', 'grpc-message': 'missing token' }, { endStream: true }); return; }
      respond();
      if (path === '/sms.v1.Messaging/Send') {
        const q = decodeMessage(reg, 'sms.v1.SendRequest', msgs[0]);
        if (!q.to.startsWith('+')) return finish(3, 'to must be E.164');
        stream.write(frame(encodeMessage(reg, 'sms.v1.SendResponse', { messageId: `M-${q.to}`, priority: q.priority })));
        return finish();
      }
      if (path === '/sms.v1.Messaging/Track') {
        for (const [i, st] of ['ACCEPTED', 'SENT', 'DELIVRD'].entries()) stream.write(frame(encodeMessage(reg, 'sms.v1.DeliveryReport', { messageId: 'M1', status: st, seq: i + 1 })));
        return finish();
      }
      if (path === '/sms.v1.Messaging/SendBatch') {
        const ids = msgs.map((m) => `M-${decodeMessage(reg, 'sms.v1.SendRequest', m).to}`);
        stream.write(frame(encodeMessage(reg, 'sms.v1.BatchSummary', { accepted: ids.length, ids })));
        return finish();
      }
      finish(12, 'not implemented');
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port })));
}

test('gRPC: unary, server streaming, client streaming, errors, metadata and reflection', async () => {
  const reg = parseProtos([{ name: 'sms.proto', text: PROTO }]);
  const { srv, port } = await grpcServer(reg);
  const target = `127.0.0.1:${port}`;
  const md = [['authorization', 'Bearer t0k']];
  try {
    const u = await grpcInvoke({ target, tls: false, path: '/sms.v1.Messaging/Send', metadata: md, request: encodeMessage(reg, 'sms.v1.SendRequest', { to: '+1555', priority: 'HIGH' }) });
    assert.equal(u.status, 'OK');
    assert.deepEqual(decodeMessage(reg, 'sms.v1.SendResponse', u.messages[0]), { messageId: 'M-+1555', priority: 'HIGH' });

    const bad = await grpcInvoke({ target, tls: false, path: '/sms.v1.Messaging/Send', metadata: md, request: encodeMessage(reg, 'sms.v1.SendRequest', { to: '1555' }) });
    assert.equal(bad.status, 'INVALID_ARGUMENT');
    assert.equal(bad.message, 'to must be E.164');

    const unauth = await grpcInvoke({ target, tls: false, path: '/sms.v1.Messaging/Send', metadata: [], request: Buffer.alloc(0) });
    assert.equal(unauth.status, 'UNAUTHENTICATED');

    const ss = await grpcInvoke({ target, tls: false, path: '/sms.v1.Messaging/Track', metadata: md, request: encodeMessage(reg, 'sms.v1.TrackRequest', { messageId: 'M1' }) });
    assert.deepEqual(ss.messages.map((b) => decodeMessage(reg, 'sms.v1.DeliveryReport', b).status), ['ACCEPTED', 'SENT', 'DELIVRD']);

    const call = new GrpcCall({ target, tls: false, path: '/sms.v1.Messaging/SendBatch', metadata: md });
    const out = [];
    call.on('message', (b) => out.push(decodeMessage(reg, 'sms.v1.BatchSummary', b)));
    const ended = new Promise((r) => call.on('end', r));
    for (const to of ['+1', '+2', '+3']) call.write(encodeMessage(reg, 'sms.v1.SendRequest', { to }));
    call.end();
    assert.equal((await ended).status, 'OK');
    assert.deepEqual(out, [{ accepted: 3, ids: ['M-+1', 'M-+2', 'M-+3'] }]);

    const { reg: rr, services } = await reflect({ target, tls: false });
    assert.deepEqual(services, ['sms.v1.Messaging']);
    const m = findMethod(rr, 'sms.v1.Messaging', 'Track');
    assert.equal(m.serverStreaming, true);
    const lab = rr.messages.get('sms.v1.Labels');
    assert.equal(lab.fields[0].type, 'map');
    assert.deepEqual(decodeMessage(rr, 'sms.v1.Labels', encodeMessage(rr, 'sms.v1.Labels', { values: { a: 1, b: 2 } })), { values: { a: 1, b: 2 } });

    const down = await grpcInvoke({ target: '127.0.0.1:1', tls: false, path: '/x/y', request: Buffer.alloc(0) }).catch((e) => e);
    assert.match(String(down.message || down.status), /refused|UNAVAILABLE/i);
  } finally {
    closeAllGrpc();
    srv.close();
  }
  assert.ok(DESCRIPTOR_PROTO.includes('FileDescriptorProto'));
});

/* ------------------------------------------------------------------ mocks */

const SPEC = `openapi: 3.0.3
info: {title: SMS API, version: "1"}
servers: [{url: "https://sms.example.com/v1"}]
paths:
  /messages:
    post:
      requestBody:
        content:
          application/json:
            schema: {$ref: "#/components/schemas/Send"}
      responses:
        "202":
          content:
            application/json:
              example: {messageId: "MSG-1", status: queued}
  /messages/{id}:
    get:
      responses:
        "200":
          content:
            application/json:
              schema: {type: object, properties: {messageId: {type: string}, status: {type: string, enum: [DELIVRD, UNDELIV]}}}
components:
  schemas:
    Send:
      type: object
      required: [to, text]
      properties:
        to: {type: string, pattern: "^\\\\+[0-9]{6,15}$"}
        text: {type: string, maxLength: 160}
`;

test('mock server from OpenAPI YAML: routes, path params, validation, templates, error injection, logging', async () => {
  const spec = parseYaml(SPEC);
  const routes = routesFromOpenApi(spec);
  assert.deepEqual(routes.map((r) => `${r.method} ${r.path} ${r.status}`), ['POST /v1/messages 202', 'GET /v1/messages/{id} 200']);
  const hub = new CallbackHub({ store: memStore(), emit: () => {} });
  const mocks = new MockManager({ store: memStore(), hub });
  const port = 7400 + Math.floor(Math.random() * 400);
  routes[1].body = '{"messageId":"{{request.params.id}}","status":"DELIVRD","echo":"{{request.query.x}}"}';
  const m = await mocks.create({ name: 'SMS', port, routes });
  assert.equal(m.running, true);
  const base = `http://127.0.0.1:${port}`;
  try {
    let r = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: '+15550001', text: 'hi' }) });
    assert.equal(r.status, 202);
    assert.deepEqual(await r.json(), { messageId: 'MSG-1', status: 'queued' });
    r = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: '555', text: 'x'.repeat(200) }) });
    assert.equal(r.status, 400);
    const v = await r.json();
    assert.equal(v.details.length, 2);
    r = await fetch(`${base}/v1/messages/ABC?x=1`);
    assert.deepEqual(await r.json(), { messageId: 'ABC', status: 'DELIVRD', echo: '1' });
    r = await fetch(`${base}/nope`);
    assert.equal(r.status, 404);
    await mocks.update(m.id, { errorRate: 100, errorStatus: 503 });
    r = await fetch(`${base}/v1/messages/1`);
    assert.equal(r.status, 503);
    const log = hub.getItems(`mock-${m.id}`);
    assert.equal(log.length, 5);
    assert.equal(log[0].mock.note, 'injected error');
    assert.equal(log[2].mock.route, 'GET /v1/messages/{id}');
  } finally { await mocks.stopAll(); clearInterval(hub.sweeper); }
  assert.deepEqual(validateSchema({ type: 'array', items: { type: 'integer' } }, [1, 'a']), ['$[1]: must be an integer']);
});

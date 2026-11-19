import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { runScript, CryptoJS, newChanges } from '../server/scripting.js';
import { executeRequest } from '../server/pipeline.js';
import { TokenStore, getOAuth2Token, signJwt, applySigV4 } from '../server/auth.js';
import { newRequest, normalizeRequest } from '../server/prepare.js';
import { LoadRun } from '../server/runner.js';
import { CallbackHub } from '../server/callbacks.js';

const listen = (handler) => new Promise((resolve) => { const srv = http.createServer(handler); srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port })); });
const memStore = () => { const m = new Map(); return { get: (k, d) => (m.has(k) ? m.get(k) : d), set: (k, v) => m.set(k, v) }; };
const scopes = () => ({ local: {}, data: { phone: '+15550001' }, env: { apiKey: 'k1' }, collection: {}, globals: {} });

test('scripts: pm API, expect, variables, legacy tests, console and CryptoJS', async () => {
  const sc = scopes();
  const changes = newChanges();
  const req = normalizeRequest(newRequest({ url: 'https://x.io/a', headers: [{ key: 'A', value: '1', enabled: true }] }));
  const pre = await runScript(`
    pm.environment.set('nonce', 'n-' + pm.iterationData.get('phone'));
    pm.variables.set('local1', 42);
    pm.request.headers.upsert({ key: 'X-Sig', value: CryptoJS.HmacSHA256('msg', 'key').toString(CryptoJS.enc.Base64) });
    pm.request.headers.remove('A');
    pm.request.url = 'https://x.io/b?y=2';
    console.log('pre ran', { phone: pm.iterationData.get('phone') });
  `, { phase: 'pre', request: req, scopes: sc, changes, interpolate: (s) => s });
  assert.equal(pre.error, null);
  assert.equal(sc.env.nonce, 'n-+15550001');
  assert.ok(changes.env.set.has('nonce'));
  assert.equal(sc.local.local1, '42');
  assert.equal(req.headers.find((h) => h.key === 'X-Sig').value, crypto.createHmac('sha256', 'key').update('msg').digest('base64'));
  assert.ok(!req.headers.some((h) => h.key === 'A'));
  assert.equal(req.url, 'https://x.io/b');
  assert.equal(req.params[0].key, 'y');
  assert.match(pre.logs[0].text, /pre ran/);

  const res = { status: 201, statusText: 'Created', headerPairs: [['Content-Type', 'application/json']], headers: { 'content-type': 'application/json' }, timings: { total: 12 }, bytesIn: 40 };
  const post = await runScript(`
    pm.test('status', () => pm.response.to.have.status(201));
    pm.test('json', () => {
      const j = pm.response.json();
      pm.expect(j.data.items).to.be.an('array').that.has.lengthOf(2);
      pm.expect(j.data.items[0]).to.have.property('id', 7);
      pm.expect(j).to.have.nested.property('data.items[1].tags').that.includes('b');
      pm.expect(j.data.msg).to.match(/^Hel/).and.not.equal('x');
      pm.expect(pm.response.responseTime).to.be.below(100);
      pm.expect([1, 2]).to.eql([1, 2]);
      pm.expect({}).to.be.empty;
      pm.expect('abc').to.have.length(3);
    });
    pm.test('fails', () => pm.expect(1).to.equal(2));
    pm.test('async', async () => { await sleep(5); pm.expect(true).to.be.true; });
    tests['legacy'] = responseCode.code === 201;
    pm.collectionVariables.set('msgId', pm.response.json().data.items[0].id);
  `, { phase: 'post', request: req, response: res, bodyText: '{"data":{"items":[{"id":7},{"tags":["a","b"]}],"msg":"Hello"}}', scopes: sc, changes, interpolate: (s) => s });
  assert.equal(post.error, null);
  const byName = Object.fromEntries(post.tests.map((t) => [t.name, t]));
  assert.equal(byName.status.pass, true);
  assert.equal(byName.json.pass, true, byName.json.error);
  assert.equal(byName.fails.pass, false);
  assert.match(byName.fails.error, /expected 1 to equal 2/);
  assert.equal(byName.async.pass, true);
  assert.equal(byName.legacy.pass, true);
  assert.equal(sc.collection.msgId, '7');
});

test('scripts: infinite loops time out, syntax errors are reported, skipRequest works', async () => {
  const req = normalizeRequest(newRequest({ url: 'https://x.io' }));
  const loop = await runScript('while (true) {}', { phase: 'pre', request: req, scopes: scopes(), interpolate: (s) => s, timeoutMs: 200 });
  assert.match(loop.error, /timed out/i);
  const bad = await runScript('this is not js', { phase: 'pre', request: req, scopes: scopes(), interpolate: (s) => s });
  assert.match(bad.error, /SyntaxError/);
  const skip = await runScript('if (pm.iterationData.get("phone")) pm.execution.skipRequest()', { phase: 'pre', request: req, scopes: scopes(), interpolate: (s) => s });
  assert.equal(skip.skipRequest, true);
  const noRequire = await runScript('require("fs")', { phase: 'pre', request: req, scopes: scopes(), interpolate: (s) => s });
  assert.match(noRequire.error, /not available/);
});

test('pipeline: pre script signs, pm.sendRequest works, post script tests count as checks', async () => {
  const { srv, port } = await listen((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      if (req.url === '/token') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"t":"abc"}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sig: req.headers['x-sig'], auth: req.headers.authorization, body: b }));
    });
  });
  const req = newRequest({
    method: 'POST', url: `http://127.0.0.1:${port}/sms`, body: { mode: 'json', raw: '{"to":"{{phone}}"}', form: [] },
    scripts: {
      pre: `const r = await pm.sendRequest('http://127.0.0.1:${port}/token'); pm.variables.set('tok', r.json().t);
            pm.request.headers.upsert({ key: 'X-Sig', value: utils.hmac('sha256', 'secret', pm.variables.replaceIn(pm.request.body.raw)) });`,
      post: `pm.test('signed', () => pm.expect(pm.response.json().sig).to.have.length(64));`,
    },
    auth: { type: 'bearer', token: '{{tok}}' },
  });
  const sc = scopes();
  const r = await executeRequest(req, { scopes: sc, send: {} });
  srv.close();
  const j = JSON.parse(r.bodyText);
  assert.equal(j.auth, 'Bearer abc');
  assert.equal(j.body, '{"to":"+15550001"}');
  assert.equal(j.sig, crypto.createHmac('sha256', 'secret').update('{"to":"+15550001"}').digest('hex'));
  assert.deepEqual(r.checks.map((c) => [c.name, c.pass]), [['signed', true]]);
});

test('OAuth2 client credentials: one token request for many concurrent callers, refetch after expiry', async () => {
  let calls = 0;
  const { srv, port } = await listen((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      calls++;
      const p = new URLSearchParams(b);
      const basic = Buffer.from((req.headers.authorization || '').replace('Basic ', ''), 'base64').toString();
      if (p.get('grant_type') !== 'client_credentials' || basic !== 'cid:csecret') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"invalid_client"}'); }
      setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ access_token: `tok${calls}`, token_type: 'Bearer', expires_in: calls === 1 ? 1 : 3600 })); }, 30);
    });
  });
  const tokens = new TokenStore(memStore());
  const auth = { type: 'oauth2', grantType: 'client_credentials', tokenUrl: `http://127.0.0.1:${port}/token`, clientId: 'cid', clientSecret: 'csecret', scope: 'sms.send' };
  const all = await Promise.all(Array.from({ length: 50 }, () => getOAuth2Token(auth, (s) => s, tokens)));
  assert.equal(calls, 1);
  assert.ok(all.every((t) => t.accessToken === 'tok1'));
  // expires_in = 1 s is within the 30 s safety margin, so the next call fetches a new token
  const t2 = await getOAuth2Token(auth, (s) => s, tokens);
  assert.equal(t2.accessToken, 'tok2');
  await assert.rejects(getOAuth2Token({ ...auth, clientSecret: 'bad' }, (s) => s, tokens), /invalid_client/);
  srv.close();
});

test('JWT RS256 / ES256 tokens verify with the public key; SigV4 example vector', () => {
  for (const [alg, type, opts] of [['RS256', 'rsa', { modulusLength: 2048 }], ['ES256', 'ec', { namedCurve: 'P-256' }]]) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync(type, opts);
    const t = signJwt({ algorithm: alg, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), payload: { sub: 'x' } });
    const [h, p, s] = t.split('.');
    const ok = crypto.verify('sha256', Buffer.from(`${h}.${p}`), alg === 'ES256' ? { key: publicKey, dsaEncoding: 'ieee-p1363' } : publicKey, Buffer.from(s, 'base64url'));
    assert.ok(ok, alg);
    assert.equal(JSON.parse(Buffer.from(h, 'base64url')).alg, alg);
  }
  assert.ok(signJwt({ algorithm: 'HS256', secret: 'your-256-bit-secret', payload: { sub: '1234567890', name: 'John Doe', iat: 1516239022 } }).endsWith('SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'));
  const prep = { method: 'GET', url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08', headers: [['Content-Type', 'application/x-www-form-urlencoded; charset=utf-8']], body: null };
  applySigV4(prep, { accessKey: 'AKIDEXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 'iam' }, (s) => s, new Date('2015-08-30T12:36:00Z'));
  assert.equal(prep.signing.signature, '5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
});

test('bulk SMS with delivery reports: DLRs matched by messageId (also when faster than the submit response)', async () => {
  const hub = new CallbackHub({ store: memStore(), emit: () => {} });
  hub.createBin({ id: 'dlr', correlation: { from: 'json', path: '$.msgId' }, status: { from: 'json', path: '$.status' } });
  const cb = await listen((req, res) => hub.handle(req, res));
  let n = 0;
  // fake SMS gateway: returns a message id; sends the DLR to the callback URL; every 4th DLR arrives BEFORE the response
  const api = await listen((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const msgId = `MSG-${++n}`;
      const status = n % 10 === 0 ? 'UNDELIV' : 'DELIVRD';
      const dlr = () => fetch(`http://127.0.0.1:${cb.port}/cb/dlr`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ msgId, status }) }).catch(() => {});
      if (n % 4 === 0) dlr().then(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ messageId: msgId })); });
      else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ messageId: msgId })); setTimeout(dlr, 20); }
    });
  });
  const req = newRequest({ method: 'POST', url: `http://127.0.0.1:${api.port}/sms`, body: { mode: 'json', raw: '{"to":"{{phone}}","text":"hi"}', form: [] }, callback: { correlateBy: 'response', from: 'json', path: '$.messageId' } });
  let result;
  const run = new LoadRun({ config: { mode: 'vus', vus: 4, iterations: 40, durationSec: 0, trackCallbacks: true, callbackTimeoutMs: 3000, data: { rows: [{ phone: '+1' }, { phone: '+2' }], mode: 'sequential' } }, requests: [req], hub, callbackBase: `http://127.0.0.1:${cb.port}`, onFinish: (r) => { result = r; } });
  await run.start();
  api.srv.close(); cb.srv.close(); clearInterval(hub.sweeper);
  assert.equal(result.callbacks.tracked, 40);
  assert.equal(result.callbacks.received, 40, JSON.stringify(result.callbacks));
  assert.equal(result.callbacks.timeouts, 0);
  assert.deepEqual(result.callbacks.statuses, { DELIVRD: 36, UNDELIV: 4 });
});

test('collection flow control with pm.execution.setNextRequest', async () => {
  const hits = [];
  const { srv, port } = await listen((req, res) => { hits.push(req.url); res.end('{}'); });
  const a = newRequest({ name: 'A', url: `http://127.0.0.1:${port}/a`, scripts: { post: "pm.execution.setNextRequest('C')" } });
  const b = newRequest({ name: 'B', url: `http://127.0.0.1:${port}/b` });
  const c = newRequest({ name: 'C', url: `http://127.0.0.1:${port}/c`, scripts: { post: 'pm.execution.setNextRequest(null)' } });
  const d = newRequest({ name: 'D', url: `http://127.0.0.1:${port}/d` });
  let result;
  const run = new LoadRun({ config: { mode: 'vus', vus: 1, iterations: 2, durationSec: 0 }, requests: [a, b, c, d], onFinish: (r) => { result = r; } });
  await run.start();
  srv.close();
  assert.deepEqual(hits, ['/a', '/c', '/a', '/c']);
  assert.equal(result.summary.count, 4);
});

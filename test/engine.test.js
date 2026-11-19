import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Histogram } from '../server/stats.js';
import { LoadRun, cumulativeArrivals } from '../server/runner.js';
import { CallbackHub } from '../server/callbacks.js';
import { newRequest } from '../server/prepare.js';

const memStore = () => { const m = new Map(); return { get: (k, d) => (m.has(k) ? m.get(k) : d), set: (k, v) => m.set(k, v) }; };

function listen(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

test('histogram percentiles are within ~1%', () => {
  const hgm = new Histogram();
  const vals = [];
  for (let i = 1; i <= 10000; i++) { const v = i / 10; vals.push(v); hgm.add(v); }
  for (const p of [50, 90, 95, 99]) {
    const exact = vals[Math.ceil((p / 100) * vals.length) - 1];
    const got = hgm.percentile(p);
    assert.ok(Math.abs(got - exact) / exact < 0.012, `p${p}: ${got} vs ${exact}`);
  }
  assert.equal(hgm.summary().max, 1000);
  assert.equal(hgm.summary().min, 0.1);
});

test('arrival schedule integrates ramps correctly', () => {
  const plan = { start: 0, stages: [{ d: 10, r: 100 }, { d: 10, r: 100 }] };
  assert.equal(cumulativeArrivals(plan, 10), 500);
  assert.equal(cumulativeArrivals(plan, 20), 1500);
  assert.equal(cumulativeArrivals(plan, 5), 125);
});

test('fixed-rate run hits the target TPS and runs checks', async () => {
  const { srv, port } = await listen((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  const req = newRequest({ name: 'ok', url: `http://127.0.0.1:${port}/x`, assertions: [{ type: 'jsonPath', path: '$.ok', op: 'eq', value: 'true' }] });
  let result;
  const run = new LoadRun({ config: { mode: 'rate', tps: 200, durationSec: 2, maxInFlight: 50 }, requests: [req], onFinish: (r) => { result = r; } });
  await run.start();
  srv.close();
  assert.equal(result.status, 'completed');
  assert.ok(Math.abs(result.summary.count - 400) <= 4, `count ${result.summary.count}`);
  assert.equal(result.summary.failed, 0);
  assert.equal(result.summary.checks['$.ok eq true'].pass, result.summary.count);
});

test('max in-flight throttle drops excess iterations against a slow server', async () => {
  const { srv, port } = await listen((req, res) => setTimeout(() => res.end('slow'), 300));
  let result;
  const run = new LoadRun({ config: { mode: 'rate', tps: 100, durationSec: 1, maxInFlight: 5, saturation: 'drop' }, requests: [newRequest({ url: `http://127.0.0.1:${port}/` })], onFinish: (r) => { result = r; } });
  await run.start();
  srv.close();
  assert.ok(result.live.inFlightMax <= 5, `inFlightMax ${result.live.inFlightMax}`);
  assert.ok(result.live.dropped > 50, `dropped ${result.live.dropped}`);
});

test('virtual users with iteration limit and variable chaining across a flow', async () => {
  const { srv, port } = await listen((req, res) => {
    if (req.url === '/login') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ token: 'T' + Math.random() })); return; }
    res.writeHead(req.headers.authorization?.startsWith('Bearer T') ? 200 : 401); res.end();
  });
  const login = newRequest({ name: 'login', method: 'POST', url: `http://127.0.0.1:${port}/login`, extract: [{ var: 'tok', from: 'json', path: '$.token' }] });
  const me = newRequest({ name: 'me', url: `http://127.0.0.1:${port}/me`, auth: { type: 'bearer', token: '{{tok}}' } });
  let result;
  const run = new LoadRun({ config: { mode: 'vus', vus: 4, iterations: 40, durationSec: 0 }, requests: [login, me], onFinish: (r) => { result = r; } });
  await run.start();
  srv.close();
  assert.equal(result.live.iterations.completed, 40);
  assert.equal(result.summary.count, 80);
  assert.equal(result.summary.failed, 0);
});

test('async callbacks are correlated during a load test', async () => {
  const hub = new CallbackHub({ store: memStore(), emit: () => {} });
  const cb = await listen((req, res) => hub.handle(req, res));
  // fake async API: accepts the job, then calls the callbackUrl from the body 50 ms later
  const api = await listen(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const { callbackUrl } = JSON.parse(body);
    res.writeHead(202); res.end();
    setTimeout(() => fetch(callbackUrl, { method: 'POST', body: '{"status":"done"}' }).catch(() => {}), 50);
  });
  const req = newRequest({ method: 'POST', url: `http://127.0.0.1:${api.port}/jobs`, body: { mode: 'json', raw: '{"callbackUrl":"{{$callbackUrl(jobs)}}"}', form: [] } });
  let result;
  const run = new LoadRun({ config: { mode: 'rate', tps: 50, durationSec: 1, trackCallbacks: true, callbackTimeoutMs: 3000 }, requests: [req], hub, callbackBase: `http://127.0.0.1:${cb.port}`, onFinish: (r) => { result = r; } });
  await run.start();
  api.srv.close(); cb.srv.close(); clearInterval(hub.sweeper);
  assert.equal(result.callbacks.tracked, 50);
  assert.equal(result.callbacks.received, 50);
  assert.equal(result.callbacks.timeouts, 0);
  assert.ok(result.callbacks.latency.p50 >= 45, `cb p50 ${result.callbacks.latency.p50}`);
  assert.equal(hub.getItems('jobs').length, 0, 'run callbacks are not stored in the inbox');
});

test('abort on error rate stops the run early', async () => {
  const { srv, port } = await listen((req, res) => { res.writeHead(500); res.end(); });
  let result;
  const run = new LoadRun({ config: { mode: 'rate', tps: 100, durationSec: 10, abortOnErrorRatePct: 10, abortMinSamples: 20 }, requests: [newRequest({ url: `http://127.0.0.1:${port}/` })], onFinish: (r) => { result = r; } });
  await run.start();
  srv.close();
  assert.equal(result.status, 'aborted');
  assert.ok(result.elapsedSec < 4, `elapsed ${result.elapsedSec}`);
});

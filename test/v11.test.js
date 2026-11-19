import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { parseCron, nextCron, nextCronTimes, describeCron } from '../server/cron.js';
import { Scheduler } from '../server/scheduler.js';
import { LoadRun } from '../server/runner.js';
import { newRequest } from '../server/prepare.js';
import { detectImport } from '../server/converters/detect.js';
import { toOpenApi, fromOpenApi } from '../server/converters/openapi.js';
import { parseYaml, toYaml } from '../server/yaml.js';
import { parseArgs, parseDuration } from '../cli.js';
import { startServer } from '../server/app.js';

const memStore = () => { const m = new Map(); return { get: (k, d) => (m.has(k) ? m.get(k) : d), set: (k, v) => m.set(k, v) }; };
const listen = (handler) => new Promise((resolve) => { const srv = http.createServer(handler); srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port })); });

test('cron: parsing, next times and descriptions', () => {
  const base = new Date(2026, 0, 5, 8, 59, 30); // Monday 08:59:30 local
  assert.deepEqual(nextCron('0 9 * * 1-5', base), new Date(2026, 0, 5, 9, 0));
  assert.deepEqual(nextCron('*/15 * * * *', base), new Date(2026, 0, 5, 9, 0));
  assert.deepEqual(nextCron('30 2 1 * *', base), new Date(2026, 1, 1, 2, 30));
  assert.deepEqual(nextCron('0 0 * * sun', base), new Date(2026, 0, 11, 0, 0));
  assert.deepEqual(nextCron('@hourly', base), new Date(2026, 0, 5, 9, 0));
  // day-of-month OR day-of-week when both are restricted
  assert.deepEqual(nextCron('0 0 13 * 5', new Date(2026, 1, 10)), new Date(2026, 1, 13, 0, 0));
  assert.equal(nextCronTimes('0 12 * * *', 3, base).length, 3);
  assert.throws(() => parseCron('61 * * * *'), /out of range/);
  assert.throws(() => parseCron('* * *'), /5 fields/);
  assert.match(describeCron('0 9 * * 1-5'), /09:00 on Monday, Tuesday/);
});

test('scheduler: interval/once/manual, overlap skip and history', async () => {
  const calls = [];
  let release;
  const sched = new Scheduler({
    store: memStore(),
    actions: {
      sendRequest: async (s) => { calls.push(s.name); return { status: 'passed', summary: 'ok' }; },
      runBulk: async () => { await new Promise((r) => { release = r; }); return { status: 'failed', summary: 'slow' }; },
      runLoad: async () => ({ status: 'passed', summary: 'ok' }),
    },
  });
  const once = sched.create({ name: 'once', kind: 'request', request: { requestId: 'r' }, trigger: { type: 'once', at: new Date(Date.now() - 500).toISOString() } });
  assert.ok(once.state.nextRunAt);
  sched.tick();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(calls, ['once']);
  const after = sched.all().find((s) => s.id === once.id);
  assert.equal(after.state.nextRunAt, null, 'one-time schedule is not re-armed');
  assert.equal(after.history[0].status, 'passed');

  const iv = sched.create({ name: 'iv', kind: 'request', request: { requestId: 'r' }, trigger: { type: 'interval', every: 5, unit: 'minutes' } });
  const next = Date.parse(iv.state.nextRunAt);
  assert.ok(Math.abs(next - (Date.now() + 5 * 60e3)) < 2000);

  const bulk = sched.create({ name: 'bulk', kind: 'bulk', bulk: { collectionId: 'c' }, trigger: { type: 'manual' } });
  assert.equal(bulk.state.nextRunAt, null);
  const p1 = sched.execute(bulk.id);
  const p2 = await sched.execute(bulk.id); // still running -> skipped
  assert.equal(p2.status, 'skipped');
  release();
  assert.equal((await p1).status, 'failed');
  const h = sched.all().find((s) => s.id === bulk.id).history.map((x) => x.status);
  assert.deepEqual(h, ['failed', 'skipped']);
  assert.throws(() => sched.create({ name: 'bad', kind: 'request', request: { requestId: 'r' }, trigger: { type: 'interval', every: 1, unit: 'seconds' } }), /unit/);
});

test('reset stats zeroes counters and the timeline while the run continues', async () => {
  const { srv, port } = await listen((req, res) => res.end('ok'));
  let result;
  const run = new LoadRun({ config: { mode: 'rate', tps: 100, durationSec: 2.5 }, requests: [newRequest({ url: `http://127.0.0.1:${port}/` })], onFinish: (r) => { result = r; } });
  const done = run.start();
  await new Promise((r) => setTimeout(r, 1300));
  const before = run.total.count;
  run.resetStats();
  assert.equal(run.total.count, 0);
  await done;
  srv.close();
  assert.ok(before > 80, `before ${before}`);
  assert.ok(result.summary.count > 80 && result.summary.count < 150, `after reset ${result.summary.count}`);
  assert.ok(result.timeline[0].t >= 1, 'timeline restarts at the reset second');
  assert.ok(Math.abs(result.summary.rps - 100) < 15, `rps since reset ${result.summary.rps}`);
  assert.ok(result.timeline.some((p) => Array.isArray(p.heat) && p.s2 > 0));
});

test('YAML OpenAPI import and OpenAPI export round trip', () => {
  const yaml = `openapi: 3.0.1
info: {title: Shop, version: "2"}
servers: [{url: "https://shop.example.com/v2"}]
paths:
  /orders/{orderId}:
    parameters:
      - {name: orderId, in: path, required: true, schema: {type: string, example: A-1}}
    get:
      tags: [orders]
      summary: Get order
      responses: {'200': {description: ok}}
    delete:
      summary: Cancel order
      responses: {'204': {description: gone}}
`;
  const r = detectImport(yaml, 'shop.yaml');
  assert.equal(r.kind, 'collection');
  assert.match(r.source, /YAML/);
  assert.equal(r.collection.requests.length, 2);
  const spec = toOpenApi(r.collection);
  assert.deepEqual(Object.keys(spec.paths), ['/orders/{orderId}']);
  assert.deepEqual(Object.keys(spec.paths['/orders/{orderId}']).sort(), ['delete', 'get']);
  assert.equal(spec.servers[0].url, 'https://shop.example.com/v2');
  assert.ok(spec.paths['/orders/{orderId}'].delete.responses['204']);
  const again = fromOpenApi(parseYaml(toYaml(spec)));
  assert.equal(again.requests.length, 2);
});

test('CLI argument parsing', () => {
  const a = parseArgs(['run', 'file.yaml', '--tps', '50', '--duration=30s', '-H', 'A: 1', '-H', 'B: 2', '--threshold', 'p95<500', '--insecure', '-d', '{"x":1}']);
  assert.deepEqual(a._, ['run', 'file.yaml']);
  assert.equal(a.tps, '50');
  assert.equal(a.duration, '30s');
  assert.deepEqual(a.header, ['A: 1', 'B: 2']);
  assert.deepEqual(a.threshold, ['p95<500']);
  assert.equal(a.insecure, true);
  assert.equal(a.data, '{"x":1}');
  assert.equal(parseDuration('2m'), 120);
  assert.equal(parseDuration('500ms'), 0.5);
  assert.equal(parseDuration('15'), 15);
  assert.throws(() => parseDuration('soon'), /Invalid duration/);
});

test('server: auth, listeners on extra ports, schedules, concurrent runs and reset over HTTP', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apistorm-test-'));
  const srv = await startServer({ port: 7291, cbPort: 7292, dataDir: dir, user: 'u', password: 'p', quiet: true });
  const auth = { authorization: 'Basic ' + Buffer.from('u:p').toString('base64'), 'content-type': 'application/json' };
  const j = async (p, method = 'GET', body) => {
    const r = await fetch(`http://localhost:7291${p}`, { method, headers: auth, body: body ? JSON.stringify(body) : undefined });
    const d = await r.json();
    if (!r.ok) throw new Error(`${p} ${r.status} ${d.error}`);
    return d;
  };
  try {
    assert.equal((await fetch('http://localhost:7291/api/info')).status, 401);
    assert.equal((await fetch('http://localhost:7291/api/health')).status, 200);

    // extra listener with a default bin catches any path
    const l = await j('/api/listeners', 'POST', { name: 'partner', port: 7293, defaultBin: 'partner' });
    assert.equal(l.running, true);
    const r = await fetch('http://localhost:7293/any/path?x=1', { method: 'POST', body: '{"a":1}' });
    assert.equal(r.status, 200);
    const items = await j('/api/bins/partner/items');
    assert.equal(items[0].path, '/any/path');
    assert.equal(items[0].port, 7293);
    await j(`/api/listeners/${l.id}/stop`, 'POST');
    await assert.rejects(fetch('http://localhost:7293/x'));

    // two concurrent runs against the primary receiver + reset of one
    const ws = await j('/api/workspace');
    const col = ws.collections[0];
    const echo = col.requests.find((x) => x.name.startsWith('Local echo'));
    const target = { type: 'request', request: echo, collectionId: col.id };
    const a = await j('/api/runs', 'POST', { target, environmentId: ws.environments[0].id, config: { name: 'A', tps: 50, durationSec: 2 } });
    const b = await j('/api/runs', 'POST', { target, environmentId: ws.environments[0].id, config: { name: 'B', mode: 'vus', vus: 2, iterations: 30, durationSec: 0 } });
    assert.equal((await j('/api/runs')).active.length >= 1, true);
    await new Promise((res) => setTimeout(res, 900));
    await j(`/api/runs/${a.id}/reset`, 'POST');
    await new Promise((res) => setTimeout(res, 2000));
    const ra = await j(`/api/runs/${a.id}`);
    const rb = await j(`/api/runs/${b.id}`);
    assert.equal(ra.status, 'completed');
    assert.ok(ra.resetAtSec > 0.5);
    assert.ok(ra.summary.count < 100, `A after reset ${ra.summary.count}`);
    assert.equal(rb.summary.count, 30);

    // schedule a bulk send and run it now
    const s = await j('/api/schedules', 'POST', { name: 'bulk', kind: 'bulk', bulk: { collectionId: col.id, requestIds: [echo.id], iterations: 20, concurrency: 4 }, environmentId: ws.environments[0].id, trigger: { type: 'manual' } });
    await j(`/api/schedules/${s.id}/run`, 'POST');
    let hist = [];
    for (let i = 0; i < 40 && !hist.length; i++) { await new Promise((res) => setTimeout(res, 100)); hist = (await j('/api/schedules')).find((x) => x.id === s.id).history; }
    assert.equal(hist[0].status, 'passed');
    assert.ok(hist[0].runId);

    await j('/api/runs', 'DELETE');
    assert.equal((await j('/api/runs')).runs.length, 0);
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

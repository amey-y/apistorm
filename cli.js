#!/usr/bin/env node
/*
 * ApiStorm command line.
 *   apistorm serve                     start the web UI (default command)
 *   apistorm run   [target] [options]  headless load test / bulk send (CI friendly exit codes)
 *   apistorm send  <curl|url> [opts]   send one request and print the response
 *   apistorm convert <file> --to fmt   convert between cURL / Postman / OpenAPI / HAR / ApiStorm / k6
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import { startServer, VERSION, ROOT } from './server/app.js';
import { Store } from './server/store.js';
import { LoadRun, DEFAULT_RUN_CONFIG } from './server/runner.js';
import { CallbackHub } from './server/callbacks.js';
import { parseCurl, toCurl } from './server/converters/curl.js';
import { detectImport } from './server/converters/detect.js';
import { toPostman } from './server/converters/postman.js';
import { toOpenApi } from './server/converters/openapi.js';
import { toK6 } from './server/converters/k6.js';
import { buildContext, newRequest, prepareRequest, normalizeRequest } from './server/prepare.js';
import { sendHttp } from './server/http-client.js';
import { executeRequest } from './server/pipeline.js';
import { TokenStore } from './server/auth.js';
import { varsToObject } from './server/template.js';
import { renderReport } from './server/report.js';
import { parseCsv } from './server/util.js';
import { toYaml } from './server/yaml.js';

/* ------------------------------------------------------------- arguments */

const BOOLEAN = new Set(['fail-on-error', 'help', 'version', 'quiet', 'q', 'insecure', 'k', 'no-keepalive', 'no-redirects', 'track-callbacks', 'save', 'include', 'i', 'verbose', 'data-random', 'json-output', 'resolve']);
const REPEAT = new Set(['header', 'H', 'var', 'threshold', 'request', 'stage']);
const ALIAS = { X: 'method', H: 'header', d: 'data', o: 'out', q: 'quiet', k: 'insecure', i: 'include', h: 'help', v: 'version', e: 'env' };

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    let m = /^--([^=]+)(?:=(.*))?$/.exec(a) || /^-([A-Za-z])$/.exec(a);
    if (!m) { out._.push(a); continue; }
    let key = m[1];
    let val = m[2];
    key = ALIAS[key] || key;
    if (BOOLEAN.has(key) || BOOLEAN.has(m[1])) { out[key] = val === undefined ? true : !/^(false|0|no)$/i.test(val); continue; }
    if (val === undefined) { val = argv[i + 1]; i++; }
    if (val === undefined) throw usage(`Missing value for --${key}`);
    if (REPEAT.has(key) || REPEAT.has(m[1])) (out[key] ||= []).push(val); else out[key] = val;
  }
  return out;
}

function usage(msg) { return Object.assign(new Error(msg), { usage: true }); }

/** "30" / "30s" / "2m" / "1h" / "500ms" -> seconds */
export function parseDuration(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(String(v).trim());
  if (!m) throw usage(`Invalid duration "${v}" (use e.g. 30s, 5m, 1h)`);
  const n = Number(m[1]);
  return { ms: n / 1000, s: n, m: n * 60, h: n * 3600 }[(m[2] || 's').toLowerCase()];
}
const ms = (v) => (v === undefined ? undefined : Math.round(parseDuration(v) * 1000));
const num = (v) => (v === undefined ? undefined : Number(v));

function env(name, def) { return process.env[name] ?? def; }

const HELP = `ApiStorm ${VERSION} - REST client, load tester and callback receiver

Usage:
  apistorm [serve] [--port 7070] [--host 127.0.0.1] [--cb-port 7071] [--cb-host 127.0.0.1]
                   [--data-dir ./data] [--user NAME --password SECRET]
  apistorm run [file] [target options] [load options] [output options]
  apistorm send <curl command | url> [-X METHOD] [-H "k: v"] [-d body] [--env file|name] [-i]
  apistorm convert <file> --to openapi|openapi-yaml|postman|apistorm|apistorm-yaml|curl|k6 [-o out]

Target options (run):
  [file]                     cURL file, Postman/OpenAPI(JSON|YAML)/HAR/ApiStorm collection
  --curl "<cmd>"             a single cURL command
  --url URL [-X M] [-H h] [-d body]
  --collection NAME|ID       a collection from the data directory
  --request NAME|ID          only these requests of the collection (repeatable)
  --preset NAME|ID           a saved load test (config + target + environment)
  --env FILE|NAME            environment (Postman/ApiStorm env file or a saved environment)
  --var key=value            variable override (repeatable)

Load options (run):
  --tps N --duration 30s --ramp 10s       fixed rate (open model)
  --stages "30s:10,1m:100,30s:0"          ramping rate profile
  --vus N [--iterations N] [--rate-limit N]  virtual users (closed model) / bulk send
  --max-in-flight N  --saturation drop|queue  --think 100ms  --jitter 50ms
  --timeout 10s  --no-keepalive  --insecure  --no-redirects
  --data-file rows.csv [--data-random]    feed {{column}} variables per iteration
  --threshold "p95<500" (repeatable)      metrics: p50 p90 p95 p99 avg max errorRate rps
  --abort-error-rate 50                   stop when more than 50% of requests fail
  --fail-on-error                         fail (exit 1) if any request fails
  --track-callbacks [--cb-port 7071] [--cb-base URL] [--callback-timeout 30s]

Output options (run):
  --report out.html  --json out.json  --csv out.csv  --save (store in the data dir / web UI)
  --quiet

Exit codes: 0 = passed, 1 = thresholds failed / test aborted / request failed, 2 = usage or setup error.
Environment variables: APISTORM_PORT APISTORM_HOST APISTORM_CB_PORT APISTORM_CB_HOST APISTORM_DATA
                       APISTORM_USER APISTORM_PASSWORD
`;

/* ------------------------------------------------------------------ main */

export async function main(argv = process.argv.slice(2)) {
  let args;
  try { args = parseArgs(argv); } catch (e) { console.error(e.message); return 2; }
  if (args.version) { console.log(VERSION); return 0; }
  const cmd = ['serve', 'run', 'send', 'convert', 'help'].includes(args._[0]) ? args._.shift() : (args.help ? 'help' : 'serve');
  try {
    if (cmd === 'help' || args.help) { console.log(HELP); return 0; }
    if (cmd === 'serve') return await serve(args);
    if (cmd === 'run') return await run(args);
    if (cmd === 'send') return await send(args);
    if (cmd === 'convert') return await convert(args);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    if (e.usage) console.error('Run "apistorm help" for usage.');
    return 2;
  }
  return 0;
}

async function serve(args) {
  const srv = await startServer({
    port: Number(args.port ?? env('APISTORM_PORT', 7070)),
    host: args.host ?? env('APISTORM_HOST', '127.0.0.1'),
    cbPort: Number(args['cb-port'] ?? env('APISTORM_CB_PORT', 7071)),
    cbHost: args['cb-host'] ?? env('APISTORM_CB_HOST', '127.0.0.1'),
    dataDir: args['data-dir'] ?? args.data ?? env('APISTORM_DATA', path.join(ROOT, 'data')),  // --data kept as an alias for serve
    user: args.user ?? env('APISTORM_USER'),
    password: args.password ?? env('APISTORM_PASSWORD'),
  });
  const shutdown = async () => { console.log('Shutting down...'); await srv.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return new Promise(() => {}); // run until signalled
}

/* ------------------------------------------------------------ workspace */

function dataStore(args) {
  const dir = path.resolve(args['data-dir'] ?? env('APISTORM_DATA', path.join(ROOT, 'data')));
  return new Store(dir);
}

function byNameOrId(list, key, what) {
  const found = list.find((x) => x.id === key) || list.find((x) => x.name === key) || list.find((x) => x.name?.toLowerCase() === String(key).toLowerCase());
  if (!found) throw usage(`${what} "${key}" not found. Available: ${list.map((x) => x.name).join(', ') || '(none)'}`);
  return found;
}

function loadEnvironment(args, store) {
  let environment = null;
  if (args.env) {
    if (fs.existsSync(args.env)) {
      const r = detectImport(fs.readFileSync(args.env, 'utf8'), args.env);
      if (r.kind !== 'environment') throw usage(`${args.env} is not an environment file`);
      environment = r.environment;
    } else environment = byNameOrId(store.get('environments', []), args.env, 'Environment');
  }
  const overrides = {};
  for (const v of args.var || []) {
    const i = v.indexOf('=');
    if (i < 1) throw usage(`--var expects key=value, got "${v}"`);
    overrides[v.slice(0, i)] = v.slice(i + 1);
  }
  return { environment, overrides, globals: store.get('globals', []) };
}

function requestFromFlags(args) {
  if (args.curl) return parseCurl(args.curl);
  if (!args.url) return null;
  const r = newRequest({ name: `${(args.method || (args.data ? 'POST' : 'GET')).toUpperCase()} ${args.url}`, method: (args.method || (args.data ? 'POST' : 'GET')).toUpperCase(), url: args.url, auth: { type: 'none' } });
  for (const h of args.header || []) { const i = h.indexOf(':'); if (i > 0) r.headers.push({ key: h.slice(0, i).trim(), value: h.slice(i + 1).trim(), enabled: true }); }
  if (args.data) {
    const json = /^\s*[[{]/.test(args.data);
    r.body = { ...r.body, mode: json ? 'json' : 'text', raw: args.data.startsWith('@') ? fs.readFileSync(args.data.slice(1), 'utf8') : args.data };
  }
  return r;
}

/** Resolve what to run: returns { requests, collection, presetConfig, presetEnvId } */
function resolveRunTarget(args, store) {
  const fromFlags = requestFromFlags(args);
  if (fromFlags) return { requests: [fromFlags], collection: null };
  if (args.preset) {
    const p = byNameOrId(store.get('presets', []), args.preset, 'Saved load test');
    const cols = store.get('collections', []);
    if (p.target?.type === 'collection') {
      const col = byNameOrId(cols, p.target.collectionId, 'Collection');
      const reqs = p.target.requestIds?.length ? p.target.requestIds.map((id) => col.requests.find((r) => r.id === id)).filter(Boolean) : col.requests;
      return { requests: reqs, collection: col, presetConfig: p.config, presetEnvId: p.environmentId };
    }
    return { requests: [p.target.request], collection: cols.find((c) => c.id === p.target.collectionId) || null, presetConfig: p.config, presetEnvId: p.environmentId };
  }
  let collection = null;
  const file = args._[0];
  if (file) {
    if (!fs.existsSync(file)) throw usage(`File not found: ${file}`);
    const r = detectImport(fs.readFileSync(file, 'utf8'), file);
    if (r.kind === 'request') return { requests: [r.request], collection: null };
    if (r.kind === 'workspace') {
      if (!args.collection) throw usage('This is a workspace backup: choose a collection with --collection NAME');
      collection = byNameOrId(r.data.collections, args.collection, 'Collection');
    } else if (r.kind === 'collection') collection = r.collection;
    else throw usage(`${file} contains an environment, not requests`);
  } else if (args.collection) collection = byNameOrId(store.get('collections', []), args.collection, 'Collection');
  else throw usage('Nothing to run. Pass a file, --curl, --url, --collection or --preset.');
  let requests = collection.requests;
  if (args.request?.length) requests = args.request.map((k) => byNameOrId(collection.requests, k, 'Request'));
  if (!requests.length) throw usage('The collection has no requests');
  return { requests, collection };
}

function configFromFlags(args, base = {}) {
  const c = { ...DEFAULT_RUN_CONFIG, thresholds: [], ...base, data: { ...DEFAULT_RUN_CONFIG.data, ...(base.data || {}) } };
  const set = (k, v) => { if (v !== undefined && !Number.isNaN(v)) c[k] = v; };
  if (args.vus || args.iterations) c.mode = 'vus';
  if (args.tps || args.stages) c.mode = 'rate';
  set('tps', num(args.tps));
  set('durationSec', parseDuration(args.duration));
  set('rampUpSec', parseDuration(args.ramp));
  set('vus', num(args.vus));
  set('iterations', num(args.iterations));
  set('rateLimit', num(args['rate-limit']));
  set('maxInFlight', num(args['max-in-flight']));
  set('maxIterations', num(args['max-iterations']));
  set('thinkTimeMs', ms(args.think));
  set('thinkJitterMs', ms(args.jitter));
  set('timeoutMs', ms(args.timeout));
  set('abortOnErrorRatePct', num(args['abort-error-rate']));
  set('callbackTimeoutMs', ms(args['callback-timeout']));
  if (args.saturation) c.saturation = args.saturation;
  if (args.name) c.name = args.name;
  if (args['no-keepalive']) c.keepAlive = false;
  if (args.insecure) c.insecure = true;
  if (args['no-redirects']) c.followRedirects = false;
  if (args['track-callbacks']) c.trackCallbacks = true;
  if (c.mode === 'vus' && args.iterations && !args.duration) c.durationSec = 0;
  const stages = (args.stages || args.stage || []).flatMap((s) => String(s).split(','));
  if (stages.length) {
    c.useStages = true;
    c.stages = stages.map((s) => {
      const [d, t] = s.split(':');
      if (t === undefined) throw usage(`Stage "${s}" must look like 30s:100 (duration:target TPS)`);
      return { durationSec: parseDuration(d), tps: Number(t) };
    });
  }
  if (args['data-file']) {
    const text = fs.readFileSync(args['data-file'], 'utf8');
    c.data = { rows: /\.json$/i.test(args['data-file']) ? JSON.parse(text) : parseCsv(text), mode: args['data-random'] ? 'random' : 'sequential' };
    if (!c.data.rows.length) throw usage(`No rows in ${args['data-file']}`);
  }
  if (args['fail-on-error']) c.thresholds.push({ metric: 'errorRate', op: '<=', value: 0 });
  for (const t of args.threshold || []) {
    const m = /^\s*(p\d+|avg|max|min|errorRate|error_rate|rps|cbP95)\s*(<=|>=|<|>)\s*([\d.]+)\s*%?\s*$/i.exec(t);
    if (!m) throw usage(`Invalid threshold "${t}" (e.g. "p95<500", "errorRate<1")`);
    c.thresholds.push({ metric: m[1].replace(/error_rate/i, 'errorRate'), op: m[2], value: Number(m[3]) });
  }
  return c;
}

/* ------------------------------------------------------------------- run */

const fmtN = (n, d = 0) => (n == null ? '-' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d }));
const fmtMs = (n) => (n == null ? '-' : n < 10 ? `${n.toFixed(2)}ms` : n < 1000 ? `${Math.round(n)}ms` : `${(n / 1000).toFixed(2)}s`);

async function run(args) {
  const store = dataStore(args);
  const target = resolveRunTarget(args, store);
  const { environment: envFromArgs, overrides, globals } = loadEnvironment(args, store);
  const environment = envFromArgs || (target.presetEnvId ? store.get('environments', []).find((e) => e.id === target.presetEnvId) : null);
  const config = configFromFlags(args, target.presetConfig);
  if (!config.name) config.name = `${target.collection?.name || target.requests[0].name} (cli)`;
  // --var overrides beat everything: inject them as the highest-priority collection variables
  const collection = target.collection ? { ...target.collection } : { variables: [] };
  const envWithOverrides = { ...(environment || {}), variables: [...(environment?.variables || []), ...Object.entries(overrides).map(([key, value]) => ({ key, value, enabled: true }))] };

  // optional callback receiver for --track-callbacks
  let hub = null, cbServer = null;
  let callbackBase = args['cb-base'] || '';
  if (config.trackCallbacks) {
    const mem = new Map();
    hub = new CallbackHub({ store: { get: (k, d) => (mem.has(k) ? mem.get(k) : d), set: (k, v) => mem.set(k, v) }, emit: () => {} });
    const port = Number(args['cb-port'] ?? 7071);
    cbServer = http.createServer((req, res) => hub.handle(req, res).catch(() => {}));
    await new Promise((resolve, reject) => { cbServer.once('error', reject); cbServer.listen(port, args['cb-host'] || '0.0.0.0', resolve); });
    if (!callbackBase) callbackBase = `http://localhost:${port}`;
  }

  const quiet = !!args.quiet;
  const tty = process.stdout.isTTY;
  let lastLine = 0;
  const emitFn = (type, p) => {
    if (quiet || type !== 'run-progress') return;
    const s = p.summary;
    const line = `[${fmtN(p.elapsedSec, 0).padStart(4)}s/${fmtN(p.plannedSec, 0)}s] ${fmtN(p.live.currentRps).padStart(6)} req/s | total ${fmtN(s.count)} | failed ${fmtN(s.errorRate, 2)}% | p50 ${fmtMs(s.latency.p50)} p95 ${fmtMs(s.latency.p95)} p99 ${fmtMs(s.latency.p99)} | in-flight ${p.live.inFlight}${p.live.dropped ? ` | dropped ${fmtN(p.live.dropped)}` : ''}${p.callbacks.tracked ? ` | callbacks ${p.callbacks.received}/${p.callbacks.tracked}` : ''}`;
    if (tty) process.stdout.write(`\r${line.padEnd(lastLine)}`);
    else if (Math.floor(p.elapsedSec) % 5 === 0) console.log(line);
    lastLine = line.length;
  };

  let result;
  const runner = new LoadRun({
    config, requests: target.requests, collection, environment: envWithOverrides, globals, callbackBase, hub, emit: emitFn, source: 'cli', tokens: new TokenStore(null),
    onFinish: (r) => { result = r; },
  });
  if (!quiet) {
    const what = config.mode === 'vus' ? `${config.vus} VUs${config.iterations ? `, ${config.iterations} iterations` : ''}${config.durationSec ? `, ${config.durationSec}s` : ''}` : config.useStages ? `stages ${config.stages.map((s) => `${s.durationSec}s:${s.tps}`).join(',')}` : `${config.tps} TPS for ${config.durationSec}s${config.rampUpSec ? ` (+${config.rampUpSec}s ramp-up)` : ''}`;
    console.log(`ApiStorm ${VERSION}: "${config.name}" - ${target.requests.length} request(s) per iteration - ${what}`);
  }
  let interrupts = 0;
  const onSig = () => { interrupts++; runner.stop(interrupts > 1 ? 'Aborted by user' : 'Stopped by user'); if (interrupts > 1) runner.stop(); if (!quiet) console.log(interrupts > 1 ? '\nForce stopping…' : '\nStopping… (Ctrl+C again to abort in-flight requests)'); };
  process.on('SIGINT', onSig);
  await runner.start();
  process.off('SIGINT', onSig);
  if (cbServer) { cbServer.close(); clearInterval(hub.sweeper); }
  if (tty && !quiet) process.stdout.write('\n');

  printSummary(result, quiet);
  if (args.report) { fs.writeFileSync(args.report, renderReport(result)); if (!quiet) console.log(`HTML report: ${path.resolve(args.report)}`); }
  if (args.json) { fs.writeFileSync(args.json, JSON.stringify(result, null, 2)); if (!quiet) console.log(`JSON result: ${path.resolve(args.json)}`); }
  if (args.csv) {
    const cols = ['t', 'started', 'completed', 'failed', 'dropped', 'target', 'inFlight', 'avg', 'p50', 'p95', 'p99', 'max', 's2', 's3', 's4', 's5', 'err'];
    fs.writeFileSync(args.csv, [cols.join(','), ...result.timeline.map((p) => cols.map((c) => p[c] ?? '').join(','))].join('\n'));
    if (!quiet) console.log(`CSV timeline: ${path.resolve(args.csv)}`);
  }
  if (args.save) saveToWorkspace(store, result, quiet);
  store.flushAll();
  const ok = result.passed && result.status === 'completed';
  if (!quiet) console.log(ok ? '\n✔ PASSED' : `\n✖ FAILED (${result.status !== 'completed' ? result.status + (result.reason ? `: ${result.reason}` : '') : 'thresholds not met'})`);
  return ok ? 0 : 1;
}

function printSummary(r, quiet) {
  if (quiet) { console.log(JSON.stringify({ status: r.status, passed: r.passed, count: r.summary.count, rps: r.summary.rps, errorRate: r.summary.errorRate, latency: r.summary.latency, thresholds: r.thresholds })); return; }
  const s = r.summary;
  const L = s.latency;
  console.log(`\n  requests ........ ${fmtN(s.count)} in ${fmtN(r.elapsedSec, 1)}s (${fmtN(s.rps, 1)} req/s)`);
  console.log(`  failed .......... ${fmtN(s.failed)} (${fmtN(s.errorRate, 2)}%)${s.netErrors ? `, ${fmtN(s.netErrors)} network errors` : ''}`);
  console.log(`  latency ......... avg ${fmtMs(L.avg)}  p50 ${fmtMs(L.p50)}  p90 ${fmtMs(L.p90)}  p95 ${fmtMs(L.p95)}  p99 ${fmtMs(L.p99)}  max ${fmtMs(L.max)}`);
  if (r.live?.dropped) console.log(`  dropped ......... ${fmtN(r.live.dropped)} iterations (max in-flight reached)`);
  console.log(`  status codes .... ${Object.entries(s.status).map(([k, v]) => `${k}: ${fmtN(v)}`).join('  ')}`);
  if (r.callbacks?.tracked) console.log(`  callbacks ....... ${r.callbacks.received}/${r.callbacks.tracked} received, ${r.callbacks.timeouts} timed out, p95 ${fmtMs(r.callbacks.latency.p95)}`);
  if (r.perRequest.length > 1) {
    console.log('\n  per request:');
    for (const p of r.perRequest) console.log(`    ${p.name.slice(0, 40).padEnd(40)} ${fmtN(p.count).padStart(8)}  failed ${fmtN(p.errorRate, 2).padStart(6)}%  p95 ${fmtMs(p.latency.p95).padStart(8)}`);
  }
  const errs = Object.entries(s.errors || {}).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (errs.length) { console.log('\n  top errors:'); for (const [m, n] of errs) console.log(`    ${fmtN(n).padStart(6)}  ${m}`); }
  if (r.thresholds?.length) {
    console.log('\n  thresholds:');
    for (const t of r.thresholds) console.log(`    ${t.pass ? '✔' : '✖'} ${t.metric} ${t.op} ${t.value}  (actual ${fmtN(t.actual, 2)})`);
  }
}

function saveToWorkspace(store, result, quiet) {
  const dir = path.join(store.dir, 'runs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${result.id}.json`), JSON.stringify(result));
  const idx = store.get('runs-index', []).filter((x) => x.id !== result.id);
  idx.unshift({
    id: result.id, name: result.name, status: result.status, reason: result.reason, startedAt: result.startedAt, endedAt: result.endedAt, elapsedSec: result.elapsedSec,
    mode: result.config?.mode, target: result.target?.collection || result.target?.requests?.[0]?.name, environment: result.target?.environment, source: 'cli',
    count: result.summary.count, rps: result.summary.rps, errorRate: result.summary.errorRate, p50: result.summary.latency.p50, p95: result.summary.latency.p95, p99: result.summary.latency.p99,
    passed: result.passed, thresholds: result.thresholds.length,
  });
  store.set('runs-index', idx, { immediate: true });
  if (!quiet) console.log(`Saved to the workspace (${store.dir}); it appears in the Runs tab of the web UI.`);
}

/* ------------------------------------------------------------------ send */

async function send(args) {
  const store = dataStore(args);
  const first = args._[0];
  let req;
  if (first && /^curl(\.exe)?\s/i.test(first)) req = parseCurl(first);
  else if (first && fs.existsSync(first)) {
    const r = detectImport(fs.readFileSync(first, 'utf8'), first);
    if (r.kind === 'request') req = r.request;
    else if (r.kind === 'collection') req = args.request?.length ? byNameOrId(r.collection.requests, args.request[0], 'Request') : r.collection.requests[0];
    else throw usage(`${first} does not contain a request`);
  } else if (first) req = requestFromFlags({ ...args, url: first });
  else req = requestFromFlags(args);
  if (!req) throw usage('Pass a cURL command, URL or file to send');
  req = normalizeRequest(req);
  if (args.method) req.method = args.method.toUpperCase();
  if (args.insecure) req.settings.insecure = true;
  const { environment, overrides, globals } = loadEnvironment(args, store);
  const scopes = { local: { ...overrides }, data: {}, env: varsToObject(environment?.variables), collection: {}, globals: varsToObject(globals) };
  const r = await executeRequest(req, {
    collection: null, scopes, callbackBase: args['cb-base'] || 'http://localhost:7071', tokens: new TokenStore(null),
    send: { timeoutMs: ms(args.timeout) || req.settings.timeoutMs, followRedirects: !args['no-redirects'], insecure: req.settings.insecure, captureBody: true },
    onPrepared: (prep) => { if (args.verbose) console.error(`> ${toCurl(prep, { multiline: false })}`); },
  });
  for (const sc of [...r.scripts.pre, ...r.scripts.post]) for (const l of sc.logs) console.error(`[${sc.source} script] ${l.text}`);
  const res = r.res;
  if (r.skipped) { console.error('Request skipped by the pre-request script'); return 0; }
  if (!res || res.error) { console.error(`✖ ${res?.error || r.error}`); return 1; }
  const body = r.bodyText;
  const checks = r.checks;
  console.error(`${res.status} ${res.statusText}  ${res.timings.total} ms  ${res.bytesIn} bytes`);
  if (args.include) for (const [k, v] of res.headerPairs) console.log(`${k}: ${v}`);
  if (args.include) console.log('');
  let out = body;
  if (/json/i.test(res.headers['content-type'] || '')) { try { out = JSON.stringify(JSON.parse(body), null, 2); } catch { /* raw */ } }
  if (args.out) fs.writeFileSync(args.out, res.body || ''); else process.stdout.write(out + (out.endsWith('\n') ? '' : '\n'));
  for (const c of checks) console.error(`${c.pass ? '✔' : '✖'} ${c.name}${c.pass ? '' : ` (${c.error || `actual: ${c.actual}`})`}`);
  return res.status < 400 && checks.every((c) => c.pass) ? 0 : 1;
}

/* --------------------------------------------------------------- convert */

async function convert(args) {
  const file = args._[0];
  if (!file) throw usage('Pass a file to convert');
  const text = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
  const r = detectImport(text, file);
  let col;
  if (r.kind === 'collection') col = r.collection;
  else if (r.kind === 'request') col = { name: r.request.name, variables: [], auth: { type: 'none' }, requests: [r.request] };
  else if (r.kind === 'workspace') col = args.collection ? byNameOrId(r.data.collections, args.collection, 'Collection') : r.data.collections[0];
  else throw usage('Environments cannot be converted with this command');
  const to = (args.to || '').toLowerCase();
  let out;
  if (to === 'openapi') out = JSON.stringify(toOpenApi(col), null, 2);
  else if (to === 'openapi-yaml' || to === 'yaml') out = toYaml(toOpenApi(col)) + '\n';
  else if (to === 'postman') out = JSON.stringify(toPostman(col), null, 2);
  else if (to === 'apistorm') out = JSON.stringify({ format: 'apistorm-collection', version: 1, collection: col }, null, 2);
  else if (to === 'apistorm-yaml') out = toYaml({ format: 'apistorm-collection', version: 1, collection: col }) + '\n';
  else if (to === 'curl') out = col.requests.map((q) => `# ${q.name}\n${toCurl(prepareRequest(q, { raw: true }, col))}`).join('\n\n') + '\n';
  else if (to === 'k6') out = toK6({ name: col.name, requests: col.requests, collection: col, config: configFromFlags(args) });
  else throw usage('--to must be one of: openapi, openapi-yaml, postman, apistorm, apistorm-yaml, curl, k6');
  if (args.out) { fs.writeFileSync(args.out, out); console.error(`Wrote ${col.requests.length} request(s) to ${args.out}`); }
  else process.stdout.write(out);
  return 0;
}

// run when executed directly (also via npm bin / docker entrypoint)
const self = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  main().then((code) => { if (code !== undefined) process.exit(code); });
}

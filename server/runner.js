import { createAgents, destroyAgents } from './http-client.js';
import { preparedContains, normalizeRequest } from './prepare.js';
import { varsToObject } from './template.js';
import { executeRequest, needsBodyFor, hasScripts, correlationValue } from './pipeline.js';
import { createScriptContext } from './scripting.js';
import { Histogram, Metrics, SecondBucket, HEAT_EDGES } from './stats.js';
import { sleep, uuid } from './util.js';

export const DEFAULT_RUN_CONFIG = {
  name: '',
  mode: 'rate',            // rate = open model (fixed TPS), vus = closed model (virtual users)
  tps: 10,
  startTps: 0,
  durationSec: 30,
  rampUpSec: 0,
  useStages: false,
  stages: [],              // [{durationSec, tps}] (rate) - linear ramps between targets
  vus: 10,
  iterations: 0,           // total iterations limit (0 = until duration)
  maxIterations: 0,        // rate mode: stop after N iterations (0 = no cap)
  rateLimit: 0,            // vus mode: max iterations/sec across all VUs (0 = unlimited)
  thinkTimeMs: 0,
  thinkJitterMs: 0,
  maxInFlight: 200,        // throttle: max concurrent iterations (rate mode)
  saturation: 'drop',      // drop | queue (what to do when maxInFlight is reached)
  timeoutMs: 30000,
  keepAlive: true,
  insecure: false,
  followRedirects: true,
  abortOnErrorRatePct: 0,
  abortMinSamples: 100,
  gracefulStopSec: 10,
  thresholds: [],          // [{metric: p95|p99|avg|max|errorRate|rps, op: '<'|'>', value}]
  data: { rows: [], mode: 'sequential' },
  trackCallbacks: false,
  callbackTimeoutMs: 30000,
  failedSamples: 25,
};

const r2 = (x) => Math.round(x * 100) / 100;

function rateStages(cfg) {
  if (cfg.useStages && Array.isArray(cfg.stages) && cfg.stages.length) {
    return { start: Number(cfg.startTps) || 0, stages: cfg.stages.map((s) => ({ d: Math.max(0.001, Number(s.durationSec) || 0), r: Math.max(0, Number(s.tps) || 0) })) };
  }
  const tps = Math.max(0, Number(cfg.tps) || 0);
  const stages = [];
  if (Number(cfg.rampUpSec) > 0) stages.push({ d: Number(cfg.rampUpSec), r: tps });
  stages.push({ d: Math.max(0.001, Number(cfg.durationSec) || 0), r: tps });
  return { start: Number(cfg.rampUpSec) > 0 ? Number(cfg.startTps) || 0 : tps, stages };
}

/** Expected number of arrivals between 0 and t seconds (piecewise linear rate). */
export function cumulativeArrivals(plan, t) {
  let acc = 0, r0 = plan.start;
  for (const s of plan.stages) {
    if (t <= s.d) return acc + r0 * t + ((s.r - r0) * t * t) / (2 * s.d);
    acc += ((r0 + s.r) / 2) * s.d;
    t -= s.d;
    r0 = s.r;
  }
  return acc;
}

export function rateAt(plan, t) {
  let r0 = plan.start;
  for (const s of plan.stages) {
    if (t <= s.d) return r0 + ((s.r - r0) * t) / s.d;
    t -= s.d; r0 = s.r;
  }
  return r0;
}

export const planDuration = (plan) => plan.stages.reduce((a, s) => a + s.d, 0);

export class LoadRun {
  /**
   * opts: { config, requests, collection, environment, globals, callbackBase, hub, emit(type, payload), onFinish(result) }
   */
  constructor(opts) {
    this.id = opts.id || uuid();
    this.config = { ...DEFAULT_RUN_CONFIG, ...opts.config, data: { ...DEFAULT_RUN_CONFIG.data, ...(opts.config?.data || {}) } };
    this.requests = opts.requests.map(normalizeRequest).filter((r) => (r.protocol || 'http') === 'http');
    if (!this.requests.length) throw Object.assign(new Error('Nothing to run: no HTTP requests selected (WebSocket, SSE and gRPC requests cannot be load tested yet)'), { status: 400 });
    this.collection = opts.collection;
    this.environment = opts.environment;
    this.globals = opts.globals;
    this.callbackBase = opts.callbackBase;
    this.hub = opts.hub;
    this.emit = opts.emit || (() => {});
    this.onFinish = opts.onFinish || (() => {});
    this.source = opts.source || null; // e.g. "schedule: Nightly smoke" or "cli"

    this.status = 'pending';
    this.phase = '';
    this.reason = '';
    this.total = new Metrics('All requests');
    this.per = new Map(this.requests.map((r) => [r.id, new Metrics(r.name)]));
    this.iterations = { started: 0, completed: 0, failed: 0 };
    this.scheduled = 0; this.dropped = 0; this.inFlight = 0; this.inFlightMax = 0; this.backlog = 0;
    this.buckets = new Map();
    this.timeline = [];
    this.lastEmittedT = -1;
    this.samples = [];
    this.cb = { tracked: 0, received: 0, timeouts: 0, pending: 0, hist: new Histogram(), samples: [], statuses: {}, noId: 0 };
    this.stopRequested = false;
    this.hardStop = false;
    this.needBody = this.requests.map((r) => needsBodyFor(r, this.collection));
    this.tokens = opts.tokens || null;
    // run-scoped variables: scripts may change them (pm.environment.set …) for later iterations of this run only
    this.scopeVars = { env: varsToObject(this.environment?.variables), collection: varsToObject(this.collection?.variables), globals: varsToObject(this.globals) };
    this.scriptContext = this.requests.some((r) => hasScripts(r, this.collection)) ? createScriptContext() : null;
    if (this.config.mode === 'rate') this.plan = rateStages(this.config);
  }

  get elapsedSec() {
    if (!this.t0) return 0;
    return ((this.tEnd ?? performance.now()) - this.t0) / 1000;
  }

  /** Seconds covered by the current statistics (differs from elapsedSec after a reset). */
  get statsSec() {
    if (!this.t0) return 0;
    return ((this.tEnd ?? performance.now()) - (this.statsT0 ?? this.t0)) / 1000;
  }

  /** Zero all statistics and charts while the test keeps running (e.g. after warm-up). */
  resetStats() {
    this.total = new Metrics('All requests');
    for (const [id, m] of this.per) this.per.set(id, new Metrics(m.name));
    this.iterations = { started: 0, completed: 0, failed: 0 };
    this.dropped = 0;
    this.inFlightMax = this.inFlight;
    this.samples = [];
    this.timeline = [];
    this.buckets.clear();
    this.cb = { ...this.cb, tracked: this.cb.pending, received: 0, timeouts: 0, hist: new Histogram(), samples: [], statuses: {}, noId: 0 };
    this.statsT0 = performance.now();
    this.resets = (this.resets || 0) + 1;
    this.resetAtSec = r2(this.elapsedSec);
    this.timelineStartT = Math.floor(this.elapsedSec);
    this.lastEmittedT = Math.floor(this.elapsedSec) - 1;
    this.emit('run-reset', { id: this.id, resetAtSec: this.resetAtSec });
  }

  bucket(now = performance.now()) {
    const t = Math.max(0, Math.floor((now - this.t0) / 1000));
    let b = this.buckets.get(t);
    if (!b) { b = new SecondBucket(t); this.buckets.set(t, b); }
    return b;
  }

  finalizeBuckets(all = false) {
    const cur = Math.floor((performance.now() - this.t0) / 1000);
    const keys = [...this.buckets.keys()].sort((a, b) => a - b);
    for (const t of keys) {
      if (!all && t >= cur) continue;
      const b = this.buckets.get(t);
      if (this.plan) b.target = t < planDuration(this.plan) ? rateAt(this.plan, Math.min(t + 0.5, planDuration(this.plan))) : null;
      else if (this.config.rateLimit > 0) b.target = Number(this.config.rateLimit);
      this.buckets.delete(t);
      const fin = b.finalize();
      // the last second of a run is usually incomplete: flag it so charts don't show a fake drop
      if (all && (this.tEnd - this.t0) / 1000 < t + 1) fin.partial = true;
      // fill gaps (seconds where nothing happened) so charts stay continuous
      const lastT = this.timeline.length ? this.timeline[this.timeline.length - 1].t : (this.timelineStartT ?? 0) - 1;
      for (let g = lastT + 1; g < t; g++) {
        const gb = new SecondBucket(g);
        if (this.plan) gb.target = rateAt(this.plan, g + 0.5);
        this.timeline.push(gb.finalize());
      }
      this.timeline.push(fin);
    }
  }

  /* ------------------------------------------------------------ lifecycle */

  async start() {
    this.status = 'running';
    this.phase = 'running';
    this.startedAt = new Date().toISOString();
    this.t0 = performance.now();
    const conc = this.config.mode === 'rate' ? Number(this.config.maxInFlight) || 200 : Number(this.config.vus) || 1;
    this.agents = createAgents({ keepAlive: this.config.keepAlive !== false, maxSockets: Math.max(1, conc * Math.max(1, this.requests.length > 1 ? 1 : 1)) });
    this.ticker = setInterval(() => this.tick(), 1000);
    this.emit('run-started', { id: this.id, config: this.publicConfig(), startedAt: this.startedAt });
    try {
      if (this.config.mode === 'vus') await this.runVus();
      else await this.runRate();
      this.phase = 'draining';
      await this.drain();
      if (this.config.trackCallbacks && this.cb.pending > 0 && !this.hardStop) {
        this.phase = 'waiting for callbacks';
        const until = performance.now() + Number(this.config.callbackTimeoutMs || 30000) + 1000;
        while (this.cb.pending > 0 && performance.now() < until && !this.hardStop) await sleep(100);
      }
      if (this.status === 'running' || this.status === 'stopping') this.status = this.stopRequested ? 'stopped' : 'completed';
    } catch (e) {
      this.status = 'failed';
      this.reason = e.message;
    } finally {
      this.tEnd = performance.now();
      clearInterval(this.ticker);
      this.hub?.untrackRun(this.id);
      destroyAgents(this.agents);
      this.finalizeBuckets(true);
      this.endedAt = new Date().toISOString();
      this.phase = 'done';
      const result = this.result();
      this.emit('run-finished', this.progress(true));
      this.onFinish(result);
    }
  }

  stop(reason = 'Stopped by user') {
    if (this.status !== 'running') {
      // second stop request = hard stop (abort in-flight requests)
      if (this.status === 'stopping' || this.status === 'aborted') { this.hardStop = true; destroyAgents(this.agents); }
      return;
    }
    this.stopRequested = true;
    this.status = reason.startsWith('Aborted') ? 'aborted' : 'stopping';
    this.reason = reason;
  }

  async drain() {
    const grace = (Number(this.config.gracefulStopSec) || 10) * 1000;
    const until = performance.now() + (this.stopRequested ? grace : Math.max(grace, Number(this.config.timeoutMs) + 2000));
    while (this.inFlight > 0 && performance.now() < until && !this.hardStop) await sleep(20);
    if (this.inFlight > 0) { this.hardStop = true; destroyAgents(this.agents); }
    const until2 = performance.now() + 2000;
    while (this.inFlight > 0 && performance.now() < until2) await sleep(20);
  }

  /* ----------------------------------------------------------- schedulers */

  async runRate() {
    const plan = this.plan;
    const total = planDuration(plan);
    const maxIt = Number(this.config.maxIterations) || 0;
    const cap = Math.max(1, Number(this.config.maxInFlight) || 200);
    const queue = this.config.saturation === 'queue';
    while (!this.stopRequested) {
      const el = (performance.now() - this.t0) / 1000;
      const done = el >= total;
      const due = Math.floor(cumulativeArrivals(plan, Math.min(el, total)) + 1e-9);
      while (this.scheduled < due && !this.stopRequested) {
        if (maxIt && this.iterations.started + this.dropped >= maxIt) break;
        if (this.inFlight >= cap) {
          if (queue) break;
          this.scheduled++; this.dropped++; this.bucket().dropped++;
          continue;
        }
        this.scheduled++;
        this.launch(this.iterations.started, 0);
      }
      this.backlog = Math.max(0, due - this.scheduled);
      if (maxIt && this.iterations.started + this.dropped >= maxIt) break;
      if (done && (!queue || this.backlog === 0)) break;
      if (done && queue && el > total + Number(this.config.gracefulStopSec || 10)) { this.dropped += this.backlog; break; }
      await sleep(1);
    }
  }

  async runVus() {
    const cfg = this.config;
    const vus = Math.max(1, Number(cfg.vus) || 1);
    const dur = Number(cfg.durationSec) || 0;
    const iters = Number(cfg.iterations) || 0;
    if (!dur && !iters) throw new Error('Set a duration or a number of iterations');
    const ramp = Number(cfg.rampUpSec) || 0;
    const limit = Number(cfg.rateLimit) || 0;
    let nextSlot = performance.now();
    const takeToken = async () => {
      if (!limit) return;
      const nowT = performance.now();
      nextSlot = Math.max(nextSlot, nowT);
      const wait = nextSlot - nowT;
      nextSlot += 1000 / limit;
      if (wait > 0) await sleep(wait);
    };
    const deadline = dur ? this.t0 + (ramp + dur) * 1000 : Infinity;
    const vu = async (n) => {
      if (ramp) await sleep((ramp * 1000 * n) / vus);
      while (!this.stopRequested && performance.now() < deadline) {
        if (iters && this.scheduled >= iters) break;
        this.scheduled++;
        await takeToken();
        if (this.stopRequested || performance.now() >= deadline) { this.scheduled--; break; }
        await this.iteration(this.iterations.started, n + 1);
        const think = (Number(cfg.thinkTimeMs) || 0) + Math.random() * (Number(cfg.thinkJitterMs) || 0);
        if (think > 0) await sleep(think);
      }
    };
    await Promise.all(Array.from({ length: vus }, (_, i) => vu(i)));
  }

  launch(iterNo, vu) {
    this.iteration(iterNo, vu).catch(() => {});
  }

  /* ------------------------------------------------------------ iteration */

  dataRow(iterNo) {
    const rows = this.config.data?.rows || [];
    if (!rows.length) return null;
    if (this.config.data.mode === 'random') return rows[Math.floor(Math.random() * rows.length)];
    return rows[iterNo % rows.length];
  }

  async iteration(iterNo, vu) {
    this.iterations.started++;
    this.inFlight++;
    if (this.inFlight > this.inFlightMax) this.inFlightMax = this.inFlight;
    const b0 = this.bucket();
    b0.started++;
    if (this.inFlight > b0.inFlightMax) b0.inFlightMax = this.inFlight;
    const scopes = { local: {}, data: this.dataRow(iterNo) || {}, ...this.scopeVars };
    let iterFailed = false;
    try {
      let i = 0;
      let steps = 0;
      while (i < this.requests.length && steps++ < this.requests.length * 20) {
        if (this.hardStop) break;
        const req = this.requests[i];
        const m = this.per.get(req.id);
        let sentAt = performance.now();
        let r;
        try {
          r = await executeRequest(req, {
            collection: this.collection, scopes, iteration: iterNo, vu, callbackBase: this.callbackBase, tokens: this.tokens,
            scriptContext: this.scriptContext, scriptTimeoutMs: this.config.scriptTimeoutMs,
            send: {
              timeoutMs: Number(this.config.timeoutMs) || req.settings.timeoutMs,
              followRedirects: this.config.followRedirects !== false, insecure: this.config.insecure,
              agents: this.agents, origin: 'run', maxBodyBytes: 2 * 1024 * 1024,
              captureBody: this.needBody[i] || this.samples.length < (this.config.failedSamples ?? 25),
            },
            onPrepared: (prep, ctx) => {
              sentAt = performance.now();
              if (this.config.trackCallbacks && this.hub && req.callback?.correlateBy !== 'response' && ctx.requestId && preparedContains(prep, ctx.requestId)) this.trackCallback(ctx.requestId, req, sentAt);
            },
          });
        } catch (e) {
          r = { error: e.message, res: null, checks: [] };
        }
        if (r.skipped) { i++; continue; }
        const res = r.res || { status: 0, error: r.error || 'Request failed before sending', timings: {} };
        if (!r.res && r.error) res.error = r.error;
        const checks = r.checks || [];
        const hasStatusCheck = req.assertions.some((a) => a.enabled !== false && a.type === 'status');
        const failed = !!res.error || (!hasStatusCheck && res.status >= 400) || checks.some((c) => !c.pass);
        m.record(res, checks, failed);
        this.total.record(res, checks, failed);
        const b = this.bucket();
        b.completed++;
        b.bytesIn += res.bytesIn || 0;
        b.bytesOut += res.bytesOut || 0;
        b.addStatus(res.status, res.error);
        if (failed) b.failed++;
        if (!res.error && res.timings?.total != null) b.addLatency(res.timings.total);
        if (failed) { iterFailed = true; this.sample(req, r.prep, res, checks, r.bodyText); }
        // delivery reports / callbacks correlated by a value from the response (e.g. a message id)
        if (this.config.trackCallbacks && this.hub && req.callback?.correlateBy === 'response' && !res.error) {
          const v = correlationValue(req, res, r.bodyText);
          if (v) this.trackCallback(v, req, sentAt);
          else this.cb.noId = (this.cb.noId || 0) + 1;
        }
        if (res.error) break; // later steps usually depend on this one
        if (r.nextRequest !== undefined) {
          if (r.nextRequest === null) break;
          const j = this.requests.findIndex((x) => x.name === r.nextRequest || x.id === r.nextRequest);
          if (j >= 0) { i = j; continue; }
        }
        i++;
      }
    } finally {
      this.inFlight--;
      this.iterations.completed++;
      if (iterFailed) this.iterations.failed++;
    }
  }

  sample(req, prep, res, checks, bodyText = '') {
    if (this.samples.length >= (this.config.failedSamples ?? 25)) return;
    this.samples.push({
      at: new Date().toISOString(),
      t: r2(this.elapsedSec),
      request: req.name,
      method: prep?.method || req.method,
      url: prep?.url || req.url,
      status: res.status,
      error: res.error || null,
      timeMs: res.timings?.total ?? null,
      failedChecks: (checks || []).filter((c) => !c.pass),
      body: bodyText ? bodyText.slice(0, 2000) : '',
    });
  }

  trackCallback(requestId, req, sentAt) {
    this.cb.tracked++;
    this.cb.pending++;
    this.hub.track(requestId, {
      runId: this.id,
      sentAt,
      timeoutMs: Number(this.config.callbackTimeoutMs) || 30000,
      onMatch: (capture) => {
        this.cb.pending--;
        this.cb.received++;
        if (capture.cbStatus != null) { const k = String(capture.cbStatus).slice(0, 40); this.cb.statuses[k] = (this.cb.statuses[k] || 0) + 1; }
        const lat = performance.now() - sentAt;
        this.cb.hist.add(lat);
        this.bucket().cbReceived++;
        this.bucket().cbLat.push(lat);
        if (this.cb.samples.length < 10) this.cb.samples.push({ request: req.name, requestId, latencyMs: r2(lat), method: capture.method, path: capture.path, status: capture.cbStatus ?? null, body: (capture.body || '').slice(0, 1000) });
      },
      onTimeout: () => { this.cb.pending--; this.cb.timeouts++; },
    });
  }

  /* -------------------------------------------------------- reporting */

  tick() {
    this.finalizeBuckets(false);
    // safety valve: abort when the error rate is too high
    const pct = Number(this.config.abortOnErrorRatePct) || 0;
    if (pct > 0 && this.status === 'running' && this.total.count >= (Number(this.config.abortMinSamples) || 100)) {
      const rate = (this.total.failed / this.total.count) * 100;
      if (rate > pct) this.stop(`Aborted: error rate ${rate.toFixed(1)}% exceeded ${pct}%`);
    }
    this.emit('run-progress', this.progress(false));
  }

  publicConfig() {
    const c = { ...this.config, data: { mode: this.config.data.mode, rows: this.config.data.rows.length } };
    return c;
  }

  callbackSummary() {
    return { tracked: this.cb.tracked, received: this.cb.received, timeouts: this.cb.timeouts, pending: this.cb.pending, latency: this.cb.hist.summary(), statuses: this.cb.statuses, noId: this.cb.noId };
  }

  progress(full) {
    const el = this.elapsedSec;
    const lastFull = this.timeline[this.timeline.length - 1];
    const newPoints = this.timeline.filter((p) => p.t > this.lastEmittedT);
    if (!full && newPoints.length) this.lastEmittedT = newPoints[newPoints.length - 1].t;
    return {
      id: this.id,
      name: this.config.name,
      status: this.status,
      phase: this.phase,
      reason: this.reason,
      startedAt: this.startedAt,
      endedAt: this.endedAt || null,
      elapsedSec: r2(el),
      plannedSec: this.plan ? planDuration(this.plan) : (Number(this.config.durationSec) || 0) + (Number(this.config.rampUpSec) || 0),
      live: {
        inFlight: this.inFlight, inFlightMax: this.inFlightMax, scheduled: this.scheduled, dropped: this.dropped, backlog: this.backlog,
        iterations: this.iterations,
        currentRps: lastFull ? lastFull.completed : 0,
        targetRps: this.plan ? r2(rateAt(this.plan, el)) : (Number(this.config.rateLimit) || null),
      },
      summary: this.total.toJSON(this.statsSec),
      perRequest: [...this.per.values()].map((m) => m.toJSON(this.statsSec)),
      distribution: this.total.hist.distribution(),
      heatEdges: HEAT_EDGES,
      resetAtSec: this.resetAtSec ?? null,
      mode: this.config.mode,
      source: this.source || null,
      callbacks: this.callbackSummary(),
      timeline: full ? this.timeline : newPoints,
    };
  }

  evaluateThresholds(summary) {
    return (this.config.thresholds || []).filter((t) => t && t.metric && t.value !== '' && t.value != null).map((t) => {
      let actual;
      if (t.metric === 'errorRate') actual = summary.errorRate;
      else if (t.metric === 'rps') actual = summary.rps;
      else if (t.metric === 'cbP95') actual = this.cb.hist.summary().p95;
      else if (t.metric === 'cbTimeoutRate') actual = this.cb.tracked ? r2((this.cb.timeouts / this.cb.tracked) * 100) : 0;
      else actual = summary.latency[t.metric];
      const v = Number(t.value);
      const pass = actual == null ? false : t.op === '>' ? actual > v : t.op === '>=' ? actual >= v : t.op === '<=' ? actual <= v : actual < v;
      return { ...t, actual, pass };
    });
  }

  result() {
    const p = this.progress(true);
    const thresholds = this.evaluateThresholds(p.summary);
    return {
      ...p,
      config: this.publicConfig(),
      target: { requests: this.requests.map((r) => ({ id: r.id, name: r.name, method: r.method, url: r.url })), collection: this.collection?.name || null, environment: this.environment?.name || null },
      thresholds,
      passed: thresholds.every((t) => t.pass) && this.status !== 'failed',
      samples: this.samples,
      callbackSamples: this.cb.samples,
    };
  }
}

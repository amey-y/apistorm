/**
 * Log-bucketed latency histogram (constant memory, ~1% precision above 1 ms,
 * 10 microsecond precision below 1 ms). Exact min/max/mean.
 */
const SUB_MS = 100;            // buckets 0..99 = 0.00 .. 0.99 ms
const LOG_BASE = Math.log(1.01);
const SIZE = SUB_MS + 1800;    // covers up to ~ 1.01^1800 ms (way beyond any timeout)

export class Histogram {
  constructor() {
    this.buckets = new Uint32Array(SIZE);
    this.count = 0; this.sum = 0; this.min = Infinity; this.max = 0;
  }
  static index(ms) {
    if (ms < 1) return Math.max(0, Math.floor(ms * 100));
    return Math.min(SIZE - 1, SUB_MS + Math.floor(Math.log(ms) / LOG_BASE));
  }
  static value(i) {
    if (i < SUB_MS) return (i + 0.5) / 100;
    return Math.exp((i - SUB_MS + 0.5) * LOG_BASE);
  }
  add(ms) {
    this.buckets[Histogram.index(ms)]++;
    this.count++; this.sum += ms;
    if (ms < this.min) this.min = ms;
    if (ms > this.max) this.max = ms;
  }
  percentile(p) {
    if (!this.count) return null;
    const target = Math.max(1, Math.ceil((p / 100) * this.count));
    let acc = 0;
    for (let i = 0; i < SIZE; i++) {
      acc += this.buckets[i];
      if (acc >= target) return Math.min(this.max, Math.max(this.min, Histogram.value(i)));
    }
    return this.max;
  }
  summary() {
    const r = (x) => (x == null ? null : Math.round(x * 100) / 100);
    if (!this.count) return { count: 0, min: null, max: null, avg: null, p50: null, p75: null, p90: null, p95: null, p99: null, p999: null };
    return {
      count: this.count, min: r(this.min), max: r(this.max), avg: r(this.sum / this.count),
      p50: r(this.percentile(50)), p75: r(this.percentile(75)), p90: r(this.percentile(90)),
      p95: r(this.percentile(95)), p99: r(this.percentile(99)), p999: r(this.percentile(99.9)),
    };
  }
  /** Compact distribution for charts: [[upperMs, count], ...] non-empty buckets merged into ~40 bins */
  distribution(bins = 40) {
    if (!this.count) return [];
    const lo = Histogram.index(this.min), hi = Histogram.index(this.max);
    const step = Math.max(1, Math.ceil((hi - lo + 1) / bins));
    const out = [];
    for (let i = lo; i <= hi; i += step) {
      let c = 0;
      for (let j = i; j < Math.min(i + step, hi + 1); j++) c += this.buckets[j];
      out.push([Math.round(Histogram.value(Math.min(i + step - 1, hi)) * 100) / 100, c]);
    }
    return out;
  }
}

function percentileOfSorted(arr, p) {
  if (!arr.length) return null;
  const idx = Math.min(arr.length - 1, Math.max(0, Math.ceil((p / 100) * arr.length) - 1));
  return arr[idx];
}

/** Upper edges (ms) of the latency heatmap rows. The last row is "above the last edge". */
export const HEAT_EDGES = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];

/** Per-second time bucket used for the live charts. */
export class SecondBucket {
  constructor(t) {
    this.t = t; this.started = 0; this.completed = 0; this.failed = 0; this.dropped = 0;
    this.lat = []; this.bytesIn = 0; this.bytesOut = 0; this.cbReceived = 0; this.cbLat = []; this.inFlightMax = 0; this.target = 0;
    this.sc = { s2: 0, s3: 0, s4: 0, s5: 0, err: 0 };
    this.heat = new Array(HEAT_EDGES.length + 1).fill(0);
  }
  addLatency(ms) {
    this.lat.push(ms);
    let i = 0;
    while (i < HEAT_EDGES.length && ms > HEAT_EDGES[i]) i++;
    this.heat[i]++;
  }
  addStatus(status, error) {
    if (error || !status) this.sc.err++;
    else if (status < 300) this.sc.s2++;
    else if (status < 400) this.sc.s3++;
    else if (status < 500) this.sc.s4++;
    else this.sc.s5++;
  }
  finalize() {
    const s = this.lat.sort((a, b) => a - b);
    const r = (x) => (x == null ? null : Math.round(x * 100) / 100);
    const out = {
      t: this.t, started: this.started, completed: this.completed, failed: this.failed, dropped: this.dropped,
      bytesIn: this.bytesIn, bytesOut: this.bytesOut, cbReceived: this.cbReceived, inFlight: this.inFlightMax, target: this.target == null ? null : r(this.target),
      ...this.sc, heat: this.heat,
      cbP50: r(percentileOfSorted(this.cbLat.sort((a, b) => a - b), 50)), cbP95: r(percentileOfSorted(this.cbLat, 95)),
      avg: s.length ? r(s.reduce((a, b) => a + b, 0) / s.length) : null,
      p50: r(percentileOfSorted(s, 50)), p95: r(percentileOfSorted(s, 95)), p99: r(percentileOfSorted(s, 99)),
      max: s.length ? r(s[s.length - 1]) : null,
    };
    this.lat = null; this.cbLat = null;
    return out;
  }
}

/** Aggregated metrics for one request (or the whole run). */
export class Metrics {
  constructor(name) {
    this.name = name;
    this.hist = new Histogram();
    this.count = 0; this.failed = 0; this.netErrors = 0; this.httpErrors = 0; this.checkFailures = 0;
    this.status = {}; this.errors = {}; this.bytesIn = 0; this.bytesOut = 0;
    this.checks = {}; // name -> {pass, fail}
  }
  record(res, checkResults, failed) {
    this.count++;
    if (res.timings?.total != null && !res.error) this.hist.add(res.timings.total);
    this.bytesIn += res.bytesIn || 0; this.bytesOut += res.bytesOut || 0;
    const code = res.error ? 'ERR' : String(res.status);
    this.status[code] = (this.status[code] || 0) + 1;
    if (res.error) {
      this.netErrors++;
      const k = res.error.slice(0, 160);
      this.errors[k] = (this.errors[k] || 0) + 1;
    } else if (res.status >= 400) this.httpErrors++;
    for (const c of checkResults || []) {
      const e = (this.checks[c.name] ||= { pass: 0, fail: 0 });
      if (c.pass) e.pass++; else { e.fail++; this.checkFailures++; }
    }
    if (failed) this.failed++;
  }
  toJSON(elapsedSec) {
    return {
      name: this.name, count: this.count, failed: this.failed,
      netErrors: this.netErrors, httpErrors: this.httpErrors, checkFailures: this.checkFailures,
      errorRate: this.count ? Math.round((this.failed / this.count) * 10000) / 100 : 0,
      rps: elapsedSec > 0 ? Math.round((this.count / elapsedSec) * 100) / 100 : 0,
      latency: this.hist.summary(),
      status: this.status, errors: this.errors, checks: this.checks,
      bytesIn: this.bytesIn, bytesOut: this.bytesOut,
    };
  }
}

import { shortId } from './util.js';
import { parseCron, nextCron, describeCron } from './cron.js';

const httpError = (status, message) => Object.assign(new Error(message), { status });
const UNIT_MS = { minutes: 60e3, hours: 3600e3, days: 86400e3 };
const HISTORY_MAX = 50;

/**
 * Schedules run a single request, a bulk send (collection × iterations with concurrency)
 * or a load test, either once, on an interval or on a cron expression.
 *
 * schedule = {
 *   id, name, enabled, kind: 'request' | 'bulk' | 'loadtest', environmentId,
 *   request:  { collectionId, requestId },
 *   bulk:     { collectionId, requestIds[], iterations, concurrency, delayMs },
 *   loadtest: { presetId } | { config, target },
 *   trigger:  { type: 'once', at } | { type: 'interval', every, unit, startAt? } | { type: 'cron', cron },
 *   overlap: 'skip' | 'allow',
 *   notify: { webhookUrl, onlyOnFailure },
 *   state: { nextRunAt, lastRunAt, lastStatus, runCount, running }, history: [...]
 * }
 *
 * actions = { sendRequest(schedule) -> Promise<result>, runBulk(schedule) -> Promise<result>, runLoad(schedule) -> Promise<result> }
 * result  = { status: 'passed' | 'failed' | 'error', summary: string, runId?, details? }
 */
export class Scheduler {
  constructor({ store, emit = () => {}, actions, log = () => {} }) {
    this.store = store;
    this.emit = emit;
    this.actions = actions;
    this.log = log;
    this.running = new Map(); // id -> count of executions in progress
    this.timer = null;
  }

  all() { return this.store.get('schedules', []); }
  save(list) { this.store.set('schedules', list); this.emit('schedules-changed', {}); }
  get(id) { const s = this.all().find((x) => x.id === id); if (!s) throw httpError(404, 'Schedule not found'); return s; }

  list() {
    return this.all().map((s) => ({ ...s, state: { ...s.state, running: (this.running.get(s.id) || 0) > 0 }, triggerText: this.describe(s.trigger) }));
  }

  describe(t = {}) {
    if (t.type === 'once') return `once at ${new Date(t.at).toLocaleString()}`;
    if (t.type === 'interval') return `every ${t.every} ${t.unit || 'minutes'}`;
    if (t.type === 'cron') return `cron "${t.cron}": ${describeCron(t.cron)}`;
    return 'manual only';
  }

  validate(s) {
    if (!['request', 'bulk', 'loadtest'].includes(s.kind)) throw httpError(400, 'Kind must be request, bulk or loadtest');
    const t = s.trigger || {};
    if (t.type === 'once') { if (Number.isNaN(Date.parse(t.at))) throw httpError(400, 'Pick a valid date and time'); }
    else if (t.type === 'interval') {
      if (!(Number(t.every) > 0)) throw httpError(400, 'Interval must be greater than 0');
      if (!UNIT_MS[t.unit || 'minutes']) throw httpError(400, 'Interval unit must be minutes, hours or days');
      if (Number(t.every) * UNIT_MS[t.unit || 'minutes'] < 10e3) throw httpError(400, 'Interval must be at least 10 seconds');
    } else if (t.type === 'cron') { try { parseCron(t.cron); } catch (e) { throw httpError(400, e.message); } }
    else if (t.type !== 'manual') throw httpError(400, 'Trigger type must be once, interval, cron or manual');
    if (s.kind === 'request' && !s.request?.requestId) throw httpError(400, 'Choose a request');
    if (s.kind === 'bulk' && !s.bulk?.collectionId) throw httpError(400, 'Choose a collection');
    if (s.kind === 'loadtest' && !s.loadtest?.presetId && !s.loadtest?.target) throw httpError(400, 'Choose a saved load test');
    if (s.notify?.webhookUrl) { try { const u = new URL(s.notify.webhookUrl); if (!/^https?:$/.test(u.protocol)) throw new Error(); } catch { throw httpError(400, 'Notification webhook must be an http(s) URL'); } }
  }

  computeNext(s, from = new Date()) {
    const t = s.trigger || {};
    if (!s.enabled) return null;
    if (t.type === 'once') return s.state?.runCount ? null : new Date(t.at).toISOString();
    if (t.type === 'interval') {
      const step = Number(t.every) * UNIT_MS[t.unit || 'minutes'];
      const anchor = s.state?.lastRunAt ? Date.parse(s.state.lastRunAt) : t.startAt ? Date.parse(t.startAt) : from.getTime();
      let next = s.state?.lastRunAt || !t.startAt ? anchor + step : anchor;
      if (next < from.getTime()) next = from.getTime() + (step - ((from.getTime() - anchor) % step));
      return new Date(next).toISOString();
    }
    if (t.type === 'cron') return nextCron(t.cron, from)?.toISOString() || null;
    return null;
  }

  create(data) {
    const s = {
      id: shortId(),
      name: String(data.name || 'Untitled schedule').slice(0, 120),
      enabled: data.enabled !== false,
      kind: data.kind,
      environmentId: data.environmentId || null,
      request: data.request || null,
      bulk: data.bulk || null,
      loadtest: data.loadtest || null,
      trigger: data.trigger || { type: 'manual' },
      overlap: data.overlap || 'skip',
      notify: data.notify || { webhookUrl: '', onlyOnFailure: false },
      state: { nextRunAt: null, lastRunAt: null, lastStatus: null, runCount: 0 },
      history: [],
      createdAt: new Date().toISOString(),
    };
    this.validate(s);
    s.state.nextRunAt = this.computeNext(s);
    this.save([...this.all(), s]);
    return s;
  }

  update(id, data) {
    const list = this.all();
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) throw httpError(404, 'Schedule not found');
    const s = { ...list[i], ...data, id, state: list[i].state, history: list[i].history };
    this.validate(s);
    // editing a one-time schedule re-arms it
    if (s.trigger.type === 'once' && JSON.stringify(s.trigger) !== JSON.stringify(list[i].trigger)) s.state = { ...s.state, runCount: 0 };
    s.state = { ...s.state, nextRunAt: this.computeNext(s) };
    list[i] = s;
    this.save(list);
    return s;
  }

  remove(id) { this.save(this.all().filter((x) => x.id !== id)); }

  clearHistory(id) {
    const list = this.all();
    const s = list.find((x) => x.id === id);
    if (s) { s.history = []; this.save(list); }
  }

  start() {
    // re-arm after a restart; one-time schedules that were missed while the server was down are marked
    const list = this.all();
    const now = Date.now();
    for (const s of list) {
      if (s.enabled && s.trigger?.type === 'once' && !s.state?.runCount && Date.parse(s.trigger.at) < now - 60e3) {
        s.state = { ...s.state, lastStatus: 'missed', nextRunAt: null };
        s.enabled = false;
        s.history = [{ at: new Date().toISOString(), status: 'missed', summary: 'Server was not running at the scheduled time' }, ...(s.history || [])].slice(0, HISTORY_MAX);
      } else s.state = { ...s.state, nextRunAt: this.computeNext(s) };
    }
    this.save(list);
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); }

  tick() {
    const now = Date.now();
    for (const s of this.all()) {
      if (!s.enabled || !s.state?.nextRunAt) continue;
      if (Date.parse(s.state.nextRunAt) > now) continue;
      this.execute(s.id, { manual: false }).catch((e) => this.log(`schedule ${s.name}: ${e.message}`));
    }
  }

  patchState(id, fn) {
    const list = this.all();
    const s = list.find((x) => x.id === id);
    if (!s) return null;
    fn(s);
    this.save(list);
    return s;
  }

  async execute(id, { manual = true } = {}) {
    const s0 = this.get(id);
    const busy = (this.running.get(id) || 0) > 0;
    const startedAt = new Date();
    // advance the timer first so a slow run never fires twice
    this.patchState(id, (s) => {
      if (!manual) {
        s.state.runCount = (s.state.runCount || 0) + 1;
        s.state.lastRunAt = startedAt.toISOString();
        s.state.nextRunAt = this.computeNext(s, new Date(startedAt.getTime() + 1000));
      }
    });
    if (busy && s0.overlap !== 'allow') {
      this.record(id, { at: startedAt.toISOString(), status: 'skipped', summary: 'Previous execution still running', manual });
      return { status: 'skipped' };
    }
    this.running.set(id, (this.running.get(id) || 0) + 1);
    this.emit('schedule-started', { id, name: s0.name, kind: s0.kind, manual });
    let result;
    try {
      const fn = { request: this.actions.sendRequest, bulk: this.actions.runBulk, loadtest: this.actions.runLoad }[s0.kind];
      result = await fn(s0);
    } catch (e) {
      result = { status: 'error', summary: e.message };
    } finally {
      this.running.set(id, Math.max(0, (this.running.get(id) || 1) - 1));
    }
    const entry = { at: startedAt.toISOString(), durationMs: Date.now() - startedAt.getTime(), manual, ...result };
    this.record(id, entry);
    this.emit('schedule-finished', { id, name: s0.name, ...entry });
    this.notify(s0, entry);
    return entry;
  }

  record(id, entry) {
    this.patchState(id, (s) => {
      s.state.lastStatus = entry.status;
      if (entry.manual) s.state.lastRunAt = entry.at;
      s.history = [entry, ...(s.history || [])].slice(0, HISTORY_MAX);
    });
  }

  async notify(s, entry) {
    const url = s.notify?.webhookUrl;
    if (!url || entry.status === 'skipped') return;
    if (s.notify.onlyOnFailure && entry.status === 'passed') return;
    const icon = entry.status === 'passed' ? '✅' : '❌';
    const text = `${icon} ApiStorm schedule "${s.name}" ${entry.status}: ${entry.summary}`;
    // "text" works for Slack / Mattermost / Teams incoming webhooks, "content" for Discord
    const body = { text, content: text, schedule: { id: s.id, name: s.name, kind: s.kind }, result: entry };
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 10000);
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal });
      clearTimeout(t);
      if (!r.ok) this.log(`notification for "${s.name}" failed: HTTP ${r.status}`);
    } catch (e) { this.log(`notification for "${s.name}" failed: ${e.message}`); }
  }
}

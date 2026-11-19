import { h, clear, mount, toast, confirmDialog, menu, fmtNum, fmtMs, fmtTime, fmtBytes, storageGet, storageSet, statusClass } from './dom.js';
import { api } from './api.js';
import { TimeChart, HeatmapChart, CategoryChart, TYPE_LABELS } from './chart.js';

/*
 * Live load-test dashboard.
 *  - keeps track of every run seen in this session (several can run at once)
 *  - a run strip to switch between them, plus an Overview that compares all live runs
 *  - configurable chart panels (add/remove, per-panel chart type, 1-3 columns)
 */

const SERIES = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-6', '--series-7', '--series-8'];

export const PANELS = {
  throughput: { title: 'Throughput', unit: 'req/s', types: ['line', 'area', 'bar'], series: [{ key: 'completed', label: 'Completed/s', color: '--series-1' }, { key: 'target', label: 'Target/s', color: '--series-2', dash: [5, 4], noFill: true }] },
  latency: { title: 'Latency percentiles', unit: 'ms', types: ['line', 'area', 'bar'], series: [{ key: 'p50', label: 'p50', color: '--series-1' }, { key: 'p95', label: 'p95', color: '--series-2' }, { key: 'p99', label: 'p99', color: '--series-3' }] },
  latencyAvgMax: { title: 'Latency average and max', unit: 'ms', types: ['line', 'area', 'bar'], series: [{ key: 'avg', label: 'Average', color: '--series-1' }, { key: 'max', label: 'Max', color: '--series-2' }] },
  status: { title: 'Status codes per second', unit: 'responses/s', types: ['stacked-bar', 'stacked-area', 'line'], series: [{ key: 's2', label: '2xx', color: '--status-good' }, { key: 's3', label: '3xx', color: '--series-1' }, { key: 's4', label: '4xx', color: '--status-warning' }, { key: 's5', label: '5xx', color: '--status-critical' }, { key: 'err', label: 'Network error', color: '--status-serious' }] },
  errors: { title: 'Failed and dropped', unit: 'per s', types: ['line', 'area', 'bar'], series: [{ key: 'failed', label: 'Failed/s', color: '--status-critical' }, { key: 'dropped', label: 'Dropped/s', color: '--series-4' }] },
  concurrency: { title: 'Concurrency (peak in-flight)', unit: '', types: ['area', 'line', 'bar'], series: [{ key: 'inFlight', label: 'In-flight', color: '--series-7' }] },
  started: { title: 'Started vs completed', unit: 'per s', types: ['line', 'bar', 'area'], series: [{ key: 'started', label: 'Started/s', color: '--series-1' }, { key: 'completed', label: 'Completed/s', color: '--series-3' }] },
  bandwidth: { title: 'Data transfer', unit: 'KB/s', types: ['area', 'line', 'bar', 'stacked-area'], series: [{ key: 'kbIn', label: 'Received', color: '--series-1' }, { key: 'kbOut', label: 'Sent', color: '--series-2' }] },
  callbacks: { title: 'Callbacks received', unit: 'per s', types: ['bar', 'line', 'area'], series: [{ key: 'cbReceived', label: 'Callbacks/s', color: '--series-3' }] },
  cbLatency: { title: 'Callback latency', unit: 'ms', types: ['line', 'area', 'bar'], series: [{ key: 'cbP50', label: 'p50', color: '--series-1' }, { key: 'cbP95', label: 'p95', color: '--series-2' }] },
  heatmap: { title: 'Latency heatmap', kind: 'heatmap', types: ['heatmap'] },
  histogram: { title: 'Latency distribution', kind: 'histogram', types: ['grouped'] },
  perRequest: { title: 'Latency by request', kind: 'perRequest', types: ['grouped'] },
};
const DEFAULT_LAYOUT = { cols: 2, panels: [{ id: 'throughput', type: 'line' }, { id: 'latency', type: 'line' }, { id: 'status', type: 'stacked-bar' }, { id: 'heatmap', type: 'heatmap' }, { id: 'errors', type: 'line' }, { id: 'concurrency', type: 'area' }] };

const db = {
  runs: new Map(),   // id -> { run, timeline, order }
  focus: null,       // run id | 'overview' | null
  layout: storageGet('apistorm.dashLayout', null) || structuredClone(DEFAULT_LAYOUT),
  charts: [],        // [{ id, chart }]
  overviewCharts: null,
  els: {},
  seq: 0,
};

const saveLayout = () => storageSet('apistorm.dashLayout', db.layout);
const isActive = (r) => r && (['running', 'stopping', 'pending'].includes(r.status) || (r.status === 'aborted' && r.phase && r.phase !== 'done'));
const activeRuns = () => [...db.runs.values()].filter((e) => isActive(e.run));

export function initDashboard(el) {
  db.els.root = el;
  render();
}

/** Load runs that are already running on the server (e.g. after a page reload). */
export async function syncActiveRuns() {
  const { active } = await api.get('/api/runs');
  for (const a of active) {
    try { const r = await api.get(`/api/runs/${a.id}`); upsert(r, r.timeline || []); } catch { /* finished meanwhile */ }
  }
  if (!db.focus && active.length) db.focus = active.length > 1 ? 'overview' : active[0].id;
  render();
}

function upsert(run, timeline) {
  const e = db.runs.get(run.id) || { order: db.seq++, timeline: [] };
  e.run = { ...(e.run || {}), ...run };
  if (timeline) e.timeline = timeline;
  db.runs.set(run.id, e);
  return e;
}

export async function showRun(id) {
  db.focus = id;
  if (id !== 'overview' && !db.runs.has(id)) {
    try { const r = await api.get(`/api/runs/${id}`); upsert(r, r.timeline || []); } catch (e) { toast(e.message, 'error'); return; }
  }
  render();
}

export function onRunEvent(type, p) {
  if (type === 'run-started') {
    upsert({ id: p.id, name: p.config?.name, status: 'running', startedAt: p.startedAt, config: p.config, summary: null }, []);
    if (!db.focus) db.focus = p.id;
    render();
    return;
  }
  if (type === 'run-reset') {
    const e = db.runs.get(p.id);
    if (e) { e.timeline = []; e.run.resetAtSec = p.resetAtSec; }
    if (db.focus === p.id || db.focus === 'overview') update();
    return;
  }
  const e = db.runs.get(p.id) || upsert(p, []);
  e.run = { ...e.run, ...p };
  if (type === 'run-finished') {
    e.timeline = p.timeline || e.timeline;
    // fetch the stored result (thresholds, samples) once it is saved
    setTimeout(() => api.get(`/api/runs/${p.id}`).then((r) => { e.run = r; e.timeline = r.timeline; if (db.focus === p.id || db.focus === 'overview') update(); }).catch(() => {}), 400);
    if (db.focus === 'overview' && !activeRuns().length) db.focus = p.id;
    renderStrip();
  } else {
    for (const pt of p.timeline || []) if (!e.timeline.length || pt.t > e.timeline[e.timeline.length - 1].t) e.timeline.push(pt);
  }
  if (db.focus === p.id || db.focus === 'overview') update();
  else updateStripOnly();
}

/* ---------------------------------------------------------------- layout */

function render() {
  const root = db.els.root;
  if (!root) return;
  db.els.strip = h('div.run-strip', { role: 'tablist', 'aria-label': 'Load tests' });
  db.els.body = h('div.dash-body');
  mount(root, db.els.strip, db.els.body);
  renderStrip();
  renderBody();
}

function renderStrip() {
  const el = db.els.strip;
  if (!el) return;
  clear(el);
  const entries = [...db.runs.values()].sort((a, b) => a.order - b.order);
  if (!entries.length) { el.hidden = true; return; }
  el.hidden = false;
  const live = activeRuns();
  if (live.length > 1 || (db.focus === 'overview')) {
    el.append(h(`button.run-chip.overview${db.focus === 'overview' ? '.on' : ''}`, { type: 'button', role: 'tab', 'aria-selected': String(db.focus === 'overview'), onclick: () => { db.focus = 'overview'; render(); } }, '▦ Overview', h('span.badge', live.length)));
  }
  for (const e of entries) {
    const r = e.run;
    const act = isActive(r);
    el.append(h(`div.run-chip${db.focus === r.id ? '.on' : ''}`, { role: 'tab', tabindex: 0, 'aria-selected': String(db.focus === r.id), title: r.name,
      onclick: () => { db.focus = r.id; render(); }, onkeydown: (ev) => { if (ev.key === 'Enter') { db.focus = r.id; render(); } } },
    h(`span.chip-dot.rs-dot-${r.status}`, { 'aria-hidden': 'true' }),
    h('span.chip-name', r.name || 'Load test'),
    h('span.chip-meta.muted', act ? `${fmtNum(r.live?.currentRps ?? 0)}/s` : (r.status || '')),
    !act ? h('button.icon-btn.chip-x', { type: 'button', 'aria-label': `Remove ${r.name} from the dashboard`, title: 'Remove from dashboard', onclick: (ev) => { ev.stopPropagation(); clearRun(r.id, false); } }, '✕') : null));
  }
}

function updateStripOnly() {
  // cheap refresh of the per-chip numbers without rebuilding charts
  renderStrip();
}

function renderBody() {
  for (const c of db.charts) c.chart.destroy();
  db.charts = [];
  db.overviewCharts?.forEach((c) => c.destroy());
  db.overviewCharts = null;
  const body = db.els.body;
  if (db.focus === 'overview') return renderOverview(body);
  const e = db.runs.get(db.focus);
  if (!e) return renderEmpty(body);
  db.els.header = h('div.dash-head');
  db.els.tiles = h('div.tiles');
  db.els.grid = h(`div.chart-grid.cols-${db.layout.cols}`);
  db.els.tables = h('div.dash-tables');
  mount(body, db.els.header, db.els.tiles, panelToolbar(), db.els.grid, db.els.tables);
  buildPanels();
  update();
}

function renderEmpty(body) {
  mount(body, h('div.lt-empty',
    h('h2', 'No test selected'),
    h('p.muted', 'Configure a test on the left and press Start. You can start more tests while others run: each gets a tab above, and the Overview compares them live.'),
    h('ul.muted.small',
      h('li', h('b', 'Fixed rate'), ' keeps a constant TPS (open model). Max in-flight throttles concurrency.'),
      h('li', h('b', 'Virtual users'), ' simulates N concurrent clients. With Iterations set, it is a bulk sender.'),
      h('li', h('b', 'Charts'), ': pick which graphs to show and switch each between line, area, bars or stacked.'),
      h('li', h('b', 'Reset stats'), ' zeroes the numbers of a running test (e.g. after warm-up) without stopping it.'))));
}

/* ---------------------------------------------------------------- panels */

function panelToolbar() {
  const shown = new Set(db.layout.panels.map((p) => p.id));
  const hidden = Object.entries(PANELS).filter(([id]) => !shown.has(id));
  return h('div.panel-bar',
    h('span.muted.small', 'Charts'),
    h('button.btn.btn-sm', { type: 'button', disabled: !hidden.length, onclick: (e) => menu(e.currentTarget, hidden.map(([id, p]) => ({ label: p.title, icon: '＋', onClick: () => { db.layout.panels.push({ id, type: p.types[0] }); saveLayout(); renderBody(); } }))) }, '＋ Add chart'),
    h('div.segmented.small-seg', { role: 'radiogroup', 'aria-label': 'Columns' }, [1, 2, 3].map((n) => h(`button.seg${db.layout.cols === n ? '.on' : ''}`, { type: 'button', role: 'radio', 'aria-checked': String(db.layout.cols === n), title: `${n} column${n > 1 ? 's' : ''}`, onclick: () => { db.layout.cols = n; saveLayout(); db.els.grid.className = `chart-grid cols-${n}`; renderBody(); } }, `${n} col`))),
    h('button.link.small', { type: 'button', onclick: () => { db.layout = structuredClone(DEFAULT_LAYOUT); saveLayout(); renderBody(); } }, 'Default layout'));
}

function buildPanels() {
  for (const [idx, p] of db.layout.panels.entries()) {
    const def = PANELS[p.id];
    if (!def) continue;
    let chart;
    if (def.kind === 'heatmap') chart = new HeatmapChart({ title: def.title });
    else if (def.kind === 'histogram') chart = new CategoryChart({ title: def.title, unit: 'requests', horizontal: false, series: [{ key: 'count', label: 'Requests', color: '--series-1' }], note: 'Whole run. Bars are latency ranges (upper bound shown).' });
    else if (def.kind === 'perRequest') chart = new CategoryChart({ title: def.title, unit: 'ms', horizontal: true, series: [{ key: 'p50', label: 'p50', color: '--series-1' }, { key: 'p95', label: 'p95', color: '--series-2' }, { key: 'p99', label: 'p99', color: '--series-3' }] });
    else chart = new TimeChart({ title: def.title, unit: def.unit, series: def.series, type: def.types.includes(p.type) ? p.type : def.types[0] });
    // per-panel toolbar: chart type toggle, move, remove
    if (def.types.length > 1) {
      chart.tools.append(h('div.segmented.small-seg', { role: 'radiogroup', 'aria-label': `${def.title} chart type` }, def.types.map((t) => h(`button.seg${chart.type === t ? '.on' : ''}`, {
        type: 'button', role: 'radio', 'aria-checked': String(chart.type === t),
        onclick: (ev) => { p.type = t; saveLayout(); chart.setType(t); [...ev.currentTarget.parentNode.children].forEach((b) => { b.classList.toggle('on', b === ev.currentTarget); b.setAttribute('aria-checked', String(b === ev.currentTarget)); }); },
      }, TYPE_LABELS[t]))));
    }
    chart.tools.append(
      h('button.icon-btn', { type: 'button', title: 'Move left/up', 'aria-label': `Move ${def.title} earlier`, disabled: idx === 0, onclick: () => { const a = db.layout.panels; [a[idx - 1], a[idx]] = [a[idx], a[idx - 1]]; saveLayout(); renderBody(); } }, '◀'),
      h('button.icon-btn', { type: 'button', title: 'Remove chart', 'aria-label': `Remove ${def.title}`, onclick: () => { db.layout.panels.splice(idx, 1); saveLayout(); renderBody(); } }, '✕'));
    db.charts.push({ id: p.id, def, chart });
    db.els.grid.append(chart.el);
  }
  if (!db.charts.length) db.els.grid.append(h('p.muted', 'No charts selected. Use "＋ Add chart".'));
}

/* ------------------------------------------------------------- updating */

function update() {
  if (db.focus === 'overview') return updateOverview();
  const e = db.runs.get(db.focus);
  if (!e || !db.els.header) return;
  renderStrip();
  const r = e.run;
  const s = r.summary || { latency: {} };
  const L = s.latency || {};
  const live = r.live || {};
  const act = isActive(r);
  const [icon, label] = STATUS[r.status] || ['', r.status];
  const pct = r.plannedSec ? Math.min(100, (r.elapsedSec / r.plannedSec) * 100) : null;
  mount(db.els.header,
    h('div.dash-title',
      h('h2', r.name || 'Load test'),
      h(`span.run-status.rs-${r.status}`, icon, ' ', label, r.phase && !['running', 'done'].includes(r.phase) ? ` · ${r.phase}` : ''),
      r.thresholds?.length && !act ? h(`span.run-status.${r.passed ? 'rs-completed' : 'rs-failed'}`, r.passed ? '✔ Thresholds passed' : '✖ Thresholds failed') : null,
      r.source ? h('span.run-status', r.source) : null,
      h('span.spacer'),
      act ? h('button.btn', { type: 'button', title: 'Zero all statistics and charts; the test keeps running', onclick: () => resetRun(r) }, '↺ Reset stats') : null,
      act ? h('button.btn.btn-danger', { type: 'button', onclick: () => stopRun(r) }, r.status === 'stopping' ? 'Force stop' : '■ Stop') : null,
      !act ? h('button.btn', { type: 'button', onclick: (ev) => exportMenu(ev.currentTarget, r.id) }, 'Export ▾') : null,
      !act ? h('button.btn', { type: 'button', title: 'Clear this dashboard (the saved result stays in Runs)', onclick: () => clearRun(r.id, true) }, '⌫ Clear') : null),
    h('div.dash-sub.muted.small', `${fmtTime(r.startedAt)} · ${fmtNum(r.elapsedSec, 1)}s${r.plannedSec ? ` of ~${fmtNum(r.plannedSec, 0)}s` : ''}${r.resetAtSec != null ? ` · stats since reset at ${fmtNum(r.resetAtSec, 1)}s` : ''}${r.reason ? ` · ${r.reason}` : ''}`),
    pct != null && act ? h('div.progress', { role: 'progressbar', 'aria-valuenow': Math.round(pct), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': 'Test progress' }, h('div.progress-bar', { style: { width: `${pct}%` } })) : null);

  const failCls = s.errorRate > 5 ? 'bad' : s.errorRate > 0 ? 'warn' : '';
  mount(db.els.tiles,
    tile('Requests', fmtNum(s.count), `${fmtNum(live.iterations?.completed)} iterations`),
    tile('Throughput', `${fmtNum(act ? live.currentRps : s.rps, 1)}/s`, act ? `avg ${fmtNum(s.rps, 1)}/s${live.targetRps ? ` · target ${fmtNum(live.targetRps, 1)}` : ''}` : 'average req/s'),
    tile('Failed', `${fmtNum(s.errorRate, 2)}%`, `${fmtNum(s.failed)} requests${s.netErrors ? ` · ${fmtNum(s.netErrors)} network` : ''}`, failCls),
    tile('p50 latency', fmtMs(L.p50), `avg ${fmtMs(L.avg)}`),
    tile('p95 latency', fmtMs(L.p95), `p90 ${fmtMs(L.p90)}`),
    tile('p99 latency', fmtMs(L.p99), `max ${fmtMs(L.max)}`),
    tile('In-flight', fmtNum(live.inFlight), `peak ${fmtNum(live.inFlightMax)}`),
    tile('Dropped', fmtNum(live.dropped), live.backlog ? `backlog ${fmtNum(live.backlog)}` : 'over throttle limit', live.dropped ? 'warn' : ''),
    r.callbacks?.tracked ? tile('Callbacks', `${fmtNum(r.callbacks.received)}/${fmtNum(r.callbacks.tracked)}`, `p95 ${fmtMs(r.callbacks.latency?.p95)} · ${fmtNum(r.callbacks.timeouts)} timed out`, r.callbacks.timeouts ? 'warn' : '') : null,
    tile('Data', fmtBytes(s.bytesIn), `received · ${fmtBytes(s.bytesOut)} sent`));

  const tl = e.timeline.filter((p) => !p.partial).map((p) => ({ ...p, kbIn: p.bytesIn != null ? p.bytesIn / 1024 : null, kbOut: p.bytesOut != null ? p.bytesOut / 1024 : null }));
  for (const { def, chart } of db.charts) {
    if (def.kind === 'heatmap') chart.setData(tl, r.heatEdges);
    else if (def.kind === 'histogram') chart.setData((r.distribution || []).map(([ms, count]) => ({ label: ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms < 10 ? ms.toFixed(1) : Math.round(ms)}ms`, count })));
    else if (def.kind === 'perRequest') chart.setData((r.perRequest || []).map((p) => ({ label: p.name, p50: p.latency.p50, p95: p.latency.p95, p99: p.latency.p99 })));
    else chart.setData(tl);
  }
  renderTables(r);
}

const STATUS = { pending: ['⏳', 'Starting'], running: ['●', 'Running'], stopping: ['■', 'Stopping'], stopped: ['■', 'Stopped'], completed: ['✔', 'Completed'], aborted: ['⚠', 'Aborted'], failed: ['✖', 'Failed'] };

function tile(label, value, sub, cls = '') {
  return h(`div.tile${cls ? '.' + cls : ''}`, h('div.tile-label', label), h('div.tile-value', value), sub ? h('div.tile-sub', sub) : null);
}

async function resetRun(r) {
  if (!(await confirmDialog(`Reset all statistics and charts of "${r.name}"? The test keeps running; numbers start again from zero.`, { okLabel: 'Reset stats', title: 'Reset statistics' }))) return;
  try { await api.post(`/api/runs/${r.id}/reset`); toast('Statistics reset', 'ok', 1500); } catch (e) { toast(e.message, 'error'); }
}

async function stopRun(r) {
  try {
    await api.post(`/api/runs/${r.id}/stop`);
    toast(r.status === 'stopping' ? 'Hard stop: aborting in-flight requests' : 'Stopping… press again to abort in-flight requests', 'warn');
  } catch (e) { toast(e.message, 'error'); }
}

async function clearRun(id, ask) {
  const e = db.runs.get(id);
  if (ask && !(await confirmDialog(`Clear "${e?.run?.name || 'this test'}" from the dashboard? The saved result stays in the Runs tab.`, { okLabel: 'Clear', title: 'Clear dashboard' }))) return;
  db.runs.delete(id);
  if (db.focus === id) db.focus = activeRuns().length > 1 ? 'overview' : (activeRuns()[0]?.run.id || [...db.runs.keys()].pop() || null);
  render();
}

function exportMenu(anchor, id) {
  menu(anchor, [
    { label: 'HTML report', icon: '⇩', onClick: () => location.assign(`/api/runs/${id}/export?format=html`) },
    { label: 'JSON (full result)', icon: '⇩', onClick: () => location.assign(`/api/runs/${id}/export?format=json`) },
    { label: 'CSV (per-second timeline)', icon: '⇩', onClick: () => location.assign(`/api/runs/${id}/export?format=csv`) },
  ]);
}

function renderTables(r) {
  const s = r.summary || {};
  const blocks = [];
  if (r.thresholds?.length) {
    blocks.push(h('div.card', h('h3', 'Thresholds'), h('table.table', h('thead', h('tr', h('th', 'Threshold'), h('th.num', 'Actual'), h('th', 'Result'))),
      h('tbody', r.thresholds.map((t) => h('tr', h('td', `${t.metric} ${t.op} ${t.value}`), h('td.num', fmtNum(t.actual, 2)), h(`td.${t.pass ? 'ok' : 'bad'}`, t.pass ? '✔ pass' : '✖ fail')))))));
  }
  const per = r.perRequest || [];
  blocks.push(h('div.card.wide', h('h3', 'Per request'), h('div.table-scroll', h('table.table', h('thead', h('tr', ['Request', 'Count', 'Req/s', 'Failed', 'avg', 'p50', 'p95', 'p99', 'max'].map((x, i) => h(i ? 'th.num' : 'th', x)))),
    h('tbody', per.map((p) => h('tr', h('td', p.name), h('td.num', fmtNum(p.count)), h('td.num', fmtNum(p.rps, 1)), h(`td.num${p.errorRate > 0 ? '.bad' : ''}`, `${fmtNum(p.errorRate, 2)}%`),
      h('td.num', fmtMs(p.latency.avg)), h('td.num', fmtMs(p.latency.p50)), h('td.num', fmtMs(p.latency.p95)), h('td.num', fmtMs(p.latency.p99)), h('td.num', fmtMs(p.latency.max)))))))));
  const statuses = Object.entries(s.status || {}).sort((a, b) => b[1] - a[1]);
  blocks.push(h('div.card', h('h3', 'Status codes'), statuses.length ? h('table.table', h('tbody', statuses.map(([code, n]) => h('tr',
    h('td', h(`span.status-pill.sm.${statusClass(code === 'ERR' ? 0 : Number(code))}`, code === 'ERR' ? 'Network error' : code)),
    h('td.num', fmtNum(n)), h('td.num.muted', `${fmtNum((n / Math.max(1, s.count)) * 100, 1)}%`), h('td.bar-cell', h('div.mini-bar', { style: { width: `${(n / Math.max(1, s.count)) * 100}%` } })))))) : h('p.muted', 'No responses yet')));
  const checks = Object.entries(s.checks || {});
  if (checks.length) blocks.push(h('div.card', h('h3', 'Checks'), h('table.table', h('thead', h('tr', h('th', 'Check'), h('th.num', 'Pass'), h('th.num', 'Fail'))),
    h('tbody', checks.map(([n, c]) => h('tr', h('td', n), h('td.num.ok', fmtNum(c.pass)), h(`td.num${c.fail ? '.bad' : ''}`, fmtNum(c.fail))))))));
  const errs = Object.entries(s.errors || {}).sort((a, b) => b[1] - a[1]).slice(0, 15);
  if (errs.length) blocks.push(h('div.card.wide', h('h3', 'Network errors'), h('table.table', h('tbody', errs.map(([m, n]) => h('tr', h('td.mono.small', m), h('td.num', fmtNum(n))))))));
  if (r.samples?.length) blocks.push(h('div.card.wide', h('h3', `Failed request samples (${r.samples.length})`), r.samples.map((x) => h('details.sample',
    h('summary', h(`span.status-pill.sm.${statusClass(x.status)}`, x.status || 'ERR'), ` ${x.request} · ${x.method} `, h('span.mono.small', x.url), h('span.muted.small', ` · t+${x.t}s${x.timeMs != null ? ` · ${fmtMs(x.timeMs)}` : ''}`)),
    x.error ? h('p.bad.mono.small', x.error) : null,
    x.failedChecks?.length ? h('ul.small', x.failedChecks.map((c) => h('li.bad', `✖ ${c.name}${c.actual !== undefined ? ` (actual: ${c.actual})` : ''}`))) : null,
    x.body ? h('pre.code.small', x.body) : null))));
  const st = r.callbacks?.statuses || {};
  if (Object.keys(st).length || r.callbacks?.noId) {
    const total = Object.values(st).reduce((a, b) => a + b, 0) || 1;
    blocks.push(h('div.card', h('h3', 'Callback / delivery status'), h('table.table', h('tbody',
      Object.entries(st).sort((a, b) => b[1] - a[1]).map(([k, n]) => h('tr', h('td.mono', k), h('td.num', fmtNum(n)), h('td.num.muted', `${fmtNum((n / total) * 100, 1)}%`), h('td.bar-cell', h('div.mini-bar', { style: { width: `${(n / total) * 100}%` } }))))),
      r.callbacks.timeouts ? h('tr', h('td', '⏱ no callback (timed out)'), h('td.num.bad', fmtNum(r.callbacks.timeouts)), h('td'), h('td')) : null,
      r.callbacks.noId ? h('tr', h('td', '∅ response had no id to correlate'), h('td.num.bad', fmtNum(r.callbacks.noId)), h('td'), h('td')) : null)));
  }
  if (r.callbackSamples?.length) blocks.push(h('div.card.wide', h('h3', 'Callback samples'), h('table.table', h('tbody', r.callbackSamples.map((x) => h('tr', h('td', x.request), h('td.mono.small', `${x.method} ${x.path}`), h('td.mono.small', x.status ?? ''), h('td.num', fmtMs(x.latencyMs))))))));
  if (r.config) blocks.push(h('details.card.wide', h('summary', 'Configuration used'), h('pre.code.small', JSON.stringify(r.config, null, 2))));
  mount(db.els.tables, blocks);
}

/* -------------------------------------------------------------- overview */

function renderOverview(body) {
  db.els.ovHead = h('div.dash-head');
  db.els.ovCards = h('div.ov-cards');
  const ovMetric = storageGet('apistorm.ovMetric', 'completed');
  const metrics = [['completed', 'Throughput (req/s)'], ['p95', 'p95 latency (ms)'], ['p50', 'p50 latency (ms)'], ['failed', 'Failed per second'], ['inFlight', 'In-flight']];
  const typeKey = storageGet('apistorm.ovType', 'line');
  const charts = [new TimeChart({ title: 'Live runs compared', unit: metrics.find(([k]) => k === ovMetric)?.[1] || '', series: [], type: typeKey, height: 240 })];
  charts[0].metric = ovMetric;
  charts[0].tools.append(
    h('select.input.small-select', { 'aria-label': 'Metric', onchange: (e) => { charts[0].metric = e.target.value; storageSet('apistorm.ovMetric', e.target.value); updateOverview(); } }, metrics.map(([k, l]) => h('option', { value: k, selected: k === ovMetric }, l))),
    h('div.segmented.small-seg', ['line', 'area', 'bar'].map((t) => h(`button.seg${typeKey === t ? '.on' : ''}`, { type: 'button', onclick: (ev) => { charts[0].setType(t); storageSet('apistorm.ovType', t); [...ev.currentTarget.parentNode.children].forEach((b) => b.classList.toggle('on', b === ev.currentTarget)); } }, TYPE_LABELS[t]))));
  db.overviewCharts = charts;
  mount(body, db.els.ovHead, db.els.ovCards, h('div.chart-grid.cols-1', charts[0].el));
  updateOverview();
}

function updateOverview() {
  renderStrip();
  const live = activeRuns().sort((a, b) => a.order - b.order);
  const all = [...db.runs.values()].sort((a, b) => a.order - b.order);
  const shown = (live.length ? live : all).slice(0, SERIES.length);
  mount(db.els.ovHead, h('div.dash-title', h('h2', 'Overview'), h('span.run-status.rs-running', `${live.length} running`), h('span.spacer'),
    live.length ? h('button.btn.btn-danger', { type: 'button', onclick: async () => {
      if (!(await confirmDialog(`Stop all ${live.length} running tests?`, { danger: true, okLabel: 'Stop all' }))) return;
      await api.post('/api/runs/stop-all');
    } }, '■ Stop all') : null),
  h('div.dash-sub.muted.small', 'All load tests side by side. Time is measured from each test\'s own start. Click a card to open its dashboard.'));
  mount(db.els.ovCards, shown.map((e, i) => {
    const r = e.run; const s = r.summary || { latency: {} };
    const pct = r.plannedSec ? Math.min(100, (r.elapsedSec / r.plannedSec) * 100) : null;
    return h('button.ov-card', { type: 'button', onclick: () => { db.focus = r.id; render(); } },
      h('div.ov-title', h('i.legend-swatch', { style: { background: `var(${SERIES[i]})` } }), h('b', r.name || 'Load test'), h(`span.run-status.rs-${r.status}`, r.status)),
      h('div.ov-stats',
        h('span', h('b', `${fmtNum(isActive(r) ? r.live?.currentRps : s.rps, 1)}`), ' req/s'),
        h('span', 'p95 ', h('b', fmtMs(s.latency?.p95))),
        h(`span${s.errorRate > 0 ? '.bad' : ''}`, h('b', `${fmtNum(s.errorRate, 2)}%`), ' failed'),
        h('span', h('b', fmtNum(s.count)), ' requests')),
      pct != null && isActive(r) ? h('div.progress', h('div.progress-bar', { style: { width: `${pct}%` } })) : null);
  }));
  if (!shown.length) db.els.ovCards.append(h('p.muted', 'No tests yet.'));
  const chart = db.overviewCharts?.[0];
  if (!chart) return;
  const key = chart.metric;
  const byT = new Map();
  shown.forEach((e, i) => { for (const p of e.timeline) { if (p.partial) continue; const row = byT.get(p.t) || { t: p.t }; row[`r${i}`] = p[key]; byT.set(p.t, row); } });
  chart.setSeries(shown.map((e, i) => ({ key: `r${i}`, label: e.run.name || `Run ${i + 1}`, color: SERIES[i] })));
  chart.setData([...byT.values()].sort((a, b) => a.t - b.t));
}

export function focusedRunId() { return db.focus; }

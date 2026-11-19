import { h, $, clear, mount, toast, modal, confirmDialog, promptDialog, select, segmented, numField, checkField, download, copyText,
  fmtNum, fmtMs, fmtTime, fmtBytes, storageGet, storageSet, readFileText, statusClass, methodClass } from './dom.js';
import { api } from './api.js';
import { state, on, emit, activeEnvId, findCollection } from './state.js';
import { currentTabTarget } from './workspace.js';
import { initDashboard, showRun, syncActiveRuns } from './dashboard.js';

const lt = {
  config: null,
  target: null,       // {type:'request', request, collectionId} | {type:'collection', collectionId, requestIds}
  envId: undefined,   // undefined = follow the active environment
  runId: null,
  run: null,
  timeline: [],
  charts: null,
  els: {},
};

function defaults() {
  return { ...(state.info?.runDefaults || {}), name: '', thresholds: [{ metric: 'p95', op: '<', value: 1000 }, { metric: 'errorRate', op: '<', value: 1 }], data: { rows: [], mode: 'sequential' } };
}

export function initLoadTest(root) {
  const saved = storageGet('apistorm.ltConfig', null);
  lt.config = { ...defaults(), ...(saved || {}), data: { rows: [], mode: saved?.data?.mode || 'sequential' } };
  lt.target = storageGet('apistorm.ltTarget', null);
  lt.els.config = h('section.lt-config', { 'aria-label': 'Load test configuration' });
  lt.els.dash = h('section.lt-dash', { 'aria-label': 'Load test results' });
  mount(root, h('div.lt', lt.els.config, lt.els.dash));
  renderConfig();
  initDashboard(lt.els.dash);
  syncActiveRuns().catch(() => {});
  on('loadtest:target', (t) => { lt.target = t; storageSet('apistorm.ltTarget', t); renderConfig(); });
  on('workspace', renderConfig);
  on('collections', renderConfig);
  on('env', renderConfig);
  on('presets', renderConfig);
}

const persist = () => storageSet('apistorm.ltConfig', { ...lt.config, data: { mode: lt.config.data.mode, rows: [] } });

/* ------------------------------------------------------------- config UI */

function section(title, ...children) {
  return h('fieldset.lt-section', h('legend', title), ...children);
}

function renderConfig() {
  const el = lt.els.config;
  if (!el || !lt.config) return;
  const c = lt.config;
  const set = (k) => (v) => { c[k] = v; persist(); };
  const rerender = () => renderConfig();

  // ---- target
  const targetType = lt.target?.type || 'request';
  const targetBox = h('div');
  const renderTarget = () => {
    clear(targetBox);
    if ((lt.target?.type || 'request') === 'request') {
      const t = lt.target?.type === 'request' ? lt.target : null;
      const options = [['', '— choose a saved request —']];
      for (const col of state.collections) for (const r of col.requests) options.push([`${col.id}::${r.id}`, `${col.name} / ${r.name}`]);
      const cur = t?.collectionId && t.request ? `${t.collectionId}::${t.request.id}` : '';
      targetBox.append(
        t?.request ? h('div.target-card', h(`span.method.${methodClass(t.request.method)}`, t.request.method), h('div', h('b', t.request.name), h('div.mono.small.muted', t.request.url))) : h('p.muted', 'No request selected.'),
        h('div.row-gap',
          select(options, options.some(([v]) => v === cur) ? cur : '', (v) => {
            if (!v) return;
            const [cid, rid] = v.split('::');
            const r = findCollection(cid)?.requests.find((x) => x.id === rid);
            if (r) { lt.target = { type: 'request', request: structuredClone(r), collectionId: cid }; storageSet('apistorm.ltTarget', lt.target); renderTarget(); }
          }, { 'aria-label': 'Saved request' }),
          h('button.btn.btn-sm', { type: 'button', title: 'Use the request in the active tab of the Requests view (including unsaved edits)', onclick: () => { const t2 = currentTabTarget(); if (t2) { lt.target = t2; storageSet('apistorm.ltTarget', t2); renderTarget(); } } }, 'Use current tab')));
    } else {
      const t = lt.target;
      const col = findCollection(t?.collectionId) || state.collections[0];
      if (!col) { targetBox.append(h('p.muted', 'No collections yet.')); return; }
      if (!t?.collectionId || t.collectionId !== col.id) { lt.target = { type: 'collection', collectionId: col.id, requestIds: col.requests.map((r) => r.id) }; storageSet('apistorm.ltTarget', lt.target); }
      const ids = new Set(lt.target.requestIds?.length ? lt.target.requestIds : col.requests.map((r) => r.id));
      targetBox.append(
        h('label.field', h('span', 'Collection'), select(state.collections.map((x) => [x.id, x.name]), col.id, (v) => { const nc = findCollection(v); lt.target = { type: 'collection', collectionId: v, requestIds: nc.requests.map((r) => r.id) }; storageSet('apistorm.ltTarget', lt.target); renderTarget(); })),
        h('p.muted.small', 'Each iteration runs the checked requests in order. Variables extracted by one request are available to the next ones in the same iteration.'),
        h('div.req-checklist', col.requests.map((r) => h('label.check', h('input', { type: 'checkbox', checked: ids.has(r.id), onchange: (e) => {
          if (e.target.checked) ids.add(r.id); else ids.delete(r.id);
          lt.target.requestIds = col.requests.filter((x) => ids.has(x.id)).map((x) => x.id);
          storageSet('apistorm.ltTarget', lt.target);
        } }), h(`span.method.${methodClass(r.method)}`, r.method), h('span', r.name)))));
    }
  };
  renderTarget();

  const envSel = select([['', '(no environment)'], ...state.environments.map((e) => [e.id, e.name])], lt.envId === undefined ? activeEnvId() || '' : lt.envId || '', (v) => { lt.envId = v; }, { 'aria-label': 'Environment' });

  // ---- load model
  const isRate = c.mode !== 'vus';
  const model = h('div');
  if (isRate) {
    if (!c.useStages) {
      model.append(h('div.form-grid',
        numField('Target rate', c.tps, set('tps'), { min: 0.1, step: 1, suffix: 'TPS', hint: 'Iterations started per second. With one request per iteration this is requests per second.' }),
        numField('Duration', c.durationSec, set('durationSec'), { min: 1, suffix: 's', hint: 'Time at the target rate (after ramp-up).' }),
        numField('Ramp-up', c.rampUpSec, set('rampUpSec'), { min: 0, suffix: 's', hint: 'Linearly increase from 0 to the target rate first.' }),
        numField('Stop after', c.maxIterations, set('maxIterations'), { min: 0, suffix: 'iterations', hint: '0 = no limit. Useful for "send exactly N requests at X TPS" bulk jobs.' })));
    } else {
      const stages = c.stages?.length ? c.stages : (c.stages = [{ durationSec: 30, tps: 10 }, { durationSec: 60, tps: 50 }, { durationSec: 30, tps: 0 }]);
      const tbl = h('div.stage-table');
      stages.forEach((s, i) => tbl.append(h('div.stage-row',
        h('span.muted.small', `#${i + 1}`),
        h('input.input', { type: 'number', min: 1, value: s.durationSec, 'aria-label': `Stage ${i + 1} duration`, oninput: (e) => { s.durationSec = Number(e.target.value); persist(); } }), h('span.small.muted', 's →'),
        h('input.input', { type: 'number', min: 0, value: s.tps, 'aria-label': `Stage ${i + 1} target TPS`, oninput: (e) => { s.tps = Number(e.target.value); persist(); } }), h('span.small.muted', 'TPS'),
        h('button.icon-btn', { type: 'button', 'aria-label': 'Remove stage', onclick: () => { stages.splice(i, 1); persist(); rerender(); } }, '✕'))));
      model.append(numField('Start rate', c.startTps, set('startTps'), { min: 0, suffix: 'TPS' }),
        h('p.muted.small', 'The rate moves linearly from the previous target to each stage target over the stage duration (like k6 ramping-arrival-rate).'), tbl,
        h('button.btn.btn-sm', { type: 'button', onclick: () => { stages.push({ durationSec: 30, tps: stages[stages.length - 1]?.tps || 10 }); persist(); rerender(); } }, '+ Stage'));
    }
    model.append(checkField('Use ramp stages (spike / soak / step profiles)', c.useStages, (v) => { c.useStages = v; persist(); rerender(); }));
  } else {
    model.append(h('div.form-grid',
      numField('Virtual users', c.vus, set('vus'), { min: 1, hint: 'Concurrent workers. Each loops: send → wait for response → think time → repeat.' }),
      numField('Duration', c.durationSec, set('durationSec'), { min: 0, suffix: 's', hint: '0 = run until the iteration count is reached.' }),
      numField('Iterations', c.iterations, set('iterations'), { min: 0, hint: 'Total across all VUs. 0 = until duration ends. Use this for bulk sends.' }),
      numField('Ramp-up', c.rampUpSec, set('rampUpSec'), { min: 0, suffix: 's', hint: 'VUs start gradually over this time.' }),
      numField('Rate limit', c.rateLimit, set('rateLimit'), { min: 0, suffix: '/s', hint: 'Cap on iterations per second across all VUs. 0 = unlimited.' })));
  }

  // ---- throttle
  const throttle = h('div.form-grid',
    isRate ? numField('Max in-flight', c.maxInFlight, set('maxInFlight'), { min: 1, hint: 'Throttle: at most this many iterations run concurrently.' }) : null,
    isRate ? h('label.field', h('span', 'When max in-flight is reached'), select([['drop', 'Drop (count as dropped)'], ['queue', 'Queue (catch up later)']], c.saturation, set('saturation'))) : null,
    numField('Think time', c.thinkTimeMs, set('thinkTimeMs'), { min: 0, suffix: 'ms', hint: isRate ? 'Pause at the end of each iteration (keeps the slot busy).' : 'Pause between iterations of a VU.' }),
    numField('Random jitter', c.thinkJitterMs, set('thinkJitterMs'), { min: 0, suffix: 'ms', hint: 'Adds 0..N ms random extra think time.' }));

  // ---- http
  const httpBox = h('div.form-grid',
    numField('Request timeout', c.timeoutMs, set('timeoutMs'), { min: 100, step: 1000, suffix: 'ms' }),
    checkField('Keep-alive (reuse connections)', c.keepAlive, set('keepAlive'), 'Off = new TCP/TLS connection per request (much heavier).'),
    checkField('Follow redirects', c.followRedirects, set('followRedirects')),
    checkField('Skip TLS verification', c.insecure, set('insecure')));

  // ---- data
  const dataInfo = h('div.small.muted', c.data.rows.length ? `${c.data.rows.length} rows · columns: ${Object.keys(c.data.rows[0] || {}).join(', ')}` : 'No data file. Columns become {{variables}} for each iteration.');
  const dataBox = h('div',
    h('div.row-gap',
      h('label.btn.btn-sm', 'Load CSV / JSON', h('input', { type: 'file', accept: '.csv,.json,.txt', hidden: true, onchange: async (e) => { const f = e.target.files[0]; if (f) loadData(await readFileText(f), f.name); } })),
      h('button.btn.btn-sm', { type: 'button', onclick: pasteData }, 'Paste'),
      c.data.rows.length ? h('button.btn.btn-sm', { type: 'button', onclick: () => { c.data.rows = []; rerender(); } }, 'Clear') : null,
      select([['sequential', 'Sequential'], ['random', 'Random row']], c.data.mode, (v) => { c.data.mode = v; persist(); }, { 'aria-label': 'Row selection' })),
    dataInfo);

  // ---- callbacks
  const cbBox = h('div',
    checkField('Track async callbacks', c.trackCallbacks, (v) => { c.trackCallbacks = v; persist(); rerender(); }, 'Requests that contain {{$callbackUrl}} or {{$requestId}} are matched with incoming callbacks. Reports callback latency and timeouts.'),
    c.trackCallbacks ? h('div.form-grid', numField('Callback timeout', c.callbackTimeoutMs, set('callbackTimeoutMs'), { min: 100, step: 1000, suffix: 'ms' })) : null,
    c.trackCallbacks ? h('p.muted.small', `Callback base URL: ${state.info?.callbackBase}. Change it in Settings when the API calls you through a tunnel.`) : null);

  // ---- thresholds
  const thrBox = h('div');
  const metrics = [['p50', 'p50 latency (ms)'], ['p90', 'p90 latency (ms)'], ['p95', 'p95 latency (ms)'], ['p99', 'p99 latency (ms)'], ['avg', 'avg latency (ms)'], ['max', 'max latency (ms)'], ['errorRate', 'error rate (%)'], ['rps', 'throughput (req/s)'], ['cbP95', 'callback p95 (ms)'], ['cbTimeoutRate', 'callback timeouts (%)']];
  (c.thresholds ||= []).forEach((t, i) => thrBox.append(h('div.thr-row',
    select(metrics, t.metric, (v) => { t.metric = v; persist(); }, { 'aria-label': 'Metric' }),
    select([['<', '<'], ['<=', '≤'], ['>', '>'], ['>=', '≥']], t.op, (v) => { t.op = v; persist(); }, { 'aria-label': 'Operator' }),
    h('input.input', { type: 'number', value: t.value, 'aria-label': 'Threshold value', oninput: (e) => { t.value = Number(e.target.value); persist(); } }),
    h('button.icon-btn', { type: 'button', 'aria-label': 'Remove threshold', onclick: () => { c.thresholds.splice(i, 1); persist(); rerender(); } }, '✕'))));
  thrBox.append(h('button.btn.btn-sm', { type: 'button', onclick: () => { c.thresholds.push({ metric: 'p99', op: '<', value: 2000 }); persist(); rerender(); } }, '+ Threshold'));

  const safety = h('div.form-grid',
    numField('Abort if error rate >', c.abortOnErrorRatePct, set('abortOnErrorRatePct'), { min: 0, suffix: '%', hint: '0 = never abort. Protects the target when it starts failing.' }),
    numField('…after at least', c.abortMinSamples, set('abortMinSamples'), { min: 1, suffix: 'requests' }),
    numField('Graceful stop', c.gracefulStopSec, set('gracefulStopSec'), { min: 0, suffix: 's', hint: 'How long in-flight requests may finish after stop/end.' }));

  // ---- presets
  const presetOpts = [['', state.presets.length ? '— load a saved test —' : 'No saved tests'], ...state.presets.map((p) => [p.id, p.name])];
  const presetBar = h('div.row-gap.preset-bar',
    select(presetOpts, '', (v) => { const p = state.presets.find((x) => x.id === v); if (p) applyPreset(p); }, { 'aria-label': 'Saved load tests' }),
    h('button.btn.btn-sm', { type: 'button', onclick: savePreset }, 'Save test'),
    state.presets.length ? h('button.btn.btn-sm', { type: 'button', onclick: managePresets }, 'Manage') : null);

  mount(el,
    h('div.lt-head', h('h2', 'Load test'), presetBar),
    h('label.field', h('span', 'Run name (optional)'), h('input.input', { value: c.name || '', placeholder: 'e.g. Checkout soak test', oninput: (e) => { c.name = e.target.value; persist(); } })),
    section('Target', segmented([['request', 'Single request'], ['collection', 'Collection flow']], targetType, (v) => {
      if (v === 'collection') { const col = findCollection(lt.target?.collectionId) || state.collections[0]; lt.target = col ? { type: 'collection', collectionId: col.id, requestIds: col.requests.map((r) => r.id) } : { type: 'collection' }; }
      else lt.target = currentTabTarget();
      storageSet('apistorm.ltTarget', lt.target); renderTarget();
    }, { label: 'Target type' }), targetBox, h('label.field', h('span', 'Environment'), envSel)),
    section('Load model', segmented([['rate', 'Fixed rate (TPS)'], ['vus', 'Virtual users']], c.mode, (v) => { c.mode = v; persist(); rerender(); }, { label: 'Load model' }),
      h('p.muted.small', isRate ? 'Open model: new iterations start on schedule regardless of how fast the server answers. Best for TPS targets.' : 'Closed model: a fixed number of users each wait for the response before the next request. Best for concurrency and bulk sends.'),
      model),
    section('Throttle & pacing', throttle),
    section('HTTP', httpBox),
    section('Test data (CSV)', dataBox),
    section('Callbacks', cbBox),
    section('Thresholds (pass / fail)', thrBox),
    section('Safety', safety),
    h('div.lt-actions',
      h('button.btn.btn-primary.btn-lg', { type: 'button', onclick: start }, '▶ Start test'),
      h('button.btn', { type: 'button', onclick: scheduleThis, title: 'Run this test automatically (once, on an interval or on a cron schedule)' }, '⏰ Schedule…'),
      h('button.btn', { type: 'button', onclick: exportK6, title: 'Generate an equivalent k6 script' }, 'Export k6 script'),
      h('button.btn', { type: 'button', onclick: () => { if (lt.config) { lt.config = { ...defaults(), mode: lt.config.mode }; persist(); rerender(); } } }, 'Reset')));
}

function loadData(text, name = '') {
  let rows = [];
  try {
    if (/\.json$/i.test(name) || /^\s*\[/.test(text)) { rows = JSON.parse(text); if (!Array.isArray(rows)) throw new Error('JSON must be an array of objects'); }
    else rows = parseCsv(text);
  } catch (e) { toast(`Could not read data: ${e.message}`, 'error'); return; }
  if (!rows.length) { toast('No rows found (the first line must be a header row)', 'warn'); return; }
  lt.config.data.rows = rows;
  toast(`Loaded ${rows.length} data rows`, 'ok');
  renderConfig();
}

function pasteData() {
  let text = '';
  modal({ title: 'Paste CSV data', wide: true, body: (el) => el.append(h('p.muted.small', 'First line is the header. Each column becomes a {{variable}}.'), h('textarea.input.mono', { rows: 12, placeholder: 'userId,email\n1,a@example.com\n2,b@example.com', oninput: (e) => { text = e.target.value; } })),
    actions: [{ label: 'Cancel' }, { label: 'Use data', primary: true, onClick: () => loadData(text) }] });
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') q = false; else field += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const clean = rows.filter((r) => r.some((v) => v !== ''));
  if (clean.length < 2) return [];
  const head = clean[0].map((x) => x.trim());
  return clean.slice(1).map((r) => Object.fromEntries(head.map((k, i) => [k, r[i] ?? ''])));
}

async function savePreset() {
  const name = await promptDialog('Save load test', lt.config.name || '', { label: 'Name', okLabel: 'Save' });
  if (!name) return;
  const existing = state.presets.find((p) => p.name === name);
  const body = { name, config: { ...lt.config }, target: lt.target, environmentId: lt.envId === undefined ? activeEnvId() : lt.envId };
  const saved = existing ? await api.put(`/api/presets/${existing.id}`, body) : await api.post('/api/presets', body);
  state.presets = existing ? state.presets.map((p) => (p.id === saved.id ? saved : p)) : [...state.presets, saved];
  emit('presets');
  toast(`Saved "${name}"`, 'ok');
}

function applyPreset(p) {
  lt.config = { ...defaults(), ...structuredClone(p.config), data: { mode: 'sequential', rows: [], ...(p.config.data || {}) } };
  lt.target = p.target ? structuredClone(p.target) : lt.target;
  lt.envId = p.environmentId ?? undefined;
  persist(); storageSet('apistorm.ltTarget', lt.target);
  renderConfig();
  toast(`Loaded "${p.name}"`, 'ok', 1500);
}

function managePresets() {
  const picked = new Set();
  modal({
    title: 'Saved load tests', wide: true,
    body: (el) => {
      const render = () => mount(el, state.presets.length ? [
        h('p.muted.small', 'Tick several tests and press "Start selected" to run them at the same time.'),
        h('table.table', state.presets.map((p) => h('tr',
          h('td', h('input', { type: 'checkbox', 'aria-label': `Select ${p.name}`, checked: picked.has(p.id), onchange: (e) => { if (e.target.checked) picked.add(p.id); else picked.delete(p.id); } })),
          h('td', h('b', p.name), h('div.small.muted', `${p.config.mode === 'vus' ? `${p.config.vus} VUs` : p.config.useStages ? 'stages' : `${p.config.tps} TPS`} · saved ${fmtTime(p.savedAt)}`)),
          h('td.right',
            h('button.btn.btn-sm', { type: 'button', onclick: () => startPresets([p.id]) }, '▶ Start'), ' ',
            h('button.btn.btn-sm', { type: 'button', onclick: () => applyPreset(p) }, 'Load'), ' ',
            h('button.btn.btn-sm', { type: 'button', onclick: () => emit('schedule:new', { kind: 'loadtest', name: p.name, loadtest: { presetId: p.id }, environmentId: p.environmentId || null }) }, '⏰'), ' ',
            h('button.btn.btn-sm.btn-danger', { type: 'button', onclick: async () => { if (!(await confirmDialog(`Delete saved test "${p.name}"?`, { danger: true, okLabel: 'Delete' }))) return; await api.del(`/api/presets/${p.id}`); state.presets = state.presets.filter((x) => x.id !== p.id); picked.delete(p.id); emit('presets'); render(); } }, 'Delete'))))),
      ] : h('p.muted', 'Nothing saved yet.'));
      render();
    },
    actions: [{ label: 'Close' }, { label: '▶ Start selected', primary: true, onClick: () => { if (!picked.size) { toast('Tick at least one test', 'warn'); return false; } startPresets([...picked]); } }],
  });
}

async function startPresets(ids) {
  let first = null;
  for (const id of ids) {
    try { const r = await api.post(`/api/presets/${id}/start`); first ||= r.id; } catch (e) { toast(e.message, 'error'); }
  }
  if (first) { showRun(ids.length > 1 ? 'overview' : first); toast(`Started ${ids.length} test(s)`, 'ok'); }
}

function scheduleThis() {
  let payload;
  try { payload = requestPayload(); } catch (e) { toast(e.message, 'warn'); return; }
  emit('schedule:new', { kind: 'loadtest', name: lt.config.name || 'Scheduled load test', loadtest: { config: { ...payload.config, data: payload.config.data }, target: payload.target }, environmentId: payload.environmentId });
}

function requestPayload() {
  const t = lt.target;
  if (!t || (t.type === 'request' && !t.request) || (t.type === 'collection' && !t.collectionId)) throw new Error('Choose a target request or collection first');
  if (t.type === 'collection' && t.requestIds && !t.requestIds.length) throw new Error('Select at least one request of the collection');
  const cfg = { ...lt.config };
  return { target: t, environmentId: lt.envId === undefined ? activeEnvId() : lt.envId || null, config: cfg };
}

async function start() {
  let payload;
  try { payload = requestPayload(); } catch (e) { toast(e.message, 'warn'); return; }
  const c = payload.config;
  const est = c.mode === 'vus' ? null : (c.useStages ? 0 : (Number(c.tps) || 0) * ((Number(c.durationSec) || 0) + (Number(c.rampUpSec) || 0) / 2));
  if (est && est > 200000 && !(await confirmDialog(`This will send roughly ${fmtNum(est)} iterations. Make sure you are allowed to put this much load on the target. Continue?`, { okLabel: 'Start' }))) return;
  try {
    const { id } = await api.post('/api/runs', payload);
    showRun(id);
    toast('Load test started. You can start more tests; each gets its own tab.', 'ok', 2500);
  } catch (e) { toast(e.message, 'error'); }
}

async function exportK6() {
  try {
    const { script } = await api.post('/api/export/k6', requestPayload());
    modal({ title: 'k6 script', wide: true, body: (el) => el.append(h('p.muted.small', 'Run with: k6 run script.js (variables are resolved at export time; data rows are embedded).'), h('pre.code.k6-code', script)),
      actions: [{ label: 'Copy', onClick: () => { copyText(script); return false; } }, { label: 'Download', primary: true, onClick: () => download('loadtest.k6.js', script, 'text/javascript') }] });
  } catch (e) { toast(e.message, 'warn'); }
}

export { showRun, onRunEvent } from './dashboard.js';

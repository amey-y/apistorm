import { h, mount, toast, modal, confirmDialog, fmtNum, fmtMs, fmtTime } from './dom.js';
import { api } from './api.js';
import { emit } from './state.js';

const rv = { runs: [], active: [], selected: new Set(), el: null };

export function initRuns(root) { rv.el = root; }

export async function refreshRuns() {
  const { runs, active } = await api.get('/api/runs');
  rv.runs = runs; rv.active = active;
  render();
}

function render() {
  if (!rv.el) return;
  const rows = rv.runs.map((r) => h('tr', { class: 'clickable', onclick: (e) => { if (e.target.closest('input,button')) return; emit('loadtest:show-run', r.id); } },
    h('td', h('input', { type: 'checkbox', 'aria-label': `Select ${r.name} for comparison`, checked: rv.selected.has(r.id), onchange: (e) => { if (e.target.checked) rv.selected.add(r.id); else rv.selected.delete(r.id); render(); } })),
    h('td', h('b', r.name || r.id), h('div.small.muted', `${r.target || ''}${r.environment ? ' · ' + r.environment : ''}${r.source ? ' · ' + r.source : ''}`)),
    h('td.small', fmtTime(r.startedAt)),
    h('td', h(`span.run-status.rs-${r.status}`, r.status), r.thresholds ? h(`span.run-status.${r.passed ? 'rs-completed' : 'rs-failed'}`, r.passed ? '✔' : '✖') : null),
    h('td.num', fmtNum(r.elapsedSec, 0) + 's'),
    h('td.num', fmtNum(r.count)),
    h('td.num', fmtNum(r.rps, 1)),
    h(`td.num${r.errorRate > 0 ? '.bad' : ''}`, `${fmtNum(r.errorRate, 2)}%`),
    h('td.num', fmtMs(r.p50)), h('td.num', fmtMs(r.p95)), h('td.num', fmtMs(r.p99)),
    h('td.right', h('button.icon-btn', { type: 'button', 'aria-label': 'Delete run', title: 'Delete', onclick: async () => { if (await confirmDialog(`Delete run "${r.name}"?`, { danger: true, okLabel: 'Delete' })) { await api.del(`/api/runs/${r.id}`); rv.selected.delete(r.id); refreshRuns(); } } }, '🗑'))));
  mount(rv.el, h('div.runs',
    h('div.runs-head', h('h2', 'Load test runs'), h('span.spacer'),
      h('button.btn', { type: 'button', disabled: rv.selected.size < 2, onclick: compare, title: 'Select two or more runs' }, `Compare${rv.selected.size ? ` (${rv.selected.size})` : ''}`),
      h('button.btn.btn-danger', { type: 'button', disabled: !rv.runs.length, onclick: async () => {
        if (!(await confirmDialog(`Delete all ${rv.runs.length} saved runs and their results? This cannot be undone.`, { danger: true, okLabel: 'Delete all', title: 'Clear run history' }))) return;
        await api.del('/api/runs'); rv.selected.clear(); refreshRuns(); toast('Run history cleared', 'ok');
      } }, 'Clear all')),
    rv.active.length ? h('div.card', h('h3', 'Running now'), rv.active.map((a) => h('div.row-gap', h('span.run-status.rs-running', '● running'), h('button.link', { type: 'button', onclick: () => emit('loadtest:show-run', a.id) }, a.name)))) : null,
    rv.runs.length
      ? h('div.table-scroll', h('table.table.runs-table', h('thead', h('tr', h('th', ''), h('th', 'Run'), h('th', 'Started'), h('th', 'Status'), ...['Duration', 'Requests', 'Req/s', 'Failed', 'p50', 'p95', 'p99'].map((x) => h('th.num', x)), h('th', ''))), h('tbody', rows)))
      : h('div.empty', h('p', 'No runs yet.'), h('p.muted', 'Start a test in the Load Test tab. Results are saved automatically.'))));
}

async function compare() {
  const ids = [...rv.selected];
  try {
    const runs = await Promise.all(ids.map((id) => api.get(`/api/runs/${id}`)));
    const metrics = [
      ['Requests', (r) => r.summary.count, (v) => fmtNum(v)],
      ['Avg req/s', (r) => r.summary.rps, (v) => fmtNum(v, 1), 'high'],
      ['Failed %', (r) => r.summary.errorRate, (v) => `${fmtNum(v, 2)}%`, 'low'],
      ['avg', (r) => r.summary.latency.avg, fmtMs, 'low'],
      ['p50', (r) => r.summary.latency.p50, fmtMs, 'low'],
      ['p90', (r) => r.summary.latency.p90, fmtMs, 'low'],
      ['p95', (r) => r.summary.latency.p95, fmtMs, 'low'],
      ['p99', (r) => r.summary.latency.p99, fmtMs, 'low'],
      ['max', (r) => r.summary.latency.max, fmtMs, 'low'],
      ['Dropped', (r) => r.live?.dropped, (v) => fmtNum(v), 'low'],
      ['Callback p95', (r) => r.callbacks?.latency?.p95, fmtMs, 'low'],
    ];
    modal({
      title: 'Compare runs', wide: true,
      body: h('div.table-scroll', h('table.table', h('thead', h('tr', h('th', 'Metric'), runs.map((r) => h('th.num', h('div', r.name), h('div.small.muted', fmtTime(r.startedAt)))))),
        h('tbody', metrics.map(([label, get, fmt, better]) => {
          const vals = runs.map((r) => get(r));
          const nums = vals.filter((v) => v != null);
          const allEqual = nums.every((v) => v === nums[0]);
          const best = better && nums.length > 1 && !allEqual ? (better === 'low' ? Math.min(...nums) : Math.max(...nums)) : null;
          return h('tr', h('td', label), vals.map((v) => h(`td.num${best != null && v === best ? '.best' : ''}`, v == null ? '–' : fmt(v), best != null && v === best ? ' ★' : '')));
        })))),
      actions: [{ label: 'Close' }],
    });
  } catch (e) { toast(e.message, 'error'); }
}

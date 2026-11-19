import { h, clear, mount, toast, modal, confirmDialog, select, segmented, numField, checkField, fmtTime, fmtMs, methodClass, debounce } from './dom.js';
import { api } from './api.js';
import { state, emit, on, findCollection, activeEnvId } from './state.js';

const sv = { list: [], el: null, timer: null };

export function initSchedules(root) {
  sv.el = root;
  on('schedule:new', (draft) => editSchedule(draft));
  // keep the "next run in…" countdown fresh while the view is open
  sv.timer = setInterval(() => { if (state.view === 'schedules') render(); }, 15000);
}

export async function refreshSchedules() {
  sv.list = await api.get('/api/schedules');
  render();
}

const KIND = { request: ['↗', 'Single request'], bulk: ['☰', 'Bulk send'], loadtest: ['⚡', 'Load test'] };

function rel(iso) {
  if (!iso) return '–';
  const d = Date.parse(iso) - Date.now();
  const a = Math.abs(d);
  const txt = a < 60e3 ? `${Math.round(a / 1000)}s` : a < 3600e3 ? `${Math.round(a / 60e3)} min` : a < 86400e3 ? `${(a / 3600e3).toFixed(1)} h` : `${(a / 86400e3).toFixed(1)} days`;
  return d >= 0 ? `in ${txt}` : `${txt} ago`;
}

function targetText(s) {
  if (s.kind === 'request') {
    const c = findCollection(s.request?.collectionId);
    const r = c?.requests.find((x) => x.id === s.request.requestId);
    return r ? [h(`span.method.${methodClass(r.method)}`, r.method), ` ${c.name} / ${r.name}`] : h('span.bad', 'request deleted');
  }
  if (s.kind === 'bulk') {
    const c = findCollection(s.bulk?.collectionId);
    if (!c) return h('span.bad', 'collection deleted');
    const n = s.bulk.requestIds?.length || c.requests.length;
    return `${c.name}: ${n} request(s) × ${s.bulk.iterations || 1}, ${s.bulk.concurrency || 1} at a time`;
  }
  if (s.loadtest?.presetId) return `saved test: ${state.presets.find((p) => p.id === s.loadtest.presetId)?.name || '(deleted)'}`;
  const c = s.loadtest?.config || {};
  return `${c.mode === 'vus' ? `${c.vus} VUs` : c.useStages ? 'staged rate' : `${c.tps} TPS`} on ${s.loadtest?.target?.type === 'collection' ? findCollection(s.loadtest.target.collectionId)?.name || 'collection' : s.loadtest?.target?.request?.name || 'request'}`;
}

function statusPill(st) {
  if (!st) return h('span.muted', 'never run');
  const cls = { passed: 'rs-completed', failed: 'rs-failed', error: 'rs-failed', skipped: 'rs-stopped', missed: 'rs-stopped' }[st] || '';
  const icon = { passed: '✔', failed: '✖', error: '✖', skipped: '⏭', missed: '⚠' }[st] || '';
  return h(`span.run-status.${cls}`, `${icon} ${st}`);
}

function render() {
  if (!sv.el) return;
  const rows = sv.list.map((s) => h('tr',
    h('td', h('label.switch', { title: s.enabled ? 'Enabled' : 'Paused' }, h('input', { type: 'checkbox', checked: s.enabled, 'aria-label': `Enable ${s.name}`, onchange: async (e) => { await api.put(`/api/schedules/${s.id}`, { ...s, enabled: e.target.checked }); refreshSchedules(); } }), h('span.switch-ui'))),
    h('td', h('b', s.name), h('div.small.muted', KIND[s.kind][0], ' ', KIND[s.kind][1], ' · ', targetText(s))),
    h('td.small', s.triggerText),
    h('td.small', s.state.running ? h('span.run-status.rs-running', '● running') : s.enabled && s.state.nextRunAt ? h('span', { title: fmtTime(s.state.nextRunAt) }, rel(s.state.nextRunAt)) : h('span.muted', !s.enabled ? 'paused' : s.trigger?.type === 'manual' ? 'manual' : 'no further runs')),
    h('td.small', statusPill(s.state.lastStatus), s.state.lastRunAt ? h('div.muted', rel(s.state.lastRunAt)) : null),
    h('td.right.nowrap',
      h('button.btn.btn-sm', { type: 'button', title: 'Run now', onclick: async () => { await api.post(`/api/schedules/${s.id}/run`); toast(`"${s.name}" started`, 'ok', 1500); setTimeout(refreshSchedules, 600); } }, '▶ Run now'), ' ',
      h('button.btn.btn-sm', { type: 'button', onclick: () => historyDialog(s) }, `History (${s.history?.length || 0})`), ' ',
      h('button.btn.btn-sm', { type: 'button', onclick: () => editSchedule(s) }, 'Edit'), ' ',
      h('button.icon-btn', { type: 'button', 'aria-label': `Delete ${s.name}`, title: 'Delete', onclick: async () => { if (await confirmDialog(`Delete schedule "${s.name}"?`, { danger: true, okLabel: 'Delete' })) { await api.del(`/api/schedules/${s.id}`); refreshSchedules(); } } }, '🗑'))));
  mount(sv.el, h('div.runs',
    h('div.runs-head', h('h2', 'Schedules'), h('span.spacer'), h('button.btn.btn-primary', { type: 'button', onclick: () => editSchedule({}) }, '+ New schedule')),
    h('p.muted.small', 'Run a request, a bulk send or a load test automatically: once, every N minutes/hours/days, or on a cron expression. Schedules run inside the ApiStorm server, so it has to be running (the Docker image is ideal for that). Results of bulk sends and load tests appear in Runs.'),
    sv.list.length
      ? h('div.table-scroll', h('table.table.sched-table', h('thead', h('tr', h('th', 'On'), h('th', 'Schedule'), h('th', 'When'), h('th', 'Next run'), h('th', 'Last result'), h('th', ''))), h('tbody', rows)))
      : h('div.empty', h('p', 'No schedules yet.'), h('p.muted', 'Create one here, from a request\'s ⋯ menu, a collection\'s ⋯ menu ("Schedule bulk send"), or the Load test view ("Schedule…").'))));
}

function historyDialog(s) {
  modal({
    title: `History: ${s.name}`, wide: true,
    body: (el) => mount(el, s.history?.length ? h('div.table-scroll', h('table.table', h('thead', h('tr', h('th', 'When'), h('th', 'Result'), h('th', 'Summary'), h('th.num', 'Took'), h('th', ''))),
      h('tbody', s.history.map((x) => h('tr', h('td.small', fmtTime(x.at), x.manual ? h('div.muted', 'manual') : null), h('td', statusPill(x.status)), h('td.small', x.summary || ''), h('td.num.small', x.durationMs != null ? fmtMs(x.durationMs) : '–'),
        h('td', x.runId ? h('button.btn.btn-sm', { type: 'button', onclick: () => { document.querySelector('.modal-back')?.remove(); emit('loadtest:show-run', x.runId); } }, 'Open run') : null))))))
      : h('p.muted', 'This schedule has not run yet.')),
    actions: [{ label: 'Clear history', danger: true, onClick: async () => { if (!(await confirmDialog('Clear the history of this schedule?', { danger: true, okLabel: 'Clear' }))) return false; await api.del(`/api/schedules/${s.id}/history`); refreshSchedules(); } }, { label: 'Close', primary: true }],
  });
}

const toLocalInput = (iso) => {
  const d = iso ? new Date(iso) : new Date(Date.now() + 10 * 60e3);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

export function editSchedule(src = {}) {
  const editing = !!src.id;
  const d = {
    name: '', enabled: true, kind: 'request', environmentId: activeEnvId(), overlap: 'skip',
    trigger: { type: 'interval', every: 15, unit: 'minutes' }, notify: { webhookUrl: '', onlyOnFailure: false },
    ...structuredClone(src),
  };
  d.request ||= { collectionId: state.collections[0]?.id || null, requestId: state.collections[0]?.requests[0]?.id || null };
  d.bulk ||= { collectionId: state.collections[0]?.id || null, requestIds: [], iterations: 10, concurrency: 1, delayMs: 0, maxErrorRate: 0 };
  d.loadtest ||= { presetId: state.presets[0]?.id || null };
  d.notify ||= { webhookUrl: '', onlyOnFailure: false };

  modal({
    title: editing ? `Edit schedule: ${src.name}` : 'New schedule', wide: true,
    body: (el) => {
      const kindBox = h('div');
      const trigBox = h('div');
      const renderKind = () => {
        clear(kindBox);
        if (d.kind === 'request') {
          const opts = [];
          for (const c of state.collections) for (const r of c.requests) opts.push([`${c.id}::${r.id}`, `${c.name} / ${r.method} ${r.name}`]);
          kindBox.append(h('label.field', h('span', 'Request (saved in a collection)'), opts.length ? select(opts, `${d.request.collectionId}::${d.request.requestId}`, (v) => { const [cid, rid] = v.split('::'); d.request = { collectionId: cid, requestId: rid }; }) : h('p.muted', 'Save a request to a collection first.')),
            h('p.muted.small', 'Sends once per trigger, like pressing Send. Passes when there is no network error, the status is below 400 (or matches your status check) and all checks pass. Responses appear in History.'));
        } else if (d.kind === 'bulk') {
          const col = findCollection(d.bulk.collectionId) || state.collections[0];
          if (!col) { kindBox.append(h('p.muted', 'Create a collection first.')); return; }
          d.bulk.collectionId = col.id;
          const ids = new Set(d.bulk.requestIds?.length ? d.bulk.requestIds : col.requests.map((r) => r.id));
          kindBox.append(
            h('label.field', h('span', 'Collection'), select(state.collections.map((c) => [c.id, c.name]), col.id, (v) => { d.bulk.collectionId = v; d.bulk.requestIds = []; renderKind(); })),
            h('div.req-checklist', col.requests.map((r) => h('label.check', h('input', { type: 'checkbox', checked: ids.has(r.id), onchange: (e) => { if (e.target.checked) ids.add(r.id); else ids.delete(r.id); d.bulk.requestIds = col.requests.filter((x) => ids.has(x.id)).map((x) => x.id); } }), h(`span.method.${methodClass(r.method)}`, r.method), h('span', r.name)))),
            h('div.form-grid',
              numField('Iterations', d.bulk.iterations, (v) => { d.bulk.iterations = v; }, { min: 1, hint: 'How many times to run the selected requests in total.' }),
              numField('Concurrency', d.bulk.concurrency, (v) => { d.bulk.concurrency = v; }, { min: 1, hint: 'Iterations running at the same time.' }),
              numField('Delay between iterations', d.bulk.delayMs, (v) => { d.bulk.delayMs = v; }, { min: 0, suffix: 'ms' }),
              numField('Allowed failures', d.bulk.maxErrorRate, (v) => { d.bulk.maxErrorRate = v; }, { min: 0, suffix: '%', hint: 'The execution counts as failed above this error rate.' })));
        } else {
          const opts = [...(src.loadtest?.config ? [['__inline', 'The test currently configured in the Load test view']] : []), ...state.presets.map((p) => [p.id, p.name])];
          const cur = d.loadtest.presetId || (d.loadtest.config ? '__inline' : '');
          kindBox.append(opts.length
            ? h('label.field', h('span', 'Load test'), select(opts, cur, (v) => { d.loadtest = v === '__inline' ? structuredClone(src.loadtest) : { presetId: v }; }))
            : h('p.muted', 'Save a load test first (Load test view → Save test).'),
          h('p.muted.small', 'A saved test is read when the schedule fires, so later edits to it are picked up. Passing means the test completed and its thresholds passed.'));
        }
      };
      const cronInfo = h('div.small.cron-info');
      const previewCron = debounce(async () => {
        const out = await api.post('/api/cron/preview', { cron: d.trigger.cron || '' });
        mount(cronInfo, out.ok ? [h('div', '✔ ', out.description), h('div.muted', 'Next: ', out.next.map((x) => fmtTime(x)).join(' · '))] : h('span.bad', '✖ ' + out.error));
      }, 250);
      const renderTrig = () => {
        clear(trigBox);
        const t = d.trigger;
        if (t.type === 'once') trigBox.append(h('label.field', h('span', 'Date and time (your local time)'), h('input.input', { type: 'datetime-local', value: toLocalInput(t.at), oninput: (e) => { t.at = new Date(e.target.value).toISOString(); } })));
        if (t.type === 'once' && !t.at) t.at = new Date(toLocalInput()).toISOString();
        if (t.type === 'interval') trigBox.append(h('div.form-grid', numField('Every', t.every, (v) => { t.every = v; }, { min: 1 }), h('label.field', h('span', 'Unit'), select([['minutes', 'minutes'], ['hours', 'hours'], ['days', 'days']], t.unit || 'minutes', (v) => { t.unit = v; }))));
        if (t.type === 'cron') {
          t.cron ||= '0 9 * * 1-5';
          const input = h('input.input.mono', { value: t.cron, placeholder: 'min hour day month weekday', 'aria-label': 'Cron expression', oninput: (e) => { t.cron = e.target.value; previewCron(); } });
          trigBox.append(h('label.field', h('span', 'Cron expression (minute hour day-of-month month day-of-week, local time)'), input),
            h('div.row-gap', [['*/5 * * * *', 'Every 5 min'], ['0 * * * *', 'Hourly'], ['0 9 * * *', 'Daily 09:00'], ['0 9 * * 1-5', 'Weekdays 09:00'], ['0 2 * * 0', 'Sundays 02:00']].map(([c, l]) => h('button.chip', { type: 'button', onclick: () => { t.cron = c; input.value = c; previewCron(); } }, l))),
            cronInfo);
          previewCron();
        }
        if (t.type === 'manual') trigBox.append(h('p.muted.small', 'Runs only when you press "Run now".'));
      };
      renderKind();
      renderTrig();
      el.append(
        h('label.field', h('span', 'Name'), h('input.input', { value: d.name, placeholder: 'e.g. Nightly checkout smoke test', oninput: (e) => { d.name = e.target.value; } })),
        h('label.field', h('span', 'What to run')),
        segmented([['request', '↗ Single request'], ['bulk', '☰ Bulk send'], ['loadtest', '⚡ Load test']], d.kind, (v) => { d.kind = v; renderKind(); }, { label: 'What to run' }),
        kindBox,
        h('label.field', h('span', 'Environment'), select([['', '(no environment)'], ...state.environments.map((e) => [e.id, e.name])], d.environmentId || '', (v) => { d.environmentId = v || null; })),
        h('label.field', h('span', 'When')),
        segmented([['once', 'Once'], ['interval', 'Every…'], ['cron', 'Cron'], ['manual', 'Manual only']], d.trigger.type, (v) => { d.trigger = v === 'interval' ? { type: v, every: 15, unit: 'minutes' } : { type: v }; renderTrig(); }, { label: 'Trigger' }),
        trigBox,
        checkField('Skip a run if the previous one is still running', d.overlap !== 'allow', (v) => { d.overlap = v ? 'skip' : 'allow'; }),
        h('h4', 'Notification (optional)'),
        h('label.field', h('span', 'Webhook URL: receives a JSON summary after each run (works with Slack, Teams, Discord and Mattermost incoming webhooks)'),
          h('input.input.mono', { value: d.notify.webhookUrl || '', placeholder: 'https://hooks.slack.com/services/…', oninput: (e) => { d.notify.webhookUrl = e.target.value.trim(); } })),
        checkField('Only notify when it fails', d.notify.onlyOnFailure, (v) => { d.notify.onlyOnFailure = v; }),
        checkField('Enabled', d.enabled, (v) => { d.enabled = v; }));
    },
    actions: [{ label: 'Cancel' }, { label: editing ? 'Save' : 'Create schedule', primary: true, onClick: async () => {
      if (!d.name.trim()) { toast('Give the schedule a name', 'warn'); return false; }
      const body = { ...d };
      if (body.kind !== 'request') delete body.request;
      if (body.kind !== 'bulk') delete body.bulk;
      if (body.kind !== 'loadtest') delete body.loadtest;
      try {
        if (editing) await api.put(`/api/schedules/${src.id}`, body); else await api.post('/api/schedules', body);
        toast(editing ? 'Schedule saved' : 'Schedule created', 'ok');
        emit('schedules:changed');
        refreshSchedules();
      } catch (e) { toast(e.message, 'error'); return false; }
    } }],
  });
}

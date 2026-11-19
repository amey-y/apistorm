/* Mock servers view: create from OpenAPI (JSON/YAML), edit routes, latency, error injection, start/stop. */
import { h, clear, mount, toast, modal, confirmDialog, select, kvEditor, numField, checkField, copyText, readFileText, methodClass } from './dom.js';
import { api } from './api.js';
import { emit, loadWorkspace } from './state.js';

const mv = { list: [], current: null, route: null, el: null };

export function initMocks(root) { mv.el = root; }

export async function refreshMocks() {
  mv.list = await api.get('/api/mocks');
  if (!mv.list.some((m) => m.id === mv.current)) mv.current = mv.list[0]?.id || null;
  render();
}

function render() {
  if (!mv.el) return;
  const m = mv.list.find((x) => x.id === mv.current);
  mount(mv.el, h('div.cb',
    h('aside.cb-side',
      h('div.cb-side-head', h('h2', 'Mock servers')),
      h('p.muted.small', 'Fake APIs on their own ports: develop and test before the real service exists, or load test your client without hitting production. Every request is logged in the Callbacks tab.'),
      h('div.row-gap', h('button.btn.btn-sm.btn-primary', { type: 'button', onclick: fromOpenApi }, '+ From OpenAPI'), h('button.btn.btn-sm', { type: 'button', onclick: emptyMock }, '+ Empty mock')),
      h('div.bin-list', mv.list.map((x) => h(`button.bin-item${x.id === mv.current ? '.on' : ''}`, { type: 'button', onclick: () => { mv.current = x.id; mv.route = null; render(); } },
        h(`span.chip-dot.${x.running ? 'rs-dot-running' : x.error ? 'rs-dot-failed' : 'rs-dot-stopped'}`, { 'aria-hidden': 'true' }), h('span.bin-name', x.name), h('span.count', `:${x.port}`)))),
      !mv.list.length ? h('p.muted.small', 'No mocks yet.') : null),
    h('section.cb-main.mock-main', m ? mockDetail(m) : h('div.lt-empty', h('h2', 'No mock selected'), h('p.muted', 'Create one from an OpenAPI spec (JSON or YAML): every operation becomes a route that answers with the example from the spec, or a generated sample.')))));
}

function mockDetail(m) {
  const d = structuredClone(m);
  const saveSettings = async () => {
    try {
      await api.put(`/api/mocks/${m.id}`, { name: d.name, port: Number(d.port), host: d.host, delayMs: Number(d.delayMs) || 0, jitterMs: Number(d.jitterMs) || 0, errorRate: Number(d.errorRate) || 0, errorStatus: Number(d.errorStatus) || 500, validate: d.validate, cors: d.cors, record: d.record });
      toast('Mock settings saved', 'ok', 1500);
      refreshMocks();
    } catch (e) { toast(e.message, 'error'); }
  };
  const routes = h('div.table-scroll', h('table.table.routes-table', h('thead', h('tr', h('th', ''), h('th', 'Method'), h('th', 'Path'), h('th.num', 'Status'), h('th.num', 'Delay'), h('th', 'Validation'), h('th', ''))),
    h('tbody', m.routes.map((r) => h(`tr.clickable${mv.route === r.id ? '.sel' : ''}`, { onclick: (e) => { if (e.target.closest('input,button')) return; mv.route = r.id; render(); } },
      h('td', h('input', { type: 'checkbox', checked: r.enabled !== false, 'aria-label': `Enable ${r.method} ${r.path}`, onchange: async (e) => { r.enabled = e.target.checked; await api.put(`/api/mocks/${m.id}`, { routes: m.routes }); refreshMocks(); } })),
      h('td', h(`span.method.${methodClass(r.method)}`, r.method)), h('td.mono.small', r.path, r.name ? h('div.muted', r.name) : null), h('td.num', r.status), h('td.num', r.delayMs ? `${r.delayMs} ms` : '–'),
      h('td.small', r.requestSchema ? '✔ schema' : '–'),
      h('td.right', h('button.icon-btn', { type: 'button', 'aria-label': 'Delete route', onclick: async () => { if (!(await confirmDialog(`Delete route ${r.method} ${r.path}?`, { danger: true, okLabel: 'Delete' }))) return; await api.put(`/api/mocks/${m.id}`, { routes: m.routes.filter((x) => x.id !== r.id) }); refreshMocks(); } }, '🗑')))))));
  const route = m.routes.find((r) => r.id === mv.route);
  return h('div.mock-detail',
    h('div.dash-title', h('h2', m.name), h(`span.run-status.${m.running ? 'rs-completed' : m.error ? 'rs-failed' : 'rs-stopped'}`, m.running ? '● running' : m.error ? `✖ ${m.error}` : 'stopped'), h('span.spacer'),
      m.running ? h('button.btn', { type: 'button', onclick: async () => { await api.post(`/api/mocks/${m.id}/stop`); refreshMocks(); } }, '■ Stop')
        : h('button.btn.btn-primary', { type: 'button', onclick: async () => { try { await api.post(`/api/mocks/${m.id}/start`); } catch (e) { toast(e.message, 'error'); } refreshMocks(); } }, '▶ Start'),
      h('button.btn', { type: 'button', onclick: () => emit('callbacks:open-bin', m.bin) }, 'Request log'),
      h('button.btn.btn-danger', { type: 'button', onclick: async () => { if (!(await confirmDialog(`Delete mock server "${m.name}" and its request log?`, { danger: true, okLabel: 'Delete' }))) return; await api.del(`/api/mocks/${m.id}`); mv.current = null; refreshMocks(); } }, 'Delete')),
    h('div.cb-url', h('span.muted.small', 'Base URL'), h('code.mono', m.baseUrl), h('button.btn.btn-sm', { type: 'button', onclick: () => copyText(m.baseUrl, 'Mock URL copied') }, 'Copy')),
    h('details.card', { open: false }, h('summary', 'Settings: latency, errors, validation'),
      h('div.form-grid',
        h('label.field', h('span', 'Name'), h('input.input', { value: d.name, oninput: (e) => { d.name = e.target.value; } })),
        numField('Port', d.port, (v) => { d.port = v; }, { min: 1, max: 65535, hint: 'In Docker use 7100-7110 (published by docker-compose).' }),
        h('label.field', h('span', 'Listen on'), select([['127.0.0.1', 'This computer only'], ['0.0.0.0', 'All network interfaces']], d.host || '127.0.0.1', (v) => { d.host = v; })),
        numField('Latency', d.delayMs, (v) => { d.delayMs = v; }, { min: 0, step: 10, suffix: 'ms', hint: 'Added to every response (a route can set its own).' }),
        numField('Random jitter', d.jitterMs, (v) => { d.jitterMs = v; }, { min: 0, step: 10, suffix: 'ms' }),
        numField('Error rate', d.errorRate, (v) => { d.errorRate = v; }, { min: 0, max: 100, step: 0.5, suffix: '%', hint: 'Share of requests that get the error status instead (chaos testing).' }),
        numField('Error status', d.errorStatus, (v) => { d.errorStatus = v; }, { min: 400, max: 599 })),
      h('div.row-gap',
        checkField('Validate request bodies against the spec (400 on mismatch)', d.validate !== false, (v) => { d.validate = v; }),
        checkField('CORS headers', d.cors !== false, (v) => { d.cors = v; }),
        checkField('Log requests', d.record !== false, (v) => { d.record = v; })),
      h('div.row-gap', h('button.btn.btn-primary.btn-sm', { type: 'button', onclick: saveSettings }, 'Save settings'))),
    h('div.row-gap', h('h3', `Routes (${m.routes.length})`), h('span.spacer'), h('button.btn.btn-sm', { type: 'button', onclick: () => { const r = { id: crypto.randomUUID().slice(0, 10), enabled: true, method: 'GET', path: '/new', status: 200, headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }], body: '{"ok": true}', delayMs: 0 }; api.put(`/api/mocks/${m.id}`, { routes: [...m.routes, r] }).then(() => { mv.route = r.id; refreshMocks(); }); } }, '+ Route')),
    routes,
    route ? routeEditor(m, route) : h('p.muted.small', 'Click a route to edit its response. Paths support {param} and *; the body can use {{request.params.id}}, {{request.query.x}}, {{request.body.field}}, {{request.headers.name}} and dynamic values like {{$uuid}}.'));
}

function routeEditor(m, route) {
  const r = structuredClone(route);
  r.headers ||= [];
  return h('div.card.route-editor',
    h('h3', 'Route'),
    h('div.form-grid',
      h('label.field', h('span', 'Method'), select(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'ANY'].map((x) => [x, x]), r.method, (v) => { r.method = v; })),
      h('label.field', h('span', 'Path'), h('input.input.mono', { value: r.path, oninput: (e) => { r.path = e.target.value; } })),
      numField('Status', r.status, (v) => { r.status = v; }, { min: 100, max: 599 }),
      numField('Delay', r.delayMs, (v) => { r.delayMs = v; }, { min: 0, step: 10, suffix: 'ms' })),
    h('h4', 'Response headers'), kvEditor(r.headers, null, { keyPh: 'Header', valPh: 'Value', bulk: false }),
    h('label.field', h('span', 'Response body (template)'), h('textarea.input.mono', { rows: 10, spellcheck: false, value: r.body || '', oninput: (e) => { r.body = e.target.value; } })),
    r.requestSchema ? h('details', h('summary.small', 'Request body schema used for validation'), h('pre.code.small', JSON.stringify(r.requestSchema, null, 2))) : null,
    h('div.row-gap',
      h('button.btn.btn-primary.btn-sm', { type: 'button', onclick: async () => { r.headers = r.headers.filter((x) => x.key); try { await api.put(`/api/mocks/${m.id}`, { routes: m.routes.map((x) => (x.id === r.id ? r : x)) }); toast('Route saved', 'ok', 1500); refreshMocks(); } catch (e) { toast(e.message, 'error'); } } }, 'Save route'),
      h('button.btn.btn-sm', { type: 'button', onclick: () => { mv.route = null; render(); } }, 'Close')));
}

function fromOpenApi() {
  const d = { name: '', port: 7100, text: '', url: '', createCollection: true, validate: true, delayMs: 0, errorRate: 0 };
  let ta;
  modal({
    title: 'Mock server from OpenAPI', wide: true,
    body: (el) => el.append(
      h('div.form-grid',
        h('label.field', h('span', 'Name (optional)'), h('input.input', { placeholder: 'Taken from the spec title', oninput: (e) => { d.name = e.target.value; } })),
        numField('Port', d.port, (v) => { d.port = v; }, { min: 1, max: 65535, hint: 'In Docker use 7100-7110.' }),
        numField('Latency', d.delayMs, (v) => { d.delayMs = v; }, { min: 0, step: 10, suffix: 'ms' }),
        numField('Error rate', d.errorRate, (v) => { d.errorRate = v; }, { min: 0, max: 100, suffix: '%' })),
      h('label.field', h('span', 'Spec URL (JSON or YAML)'), h('input.input.mono', { placeholder: 'https://example.com/openapi.yaml', oninput: (e) => { d.url = e.target.value.trim(); } })),
      h('div.or', 'or'),
      h('div.row-gap', h('label.btn.btn-sm', 'Choose file', h('input', { type: 'file', accept: '.json,.yaml,.yml', hidden: true, onchange: async (e) => { const f = e.target.files[0]; if (f) { d.text = await readFileText(f); ta.value = d.text; } } }))),
      (ta = h('textarea.input.mono', { rows: 10, placeholder: 'or paste the OpenAPI 3 / Swagger 2 document here', oninput: (e) => { d.text = e.target.value; } })),
      checkField('Also create a collection whose {{baseUrl}} points at the mock', d.createCollection, (v) => { d.createCollection = v; }),
      checkField('Validate request bodies against the spec', d.validate, (v) => { d.validate = v; })),
    actions: [{ label: 'Cancel' }, { label: 'Create mock', primary: true, onClick: async () => {
      if (!d.url && !d.text.trim()) { toast('Give a spec URL, file or text', 'warn'); return false; }
      try {
        const out = await api.post('/api/mocks/from-openapi', { name: d.name, port: Number(d.port), url: d.url || undefined, text: d.url ? undefined : d.text, createCollection: d.createCollection, validate: d.validate, delayMs: d.delayMs, errorRate: d.errorRate });
        mv.current = out.mock.id;
        toast(`Mock "${out.mock.name}" ${out.mock.running ? `is running on ${out.mock.baseUrl}` : `created (${out.mock.error || 'not started'})`}${out.collection ? `; collection "${out.collection.name}" created` : ''}`, out.mock.running ? 'ok' : 'warn', 6000);
        if (out.collection) loadWorkspace();
        refreshMocks();
      } catch (e) { toast(e.message, 'error', 6000); return false; }
    } }],
  });
}

function emptyMock() {
  const d = { name: 'My mock', port: 7101 };
  modal({
    title: 'New mock server',
    body: (el) => el.append(h('label.field', h('span', 'Name'), h('input.input', { value: d.name, oninput: (e) => { d.name = e.target.value; } })), numField('Port', d.port, (v) => { d.port = v; }, { min: 1, max: 65535 })),
    actions: [{ label: 'Cancel' }, { label: 'Create', primary: true, onClick: async () => {
      try {
        const m = await api.post('/api/mocks', { name: d.name, port: Number(d.port), routes: [{ method: 'GET', path: '/health', status: 200, headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }], body: '{"status":"ok","at":"{{$isoTimestamp}}"}' }] });
        mv.current = m.id; refreshMocks();
      } catch (e) { toast(e.message, 'error'); return false; }
    } }],
  });
}

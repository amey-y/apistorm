import { h, $, mount, clear, toast, modal, confirmDialog, promptDialog, select, kvEditor, numField, menu, readFileText, storageGet, storageSet, fmtNum } from './dom.js';
import { api, connectEvents } from './api.js';
import { state, on, emit, loadWorkspace, loadHistory, activeEnvId, setActiveEnv, saveEnvironment, saveSettings } from './state.js';
import { initWorkspace, openTab, onCallbackMatched, onCallbackTimeout, refreshWorkspace, onSessionEvent } from './workspace.js';
import { initMocks, refreshMocks } from './mocks.js';
import { initLoadTest, onRunEvent, showRun } from './loadtest.js';
import { initCallbacks, refreshCallbacks, onCallback, clearUnseen, selectBin } from './callbacks.js';
import { initRuns, refreshRuns } from './runs.js';
import { initSchedules, refreshSchedules } from './schedules.js';

const VIEWS = [['requests', 'Requests'], ['loadtest', 'Load test'], ['schedules', 'Schedules'], ['callbacks', 'Callbacks'], ['mocks', 'Mocks'], ['runs', 'Runs']];
let liveRuns = 0;
let unseenCallbacks = 0;

/* ----------------------------------------------------------------- theme */

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  storageSet('apistorm.theme', t);
}
applyTheme(storageGet('apistorm.theme', 'dark'));

/* ---------------------------------------------------------------- topbar */

function renderTopbar() {
  const bar = $('#topbar');
  const envSel = select([['', 'No environment'], ...state.environments.map((e) => [e.id, e.name])], activeEnvId() || '', async (v) => { await setActiveEnv(v); renderTopbar(); }, { 'aria-label': 'Active environment', class: 'env-select' });
  mount(bar,
    h('div.brand', h('span.logo', { 'aria-hidden': 'true' }, '⚡'), h('span', 'ApiStorm')),
    h('nav.nav', { 'aria-label': 'Main' }, VIEWS.map(([id, label]) => h(`button.nav-btn${state.view === id ? '.on' : ''}`, { type: 'button', 'aria-current': state.view === id ? 'page' : null, onclick: () => setView(id) },
      label,
      id === 'loadtest' && liveRuns ? h('span.badge.live', { title: `${liveRuns} test(s) running` }, `● ${liveRuns} live`) : null,
      id === 'callbacks' && unseenCallbacks ? h('span.badge.new', unseenCallbacks) : null))),
    h('span.spacer'),
    h('div.env-box', envSel, h('button.icon-btn', { type: 'button', title: 'Manage environments & globals', 'aria-label': 'Manage environments', onclick: () => environmentsDialog() }, '✎')),
    h('button.btn.btn-sm', { type: 'button', onclick: importDialog }, 'Import'),
    h('button.btn.btn-sm', { type: 'button', onclick: (e) => menu(e.currentTarget, [
      { label: 'Full workspace backup (JSON)', icon: '⇩', onClick: () => location.assign('/api/export/workspace') },
      { sep: true },
      ...state.collections.map((c) => ({ label: `Collection: ${c.name}`, icon: '⇩', onClick: () => location.assign(`/api/export/collection/${c.id}?format=native`) })),
      ...state.collections.map((c) => ({ label: `Postman: ${c.name}`, icon: '⇩', onClick: () => location.assign(`/api/export/collection/${c.id}?format=postman`) })),
      ...state.collections.map((c) => ({ label: `OpenAPI (YAML): ${c.name}`, icon: '⇩', onClick: () => location.assign(`/api/export/collection/${c.id}?format=openapi-yaml`) })),
      ...state.environments.map((e) => ({ label: `Environment: ${e.name} (Postman)`, icon: '⇩', onClick: () => location.assign(`/api/export/environment/${e.id}?format=postman`) })),
    ]) }, 'Export ▾'),
    h('button.icon-btn', { type: 'button', title: 'Toggle light/dark theme', 'aria-label': 'Toggle theme', onclick: () => { applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); emit('theme'); } }, document.documentElement.dataset.theme === 'dark' ? '☀' : '☾'),
    h('button.icon-btn', { type: 'button', title: 'Settings', 'aria-label': 'Settings', onclick: settingsDialog }, '⚙'),
    h('button.icon-btn', { type: 'button', title: 'Help & shortcuts', 'aria-label': 'Help', onclick: helpDialog }, '?'),
    h('span.conn', { id: 'conn', title: 'Live connection to the ApiStorm server' }));
}

function setView(v) {
  state.view = v;
  storageSet('apistorm.view', v);
  for (const [id] of VIEWS) $(`#view-${id}`).hidden = id !== v;
  if (v === 'callbacks') { refreshCallbacks(); clearUnseen(); }
  if (v === 'runs') refreshRuns();
  if (v === 'schedules') refreshSchedules();
  if (v === 'mocks') refreshMocks();
  renderTopbar();
}

/* ---------------------------------------------------------- environments */

function environmentsDialog(selectId) {
  let current = selectId || activeEnvId() || state.environments[0]?.id || 'globals';
  modal({
    title: 'Environments & variables', wide: true,
    body: (el) => {
      const render = () => {
        const isGlobals = current === 'globals';
        const env = state.environments.find((e) => e.id === current);
        const draft = isGlobals ? { variables: structuredClone(state.globals) } : env ? structuredClone(env) : null;
        const side = h('div.env-side',
          h('button.env-item' + (isGlobals ? '.on' : ''), { type: 'button', onclick: () => { current = 'globals'; render(); } }, '🌐 Globals'),
          state.environments.map((e) => h('button.env-item' + (e.id === current ? '.on' : ''), { type: 'button', onclick: () => { current = e.id; render(); } }, e.name, e.id === activeEnvId() ? h('span.badge.ok', 'active') : null)),
          h('button.btn.btn-sm', { type: 'button', onclick: async () => {
            const name = await promptDialog('New environment', '', { label: 'Name', placeholder: 'e.g. Staging', okLabel: 'Create' });
            if (!name) return;
            const e = await api.post('/api/environments', { name, variables: [] });
            state.environments.push(e); current = e.id; emit('environments'); renderTopbar(); render();
          } }, '+ Environment'));
        if (!draft) { mount(el, h('div.env-dlg', side, h('p.muted', 'Select an environment'))); return; }
        const saveBtn = h('button.btn.btn-primary', { type: 'button', onclick: async () => {
          draft.variables = draft.variables.filter((v) => v.key);
          if (isGlobals) { state.globals = await api.put('/api/globals', draft.variables); emit('environments'); }
          else await saveEnvironment(draft);
          renderTopbar(); toast('Saved', 'ok', 1500); render();
        } }, 'Save');
        mount(el, h('div.env-dlg', side, h('div.env-main',
          isGlobals ? h('p.muted.small', 'Globals are available everywhere. Precedence: extracted values > CSV data > environment > collection > globals.')
            : h('div.row-gap', h('input.input', { value: draft.name, 'aria-label': 'Environment name', oninput: (e) => { draft.name = e.target.value; } }),
              env.id !== activeEnvId() ? h('button.btn.btn-sm', { type: 'button', onclick: async () => { await setActiveEnv(env.id); renderTopbar(); render(); } }, 'Set active') : null,
              h('button.btn.btn-sm', { type: 'button', onclick: async () => { const copy = await api.post('/api/environments', { name: env.name + ' (copy)', variables: structuredClone(env.variables) }); state.environments.push(copy); current = copy.id; emit('environments'); renderTopbar(); render(); } }, 'Duplicate'),
              h('button.btn.btn-sm', { type: 'button', onclick: () => location.assign(`/api/export/environment/${env.id}?format=postman`) }, 'Export'),
              h('button.btn.btn-sm.btn-danger', { type: 'button', onclick: async () => {
                if (!(await confirmDialog(`Delete environment "${env.name}"?`, { danger: true, okLabel: 'Delete' }))) return;
                await api.del(`/api/environments/${env.id}`);
                state.environments = state.environments.filter((x) => x.id !== env.id);
                if (activeEnvId() === env.id) await setActiveEnv(null);
                current = 'globals'; emit('environments'); renderTopbar(); render();
              } }, 'Delete')),
          kvEditor(draft.variables, null, { keyPh: 'Variable', valPh: 'Value', secrets: true }),
          h('div.row-gap.right', saveBtn))));
      };
      render();
    },
    actions: [{ label: 'Close' }],
  });
}

/* ---------------------------------------------------------------- import */

function importDialog() {
  let text = '';
  let url = '';
  let mode = 'merge';
  modal({
    title: 'Import', wide: true,
    body: (el) => {
      const ta = h('textarea.input.mono', { rows: 10, placeholder: 'Paste one or more cURL commands, a Postman collection/environment, an OpenAPI 3 / Swagger 2 spec (JSON or YAML), a HAR file, or an ApiStorm export…', oninput: (e) => { text = e.target.value; } });
      const fetchUrl = async () => { if (!url) { toast('Enter a URL', 'warn'); return; } if (await doImport('', url, mode, url)) document.querySelector('.modal-back')?.remove(); };
      const urlInput = h('input.input.mono', { placeholder: 'https://example.com/openapi.yaml', 'aria-label': 'Import from URL', oninput: (e) => { url = e.target.value.trim(); }, onkeydown: (e) => { if (e.key === 'Enter') fetchUrl(); } });
      const drop = h('label.dropzone',
        h('input', { type: 'file', multiple: true, accept: '.json,.yaml,.yml,.har,.txt,.sh,.curl', hidden: true, onchange: (e) => importFiles([...e.target.files]) }),
        h('span', '📂 Choose files or drop them here'), h('span.muted.small', 'Postman (.json), OpenAPI / Swagger (.json, .yaml, .yml), HAR (.har), cURL (.txt/.sh), ApiStorm backups'));
      drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('over'));
      drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); importFiles([...e.dataTransfer.files]); });
      el.append(drop, h('div.or', 'or import from a URL (e.g. an OpenAPI spec)'), h('div.row-gap.url-row', urlInput, h('button.btn', { type: 'button', onclick: fetchUrl }, 'Fetch & import')), h('div.or', 'or paste'), ta,
        h('label.field.inline', h('span', 'Workspace backups:'), select([['merge', 'Merge into current workspace'], ['replace', 'Replace current workspace']], mode, (v) => { mode = v; })));
    },
    actions: [{ label: 'Cancel' }, { label: 'Import', primary: true, onClick: async () => { if (!text.trim()) { toast('Paste something to import first', 'warn'); return false; } return (await doImport(text, '', mode)) ? undefined : false; } }],
  });
  async function importFiles(files) {
    let ok = 0;
    for (const f of files) {
      if (f.size > 40 * 1024 * 1024) { toast(`${f.name} is too large`, 'error'); continue; }
      if (await doImport(await readFileText(f), f.name, mode)) ok++;
    }
    if (ok) document.querySelector('.modal-back')?.remove();
  }
}

async function doImport(text, filename, mode, url) {
  try {
    if (mode === 'replace' && text.includes('apistorm-workspace') && !(await confirmDialog('Replace ALL collections, environments and globals with this backup?', { danger: true, okLabel: 'Replace' }))) return false;
    if (url) toast(`Downloading ${url}…`, 'info', 2000);
    const out = await api.post('/api/import', url ? { url, mode } : { text, filename, mode });
    if (out.kind === 'request') {
      setView('requests');
      openTab(out.request, {});
      toast('Request imported into a new tab (save it to a collection with Ctrl+S)', 'ok', 5000);
    } else {
      await loadWorkspace();
      renderTopbar();
      const s = out.summary;
      const parts = [];
      if (s.collections.length) parts.push(`${s.collections.length} collection(s) with ${s.requests} requests`);
      if (s.environments.length) parts.push(`${s.environments.length} environment(s)`);
      toast(`Imported ${parts.join(' and ') || 'nothing'}${s.source ? ` (${s.source})` : ''}${filename ? ` from ${filename}` : ''}`, 'ok', 5000);
    }
    if (out.errors?.length) toast(`${out.errors.length} command(s) skipped: ${out.errors[0]}`, 'warn', 6000);
    return true;
  } catch (e) { toast(`${filename ? filename + ': ' : ''}${e.message}`, 'error', 6000); return false; }
}

/* -------------------------------------------------------------- settings */

function settingsDialog() {
  const s = { ...state.settings };
  modal({
    title: 'Settings',
    body: (el) => el.append(
      h('label.field', h('span', 'Public callback base URL'), h('input.input.mono', { value: s.publicCallbackBase || '', placeholder: `http://localhost:${state.info.callbackPort}`, oninput: (e) => { s.publicCallbackBase = e.target.value.trim(); } }),
        h('span.muted.small', 'What {{$callbackUrl}} expands to. Set this to your tunnel URL (e.g. https://abc.trycloudflare.com) when a remote API must reach you.')),
      h('div.form-grid',
        numField('Wait for callback', s.callbackWaitMs, (v) => { s.callbackWaitMs = v; }, { min: 1000, step: 1000, suffix: 'ms', hint: 'How long a single request waits for its correlated callback.' }),
        numField('History size', s.historyLimit, (v) => { s.historyLimit = v; }, { min: 10, suffix: 'entries' }),
        numField('Script timeout', s.scriptTimeoutMs ?? 5000, (v) => { s.scriptTimeoutMs = v; }, { min: 100, step: 500, suffix: 'ms', hint: 'Maximum run time of one pre-request or post-response script.' }),
        numField('Max concurrent load tests', s.maxConcurrentRuns, (v) => { s.maxConcurrentRuns = v; }, { min: 1, max: 100, hint: 'How many load tests may run at the same time. They share this machine’s CPU and network.' })),
      h('div.info-box.small',
        h('div', h('b', 'UI / API: '), `http://localhost:${state.info.uiPort}`),
        h('div', h('b', 'Callback receiver: '), `${state.info.callbackHost}:${state.info.callbackPort}`, state.info.callbackHost === '127.0.0.1' ? h('span.muted', ' (local only; start with --cb-host 0.0.0.0 to accept LAN traffic)') : null),
        h('div', h('b', 'Data folder: '), h('code', state.info.dataDir)),
        h('div', h('b', 'Version: '), state.info.version, state.info.docker ? ' (Docker)' : ''),
        h('div', h('b', 'Password protection: '), state.info.auth ? 'on' : 'off (set APISTORM_USER and APISTORM_PASSWORD to enable)'),
        h('div', h('b', 'Scripts: '), state.info.scriptsEnabled ? 'enabled (they run with the server\u2019s privileges; set APISTORM_SCRIPTS=off on shared servers with untrusted users)' : 'disabled by APISTORM_SCRIPTS=off'))),
    actions: [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: async () => {
      await saveSettings(s);
      state.info = await api.get('/api/info');
      toast('Settings saved', 'ok', 1500);
    } }],
  });
}

function helpDialog() {
  const dyn = Object.entries(state.info?.dynamicVars || {});
  modal({
    title: 'Help', wide: true,
    body: h('div.help',
      h('h3', 'Keyboard shortcuts'),
      h('table.table', h('tbody',
        [['Ctrl + Enter', 'Send request'], ['Ctrl + S', 'Save request'], ['Ctrl + Alt + N', 'New request tab'], ['Middle-click a tab', 'Close tab'], ['Paste cURL into the URL bar', 'Import it into the tab']]
          .map(([k, v]) => h('tr', h('td', h('kbd', k)), h('td', v))))),
      h('h3', 'Variables'),
      h('p', 'Use ', h('code', '{{name}}'), ' anywhere in a request. Lookup order: values extracted earlier in the same run › CSV data row › active environment › collection variables › globals.'),
      h('h3', 'Dynamic variables'),
      h('table.table', h('tbody', dyn.map(([k, v]) => h('tr', h('td', h('code', `{{$${k}}}`)), h('td.small', v))))),
      h('h3', 'Callbacks (async APIs)'),
      h('p', 'Put ', h('code', '{{$callbackUrl}}'), ' in the request body (e.g. as webhook_url). The URL contains a unique id, so when the API calls it back ApiStorm links the callback to the request and measures end-to-end latency. During load tests enable "Track async callbacks".')),
    actions: [{ label: 'Close' }],
  });
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  const root = $('#app');
  mount(root,
    h('header#topbar.topbar'),
    h('main.views',
      h('section#view-requests.view'),
      h('section#view-loadtest.view', { hidden: true }),
      h('section#view-schedules.view', { hidden: true }),
      h('section#view-callbacks.view', { hidden: true }),
      h('section#view-mocks.view', { hidden: true }),
      h('section#view-runs.view', { hidden: true })));
  try {
    state.info = await api.get('/api/info');
    await loadWorkspace();
    await loadHistory();
  } catch (e) {
    mount(root, h('div.fatal', h('h1', 'Cannot reach the ApiStorm server'), h('p', e.message), h('p', 'Start it with: ', h('code', 'npm start'))));
    return;
  }
  initWorkspace($('#view-requests'));
  initLoadTest($('#view-loadtest'));
  initCallbacks($('#view-callbacks'));
  initRuns($('#view-runs'));
  initSchedules($('#view-schedules'));
  initMocks($('#view-mocks'));
  refreshCallbacks().catch(() => {});

  const runs = await api.get('/api/runs').catch(() => ({ active: [] }));
  liveRuns = runs.active.length;

  on('loadtest:target', () => setView('loadtest'));
  on('loadtest:show-run', (id) => { setView('loadtest'); showRun(id); });
  on('open-request', (r) => { setView('requests'); openTab(r, {}); });
  on('callbacks:open-bin', (id) => { selectBin(id); setView('callbacks'); });
  on('environments', renderTopbar);
  on('env', renderTopbar);
  on('workspace', renderTopbar);
  on('callbacks:unseen', (n) => { unseenCallbacks = n; renderTopbar(); });

  connectEvents({
    'callback': onCallback,
    'callback-matched': onCallbackMatched,
    'callback-timeout': onCallbackTimeout,
    'run-started': (p) => { liveRuns++; renderTopbar(); onRunEvent('run-started', p); },
    'run-progress': (p) => onRunEvent('run-progress', p),
    'run-reset': (p) => onRunEvent('run-reset', p),
    'schedules-changed': () => { if (state.view === 'schedules') refreshSchedules(); },
    'schedule-started': (p) => { if (!p.manual) toast(`Schedule "${p.name}" started`, 'info', 2500); },
    'schedule-finished': (p) => { toast(`Schedule "${p.name}" ${p.status}: ${p.summary}`, p.status === 'passed' ? 'ok' : 'warn', 6000); if (state.view === 'schedules') refreshSchedules(); },
    'listeners-changed': () => { if (state.view === 'callbacks') refreshCallbacks(); },
    'mocks-changed': () => { if (state.view === 'mocks') refreshMocks(); },
    'session': (p) => onSessionEvent(p),
    'oauth2-token': (p) => emit('oauth2-token', p),
    'run-finished': (p) => {
      liveRuns = Math.max(0, liveRuns - 1); renderTopbar(); onRunEvent('run-finished', p);
      toast(`Load test "${p.name}" ${p.status}: ${fmtNum(p.summary.count)} requests, ${fmtNum(p.summary.errorRate, 2)}% failed`, p.status === 'completed' ? 'ok' : 'warn', 6000);
    },
    'runs-changed': () => { if (state.view === 'runs') refreshRuns(); },
    'history-changed': () => loadHistory(),
    'workspace-changed': async (p) => { if (p.what === 'all') { await loadWorkspace(); refreshWorkspace(); } else { const ws = await api.get('/api/workspace'); state.environments = ws.environments; state.globals = ws.globals; emit('environments'); } },
    'bins-changed': () => { if (state.view === 'callbacks') refreshCallbacks(); },
  }, (ok) => { const c = $('#conn'); if (c) { c.className = `conn ${ok ? 'up' : 'down'}`; c.title = ok ? 'Connected to server' : 'Disconnected, retrying…'; } });

  setView(storageGet('apistorm.view', 'requests'));
}

boot();

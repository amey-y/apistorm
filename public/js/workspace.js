import { h, $, clear, mount, toast, modal, confirmDialog, promptDialog, menu, select, kvEditor, checkField, numField, download, copyText,
  fmtBytes, fmtMs, fmtTime, highlightJson, prettyMaybeJson, prettyXml, statusClass, methodClass, storageGet, storageSet, escapeHtml, debounce } from './dom.js';
import { api } from './api.js';
import { state, on, emit, activeEnvId, findCollection, variableMap, saveCollection, loadHistory } from './state.js';
import { PROTOCOLS, protocolLabel, protocolClass, applyProtocol, realtimeEditor, realtimeResponse, grpcEditor, grpcResponse, onSessionEvent as protoSessionEvent, forgetTab, newRequestMenu } from './protocols.js';
import { scriptsPanel, consoleView, advancedAuthFields, ADVANCED_AUTH } from './scripts-ui.js';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const uid = () => crypto.randomUUID();

export function blankRequest(over = {}) {
  return {
    id: uid(), name: 'Untitled request', method: 'GET', url: '', params: [], headers: [],
    body: { mode: 'none', raw: '', form: [], graphql: { query: '', variables: '' } },
    auth: { type: 'inherit' }, assertions: [], extract: [],
    settings: { timeoutMs: 30000, followRedirects: true, insecure: false }, folder: '', description: '',
    scripts: { pre: '', post: '' }, callback: { correlateBy: 'auto', from: 'json', path: '' }, protocol: 'http', ...over,
  };
}

function normalize(r) {
  const b = blankRequest();
  return { ...b, ...r, body: { ...b.body, ...(r.body || {}), graphql: { ...b.body.graphql, ...(r.body?.graphql || {}) } }, auth: { ...(r.auth || b.auth) }, settings: { ...b.settings, ...(r.settings || {}) },
    params: r.params || [], headers: r.headers || [], assertions: r.assertions || [], extract: r.extract || [],
    scripts: { pre: '', post: '', ...(r.scripts || {}) }, callback: { ...b.callback, ...(r.callback || {}) }, protocol: r.protocol || 'http' };
}

/* ------------------------------------------------------------------ tabs */

const ws = {
  tabs: [],
  active: null,
  sidebarTab: storageGet('apistorm.sidebarTab', 'collections'),
  expanded: new Set(storageGet('apistorm.expanded', [])),
  filter: '',
  els: {},
};

const persistTabs = debounce(() => {
  storageSet('apistorm.tabs', {
    active: ws.active,
    tabs: ws.tabs.map((t) => ({ key: t.key, request: t.request, collectionId: t.collectionId, saved: t.saved, dirty: t.dirty, sub: t.sub })),
  });
}, 400);

const activeTab = () => ws.tabs.find((t) => t.key === ws.active) || null;

export function openTab(request, { collectionId = null, saved = false, focus = true } = {}) {
  if (saved) {
    const existing = ws.tabs.find((t) => t.saved && t.request.id === request.id && t.collectionId === collectionId);
    if (existing) { if (focus) activate(existing.key); return existing; }
  }
  const tab = { key: uid(), request: normalize(structuredClone(request)), collectionId, saved, dirty: !saved, response: null, sending: false, sub: 'params', resp: 'body', bodyView: 'pretty', callback: null };
  // replace a pristine empty tab instead of piling up tabs
  const cur = activeTab();
  if (cur && !cur.saved && !cur.dirty && !cur.request.url && !cur.response) ws.tabs.splice(ws.tabs.indexOf(cur), 1, tab);
  else ws.tabs.push(tab);
  if (focus) activate(tab.key); else renderTabs();
  persistTabs();
  return tab;
}

function activate(key) {
  ws.active = key;
  renderTabs();
  renderEditor();
  renderResponse();
  persistTabs();
}

async function closeTab(key) {
  const t = ws.tabs.find((x) => x.key === key);
  if (!t) return;
  if (t.dirty && t.saved && !(await confirmDialog(`"${t.request.name}" has unsaved changes. Close anyway?`, { okLabel: 'Discard changes', danger: true }))) return;
  const i = ws.tabs.indexOf(t);
  forgetTab(t.key);
  ws.tabs.splice(i, 1);
  if (ws.active === key) ws.active = (ws.tabs[i] || ws.tabs[i - 1])?.key || null;
  if (!ws.tabs.length) { openTab(blankRequest()); return; }
  activate(ws.active);
}

function markDirty(tab = activeTab()) {
  if (!tab) return;
  if (!tab.dirty) { tab.dirty = true; renderTabs(); }
  persistTabs();
}

/* ---------------------------------------------------------------- layout */

export function initWorkspace(root) {
  ws.els.sidebar = h('aside.sidebar', { 'aria-label': 'Collections and history' });
  ws.els.tabs = h('div.tabstrip', { role: 'tablist' });
  ws.els.editor = h('section.editor', { 'aria-label': 'Request editor' });
  ws.els.response = h('section.response', { 'aria-label': 'Response' });
  const split = h('div.hsplit', { title: 'Drag to resize', role: 'separator', 'aria-orientation': 'horizontal' });
  const main = h('div.ws-main', ws.els.tabs, h('div.ws-panes', ws.els.editor, split, ws.els.response));
  mount(root, h('div.ws', ws.els.sidebar, main));

  // draggable splitter between request and response
  const panes = main.querySelector('.ws-panes');
  let edH = storageGet('apistorm.editorHeight', null);
  const applyH = () => { if (edH) ws.els.editor.style.flexBasis = `${edH}px`; };
  applyH();
  split.addEventListener('pointerdown', (e) => {
    split.setPointerCapture(e.pointerId);
    const top = panes.getBoundingClientRect().top;
    const move = (ev) => { edH = Math.max(140, Math.min(panes.clientHeight - 120, ev.clientY - top)); applyH(); };
    const up = () => { split.removeEventListener('pointermove', move); storageSet('apistorm.editorHeight', edH); };
    split.addEventListener('pointermove', move);
    split.addEventListener('pointerup', up, { once: true });
  });

  const saved = storageGet('apistorm.tabs', null);
  if (saved?.tabs?.length) {
    ws.tabs = saved.tabs.map((t) => ({ ...t, request: normalize(t.request), response: null, sending: false, resp: 'body', bodyView: 'pretty', callback: null, sub: t.sub || 'params' }));
    ws.active = ws.tabs.some((t) => t.key === saved.active) ? saved.active : ws.tabs[0].key;
  } else {
    const first = state.collections[0]?.requests[0];
    if (first) openTab(first, { collectionId: state.collections[0].id, saved: true, focus: false });
    else openTab(blankRequest(), { focus: false });
    ws.active = ws.tabs[0].key;
  }

  renderSidebar(); renderTabs(); renderEditor(); renderResponse();
  on('workspace', () => { renderSidebar(); renderEditor(); });
  on('collections', renderSidebar);
  on('history', () => { if (ws.sidebarTab === 'history') renderSidebar(); });
  on('env', () => renderEditor());
  on('environments', () => renderVarHints());

  document.addEventListener('keydown', (e) => {
    if (state.view !== 'requests') return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === 'Enter') { e.preventDefault(); send(); }
    else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
    else if (mod && e.altKey && e.key.toLowerCase() === 'n') { e.preventDefault(); openTab(blankRequest()); }
  });
}

/* --------------------------------------------------------------- sidebar */

function renderSidebar() {
  const sb = ws.els.sidebar;
  if (!sb) return;
  const tabBtn = (id, label) => h(`button.sb-tab${ws.sidebarTab === id ? '.on' : ''}`, {
    type: 'button', role: 'tab', 'aria-selected': String(ws.sidebarTab === id),
    onclick: () => { ws.sidebarTab = id; storageSet('apistorm.sidebarTab', id); if (id === 'history') loadHistory(); renderSidebar(); },
  }, label);
  const search = h('input.input.sb-search', { type: 'search', placeholder: ws.sidebarTab === 'history' ? 'Filter history' : 'Filter requests', value: ws.filter, 'aria-label': 'Filter',
    oninput: debounce((e) => { ws.filter = e.target.value; renderList(); }, 150) });
  const actions = ws.sidebarTab === 'collections'
    ? h('div.sb-actions',
      h('button.btn.btn-sm', { type: 'button', onclick: newCollection, title: 'New collection' }, '+ Collection'),
      h('button.btn.btn-sm', { type: 'button', onclick: () => openTab(blankRequest()), title: 'New request (Ctrl+Alt+N)' }, '+ Request'))
    : h('div.sb-actions', h('button.btn.btn-sm', { type: 'button', onclick: async () => { if (await confirmDialog('Clear all history?', { danger: true, okLabel: 'Clear' })) { await api.del('/api/history'); loadHistory(); } } }, 'Clear history'));
  const list = h('div.sb-list');
  mount(sb, h('div.sb-tabs', { role: 'tablist' }, tabBtn('collections', 'Collections'), tabBtn('history', 'History')), h('div.sb-tools', search, actions), list);
  const renderList = () => (ws.sidebarTab === 'collections' ? renderCollections(list) : renderHistory(list));
  renderList();
}

function matches(r, f) {
  if (!f) return true;
  f = f.toLowerCase();
  return r.name?.toLowerCase().includes(f) || r.url?.toLowerCase().includes(f) || r.method?.toLowerCase() === f;
}

function toggleExpanded(id) {
  if (ws.expanded.has(id)) ws.expanded.delete(id); else ws.expanded.add(id);
  storageSet('apistorm.expanded', [...ws.expanded]);
}

function renderCollections(list) {
  clear(list);
  if (!state.collections.length) {
    list.append(h('div.empty', h('p', 'No collections yet.'), h('button.btn.btn-sm', { type: 'button', onclick: newCollection }, 'Create a collection'), h('p.muted', 'or import a Postman collection, OpenAPI spec, HAR file or cURL commands from the Import button.')));
    return;
  }
  const at = activeTab();
  for (const c of state.collections) {
    const reqs = c.requests.filter((r) => matches(r, ws.filter));
    if (ws.filter && !reqs.length) continue;
    const open = ws.expanded.has(c.id) || !!ws.filter;
    const head = h('div.tree-row.tree-col', { tabindex: 0, role: 'treeitem', 'aria-expanded': String(open),
      onclick: () => { toggleExpanded(c.id); renderCollections(list); },
      onkeydown: (e) => { if (e.key === 'Enter') { toggleExpanded(c.id); renderCollections(list); } } },
    h('span.caret', open ? '▾' : '▸'), h('span.tree-name', { title: c.description || c.name }, c.name), h('span.count', c.requests.length),
    h('button.icon-btn.row-menu', { type: 'button', 'aria-label': `Actions for ${c.name}`, onclick: (e) => { e.stopPropagation(); collectionMenu(e.currentTarget, c); } }, '⋯'));
    list.append(head);
    if (!open) continue;
    // group by folder
    const groups = new Map();
    for (const r of reqs) { const f = r.folder || ''; if (!groups.has(f)) groups.set(f, []); groups.get(f).push(r); }
    const folders = [...groups.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
    for (const f of folders) {
      let depth = 1;
      if (f) {
        const fid = `${c.id}/${f}`;
        const fopen = !ws.expanded.has('closed:' + fid) || !!ws.filter;
        list.append(h('div.tree-row.tree-folder', { style: { paddingLeft: '22px' }, tabindex: 0, onclick: () => { toggleExpanded('closed:' + fid); renderCollections(list); } },
          h('span.caret', fopen ? '▾' : '▸'), h('span.tree-name', '📁 ' + f), h('span.count', groups.get(f).length)));
        if (!fopen) continue;
        depth = 2;
      }
      for (const r of groups.get(f)) {
        const isActive = at && at.saved && at.collectionId === c.id && at.request.id === r.id;
        list.append(h(`div.tree-row.tree-req${isActive ? '.on' : ''}`, {
          style: { paddingLeft: `${12 + depth * 14}px` }, tabindex: 0, role: 'treeitem', title: r.url,
          onclick: () => openTab(r, { collectionId: c.id, saved: true }),
          onkeydown: (e) => { if (e.key === 'Enter') openTab(r, { collectionId: c.id, saved: true }); },
        }, h(`span.method.${protocolClass(r)}`, protocolLabel(r)), h('span.tree-name', r.name),
        h('button.icon-btn.row-menu', { type: 'button', 'aria-label': `Actions for ${r.name}`, onclick: (e) => { e.stopPropagation(); requestMenu(e.currentTarget, c, r); } }, '⋯')));
      }
    }
    if (!reqs.length) list.append(h('div.tree-empty', { style: { paddingLeft: '30px' } }, 'Empty. ', h('button.link', { type: 'button', onclick: async () => { const r = blankRequest({ name: 'New request' }); c.requests.push(r); await saveCollection(c); openTab(r, { collectionId: c.id, saved: true }); } }, 'Add a request')));
  }
}

function renderHistory(list) {
  clear(list);
  const items = state.history.filter((x) => matches(x.request, ws.filter));
  if (!items.length) { list.append(h('div.empty', h('p', 'No requests sent yet.'))); return; }
  let lastDay = '';
  for (const it of items) {
    const day = new Date(it.at).toDateString();
    if (day !== lastDay) { list.append(h('div.tree-day', day === new Date().toDateString() ? 'Today' : day)); lastDay = day; }
    list.append(h('div.tree-row.tree-req.hist', { tabindex: 0, title: `${it.request.method} ${it.request.url}\n${fmtTime(it.at)}`,
      onclick: () => openTab({ ...it.request, name: it.request.name || it.request.url }, {}) },
    h(`span.method.${methodClass(it.request.method)}`, it.request.method),
    h('span.tree-name', it.request.url || it.request.name),
    h(`span.hist-status.${statusClass(it.status)}`, it.status || 'ERR'),
    h('button.icon-btn.row-menu', { type: 'button', 'aria-label': 'Remove from history', onclick: async (e) => { e.stopPropagation(); await api.del(`/api/history/${it.id}`); loadHistory(); } }, '✕')));
  }
}

async function newCollection() {
  const name = await promptDialog('New collection', '', { label: 'Name', placeholder: 'e.g. Payments API', okLabel: 'Create' });
  if (!name) return;
  const c = await api.post('/api/collections', { name });
  state.collections.push(c);
  ws.expanded.add(c.id);
  emit('collections');
  toast(`Collection "${name}" created`, 'ok');
}

function collectionMenu(anchor, c) {
  menu(anchor, [
    { label: 'Add request', icon: '+', onClick: () => { const r = blankRequest({ name: 'New request' }); c.requests.push(r); saveCollection(c).then(() => { ws.expanded.add(c.id); openTab(r, { collectionId: c.id, saved: true }); }); } },
    { label: 'Run as load test', icon: '⚡', onClick: () => emit('loadtest:target', { type: 'collection', collectionId: c.id }) },
    { label: 'Schedule bulk send…', icon: '⏰', onClick: () => emit('schedule:new', { kind: 'bulk', name: `${c.name} bulk send`, bulk: { collectionId: c.id, requestIds: [], iterations: 10, concurrency: 1, delayMs: 0, maxErrorRate: 0 } }) },
    { label: 'Edit variables, auth & details', icon: '⚙', onClick: () => editCollection(c) },
    { label: 'Rename', icon: '✎', onClick: async () => { const n = await promptDialog('Rename collection', c.name); if (n) { c.name = n; saveCollection(c); } } },
    { label: 'Duplicate', icon: '⧉', onClick: async () => { const copy = await api.post(`/api/collections/${c.id}/duplicate`); state.collections.push(copy); emit('collections'); } },
    { sep: true },
    { label: 'Export (ApiStorm JSON)', icon: '⇩', onClick: () => location.assign(`/api/export/collection/${c.id}?format=native`) },
    { label: 'Export as Postman v2.1', icon: '⇩', onClick: () => location.assign(`/api/export/collection/${c.id}?format=postman`) },
    { label: 'Export as OpenAPI 3 (YAML)', icon: '⇩', onClick: () => location.assign(`/api/export/collection/${c.id}?format=openapi-yaml`) },
    { label: 'Export as OpenAPI 3 (JSON)', icon: '⇩', onClick: () => location.assign(`/api/export/collection/${c.id}?format=openapi`) },
    { label: 'Export (ApiStorm YAML)', icon: '⇩', onClick: () => location.assign(`/api/export/collection/${c.id}?format=yaml`) },
    { label: 'Export as cURL script', icon: '⇩', onClick: () => location.assign(`/api/export/collection/${c.id}?format=curl`) },
    { label: 'Export cURL (variables resolved)', icon: '⇩', onClick: () => location.assign(`/api/export/collection/${c.id}?format=curl&resolve=1&environmentId=${activeEnvId() || ''}`) },
    { label: 'Export as k6 script', icon: '⇩', onClick: () => location.assign(`/api/export/collection/${c.id}?format=k6&environmentId=${activeEnvId() || ''}`) },
    { sep: true },
    { label: 'Delete collection', icon: '🗑', danger: true, onClick: async () => {
      if (!(await confirmDialog(`Delete "${c.name}" and its ${c.requests.length} requests? This cannot be undone (export it first if unsure).`, { danger: true, okLabel: 'Delete' }))) return;
      await api.del(`/api/collections/${c.id}`);
      state.collections = state.collections.filter((x) => x.id !== c.id);
      for (const t of ws.tabs) if (t.collectionId === c.id) { t.collectionId = null; t.saved = false; t.dirty = true; }
      emit('collections'); renderTabs();
    } },
  ]);
}

function requestMenu(anchor, c, r) {
  menu(anchor, [
    { label: 'Open in new tab', icon: '↗', onClick: () => openTab(r, { collectionId: c.id, saved: true }) },
    { label: 'Duplicate', icon: '⧉', onClick: async () => { const copy = { ...structuredClone(r), id: uid(), name: r.name + ' (copy)' }; c.requests.splice(c.requests.indexOf(r) + 1, 0, copy); await saveCollection(c); } },
    { label: 'Rename', icon: '✎', onClick: async () => { const n = await promptDialog('Rename request', r.name); if (n) { r.name = n; await saveCollection(c); syncOpenTabs(c.id, r); } } },
    { label: 'Copy as cURL', icon: '⧉', onClick: async () => { const { code } = await api.post('/api/codegen', { request: r, collectionId: c.id, environmentId: activeEnvId(), lang: 'curl-bash', resolve: false }); copyText(code, 'cURL copied'); } },
    { label: 'Load test this request', icon: '⚡', onClick: () => emit('loadtest:target', { type: 'request', request: r, collectionId: c.id }) },
    { label: 'Schedule…', icon: '⏰', onClick: () => emit('schedule:new', { kind: 'request', name: r.name, request: { collectionId: c.id, requestId: r.id } }) },
    { sep: true },
    { label: 'Delete', icon: '🗑', danger: true, onClick: async () => {
      if (!(await confirmDialog(`Delete request "${r.name}"?`, { danger: true, okLabel: 'Delete' }))) return;
      c.requests = c.requests.filter((x) => x.id !== r.id);
      await saveCollection(c);
      for (const t of ws.tabs) if (t.collectionId === c.id && t.request.id === r.id) { t.saved = false; t.dirty = true; }
      renderTabs();
    } },
  ]);
}

function syncOpenTabs(cid, r) {
  for (const t of ws.tabs) if (t.saved && t.collectionId === cid && t.request.id === r.id && !t.dirty) t.request = normalize(structuredClone(r));
  renderTabs(); renderEditor();
}

export function editCollection(c) {
  const draft = structuredClone(c);
  draft.variables ||= []; draft.auth ||= { type: 'none' };
  modal({
    title: `Collection: ${c.name}`, wide: true,
    body: (el) => {
      el.append(
        h('label.field', h('span', 'Name'), h('input.input', { value: draft.name, oninput: (e) => { draft.name = e.target.value; } })),
        h('label.field', h('span', 'Description'), h('textarea.input', { rows: 2, value: draft.description || '', oninput: (e) => { draft.description = e.target.value; } })),
        h('h3', 'Collection variables'), h('p.muted', 'Used as {{name}}. Environment variables with the same name take precedence.'),
        kvEditor(draft.variables, null, { keyPh: 'Variable', valPh: 'Value' }),
        h('h3', 'Authorization'), h('p.muted', 'Requests whose auth is "Inherit from collection" use this.'),
        authEditor(draft.auth, () => {}, { inherit: false, collectionId: c.id }),
        h('h3', 'Collection scripts'), scriptsPanel((draft.scripts ||= { pre: '', post: '' }), () => {}, { collection: true }),
      );
    },
    actions: [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: async () => { draft.variables = draft.variables.filter((v) => v.key); await saveCollection(draft); toast('Collection saved', 'ok'); } }],
  });
}

/* ------------------------------------------------------------------ tabs */

function renderTabs() {
  const el = ws.els.tabs;
  if (!el) return;
  clear(el);
  for (const t of ws.tabs) {
    const label = t.request.name || t.request.url || 'Untitled';
    el.append(h(`div.tab${t.key === ws.active ? '.on' : ''}`, {
      role: 'tab', 'aria-selected': String(t.key === ws.active), tabindex: 0, title: `${label}${t.collectionId ? '\nCollection: ' + (findCollection(t.collectionId)?.name || '') : '\n(not saved to a collection)'}`,
      onclick: () => activate(t.key),
      onauxclick: (e) => { if (e.button === 1) closeTab(t.key); },
      onkeydown: (e) => { if (e.key === 'Enter') activate(t.key); },
    }, h(`span.method.${protocolClass(t.request)}`, protocolLabel(t.request)), h('span.tab-name', label),
    t.sending ? h('span.spinner', { 'aria-label': 'Sending' }) : null,
    t.dirty ? h('span.dot', { title: t.saved ? 'Unsaved changes' : 'Not saved to a collection' }, '●') : null,
    h('button.icon-btn.tab-x', { type: 'button', 'aria-label': `Close ${label}`, onclick: (e) => { e.stopPropagation(); closeTab(t.key); } }, '✕')));
  }
  el.append(h('button.icon-btn.tab-new', { type: 'button', title: 'New request: HTTP, WebSocket, SSE or gRPC (Ctrl+Alt+N for HTTP)', 'aria-label': 'New request tab', onclick: (e) => newRequestMenu(e.currentTarget, (p) => openTab(applyProtocol(blankRequest({ name: p === 'http' ? 'Untitled request' : `New ${PROTOCOLS.find(([x]) => x === p)[1]} request`, url: p === 'ws' ? 'ws://' : '' }), p))) }, '+'));
}

/* ---------------------------------------------------------------- editor */

const SUBTABS = [['params', 'Params'], ['headers', 'Headers'], ['body', 'Body'], ['auth', 'Auth'], ['tests', 'Tests'], ['scripts', 'Scripts'], ['extract', 'Extract'], ['settings', 'Settings'], ['code', 'Code'], ['docs', 'Docs']];

let varHintsEl = null;

function renderEditor() {
  const el = ws.els.editor;
  const tab = activeTab();
  if (!el) return;
  if (!tab) { mount(el, h('div.empty', 'No request open')); return; }
  const r = tab.request;
  const protocolSelect = () => select(PROTOCOLS, r.protocol || 'http', (v) => { applyProtocol(r, v); tab.sub = null; tab.response = null; markDirty(); renderTabs(); renderEditor(); renderResponse(); }, { 'aria-label': 'Protocol', class: 'input proto-select' });
  if (r.protocol && r.protocol !== 'http') {
    varHintsEl = h('div.var-hints');
    const ctx = {
      markDirty: (full = true) => { markDirty(); if (full) renderTabs(); }, renderVarHints, varHints: () => varHintsEl,
      rerender: () => { renderEditor(); renderResponse(); }, rerenderResponse: renderResponse,
      protocolSelect, saveButton: () => h('button.btn', { type: 'button', onclick: save, title: 'Save (Ctrl+S)' }, tab.saved ? 'Save' : 'Save…'),
      moreButton: () => h('button.btn', { type: 'button', 'aria-label': 'More actions', onclick: (e) => menu(e.currentTarget, [
        { label: 'Save as…', icon: '⎘', onClick: () => saveAs(tab) },
        { label: 'Duplicate tab', icon: '⧉', onClick: () => openTab({ ...structuredClone(r), id: uid(), name: r.name + ' (copy)' }, { collectionId: tab.collectionId }) },
        { label: 'Export request (JSON)', icon: '⇩', onClick: () => download(`${r.name}.request.json`, JSON.stringify(r, null, 2)) },
      ]) }, '⋯'),
      subtabs: (subs, renderPanel) => h('div.subtabs', { role: 'tablist' }, subs.map(([id, label]) => h(`button.subtab${tab.sub === id ? '.on' : ''}`, { type: 'button', role: 'tab', 'aria-selected': String(tab.sub === id), onclick: () => { tab.sub = id; persistTabs(); renderEditor(); } }, label))),
      bodyEditor: (req) => bodyEditor(req, () => markDirty()),
      authEditor: (req, o = {}) => authEditor(req.auth, () => markDirty(), { inherit: true, collection: findCollection(tab.collectionId), collectionId: tab.collectionId, ...o }),
      scriptsPanel: (req, note) => scriptsPanel(req.scripts, () => markDirty(), { note }),
      docsPanel: (req) => docsPanel(req),
    };
    const crumbs0 = h('div.crumbs', tab.collectionId ? h('span.muted', `${findCollection(tab.collectionId)?.name || 'Deleted collection'}${r.folder ? ' / ' + r.folder : ''} / `) : h('span.muted', 'Unsaved / '),
      h('input.input.name-input', { value: r.name, 'aria-label': 'Request name', oninput: (e) => { r.name = e.target.value; markDirty(); renderTabs(); } }));
    mount(el, crumbs0, ...(r.protocol === 'grpc' ? grpcEditor(tab, ctx) : realtimeEditor(tab, ctx)));
    renderVarHints();
    return;
  }
  const methodSel = select(METHODS.map((m) => [m, m]), r.method, (v) => { r.method = v; methodSel.className = `input method-select ${methodClass(v)}`; markDirty(); renderTabs(); }, { 'aria-label': 'HTTP method' });
  methodSel.className = `input method-select ${methodClass(r.method)}`;
  const url = h('input.input.url-input.mono', {
    value: r.url, placeholder: 'Enter URL or paste a cURL command, e.g. {{baseUrl}}/users?page=1', spellcheck: false, 'aria-label': 'Request URL',
    oninput: (e) => { r.url = e.target.value; markDirty(); renderVarHints(); },
    onblur: () => { if (splitQuery(r)) { url.value = r.url; if (tab.sub === 'params') renderPanel(); } },
    onpaste: async (e) => {
      const text = e.clipboardData.getData('text');
      if (!/^\s*curl(\.exe)?\s/i.test(text)) return;
      e.preventDefault();
      try {
        const parsed = await api.post('/api/parse-curl', { text });
        tab.request = normalize({ ...parsed, id: r.id });
        markDirty(); renderTabs(); renderEditor();
        toast('cURL imported into this tab', 'ok');
      } catch (err) { toast(err.message, 'error'); }
    },
    onkeydown: (e) => { if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); send(); } },
  });
  const sendBtn = tab.sending
    ? h('button.btn.btn-danger.send-btn', { type: 'button', onclick: cancelSend }, 'Cancel')
    : h('button.btn.btn-primary.send-btn', { type: 'button', onclick: send, title: 'Send (Ctrl+Enter)' }, 'Send');
  const saveBtn = h('button.btn', { type: 'button', onclick: save, title: 'Save (Ctrl+S)' }, tab.saved ? 'Save' : 'Save…');
  const more = h('button.btn', { type: 'button', 'aria-label': 'More actions', onclick: (e) => menu(e.currentTarget, [
    { label: 'Save as…', icon: '⎘', onClick: () => saveAs(tab) },
    { label: 'Load test this request', icon: '⚡', onClick: () => emit('loadtest:target', { type: 'request', request: structuredClone(r), collectionId: tab.collectionId }) },
    { label: 'Schedule…', icon: '⏰', disabled: !tab.saved, hint: tab.saved ? '' : 'save first', onClick: () => emit('schedule:new', { kind: 'request', name: r.name, request: { collectionId: tab.collectionId, requestId: r.id } }) },
    { label: 'Copy as cURL', icon: '⧉', onClick: async () => { const { code } = await api.post('/api/codegen', { request: r, collectionId: tab.collectionId, environmentId: activeEnvId(), lang: 'curl-bash', resolve: false }); copyText(code, 'cURL copied'); } },
    { label: 'Copy as cURL (resolved)', icon: '⧉', onClick: async () => { try { const { code } = await api.post('/api/codegen', { request: r, collectionId: tab.collectionId, environmentId: activeEnvId(), lang: 'curl-bash', resolve: true }); copyText(code, 'cURL copied'); } catch (e) { toast(e.message, 'error'); } } },
    { label: 'Import cURL into this tab', icon: '⇪', onClick: () => importCurlIntoTab(tab) },
    { label: 'Duplicate tab', icon: '⧉', onClick: () => openTab({ ...structuredClone(r), id: uid(), name: r.name + ' (copy)' }, { collectionId: tab.collectionId }) },
    { label: 'Export request (JSON)', icon: '⇩', onClick: () => download(`${r.name}.request.json`, JSON.stringify(r, null, 2)) },
  ]) }, '⋯');

  const nameInput = h('input.input.name-input', { value: r.name, 'aria-label': 'Request name', oninput: (e) => { r.name = e.target.value; markDirty(); renderTabs(); } });
  const crumbs = h('div.crumbs', tab.collectionId ? h('span.muted', `${findCollection(tab.collectionId)?.name || 'Deleted collection'}${r.folder ? ' / ' + r.folder : ''} / `) : h('span.muted', 'Unsaved / '), nameInput);
  varHintsEl = h('div.var-hints');
  const subtabs = h('div.subtabs', { role: 'tablist' }, SUBTABS.map(([id, label]) => {
    const count = id === 'params' ? r.params.filter((p) => p.key).length : id === 'headers' ? r.headers.filter((p) => p.key).length : id === 'tests' ? r.assertions.length : id === 'extract' ? r.extract.length : id === 'body' && r.body.mode !== 'none' ? '•' : id === 'auth' && !['none', 'inherit'].includes(r.auth.type) ? '•' : id === 'scripts' && (r.scripts.pre.trim() || r.scripts.post.trim()) ? '•' : 0;
    return h(`button.subtab${tab.sub === id ? '.on' : ''}`, { type: 'button', role: 'tab', 'aria-selected': String(tab.sub === id), onclick: () => { tab.sub = id; persistTabs(); renderEditor(); } }, label, count ? h('span.badge', count) : null);
  }));
  const panel = h('div.req-panel');
  mount(el, crumbs, h('div.urlbar', protocolSelect(), methodSel, url, sendBtn, saveBtn, more), varHintsEl, subtabs, panel);
  renderVarHints();
  renderPanel();

  function renderPanel() {
    clear(panel);
    switch (tab.sub) {
      case 'params':
        panel.append(h('p.muted.small', 'Query parameters are appended to the URL. A query string typed into the URL moves here automatically.'), kvEditor(r.params, () => markDirty(), { keyPh: 'Parameter', valPh: 'Value' }));
        break;
      case 'headers':
        panel.append(h('p.muted.small', 'Content-Type, User-Agent, Accept and Accept-Encoding are added automatically unless you set them.'), kvEditor(r.headers, () => markDirty(), { keyPh: 'Header', valPh: 'Value' }));
        break;
      case 'body': panel.append(bodyEditor(r, () => markDirty())); break;
      case 'auth': panel.append(authEditor(r.auth, () => markDirty(), { inherit: true, collection: findCollection(tab.collectionId), collectionId: tab.collectionId })); break;
      case 'scripts': panel.append(scriptsPanel(r.scripts, () => markDirty())); break;
      case 'tests': panel.append(assertionsEditor(r.assertions, () => markDirty())); break;
      case 'extract': panel.append(extractEditor(r.extract, () => markDirty())); break;
      case 'settings':
        panel.append(h('div.form-grid',
          numField('Timeout', r.settings.timeoutMs, (v) => { r.settings.timeoutMs = v; markDirty(); }, { min: 100, step: 1000, suffix: 'ms' }),
          checkField('Follow redirects', r.settings.followRedirects, (v) => { r.settings.followRedirects = v; markDirty(); }),
          checkField('Skip TLS certificate verification', r.settings.insecure, (v) => { r.settings.insecure = v; markDirty(); }, 'Like curl -k. Use only for self-signed test servers.')),
          callbackSettings(r, () => markDirty()));
        break;
      case 'code': panel.append(codePanel(tab)); break;
      case 'docs': panel.append(docsPanel(r)); break;
      default: break;
    }
  }
}

function docsPanel(r) {
  return h('div',
    h('label.field', h('span', 'Folder'), h('input.input', { value: r.folder || '', placeholder: 'e.g. Users or Users / Admin', oninput: (e) => { r.folder = e.target.value; markDirty(); } })),
    h('label.field', h('span', 'Description / notes'), h('textarea.input', { rows: 8, value: r.description || '', oninput: (e) => { r.description = e.target.value; markDirty(); } })),
    r.postmanScripts ? h('details', h('summary', 'Original Postman scripts from an older import'), h('p.muted.small', 'Copy them into the Scripts tab to run them.'), h('pre.code', Object.entries(r.postmanScripts).map(([k, v]) => `// ${k}\n${v}`).join('\n\n'))) : null);
}

/** Delivery report / callback correlation for this request. */
function callbackSettings(r, changed) {
  const c = r.callback;
  const box = h('div');
  const render = () => {
    clear(box);
    box.append(h('h4', 'Callbacks & delivery reports'),
      h('label.field', h('span', 'Match incoming callbacks to this request by'), select([
        ['auto', 'A unique id ApiStorm puts in the request ({{$callbackUrl}} or {{$requestId}})'],
        ['response', 'A value from the response (e.g. the message id an SMS API returns)'],
      ], c.correlateBy || 'auto', (v) => { c.correlateBy = v; changed(); render(); })));
    if (c.correlateBy === 'response') {
      box.append(h('div.form-grid',
        h('label.field', h('span', 'Take it from the response'), select([['json', 'JSON path'], ['header', 'Header'], ['regex', 'Regex on body']], c.from || 'json', (v) => { c.from = v; changed(); render(); })),
        h('label.field', h('span', c.from === 'header' ? 'Header name' : c.from === 'regex' ? 'Regex (first group)' : 'JSON path'), h('input.input.mono', { value: c.path || '', placeholder: c.from === 'header' ? 'X-Message-Id' : c.from === 'regex' ? 'id=(\\w+)' : '$.messageId', oninput: (e) => { c.path = e.target.value; changed(); } }))),
      h('p.muted.small', 'Then tell the callback bin where the same id is in the delivery report: Callbacks tab → bin → ⚙ Settings → "Correlation field". Single sends show the matching DLR in the Callback tab; load tests with "Track async callbacks" report DLR latency, timeouts and status counts (DELIVRD, UNDELIV…).'));
    }
  };
  render();
  return box;
}

function renderVarHints() {
  const tab = activeTab();
  if (!varHintsEl || !tab) return;
  const r = tab.request;
  const text = [r.url, ...r.params.map((p) => p.value), ...r.headers.map((p) => p.value), r.body.raw, ...r.body.form.map((f) => f.value), r.auth.token, r.auth.value, r.auth.username, r.auth.password].join(' ');
  const names = [...new Set([...String(text).matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map((m) => m[1]))];
  clear(varHintsEl);
  if (!names.length) return;
  const vars = variableMap(tab.collectionId);
  for (const n of names) {
    if (n.startsWith('$')) {
      const base = n.slice(1).split('(')[0];
      const known = state.info?.dynamicVars?.[base];
      varHintsEl.append(h(`span.var-chip${known ? '.dyn' : '.missing'}`, { title: known || 'Unknown dynamic variable' }, `{{${n}}}`));
    } else {
      const v = vars.get(n);
      varHintsEl.append(h(`span.var-chip${v ? '.ok' : '.missing'}`, { title: v ? `${v.src}\n${v.secret ? '••••••' : v.value}` : 'Not defined in the active environment, collection or globals' }, `{{${n}}}`, v ? null : ' ?'));
    }
  }
}

function splitQuery(r) {
  const i = r.url.indexOf('?');
  if (i < 0) return false;
  const qs = r.url.slice(i + 1).split('#')[0];
  r.url = r.url.slice(0, i);
  for (const part of qs.split('&')) {
    if (!part) continue;
    const e = part.indexOf('=');
    const dec = (x) => { try { return decodeURIComponent(x.replace(/\+/g, ' ')); } catch { return x; } };
    r.params = r.params.filter((p) => p.key || p.value);
    r.params.push({ key: dec(e < 0 ? part : part.slice(0, e)), value: e < 0 ? '' : dec(part.slice(e + 1)), enabled: true });
  }
  markDirty();
  return true;
}

/* ----------------------------------------------------------- sub-editors */

function bodyEditor(r, changed) {
  const wrap = h('div.body-editor');
  const modes = [['none', 'None'], ['json', 'JSON'], ['text', 'Text'], ['xml', 'XML'], ['urlencoded', 'Form URL-encoded'], ['formdata', 'Multipart form'], ['graphql', 'GraphQL']];
  const render = () => {
    clear(wrap);
    wrap.append(h('div.radio-row', { role: 'radiogroup', 'aria-label': 'Body type' }, modes.map(([m, l]) => h('label.radio', h('input', { type: 'radio', name: 'bodymode', checked: r.body.mode === m, onchange: () => { r.body.mode = m; changed(); render(); } }), l))));
    const m = r.body.mode;
    if (m === 'none') wrap.append(h('p.muted', 'This request has no body.'));
    else if (['json', 'text', 'xml'].includes(m)) {
      const ta = h('textarea.input.mono.code-area', { value: r.body.raw, spellcheck: false, rows: 12, 'aria-label': 'Request body', oninput: (e) => { r.body.raw = e.target.value; changed(); validate(); },
        onkeydown: (e) => { if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('  ', s, ta.selectionEnd, 'end'); r.body.raw = ta.value; changed(); } } });
      const status = h('span.small');
      const validate = () => {
        if (m !== 'json') return;
        // validate after replacing template tokens with placeholders
        const probe = r.body.raw.replace(/\{\{[^{}]+\}\}/g, '0');
        try { if (probe.trim()) JSON.parse(probe); status.textContent = probe.trim() ? '✔ valid JSON' : ''; status.className = 'small ok'; }
        catch (e) { status.textContent = '✖ ' + e.message; status.className = 'small bad'; }
      };
      wrap.append(h('div.body-tools',
        m === 'json' ? h('button.btn.btn-sm', { type: 'button', onclick: () => {
          try {
            const tokens = [];
            const probe = r.body.raw.replace(/("?)\{\{[^{}]+\}\}("?)/g, (all) => { tokens.push(all); return `"__TOK${tokens.length - 1}__"`; });
            const pretty = JSON.stringify(JSON.parse(probe), null, 2).replace(/"__TOK(\d+)__"/g, (_, i) => tokens[i]);
            r.body.raw = pretty; ta.value = pretty; changed(); validate();
          } catch (e) { toast('Cannot format: ' + e.message, 'error'); }
        } }, 'Beautify') : null,
        m === 'xml' ? h('button.btn.btn-sm', { type: 'button', onclick: () => { r.body.raw = prettyXml(r.body.raw); ta.value = r.body.raw; changed(); } }, 'Beautify') : null,
        status, h('span.muted.small', 'Variables like {{name}} and {{$uuid}} work here.')), ta);
      validate();
    } else if (m === 'urlencoded') wrap.append(kvEditor(r.body.form, changed, { keyPh: 'Field', valPh: 'Value' }));
    else if (m === 'formdata') wrap.append(h('p.muted.small', 'Files are stored inside the request (max 20 MB each).'), kvEditor(r.body.form, changed, { keyPh: 'Field', valPh: 'Value', files: true, bulk: false }));
    else if (m === 'graphql') {
      wrap.append(h('label.field', h('span', 'Query'), h('textarea.input.mono.code-area', { rows: 10, spellcheck: false, value: r.body.graphql.query, oninput: (e) => { r.body.graphql.query = e.target.value; changed(); } })),
        h('label.field', h('span', 'Variables (JSON)'), h('textarea.input.mono', { rows: 4, spellcheck: false, value: r.body.graphql.variables, oninput: (e) => { r.body.graphql.variables = e.target.value; changed(); } })));
    }
  };
  render();
  return wrap;
}

export function authEditor(auth, changed, { inherit = true, collection = null, collectionId = null, grpc = false } = {}) {
  const wrap = h(`div.auth-editor${['oauth2', 'jwt', 'hmac', 'awsv4'].includes(auth.type) ? '.wide' : ''}`);
  const types = [...(inherit ? [['inherit', 'Inherit from collection']] : []), ['none', 'No auth'], ['bearer', 'Bearer token'], ['basic', 'Basic auth'], ['apikey', 'API key'],
    ...ADVANCED_AUTH.filter(([t]) => !grpc || ['oauth2', 'jwt'].includes(t))];
  const field = (label, key, ph = '', type = 'text') => h('label.field', h('span', label), h('input.input.mono', { type, value: auth[key] || '', placeholder: ph, spellcheck: false, oninput: (e) => { auth[key] = e.target.value; changed(); } }));
  const render = () => {
    clear(wrap);
    wrap.append(h('label.field', h('span', 'Type'), select(types, auth.type || 'none', (v) => { auth.type = v; changed(); render(); })));
    if (auth.type === 'inherit') wrap.append(h('p.muted', collection ? `Uses the auth of collection "${collection.name}": ${collection.auth?.type && collection.auth.type !== 'none' ? collection.auth.type : 'none'}.` : 'Not in a collection, so no auth is sent.'));
    if (auth.type === 'bearer') wrap.append(field('Token', 'token', '{{token}}'), field('Prefix', 'prefix', 'Bearer'));
    if (auth.type === 'basic') wrap.append(field('Username', 'username'), field('Password', 'password', '', 'password'));
    if (auth.type === 'apikey') wrap.append(field('Key', 'key', 'X-API-Key'), field('Value', 'value', '{{apiKey}}'), h('label.field', h('span', 'Add to'), select([['header', 'Header'], ['query', 'Query params']], auth.in || 'header', (v) => { auth.in = v; changed(); })));
    const adv = advancedAuthFields(auth, changed, render, { collectionId });
    if (adv) wrap.append(adv);
  };
  render();
  return wrap;
}

const ASSERT_TYPES = [['status', 'Status code'], ['responseTime', 'Response time (ms)'], ['jsonPath', 'JSON path'], ['bodyContains', 'Body contains'], ['header', 'Header']];
const OPS = [['eq', '='], ['neq', '≠'], ['lt', '<'], ['lte', '≤'], ['gt', '>'], ['gte', '≥'], ['contains', 'contains'], ['notContains', 'not contains'], ['exists', 'exists'], ['notExists', 'not exists'], ['matches', 'matches regex'], ['in', 'in list']];

function assertionsEditor(list, changed) {
  const wrap = h('div');
  const render = () => {
    clear(wrap);
    wrap.append(h('p.muted.small', 'Checks run after every response (and on every request during load tests). Status accepts patterns like 2xx or 200,201. JSON paths look like $.data[0].id.'));
    const tbl = h('div.rule-table');
    list.forEach((a, i) => {
      const needsPath = a.type === 'jsonPath' || a.type === 'header';
      const noValue = ['exists', 'notExists'].includes(a.op) || a.type === 'bodyContains' && false;
      tbl.append(h('div.rule-row',
        h('input', { type: 'checkbox', checked: a.enabled !== false, 'aria-label': 'Enabled', onchange: (e) => { a.enabled = e.target.checked; changed(); } }),
        select(ASSERT_TYPES, a.type, (v) => { a.type = v; a.op = v === 'responseTime' ? 'lt' : v === 'header' ? 'exists' : 'eq'; changed(); render(); }, { 'aria-label': 'Check type' }),
        needsPath ? h('input.input.mono', { value: a.path || '', placeholder: a.type === 'header' ? 'Header name' : '$.path.to.value', oninput: (e) => { a.path = e.target.value; changed(); } }) : h('span'),
        a.type === 'bodyContains' ? h('span.muted', 'contains') : select(OPS, a.op || 'eq', (v) => { a.op = v; changed(); render(); }, { 'aria-label': 'Operator' }),
        noValue ? h('span') : h('input.input.mono', { value: a.value ?? '', placeholder: a.type === 'status' ? '2xx' : 'expected', oninput: (e) => { a.value = e.target.value; changed(); } }),
        h('button.icon-btn', { type: 'button', 'aria-label': 'Remove check', onclick: () => { list.splice(i, 1); changed(); render(); } }, '✕')));
    });
    wrap.append(tbl, h('div.row-gap',
      h('button.btn.btn-sm', { type: 'button', onclick: () => { list.push({ type: 'status', op: 'eq', value: '2xx', enabled: true }); changed(); render(); } }, '+ Status check'),
      h('button.btn.btn-sm', { type: 'button', onclick: () => { list.push({ type: 'jsonPath', path: '$.', op: 'exists', enabled: true }); changed(); render(); } }, '+ JSON check'),
      h('button.btn.btn-sm', { type: 'button', onclick: () => { list.push({ type: 'responseTime', op: 'lt', value: '500', enabled: true }); changed(); render(); } }, '+ Time check')));
  };
  render();
  return wrap;
}

function extractEditor(list, changed) {
  const wrap = h('div');
  const render = () => {
    clear(wrap);
    wrap.append(h('p.muted.small', 'Save values from the response into variables. Single sends store them in the active environment (or globals). In load tests they live per iteration, so the next request in a collection run can use them (e.g. a login token).'));
    const tbl = h('div.rule-table');
    list.forEach((x, i) => {
      tbl.append(h('div.rule-row.extract',
        h('input', { type: 'checkbox', checked: x.enabled !== false, 'aria-label': 'Enabled', onchange: (e) => { x.enabled = e.target.checked; changed(); } }),
        h('input.input.mono', { value: x.var || '', placeholder: 'variable name', oninput: (e) => { x.var = e.target.value; changed(); } }),
        select([['json', 'JSON path'], ['header', 'Header'], ['regex', 'Regex on body'], ['status', 'Status code']], x.from || 'json', (v) => { x.from = v; changed(); render(); }, { 'aria-label': 'Source' }),
        x.from === 'status' ? h('span') : h('input.input.mono', { value: x.path || '', placeholder: x.from === 'header' ? 'Header name' : x.from === 'regex' ? 'token":"([^"]+)' : '$.data.token', oninput: (e) => { x.path = e.target.value; changed(); } }),
        h('button.icon-btn', { type: 'button', 'aria-label': 'Remove', onclick: () => { list.splice(i, 1); changed(); render(); } }, '✕')));
    });
    wrap.append(tbl, h('button.btn.btn-sm', { type: 'button', onclick: () => { list.push({ var: '', from: 'json', path: '$.', enabled: true }); changed(); render(); } }, '+ Extract variable'));
  };
  render();
  return wrap;
}

function codePanel(tab) {
  const langs = [...(state.info?.codegenLangs || []), { id: 'k6', label: 'k6 script' }];
  let lang = storageGet('apistorm.codeLang', 'curl-bash');
  let resolve = false;
  const out = h('pre.code.code-out', 'Generating…');
  const gen = async () => {
    try {
      const { code } = await api.post('/api/codegen', { request: tab.request, collectionId: tab.collectionId, environmentId: activeEnvId(), lang, resolve });
      out.textContent = code;
    } catch (e) { out.textContent = `// ${e.message}`; }
  };
  gen();
  return h('div',
    h('div.row-gap',
      select(langs.map((l) => [l.id, l.label]), lang, (v) => { lang = v; storageSet('apistorm.codeLang', v); gen(); }, { 'aria-label': 'Language' }),
      checkField('Resolve variables', resolve, (v) => { resolve = v; gen(); }, 'Substitute {{variables}} using the active environment'),
      h('button.btn.btn-sm', { type: 'button', onclick: () => copyText(out.textContent) }, 'Copy')),
    out);
}

/* ------------------------------------------------------------ send/save */

async function send() {
  const tab = activeTab();
  if (!tab || tab.sending) return;
  const r = tab.request;
  if (r.protocol && r.protocol !== 'http') { ws.els.editor.querySelector('.send-btn')?.click(); return; }
  splitQuery(r);
  if (!r.url.trim()) { toast('Enter a URL first', 'warn'); return; }
  tab.sending = true;
  tab.clientId = uid();
  tab.callback = null;
  renderTabs(); renderEditor(); renderResponse();
  try {
    const out = await api.post('/api/send', { request: r, environmentId: activeEnvId(), collectionId: tab.collectionId, clientId: tab.clientId });
    tab.response = out;
    tab.resp = tab.resp === 'request' ? 'body' : tab.resp;
    if (out.waitingForCallback) tab.callback = { status: 'waiting', requestId: out.requestId, since: Date.now() };
    if (out.updated?.environment) { const i = state.environments.findIndex((e) => e.id === out.updated.environment.id); if (i >= 0) state.environments[i] = out.updated.environment; emit('environments'); }
    if (out.updated?.globals) { state.globals = out.updated.globals; emit('environments'); }
    if (Object.keys(out.extracted || {}).length) toast(`Saved variables: ${Object.keys(out.extracted).join(', ')}`, 'ok');
  } catch (e) {
    tab.response = { response: { error: e.message }, assertions: [], prepared: null };
  } finally {
    tab.sending = false;
    if (ws.sidebarTab === 'history') loadHistory(); else state.history = [];
    renderTabs();
    if (tab.key === ws.active) { renderEditor(); renderResponse(); }
  }
}

async function cancelSend() {
  const tab = activeTab();
  if (tab?.clientId) await api.post('/api/send/cancel', { clientId: tab.clientId }).catch(() => {});
}

async function save() {
  const tab = activeTab();
  if (!tab) return;
  if (!tab.saved || !tab.collectionId || !findCollection(tab.collectionId)) return saveAs(tab);
  splitQuery(tab.request);
  try {
    const saved = await api.put(`/api/collections/${tab.collectionId}/requests/${tab.request.id}`, tab.request);
    const c = findCollection(tab.collectionId);
    const i = c.requests.findIndex((x) => x.id === saved.id);
    if (i >= 0) c.requests[i] = saved; else c.requests.push(saved);
    tab.dirty = false;
    emit('collections'); renderTabs(); persistTabs();
    toast('Saved', 'ok', 1500);
  } catch (e) { toast(e.message, 'error'); }
}

function saveAs(tab) {
  if (!state.collections.length) {
    promptDialog('Create a collection to save into', 'My collection', { label: 'Collection name', okLabel: 'Create' }).then(async (name) => {
      if (!name) return;
      const c = await api.post('/api/collections', { name });
      state.collections.push(c); emit('collections');
      saveAs(tab);
    });
    return;
  }
  let colId = tab.collectionId && findCollection(tab.collectionId) ? tab.collectionId : state.collections[0].id;
  let name = tab.request.name;
  let folder = tab.request.folder || '';
  modal({
    title: 'Save request',
    body: (el) => el.append(
      h('label.field', h('span', 'Name'), h('input.input', { value: name, oninput: (e) => { name = e.target.value; } })),
      h('label.field', h('span', 'Collection'), select(state.collections.map((c) => [c.id, c.name]), colId, (v) => { colId = v; })),
      h('label.field', h('span', 'Folder (optional)'), h('input.input', { value: folder, placeholder: 'e.g. Users', oninput: (e) => { folder = e.target.value; } }))),
    actions: [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: async () => {
      splitQuery(tab.request);
      const copy = { ...structuredClone(tab.request), id: tab.saved && tab.collectionId === colId ? tab.request.id : uid(), name: name || 'Untitled request', folder };
      const saved = await api.put(`/api/collections/${colId}/requests/${copy.id}`, copy);
      const c = findCollection(colId);
      const i = c.requests.findIndex((x) => x.id === saved.id);
      if (i >= 0) c.requests[i] = saved; else c.requests.push(saved);
      Object.assign(tab, { request: normalize(saved), collectionId: colId, saved: true, dirty: false });
      ws.expanded.add(colId);
      emit('collections'); renderTabs(); renderEditor(); persistTabs();
      toast(`Saved to ${c.name}`, 'ok');
    } }],
  });
}

function importCurlIntoTab(tab) {
  let text = '';
  modal({
    title: 'Import cURL', wide: true,
    body: (el) => el.append(h('textarea.input.mono', { rows: 10, placeholder: "curl 'https://api.example.com/users' -H 'Authorization: Bearer ...'", oninput: (e) => { text = e.target.value; } })),
    actions: [{ label: 'Cancel' }, { label: 'Import', primary: true, onClick: async () => {
      try {
        const parsed = await api.post('/api/parse-curl', { text });
        tab.request = normalize({ ...parsed, id: tab.request.id });
        markDirty(); renderTabs(); renderEditor();
      } catch (e) { toast(e.message, 'error'); return false; }
    } }],
  });
}

/* -------------------------------------------------------------- response */

function renderResponse() {
  const el = ws.els.response;
  const tab = activeTab();
  if (!el) return;
  if (!tab) { clear(el); return; }
  if (tab.request.protocol === 'ws' || tab.request.protocol === 'sse') { mount(el, ...realtimeResponse(tab, { rerenderResponse: renderResponse })); return; }
  if (tab.request.protocol === 'grpc') { mount(el, ...grpcResponse(tab, { rerenderResponse: renderResponse })); return; }
  if (tab.sending) { mount(el, h('div.resp-empty', h('span.spinner.big'), h('p', 'Sending request…'), h('button.btn.btn-sm', { type: 'button', onclick: cancelSend }, 'Cancel'))); return; }
  const out = tab.response;
  if (!out) {
    mount(el, h('div.resp-empty', h('p.muted', 'Send the request to see the response here.'),
      h('p.muted.small', 'Ctrl+Enter sends, Ctrl+S saves. Paste a cURL command into the URL bar to import it.')));
    return;
  }
  const res = out.response || {};
  const tests = out.assertions || [];
  const passed = tests.filter((t) => t.pass).length;
  const statusLine = res.error
    ? h('div.resp-status', h('span.status-pill.st-err', '✖ Error'), h('span.resp-err', res.error), res.timings?.total != null ? h('span.muted', fmtMs(res.timings.total)) : null)
    : h('div.resp-status',
      h(`span.status-pill.${statusClass(res.status)}`, `${res.status} ${res.statusText || ''}`),
      h('span.meta', h('span.muted', 'Time '), fmtMs(res.timings?.total)),
      h('span.meta', h('span.muted', 'Size '), fmtBytes(res.size)),
      tests.length ? h(`span.meta${passed === tests.length ? '.ok' : '.bad'}`, `${passed === tests.length ? '✔' : '✖'} ${passed}/${tests.length} checks`) : null,
      tab.callback ? h(`span.meta${tab.callback.status === 'received' ? '.ok' : tab.callback.status === 'timeout' ? '.bad' : ''}`, tab.callback.status === 'waiting' ? '⏳ waiting for callback' : tab.callback.status === 'received' ? `✔ callback in ${fmtMs(tab.callback.latencyMs)}` : '✖ no callback (timed out)') : null,
      h('span.spacer'),
      h('button.btn.btn-sm', { type: 'button', onclick: () => copyText(res.bodyEncoding === 'base64' ? res.body : res.body || '', 'Response copied') }, 'Copy'),
      h('button.btn.btn-sm', { type: 'button', onclick: () => saveResponse(tab) }, 'Save'));

  const logCount = [...(out.scripts?.pre || []), ...(out.scripts?.post || [])].reduce((a, x) => a + x.logs.length + (x.error ? 1 : 0), 0);
  const scriptErr = [...(out.scripts?.pre || []), ...(out.scripts?.post || [])].some((x) => x.error);
  const tabs = [['body', 'Body'], ['headers', `Headers${res.headers ? ` (${res.headers.length})` : ''}`], ['tests', `Checks${tests.length ? ` (${passed}/${tests.length})` : ''}`], ['timing', 'Timing'], ['request', 'Sent request'],
    ...(out.scripts && (out.scripts.pre.length || out.scripts.post.length) ? [['console', `Console${logCount ? ` (${logCount})` : ''}${scriptErr ? ' ⚠' : ''}`]] : []), ...(tab.callback ? [['callback', 'Callback']] : [])];
  const panel = h('div.resp-panel');
  mount(el, statusLine, h('div.subtabs', { role: 'tablist' }, tabs.map(([id, l]) => h(`button.subtab${tab.resp === id ? '.on' : ''}`, { type: 'button', role: 'tab', 'aria-selected': String(tab.resp === id), onclick: () => { tab.resp = id; renderResponse(); } }, l))), panel);

  switch (tab.resp) {
    case 'headers':
      panel.append(res.headers ? headerTable(res.headers) : h('p.muted', 'No headers'));
      if (res.redirects?.length) panel.append(h('h4', 'Redirects'), h('ol.small', res.redirects.map((r) => h('li.mono', `${r.status} ${r.url} → ${r.location}`))));
      break;
    case 'tests':
      if (!tests.length) panel.append(h('p.muted', 'No checks defined. Add some in the Tests tab of the request.'));
      else panel.append(h('ul.test-list', tests.map((t) => h(`li.${t.pass ? 'ok' : 'bad'}`, h('span.test-icon', t.skipped ? '–' : t.pass ? '✔' : '✖'), h('span', t.name), t.source === 'script' ? h('span.badge', 'script') : null,
        !t.pass && t.error ? h('span.muted.mono', ` ${t.error}`) : !t.pass && t.actual !== undefined ? h('span.muted.mono', ` actual: ${t.actual}`) : null))));
      if (Object.keys(out.extracted || {}).length) panel.append(h('h4', 'Extracted variables'), h('table.table', Object.entries(out.extracted).map(([k, v]) => h('tr', h('td.mono', k), h('td.mono', v)))));
      break;
    case 'timing': panel.append(timingView(res)); break;
    case 'request': {
      const p = out.prepared;
      if (!p) { panel.append(h('p.muted', 'Request could not be built.')); break; }
      panel.append(h('div.mono.sent-line', `${p.method} ${p.url}`), headerTable(p.headers), p.body != null ? h('pre.code', p.body) : null);
      if (p.signing) panel.append(h('h4', 'Signature details'), p.signing.canonicalRequest ? h('div', h('div.small.muted', 'Canonical request'), h('pre.code', p.signing.canonicalRequest)) : null, h('div.small.muted', 'String to sign'), h('pre.code', p.signing.stringToSign), h('div.small.muted', 'Signature'), h('pre.code', p.signing.signature));
      break;
    }
    case 'console': panel.append(consoleView(out.scripts)); break;
    case 'callback': panel.append(callbackView(tab)); break;
    default: panel.append(bodyView(tab, res));
  }
}

function headerTable(pairs) {
  return h('table.table.headers-table', h('tbody', pairs.map(([k, v]) => h('tr', h('td.mono.hk', k), h('td.mono', v)))));
}

function bodyView(tab, res) {
  if (res.error) return h('div.error-box', h('strong', 'The request failed'), h('p.mono', res.error), h('p.muted.small', hintForError(res.error)));
  const ct = (res.contentType || '').toLowerCase();
  const wrap = h('div.body-view');
  if (res.bodyEncoding === 'base64') {
    if (ct.startsWith('image/')) wrap.append(h('img.preview-img', { src: `data:${ct};base64,${res.body}`, alt: 'Response image' }));
    else wrap.append(h('p.muted', `Binary response (${fmtBytes(res.bodySize)}, ${ct || 'unknown type'}).`), h('button.btn.btn-sm', { type: 'button', onclick: () => saveResponse(tab) }, 'Download'));
    return wrap;
  }
  const text = res.body || '';
  if (!text) { wrap.append(h('p.muted', 'Empty body')); return wrap; }
  const views = [['pretty', 'Pretty'], ['raw', 'Raw'], ...(ct.includes('html') ? [['preview', 'Preview']] : [])];
  if (!views.some(([v]) => v === tab.bodyView)) tab.bodyView = 'pretty';
  wrap.append(h('div.row-gap.small', views.map(([v, l]) => h(`button.chip${tab.bodyView === v ? '.on' : ''}`, { type: 'button', onclick: () => { tab.bodyView = v; renderResponse(); } }, l)),
    res.truncated ? h('span.bad', 'Body truncated (too large)') : null,
    h('span.muted', ct)));
  if (tab.bodyView === 'preview') {
    wrap.append(h('iframe.preview-frame', { sandbox: '', srcdoc: text, title: 'HTML preview' }));
  } else if (tab.bodyView === 'raw') {
    wrap.append(h('pre.code.resp-body', text));
  } else {
    const { pretty, json } = prettyMaybeJson(text);
    const pre = h('pre.code.resp-body');
    if (json) pre.innerHTML = highlightJson(pretty);
    else if (ct.includes('xml')) pre.textContent = prettyXml(text);
    else pre.textContent = text;
    wrap.append(pre);
  }
  return wrap;
}

function hintForError(msg) {
  if (/ECONNREFUSED/.test(msg)) return 'Nothing is listening on that host/port. Check the URL and that the server is running.';
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return 'The host name could not be resolved. Check the URL or your DNS/VPN.';
  if (/Timeout/i.test(msg)) return 'The server did not answer in time. Raise the timeout in the request Settings tab.';
  if (/certificate|self.signed|CERT_/i.test(msg)) return 'TLS certificate problem. For test servers you can enable "Skip TLS certificate verification" in Settings.';
  if (/Unresolved variable/.test(msg)) return 'Select an environment that defines this variable (top bar), or add it in Environments.';
  return '';
}

function timingView(res) {
  const t = res.timings || {};
  const phases = [['DNS lookup', t.dns], ['TCP connect', t.connect], ['TLS handshake', t.tls], ['Waiting (TTFB)', t.ttfb], ['Download', t.download]].filter(([, v]) => v != null);
  const total = t.total || phases.reduce((a, [, v]) => a + v, 0) || 1;
  let offset = 0;
  const rows = phases.map(([label, v]) => {
    const row = h('div.timing-row', h('span.timing-label', label), h('div.timing-track', h('div.timing-bar', { style: { marginLeft: `${(offset / total) * 100}%`, width: `${Math.max(0.5, (v / total) * 100)}%` } })), h('span.timing-val', fmtMs(v)));
    offset += v;
    return row;
  });
  return h('div.timing', rows, h('div.timing-row.total', h('span.timing-label', 'Total'), h('span'), h('span.timing-val', fmtMs(t.total))),
    res.reused ? h('p.muted.small', 'Connection was reused (keep-alive), so DNS/TCP/TLS were skipped.') : null,
    res.redirects?.length ? h('p.muted.small', `Includes ${res.redirects.length} redirect(s).`) : null);
}

function callbackView(tab) {
  const cb = tab.callback;
  if (cb.status === 'waiting') return h('div.resp-empty', h('span.spinner.big'), h('p', 'Waiting for the callback…'), h('p.muted.small', `Correlation id ${cb.requestId}. Any request to the callback receiver that contains this id (URL, header or body) completes it.`));
  if (cb.status === 'timeout') return h('div.error-box', h('strong', 'No callback received'), h('p.muted', `Nothing containing ${cb.requestId} arrived before the timeout (Settings > callback wait).`));
  const c = cb.capture;
  return h('div', h('p', h('strong', `${c.method} ${c.path}`), h('span.muted', `  received ${fmtTime(c.at)} · ${fmtMs(cb.latencyMs)} after sending`)), headerTable(c.headers), h('pre.code', prettyMaybeJson(c.body || '').pretty));
}

function saveResponse(tab) {
  const res = tab.response?.response;
  if (!res || res.error) return;
  const ct = res.contentType || 'text/plain';
  const ext = ct.includes('json') ? 'json' : ct.includes('html') ? 'html' : ct.includes('xml') ? 'xml' : ct.includes('csv') ? 'csv' : ct.startsWith('image/') ? ct.split('/')[1].split(';')[0] : 'txt';
  const name = `${(tab.request.name || 'response').replace(/[^\w.-]+/g, '_')}.${ext}`;
  if (res.bodyEncoding === 'base64') {
    const bin = Uint8Array.from(atob(res.body), (ch) => ch.charCodeAt(0));
    download(name, new Blob([bin], { type: ct }));
  } else download(name, res.body || '', ct);
}

/* ---------------------------------------------------------- SSE handlers */

export function onCallbackMatched(evt) {
  const tab = ws.tabs.find((t) => t.clientId && t.clientId === evt.clientId);
  if (!tab) return;
  tab.callback = { status: 'received', capture: evt.capture, latencyMs: evt.latencyMs, requestId: evt.requestId };
  toast(`Callback received for "${tab.request.name}" after ${fmtMs(evt.latencyMs)}`, 'ok');
  if (tab.key === ws.active) renderResponse();
}

export function onCallbackTimeout(evt) {
  const tab = ws.tabs.find((t) => t.clientId && t.clientId === evt.clientId);
  if (!tab || tab.callback?.status !== 'waiting') return;
  tab.callback = { status: 'timeout', requestId: evt.requestId };
  if (tab.key === ws.active) renderResponse();
}

export function openRequestFromImport(request) {
  openTab(request, {});
}

export function currentTabTarget() {
  const t = activeTab();
  return t ? { type: 'request', request: structuredClone(t.request), collectionId: t.collectionId } : null;
}

export function refreshWorkspace() { renderSidebar(); renderTabs(); renderEditor(); }
export { escapeHtml };

export function onSessionEvent(evt) {
  protoSessionEvent(evt, ws.tabs, (tab) => { if (tab.key === ws.active) { renderResponse(); if (evt.event.type === 'open' || evt.event.type === 'close' || evt.event.type === 'error') renderEditor(); } });
}

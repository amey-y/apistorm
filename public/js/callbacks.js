import { h, clear, mount, toast, modal, confirmDialog, promptDialog, kvEditor, numField, select, copyText, download, fmtTime, fmtBytes, fmtMs, prettyMaybeJson, highlightJson, escapeHtml, methodClass, statusClass } from './dom.js';
import { api } from './api.js';
import { state, emit } from './state.js';

const cb = { bins: [], base: '', listeners: [], current: 'default', items: [], selected: null, els: {}, unseen: new Map() };

export function initCallbacks(root) {
  cb.els.side = h('aside.cb-side', { 'aria-label': 'Callback bins' });
  cb.els.main = h('section.cb-main', { 'aria-label': 'Received callbacks' });
  mount(root, h('div.cb', cb.els.side, cb.els.main));
}

export async function refreshCallbacks() {
  const { bins, base, listeners } = await api.get('/api/bins');
  cb.bins = bins; cb.base = base; cb.listeners = listeners || [];
  if (!bins.some((b) => b.id === cb.current)) cb.current = bins[0]?.id || 'default';
  cb.items = await api.get(`/api/bins/${encodeURIComponent(cb.current)}/items`);
  cb.unseen.delete(cb.current);
  render();
}

export function onCallback(evt) {
  if (evt.bin === cb.current) {
    cb.items.unshift(evt.capture);
    const max = cb.bins.find((b) => b.id === cb.current)?.maxItems || 200;
    if (cb.items.length > max) cb.items.length = max;
  }
  if (state.view !== 'callbacks' || evt.bin !== cb.current) cb.unseen.set(evt.bin, (cb.unseen.get(evt.bin) || 0) + 1);
  const b = cb.bins.find((x) => x.id === evt.bin);
  if (b) b.count = (b.count || 0) + 1; else { refreshCallbacks(); return; }
  emit('callbacks:unseen', [...cb.unseen.values()].reduce((a, n) => a + n, 0));
  if (state.view === 'callbacks') render();
}

/** Open a specific bin next time the Callbacks view renders. */
export function selectBin(id) { cb.current = id; cb.selected = null; }

export function clearUnseen() {
  cb.unseen.delete(cb.current);
  emit('callbacks:unseen', [...cb.unseen.values()].reduce((a, n) => a + n, 0));
}

const binUrl = (id) => `${cb.base}/cb/${encodeURIComponent(id)}`;

function render() {
  renderSide();
  renderMain();
}

function renderSide() {
  mount(cb.els.side,
    h('div.cb-side-head', h('h2', 'Callback bins'), h('button.btn.btn-sm', { type: 'button', onclick: newBin }, '+ Bin')),
    h('p.muted.small', 'Each bin is a webhook URL that records every request it receives and replies with a configurable mock response.'),
    h('div.bin-list', cb.bins.map((b) => h(`button.bin-item${b.id === cb.current ? '.on' : ''}`, {
      type: 'button',
      onclick: async () => { cb.current = b.id; cb.selected = null; await refreshCallbacks(); clearUnseen(); },
    }, h('span.bin-name', b.name || b.id), h('span.count', b.count || 0), cb.unseen.get(b.id) ? h('span.badge.new', `+${cb.unseen.get(b.id)}`) : null))),
    listenersSection(),
    h('div.cb-help',
      h('h3', 'Receiving callbacks from the internet'),
      h('p.small', 'The receiver listens on ', h('code', `port ${state.info?.callbackPort}`), '. For a remote API to reach it, expose that port with a tunnel and put the public URL in Settings → Public callback base URL:'),
      h('pre.code.small', `cloudflared tunnel --url http://localhost:${state.info?.callbackPort}\n# or\nngrok http ${state.info?.callbackPort}`),
      h('p.small', 'Use ', h('code', '{{$callbackUrl}}'), ' (or ', h('code', '{{$callbackUrl(binName)}}'), ') in a request body to send a unique, auto-correlated callback URL. Or put ', h('code', '{{$requestId}}'), ' anywhere: callbacks containing that id are matched to the request.')));
}

function renderMain() {
  const bin = cb.bins.find((b) => b.id === cb.current);
  if (!bin) { mount(cb.els.main, h('p.muted', 'No bin selected')); return; }
  const url = binUrl(bin.id);
  const list = h('div.cap-list', { role: 'listbox', 'aria-label': 'Received requests' });
  if (!cb.items.length) list.append(h('div.empty', h('p', 'Nothing received yet.'), h('p.muted.small', 'Send any HTTP request to the URL above (any method, any sub-path).')));
  for (const it of cb.items) {
    list.append(h(`button.cap-item${cb.selected === it.id ? '.on' : ''}`, { type: 'button', role: 'option', 'aria-selected': String(cb.selected === it.id), onclick: () => { cb.selected = it.id; renderMain(); } },
      h(`span.method.${methodClass(it.method)}`, it.method),
      h('span.cap-path.mono', it.path.replace(`/cb/${bin.id}`, '') || '/'),
      it.listener ? h('span.badge', { title: `Received by listener ${it.listener}` }, `:${it.port}`) : null,
      it.cbStatus != null ? h('span.badge', { title: 'Delivery status from the bin settings' }, it.cbStatus) : null,
      it.mock ? h(`span.badge${it.mock.status >= 400 ? '.bad' : ''}`, { title: it.mock.note || it.mock.route || '' }, it.mock.status) : null,
      it.matchedRequestId ? h('span.badge.ok', { title: `Matched request ${it.matchedRequestId}` }, `⇄ ${fmtMs(it.latencyMs)}`) : null,
      h('span.cap-time.muted', new Date(it.at).toLocaleTimeString())));
  }
  const sel = cb.items.find((x) => x.id === cb.selected) || cb.items[0];
  if (sel && !cb.selected) cb.selected = sel.id;
  mount(cb.els.main,
    h('div.cb-head',
      h('div.cb-url', h('span.muted.small', 'Send callbacks to'), h('code.mono', `${url}/…`), h('button.btn.btn-sm', { type: 'button', onclick: () => copyText(url, 'Callback URL copied') }, 'Copy URL')),
      cb.listeners.filter((l) => l.defaultBin === bin.id).map((l) => {
        const lu = (l.publicBase || `http://localhost:${l.port}`).replace(/\/$/, '');
        return h('div.cb-url', h('span.muted.small', `Also any path on port ${l.port} (${l.name})${l.running ? '' : ', stopped'}`), h('code.mono', `${lu}/…`), h('button.btn.btn-sm', { type: 'button', onclick: () => copyText(lu, 'Listener URL copied') }, 'Copy'));
      }),
      h('div.row-gap',
        h('button.btn.btn-sm', { type: 'button', onclick: () => configureBin(bin) }, '⚙ Settings'),
        h('button.btn.btn-sm', { type: 'button', onclick: () => testCallback(bin) }, 'Send test callback'),
        h('button.btn.btn-sm', { type: 'button', onclick: () => download(`callbacks-${bin.id}.json`, JSON.stringify(cb.items, null, 2)) }, 'Export'),
        h('button.btn.btn-sm', { type: 'button', onclick: async () => { if (await confirmDialog(`Clear ${cb.items.length} captured requests from "${bin.name}"?`, { danger: true, okLabel: 'Clear' })) { await api.del(`/api/bins/${encodeURIComponent(bin.id)}/items`); refreshCallbacks(); } } }, 'Clear'),
        bin.id !== 'default' ? h('button.btn.btn-sm.btn-danger', { type: 'button', onclick: async () => { if (await confirmDialog(`Delete bin "${bin.name}"?`, { danger: true, okLabel: 'Delete' })) { await api.del(`/api/bins/${encodeURIComponent(bin.id)}`); cb.current = 'default'; refreshCallbacks(); } } }, 'Delete bin') : null)),
    h('div.muted.small.cb-mock-line', `Replies ${bin.response?.status || 200}${Number(bin.response?.delayMs) ? ` after ${bin.response.delayMs} ms` : ''} · keeps the last ${bin.maxItems || 200} requests`),
    h('div.cb-body', list, h('div.cap-detail', sel ? captureDetail(sel, bin) : h('p.muted', 'Select a request to inspect it.'))));
}

function captureDetail(it, bin) {
  const { pretty, json } = prettyMaybeJson(it.body || '');
  const body = h('pre.code');
  if (json) body.innerHTML = highlightJson(pretty); else body.textContent = pretty || '(empty body)';
  return h('div',
    h('div.cap-title', h(`span.method.${methodClass(it.method)}`, it.method), h('span.mono', it.path + (Object.keys(it.query || {}).length ? '?' + new URLSearchParams(it.query).toString() : ''))),
    h('div.muted.small', `${fmtTime(it.at)} · from ${it.ip || '?'} · ${fmtBytes(it.size)}${it.matchedRequestId ? ` · matched request ${it.matchedRequestId} after ${fmtMs(it.latencyMs)}` : ''}`),
    h('div.row-gap',
      h('button.btn.btn-sm', { type: 'button', onclick: () => copyText(captureToCurl(it), 'cURL copied') }, 'Copy as cURL'),
      h('button.btn.btn-sm', { type: 'button', onclick: () => copyText(it.body || '', 'Body copied') }, 'Copy body'),
      h('button.btn.btn-sm', { type: 'button', onclick: () => emit('open-request', captureToRequest(it)), title: 'Open this callback as a request so you can replay it elsewhere' }, 'Open as request')),
    Object.keys(it.query || {}).length ? h('div', h('h4', 'Query'), h('table.table.headers-table', h('tbody', Object.entries(it.query).map(([k, v]) => h('tr', h('td.mono.hk', k), h('td.mono', v)))))) : null,
    h('h4', 'Headers'), h('table.table.headers-table', h('tbody', it.headers.map(([k, v]) => h('tr', h('td.mono.hk', k), h('td.mono', v))))),
    h('h4', 'Body'), body);
}

function captureToCurl(it) {
  const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  const url = `${cb.base}${it.path}${Object.keys(it.query || {}).length ? '?' + new URLSearchParams(it.query).toString() : ''}`;
  const parts = [`curl -X ${it.method} ${q(url)}`];
  for (const [k, v] of it.headers) if (!/^(host|content-length|connection)$/i.test(k)) parts.push(`-H ${q(`${k}: ${v}`)}`);
  if (it.body) parts.push(`--data-raw ${q(it.body)}`);
  return parts.join(' \\\n  ');
}

function captureToRequest(it) {
  const ct = (it.headers.find(([k]) => k.toLowerCase() === 'content-type') || [])[1] || '';
  return {
    id: crypto.randomUUID(), name: `Callback ${it.method} ${it.path}`, method: it.method, url: `${cb.base}${it.path}`,
    params: Object.entries(it.query || {}).map(([key, value]) => ({ key, value, enabled: true })),
    headers: it.headers.filter(([k]) => !/^(host|content-length|connection|accept-encoding|x-apistorm-origin)$/i.test(k)).map(([key, value]) => ({ key, value, enabled: true })),
    body: { mode: it.body ? (ct.includes('json') ? 'json' : ct.includes('xml') ? 'xml' : 'text') : 'none', raw: it.body || '', form: [], graphql: { query: '', variables: '' } },
    auth: { type: 'none' }, assertions: [], extract: [], settings: { timeoutMs: 30000, followRedirects: true, insecure: false },
  };
}

/* ------------------------------------------------------------ listeners */

function listenersSection() {
  return h('div.listeners',
    h('div.cb-side-head', h('h3', 'Listener ports'), h('button.btn.btn-sm', { type: 'button', onclick: () => editListener() }, '+ Port')),
    h('p.muted.small', 'Receive callbacks on more ports, e.g. to mock several services or when a partner needs a fixed URL like http://host:9001/webhook.'),
    h('div.listener-list',
      h('div.listener-item', h('span.chip-dot.rs-dot-running', { 'aria-hidden': 'true' }), h('span.bin-name', `Primary :${state.info?.callbackPort}`), h('span.muted.small', '/cb/<bin>/…')),
      cb.listeners.map((l) => h('div.listener-item',
        h(`span.chip-dot.${l.running ? 'rs-dot-running' : l.error ? 'rs-dot-failed' : 'rs-dot-stopped'}`, { 'aria-hidden': 'true', title: l.running ? 'Listening' : l.error || 'Stopped' }),
        h('span.bin-name', { title: `${l.host}:${l.port}${l.defaultBin ? ` → bin ${l.defaultBin}` : ''}` }, `${l.name} :${l.port}`),
        l.defaultBin ? h('button.link.small', { type: 'button', onclick: async () => { cb.current = l.defaultBin; await refreshCallbacks(); } }, `→ ${l.defaultBin}`) : null,
        h('button.icon-btn', { type: 'button', title: l.running ? 'Stop' : 'Start', 'aria-label': `${l.running ? 'Stop' : 'Start'} ${l.name}`, onclick: async () => {
          try { await api.post(`/api/listeners/${l.id}/${l.running ? 'stop' : 'start'}`); } catch (e) { toast(e.message, 'error'); }
          refreshCallbacks();
        } }, l.running ? '■' : '▶'),
        h('button.icon-btn', { type: 'button', title: 'Edit', 'aria-label': `Edit ${l.name}`, onclick: () => editListener(l) }, '✎'),
        h('button.icon-btn', { type: 'button', title: 'Delete', 'aria-label': `Delete ${l.name}`, onclick: async () => { if (await confirmDialog(`Stop and delete listener "${l.name}" on port ${l.port}?`, { danger: true, okLabel: 'Delete' })) { await api.del(`/api/listeners/${l.id}`); refreshCallbacks(); } } }, '🗑'),
        l.error ? h('div.small.bad.listener-err', l.error) : null))));
}

function editListener(l = null) {
  const d = l ? { ...l } : { name: '', port: '', defaultBin: '', publicBase: '', host: state.info?.callbackHost || '127.0.0.1', enabled: true };
  const binOpts = [['', '(none: only /cb/<bin>/… paths)'], ...cb.bins.map((b) => [b.id, b.name || b.id]), ['__new', '+ New bin…']];
  modal({
    title: l ? `Listener: ${l.name}` : 'Add listener port',
    body: (el) => {
      const newBin = h('input.input', { placeholder: 'new bin id, e.g. stripe', hidden: true, oninput: (e) => { d.defaultBin = e.target.value.trim(); } });
      el.append(
        h('label.field', h('span', 'Name'), h('input.input', { value: d.name, placeholder: 'e.g. Payment gateway mock', oninput: (e) => { d.name = e.target.value; } })),
        h('div.form-grid',
          numField('Port', d.port, (v) => { d.port = v; }, { min: 1, max: 65535, hint: 'In Docker, publish this port too (the compose file maps 7100-7110).' }),
          h('label.field', h('span', 'Listen on'), select([['127.0.0.1', 'This computer only (127.0.0.1)'], ['0.0.0.0', 'All network interfaces (0.0.0.0)']], d.host, (v) => { d.host = v; }))),
        h('label.field', h('span', 'Default bin: requests to any other path on this port are recorded here'), select(binOpts, d.defaultBin, (v) => { if (v === '__new') { newBin.hidden = false; newBin.focus(); d.defaultBin = ''; } else { newBin.hidden = true; d.defaultBin = v; } }), newBin),
        h('label.field', h('span', 'Public base URL (optional, e.g. a tunnel to this port)'), h('input.input.mono', { value: d.publicBase || '', placeholder: 'https://payments-mock.example.com', oninput: (e) => { d.publicBase = e.target.value.trim(); } })),
        h('p.muted.small', '{{$callbackUrl(<default bin>)}} points at this port (or the public base URL) while the listener is running. The mock response of that bin answers every request.'));
    },
    actions: [{ label: 'Cancel' }, { label: l ? 'Save' : 'Add & start', primary: true, onClick: async () => {
      try {
        const body = { name: d.name || `Port ${d.port}`, port: Number(d.port), host: d.host, defaultBin: d.defaultBin, publicBase: d.publicBase, enabled: true };
        const out = l ? await api.put(`/api/listeners/${l.id}`, body) : await api.post('/api/listeners', body);
        if (out.error) toast(out.error, 'error'); else toast(`Listening on port ${out.port}`, 'ok');
        if (d.defaultBin) cb.current = d.defaultBin;
        refreshCallbacks();
      } catch (e) { toast(e.message, 'error'); return false; }
    } }],
  });
}

async function newBin() {
  const id = await promptDialog('New callback bin', '', { label: 'Bin id (used in the URL)', placeholder: 'e.g. payments', okLabel: 'Create' });
  if (!id) return;
  try {
    await api.post('/api/bins', { id: id.trim(), name: id.trim() });
    cb.current = id.trim();
    refreshCallbacks();
  } catch (e) { toast(e.message, 'error'); }
}

function configureBin(bin) {
  const d = structuredClone(bin);
  d.response ||= { status: 200, headers: [], body: '', delayMs: 0 };
  d.response.headers ||= [];
  modal({
    title: `Bin settings: ${bin.name}`, wide: true,
    body: (el) => el.append(
      h('label.field', h('span', 'Display name'), h('input.input', { value: d.name || '', oninput: (e) => { d.name = e.target.value; } })),
      h('div.form-grid',
        numField('Status code', d.response.status, (v) => { d.response.status = v; }, { min: 100, max: 599 }),
        numField('Delay', d.response.delayMs, (v) => { d.response.delayMs = v; }, { min: 0, step: 50, suffix: 'ms', hint: 'Simulate a slow endpoint (useful as a load-test target).' }),
        numField('Keep last', d.maxItems, (v) => { d.maxItems = v; }, { min: 1, suffix: 'requests' })),
      h('h4', 'Response headers'), kvEditor(d.response.headers, null, { keyPh: 'Header', valPh: 'Value' }),
      h('label.field', h('span', 'Response body'), h('textarea.input.mono', { rows: 8, spellcheck: false, value: d.response.body || '', oninput: (e) => { d.response.body = e.target.value; } })),
      h('p.muted.small', 'Templates: {{$uuid}}, {{$isoTimestamp}}, {{$randomInt(1,9)}} … and values from the incoming request: {{request.body.orderId}}, {{request.query.page}}, {{request.headers.x-trace-id}}, {{request.method}}, {{request.path}}.'),
      h('h4', 'Delivery reports (DLR): correlation and status'),
      h('p.muted.small', 'For APIs that return their own id (e.g. a message id) and send it back in the delivery report. Set the request to "Match by a value from the response" (request Settings tab), and tell the bin where that id is in the callback.'),
      fieldPair('Correlation field', (d.correlation ||= { from: 'json', path: '' }), '$.messageId'),
      fieldPair('Status field (counted per value in load tests)', (d.status ||= { from: 'json', path: '' }), '$.status')),
    actions: [{ label: 'Cancel' }, { label: 'Save', primary: true, onClick: async () => {
      d.response.headers = d.response.headers.filter((x) => x.key);
      await api.put(`/api/bins/${encodeURIComponent(bin.id)}`, { name: d.name, response: d.response, maxItems: d.maxItems, correlation: d.correlation, status: d.status });
      toast('Bin settings saved', 'ok');
      refreshCallbacks();
    } }],
  });
}

function fieldPair(label, spec, ph) {
  return h('div.form-grid',
    h('label.field', h('span', label), select([['json', 'JSON body path'], ['form', 'Form field (urlencoded body)'], ['query', 'Query parameter'], ['header', 'Header'], ['regex', 'Regex on body']], spec.from || 'json', (v) => { spec.from = v; })),
    h('label.field', h('span', 'Path / name'), h('input.input.mono', { value: spec.path || '', placeholder: ph, oninput: (e) => { spec.path = e.target.value.trim(); } })));
}

function testCallback(bin) {
  let path = '/test';
  let body = JSON.stringify({ event: 'test', id: crypto.randomUUID(), at: new Date().toISOString() }, null, 2);
  modal({
    title: 'Send test callback', wide: true,
    body: (el) => el.append(
      h('p.muted.small', 'Sends a POST to this bin from your browser. Paste a request id (or the full callback path) to complete a request that is waiting for its callback.'),
      h('label.field', h('span', 'Path after the bin URL'), h('input.input.mono', { value: path, oninput: (e) => { path = e.target.value; } })),
      h('label.field', h('span', 'JSON body'), h('textarea.input.mono', { rows: 8, value: body, oninput: (e) => { body = e.target.value; } }))),
    actions: [{ label: 'Cancel' }, { label: 'Send', primary: true, onClick: async () => {
      try {
        const p = path.startsWith('/') ? path : '/' + path;
        const r = await fetch(`/api/test-callback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bin: bin.id, path: p, body }) });
        const out = await r.json();
        if (!r.ok) throw new Error(out.error);
        toast(`Callback answered ${out.status}`, 'ok');
      } catch (e) { toast(e.message, 'error'); return false; }
    } }],
  });
}

export { escapeHtml, statusClass };

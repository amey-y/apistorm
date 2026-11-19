/* Editors and live consoles for WebSocket, Server-Sent Events and gRPC requests. */
import { h, clear, mount, toast, select, kvEditor, numField, checkField, copyText, menu, fmtMs, fmtBytes, highlightJson, prettyMaybeJson, readFileText, debounce } from './dom.js';
import { api } from './api.js';
import { activeEnvId } from './state.js';

export const PROTOCOLS = [['http', 'HTTP'], ['ws', 'WebSocket'], ['sse', 'SSE'], ['grpc', 'gRPC']];
export const protocolLabel = (r) => ({ ws: 'WS', sse: 'SSE', grpc: 'gRPC' }[r.protocol] || r.method);
export const protocolClass = (r) => ({ ws: 'm-ws', sse: 'm-sse', grpc: 'm-grpc' }[r.protocol] || `m-${String(r.method || 'GET').toLowerCase()}`);

/** Fill in defaults when a request switches protocol. */
export function applyProtocol(r, p) {
  r.protocol = p;
  if (p === 'ws') { r.ws ||= { subprotocols: '', messages: [], draft: '{\n  "type": "ping"\n}', format: 'json' }; if (/^https?:/.test(r.url)) r.url = r.url.replace(/^http/, 'ws'); }
  if (p === 'sse') { r.method = r.method === 'POST' ? 'POST' : 'GET'; if (/^wss?:/.test(r.url)) r.url = r.url.replace(/^ws/, 'http'); }
  if (p === 'grpc') r.grpc ||= { target: '', tls: true, protoSource: 'reflection', protos: [], service: '', method: '', message: '{}' };
  if (p === 'http' && /^wss?:/.test(r.url)) r.url = r.url.replace(/^ws/, 'http');
  return r;
}

const live = new Map(); // tab key -> { session, log: [] }
const stateOf = (tab) => { let s = live.get(tab.key); if (!s) { s = { session: null, log: [], filter: '', grpc: null }; live.set(tab.key, s); } return s; };

/** Session events from the server (`session` SSE). Returns true if a tab was updated. */
export function onSessionEvent(evt, tabs, rerender) {
  for (const tab of tabs) {
    const st = live.get(tab.key);
    if (!st?.session || st.session.id !== evt.id) continue;
    st.session.state = evt.state;
    st.log.push(evt.event);
    if (st.log.length > 2000) st.log.splice(0, st.log.length - 2000);
    if (evt.event.type === 'close' || evt.event.type === 'error') {
      const e = evt.event;
      if (tab.request.protocol === 'grpc') st.grpcEnd = e;
      if (e.type === 'error' && e.message && evt.state !== 'open') toast(`${tab.request.name}: ${e.message}`, 'error', 5000);
    }
    rerender(tab);
    return true;
  }
  return false;
}

export function forgetTab(key) {
  const st = live.get(key);
  if (st?.session?.state === 'open') api.post(`/api/sessions/${st.session.id}/close`, {}).catch(() => {});
  live.delete(key);
}

/* =========================================================== WebSocket/SSE */

async function connect(tab, ctx) {
  const st = stateOf(tab);
  if (st.session?.state === 'open') return;
  st.log = [];
  st.connecting = true;
  ctx.rerender();
  try {
    const out = await api.post('/api/realtime/connect', { request: tab.request, environmentId: activeEnvId(), collectionId: tab.collectionId, clientId: tab.key });
    st.session = { id: out.id, state: 'open', info: out.info };
    // events may have raced ahead of this response
    try { const full = await api.get(`/api/sessions/${out.id}`); st.log = full.log; st.session.state = full.state; } catch { /* ignore */ }
  } catch (e) {
    st.log.push({ type: 'error', message: e.message, at: new Date().toISOString() });
    toast(e.message, 'error', 6000);
  } finally {
    st.connecting = false;
    ctx.rerender();
  }
}

async function disconnect(tab, ctx) {
  const st = stateOf(tab);
  if (st.session) await api.post(`/api/sessions/${st.session.id}/close`, {}).catch(() => {});
  ctx.rerender();
}

async function sendWs(tab, text, format) {
  const st = stateOf(tab);
  if (st.session?.state !== 'open') { toast('Connect first', 'warn'); return; }
  try {
    const vars = { interpolate: true, environmentId: activeEnvId(), collectionId: tab.collectionId };
    await api.post(`/api/sessions/${st.session.id}/send`, format === 'binary' ? { data: text.replace(/\s+/g, ''), binary: true } : { data: text, ...vars });
  } catch (e) { toast(e.message, 'error'); }
}

export function realtimeEditor(tab, ctx) {
  const r = tab.request;
  const st = stateOf(tab);
  const isWs = r.protocol === 'ws';
  const open = st.session?.state === 'open';
  const url = h('input.input.url-input.mono', {
    value: r.url, spellcheck: false, 'aria-label': 'URL', placeholder: isWs ? 'ws://localhost:8080/socket or wss://…' : 'https://api.example.com/events',
    oninput: (e) => { r.url = e.target.value; ctx.markDirty(); ctx.renderVarHints(); },
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); open ? disconnect(tab, ctx) : connect(tab, ctx); } },
  });
  const btn = st.connecting ? h('button.btn.send-btn', { type: 'button', disabled: true }, 'Connecting…')
    : open ? h('button.btn.btn-danger.send-btn', { type: 'button', onclick: () => disconnect(tab, ctx) }, 'Disconnect')
      : h('button.btn.btn-primary.send-btn', { type: 'button', onclick: () => connect(tab, ctx) }, 'Connect');
  const head = [ctx.protocolSelect(), !isWs ? select([['GET', 'GET'], ['POST', 'POST']], r.method === 'POST' ? 'POST' : 'GET', (v) => { r.method = v; ctx.markDirty(); }, { class: 'input method-select', 'aria-label': 'Method' }) : null, url, btn, ctx.saveButton(), ctx.moreButton()];
  const subs = isWs ? [['message', 'Message'], ['headers', 'Headers'], ['auth', 'Auth'], ['scripts', 'Scripts'], ['settings', 'Settings'], ['docs', 'Docs']]
    : [['headers', 'Headers'], ...(r.method === 'POST' ? [['body', 'Body']] : []), ['auth', 'Auth'], ['scripts', 'Scripts'], ['settings', 'Settings'], ['docs', 'Docs']];
  if (!subs.some(([id]) => id === tab.sub)) tab.sub = subs[0][0];
  const panel = h('div.req-panel');
  const render = () => {
    clear(panel);
    switch (tab.sub) {
      case 'message': panel.append(wsComposer(tab, ctx)); break;
      case 'headers': panel.append(h('p.muted.small', isWs ? 'Sent with the HTTP upgrade request.' : 'Accept: text/event-stream is added automatically.'), kvEditor(r.headers, ctx.markDirty, { keyPh: 'Header', valPh: 'Value' })); break;
      case 'body': panel.append(ctx.bodyEditor(r)); break;
      case 'auth': panel.append(ctx.authEditor(r)); break;
      case 'scripts': panel.append(ctx.scriptsPanel(r, 'Only the pre-request script runs (before connecting): use it to compute tokens or signatures.')); break;
      case 'settings':
        panel.append(h('div.form-grid',
          isWs ? h('label.field', h('span', 'Subprotocols (comma separated)'), h('input.input.mono', { value: r.ws?.subprotocols || '', placeholder: 'e.g. graphql-ws, v1.chat', oninput: (e) => { (r.ws ||= {}).subprotocols = e.target.value; ctx.markDirty(); } })) : null,
          checkField('Skip TLS certificate verification', r.settings.insecure, (v) => { r.settings.insecure = v; ctx.markDirty(); })));
        break;
      default: panel.append(ctx.docsPanel(r));
    }
  };
  render();
  return [h('div.urlbar', head), ctx.varHints(), ctx.subtabs(subs, render), panel];
}

function wsComposer(tab, ctx) {
  const r = tab.request;
  r.ws ||= { subprotocols: '', messages: [], draft: '', format: 'text' };
  const ta = h('textarea.input.mono.code-area', {
    rows: 7, spellcheck: false, value: r.ws.draft || '', 'aria-label': 'Message',
    placeholder: r.ws.format === 'binary' ? 'Base64 bytes, e.g. AQID' : 'Message to send. Ctrl+Enter sends.',
    oninput: (e) => { r.ws.draft = e.target.value; ctx.markDirty(false); },
    onkeydown: (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); sendWs(tab, ta.value, r.ws.format); } },
  });
  const saved = h('div.saved-msgs');
  const renderSaved = () => mount(saved, (r.ws.messages || []).length ? r.ws.messages.map((m, i) => h('div.saved-msg',
    h('span.badge', m.format || 'text'), h('span.saved-name', m.name || `Message ${i + 1}`),
    h('button.btn.btn-sm', { type: 'button', onclick: () => sendWs(tab, m.body, m.format) }, 'Send'),
    h('button.btn.btn-sm', { type: 'button', onclick: () => { r.ws.draft = m.body; r.ws.format = m.format; ctx.rerender(); } }, 'Load'),
    h('button.icon-btn', { type: 'button', 'aria-label': 'Delete saved message', onclick: () => { r.ws.messages.splice(i, 1); ctx.markDirty(); renderSaved(); } }, '✕'))) : h('p.muted.small', 'Saved messages appear here. They are stored with the request.'));
  renderSaved();
  return h('div',
    h('div.row-gap',
      select([['text', 'Text'], ['json', 'JSON'], ['binary', 'Binary (base64)']], r.ws.format || 'text', (v) => { r.ws.format = v; ctx.markDirty(); }, { 'aria-label': 'Format' }),
      h('button.btn.btn-primary.btn-sm', { type: 'button', onclick: () => sendWs(tab, ta.value, r.ws.format) }, 'Send ↑'),
      h('button.btn.btn-sm', { type: 'button', title: 'Send a WebSocket ping frame', onclick: async () => { const st = stateOf(tab); if (st.session?.state !== 'open') return toast('Connect first', 'warn'); await api.post(`/api/sessions/${st.session.id}/ping`, {}).catch((e) => toast(e.message, 'error')); } }, 'Ping'),
      r.ws.format === 'json' ? h('button.btn.btn-sm', { type: 'button', onclick: () => { try { ta.value = r.ws.draft = JSON.stringify(JSON.parse(ta.value), null, 2); } catch (e) { toast(e.message, 'error'); } } }, 'Beautify') : null,
      h('button.btn.btn-sm', { type: 'button', onclick: () => { const name = prompt('Name for this message', `Message ${(r.ws.messages || []).length + 1}`); if (name == null) return; (r.ws.messages ||= []).push({ name, body: ta.value, format: r.ws.format }); ctx.markDirty(); renderSaved(); } }, 'Save message')),
    ta, h('h4', 'Saved messages'), saved);
}

export function realtimeResponse(tab, ctx) {
  const st = stateOf(tab);
  const isSse = tab.request.protocol === 'sse';
  const s = st.session;
  const open = s?.state === 'open';
  const ins = st.log.filter((e) => e.dir === 'in' && e.type === 'message').length;
  const outs = st.log.filter((e) => e.dir === 'out' && e.type === 'message').length;
  const openEv = st.log.find((e) => e.type === 'open');
  const status = h('div.resp-status',
    h(`span.status-pill.${open ? 'st-2' : s ? 'st-3' : 'st-3'}`, st.connecting ? 'Connecting…' : open ? '● Connected' : s ? 'Disconnected' : 'Not connected'),
    openEv?.info?.handshakeMs != null ? h('span.meta', h('span.muted', 'Handshake '), fmtMs(openEv.info.handshakeMs)) : null,
    openEv?.info?.connectMs != null ? h('span.meta', h('span.muted', 'Connect '), fmtMs(openEv.info.connectMs)) : null,
    s ? h('span.meta', `↓ ${ins} in`) : null, !isSse && s ? h('span.meta', `↑ ${outs} out`) : null,
    h('span.spacer'),
    h('input.input.log-filter', { type: 'search', placeholder: 'Filter messages', value: st.filter, 'aria-label': 'Filter messages', oninput: debounce((e) => { st.filter = e.target.value; ctx.rerenderResponse(); }, 200) }),
    h('button.btn.btn-sm', { type: 'button', onclick: () => { st.log = st.log.filter((e) => e.type === 'open'); ctx.rerenderResponse(); } }, 'Clear'),
    h('button.btn.btn-sm', { type: 'button', onclick: () => copyText(JSON.stringify(st.log, null, 2), 'Log copied') }, 'Copy log'));
  if (!s && !st.log.length) return [status, h('div.resp-empty', h('p.muted', isSse ? 'Connect to start receiving events.' : 'Connect, then send messages from the Message tab. Everything sent and received shows up here.'))];
  return [status, messageLog(st.log, st.filter, isSse)];
}

function messageLog(log, filter, isSse) {
  const f = filter.toLowerCase();
  const rows = log.filter((e) => !f || JSON.stringify(e).toLowerCase().includes(f));
  const list = h('div.msg-log', { role: 'log', 'aria-live': 'polite' });
  for (const e of rows.slice(-500).reverse()) {
    const time = new Date(e.at).toLocaleTimeString(undefined, { hour12: false }) + '.' + String(new Date(e.at).getMilliseconds()).padStart(3, '0');
    if (e.type !== 'message') {
      const text = e.type === 'open' ? `Connected${e.info?.protocol ? ` (subprotocol ${e.info.protocol})` : ''}${e.info?.status ? ` · HTTP ${e.info.status}` : ''}`
        : e.type === 'close' ? `Closed${e.code != null ? ` · code ${e.code}${e.status ? ` ${e.status}` : ''}` : ''}${e.reason || e.message ? ` · ${e.reason || e.message}` : ''}`
          : e.type === 'error' ? `Error: ${e.message}` : e.type === 'headers' ? `Response headers: ${Object.entries(e.headers || {}).filter(([k]) => !k.startsWith(':')).map(([k, v]) => `${k}=${v}`).join(', ')}`
            : e.type === 'half-close' ? 'Client finished sending (half-close)' : e.type;
      list.append(h(`div.msg-row.sys${e.type === 'error' ? '.bad' : ''}`, h('span.msg-time', time), h('span.msg-dir', '•'), h('span.msg-sys', text)));
      continue;
    }
    const { pretty, json } = prettyMaybeJson(e.data || '');
    const body = h('pre.msg-body.mono');
    if (e.binary) body.textContent = `<${fmtBytes(e.size)} binary> ${e.data.slice(0, 200)}`;
    else if (json) body.innerHTML = highlightJson(pretty.length > 20000 ? pretty.slice(0, 20000) + '\n…' : pretty);
    else body.textContent = e.data;
    list.append(h(`details.msg-row.${e.dir === 'out' ? 'out' : 'in'}`, { open: (e.data || '').length < 400 },
      h('summary', h('span.msg-time', time), h('span.msg-dir', { title: e.dir === 'out' ? 'Sent' : 'Received' }, e.dir === 'out' ? '↑' : '↓'),
        isSse && e.event && e.event !== 'message' ? h('span.badge', e.event) : null, isSse && e.id ? h('span.muted.small', `id ${e.id}`) : null,
        h('span.msg-preview.mono', (e.data || '').replace(/\s+/g, ' ').slice(0, 140)), h('span.muted.small', fmtBytes(e.size ?? (e.data || '').length)),
        h('button.icon-btn', { type: 'button', 'aria-label': 'Copy message', onclick: (ev) => { ev.preventDefault(); copyText(e.data || '', 'Message copied'); } }, '⧉')),
      body));
  }
  if (!rows.length) list.append(h('p.muted', filter ? 'No messages match the filter.' : 'Nothing yet.'));
  return list;
}

/* =================================================================== gRPC */

async function loadServices(tab, ctx, refresh = false) {
  const st = stateOf(tab);
  st.loading = true;
  ctx.rerender();
  try {
    const { services } = await api.post('/api/grpc/describe', { request: tab.request, environmentId: activeEnvId(), collectionId: tab.collectionId, refresh });
    st.services = services;
    const g = tab.request.grpc;
    if (!services.some((s) => s.name === g.service)) { g.service = services[0]?.name || ''; g.method = services[0]?.methods[0]?.name || ''; ctx.markDirty(); }
    if (g.service && !st.services.find((s) => s.name === g.service)?.methods.some((m) => m.name === g.method)) { g.method = st.services.find((s) => s.name === g.service)?.methods[0]?.name || ''; ctx.markDirty(); }
    if ((!g.message || g.message.trim() === '{}') && currentMethod(tab)) { g.message = JSON.stringify(currentMethod(tab).template, null, 2); ctx.markDirty(); }
    toast(`Loaded ${services.length} service(s)`, 'ok', 1500);
  } catch (e) { toast(e.message, 'error', 6000); st.loadError = e.message; }
  finally { st.loading = false; ctx.rerender(); }
}

function currentMethod(tab) {
  const st = stateOf(tab);
  const g = tab.request.grpc;
  return st.services?.find((s) => s.name === g.service)?.methods.find((m) => m.name === g.method) || null;
}

async function invoke(tab, ctx) {
  const st = stateOf(tab);
  const m = currentMethod(tab);
  st.result = null; st.grpcEnd = null; st.log = [];
  st.invoking = true;
  ctx.rerender();
  try {
    const out = await api.post('/api/grpc/invoke', { request: tab.request, environmentId: activeEnvId(), collectionId: tab.collectionId, clientId: tab.key, live: !!m?.serverStreaming });
    if (out.streaming) {
      st.session = { id: out.id, state: 'open' };
      try { const full = await api.get(`/api/sessions/${out.id}`); st.log = full.log; st.session.state = full.state; } catch { /* ignore */ }
    } else { st.result = out; st.session = null; }
  } catch (e) {
    st.result = { error: e.message };
  } finally { st.invoking = false; ctx.rerender(); }
}

export function grpcEditor(tab, ctx) {
  const r = tab.request;
  const g = (r.grpc ||= { target: '', tls: true, protoSource: 'reflection', protos: [], service: '', method: '', message: '{}' });
  const st = stateOf(tab);
  if (!st.services && !st.loading && !st.autoTried && g.target && (g.protoSource === 'proto' ? g.protos?.length : true)) { st.autoTried = true; setTimeout(() => loadServices(tab, ctx), 0); }
  const m = currentMethod(tab);
  const streaming = st.session?.state === 'open';
  const target = h('input.input.url-input.mono', { value: g.target || '', spellcheck: false, placeholder: 'host:port, e.g. grpc.example.com:443 or localhost:50051', 'aria-label': 'gRPC server address',
    oninput: (e) => { g.target = e.target.value; ctx.markDirty(); ctx.renderVarHints(); }, onchange: () => { st.services = null; st.autoTried = false; } });
  const btn = st.invoking ? h('button.btn.send-btn', { type: 'button', disabled: true }, 'Calling…')
    : streaming ? h('button.btn.btn-danger.send-btn', { type: 'button', onclick: () => api.post(`/api/sessions/${st.session.id}/close`, {}) }, 'Cancel')
      : h('button.btn.btn-primary.send-btn', { type: 'button', onclick: () => invoke(tab, ctx), title: 'Invoke (Ctrl+Enter)' }, m?.clientStreaming ? 'Start stream' : 'Invoke');
  const services = st.services || [];
  const methods = services.find((s) => s.name === g.service)?.methods || [];
  // each method keeps its own message; a method used for the first time starts from its template
  const switchMethod = (svc, meth) => {
    g.messages ||= {};
    if (g.service && g.method) g.messages[`${g.service}/${g.method}`] = g.message;
    g.service = svc; g.method = meth;
    const t = services.find((x) => x.name === svc)?.methods.find((x) => x.name === meth)?.template;
    g.message = g.messages[`${svc}/${meth}`] ?? (t ? JSON.stringify(t, null, 2) : '{}');
    ctx.markDirty(); ctx.rerender();
  };
  const svcSel = select(services.length ? services.map((x) => [x.name, x.name]) : [[g.service || '', g.service || '(load services)']], g.service, (v) => switchMethod(v, services.find((x) => x.name === v)?.methods[0]?.name || ''), { 'aria-label': 'Service' });
  const mSel = select(methods.length ? methods.map((x) => [x.name, `${x.name}${x.clientStreaming && x.serverStreaming ? ' (bidi stream)' : x.clientStreaming ? ' (client stream)' : x.serverStreaming ? ' (server stream)' : ''}`]) : [[g.method || '', g.method || '(method)']], g.method, (v) => switchMethod(g.service, v), { 'aria-label': 'Method' });
  const subs = [['message', 'Message'], ['metadata', 'Metadata'], ['auth', 'Auth'], ['proto', 'Proto / schema'], ['scripts', 'Scripts'], ['settings', 'Settings'], ['docs', 'Docs']];
  if (!subs.some(([id]) => id === tab.sub)) tab.sub = 'message';
  const panel = h('div.req-panel');
  const render = () => {
    clear(panel);
    if (tab.sub === 'message') {
      const ta = h('textarea.input.mono.code-area', { rows: 10, spellcheck: false, value: g.message || '{}', 'aria-label': 'Request message (JSON)',
        oninput: (e) => { g.message = e.target.value; ctx.markDirty(false); },
        onkeydown: (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (streaming) sendGrpc(tab, ta.value); else invoke(tab, ctx); } } });
      panel.append(
        h('div.row-gap',
          h('button.btn.btn-sm', { type: 'button', disabled: !m, onclick: () => { ta.value = g.message = JSON.stringify(m.template, null, 2); ctx.markDirty(); } }, 'Fill template'),
          h('button.btn.btn-sm', { type: 'button', onclick: () => { try { ta.value = g.message = JSON.stringify(JSON.parse(ta.value), null, 2); } catch (e) { toast(e.message, 'error'); } } }, 'Beautify'),
          streaming && m?.clientStreaming ? [h('button.btn.btn-primary.btn-sm', { type: 'button', onclick: () => sendGrpc(tab, ta.value) }, 'Send message ↑'), h('button.btn.btn-sm', { type: 'button', onclick: () => api.post(`/api/sessions/${st.session.id}/end`, {}).catch((e) => toast(e.message, 'error')) }, 'End stream')] : null,
          m ? h('span.muted.small', `${m.inputType} → ${m.outputType}`) : null),
        ta,
        h('p.muted.small', 'Protobuf JSON mapping: camelCase field names, enums by name, int64 as strings, bytes as base64, Timestamp as "2026-01-01T00:00:00Z". {{variables}} work here.'));
    } else if (tab.sub === 'metadata') panel.append(h('p.muted.small', 'Sent as gRPC metadata (HTTP/2 headers). Auth from the Auth tab is added too.'), kvEditor(r.headers, ctx.markDirty, { keyPh: 'Key (lowercase)', valPh: 'Value' }));
    else if (tab.sub === 'auth') panel.append(ctx.authEditor(r, { grpc: true }));
    else if (tab.sub === 'proto') panel.append(protoPanel(tab, ctx));
    else if (tab.sub === 'scripts') panel.append(ctx.scriptsPanel(r, 'Only the pre-request script runs (before the call), e.g. to compute a token for the metadata.'));
    else if (tab.sub === 'settings') panel.append(h('div.form-grid',
      numField('Deadline', r.settings.timeoutMs, (v) => { r.settings.timeoutMs = v; ctx.markDirty(); }, { min: 100, step: 1000, suffix: 'ms' }),
      checkField('Skip TLS certificate verification', r.settings.insecure, (v) => { r.settings.insecure = v; ctx.markDirty(); })));
    else panel.append(ctx.docsPanel(r));
  };
  render();
  return [
    h('div.urlbar', ctx.protocolSelect(), target, h('label.check.tls-toggle', { title: 'Use TLS (grpcs). Turn off for plaintext servers such as localhost:50051' }, h('input', { type: 'checkbox', checked: g.tls !== false, onchange: (e) => { g.tls = e.target.checked; st.services = null; ctx.markDirty(); } }), 'TLS'), btn, ctx.saveButton(), ctx.moreButton()),
    h('div.grpc-row', svcSel, mSel,
      h('button.btn.btn-sm', { type: 'button', disabled: st.loading, title: g.protoSource === 'reflection' ? 'Ask the server for its services (server reflection)' : 'Parse the .proto files', onclick: () => loadServices(tab, ctx, true) }, st.loading ? 'Loading…' : g.protoSource === 'reflection' ? '⟳ Reflect' : '⟳ Load .proto'),
      h('span.muted.small', st.services ? `${st.services.length} service(s) via ${g.protoSource === 'reflection' ? 'reflection' : '.proto files'}` : st.loadError ? h('span.bad', st.loadError) : '')),
    ctx.varHints(), ctx.subtabs(subs, render), panel];
}

function protoPanel(tab, ctx) {
  const g = tab.request.grpc;
  const st = stateOf(tab);
  const wrap = h('div');
  const render = () => {
    clear(wrap);
    wrap.append(h('div.row-gap', h('span', 'Schema source'), select([['reflection', 'Server reflection'], ['proto', '.proto files']], g.protoSource || 'reflection', (v) => { g.protoSource = v; st.services = null; ctx.markDirty(); render(); }, { 'aria-label': 'Schema source' })));
    if ((g.protoSource || 'reflection') === 'reflection') {
      wrap.append(h('p.muted.small', 'The server must have gRPC server reflection enabled. Press ⟳ Reflect above to load services.'));
      return;
    }
    g.protos ||= [];
    wrap.append(h('p.muted.small', 'Paste or upload every .proto file the service needs (imports of google/protobuf/*.proto are built in). They are stored with the request.'));
    g.protos.forEach((f, i) => wrap.append(h('div.proto-file',
      h('div.row-gap', h('input.input.mono', { value: f.name, 'aria-label': 'File name', oninput: (e) => { f.name = e.target.value; ctx.markDirty(); } }),
        h('button.btn.btn-sm.btn-danger', { type: 'button', onclick: () => { g.protos.splice(i, 1); st.services = null; ctx.markDirty(); render(); } }, 'Remove')),
      h('textarea.input.mono', { rows: 10, spellcheck: false, value: f.text, 'aria-label': `${f.name} contents`, oninput: (e) => { f.text = e.target.value; st.services = null; ctx.markDirty(false); } }))));
    wrap.append(h('div.row-gap',
      h('button.btn.btn-sm', { type: 'button', onclick: () => { g.protos.push({ name: `service${g.protos.length || ''}.proto`, text: 'syntax = "proto3";\n\npackage example;\n\nservice Greeter {\n  rpc SayHello (HelloRequest) returns (HelloReply);\n}\n\nmessage HelloRequest { string name = 1; }\nmessage HelloReply { string message = 1; }\n' }); ctx.markDirty(); render(); } }, '+ New file'),
      h('label.btn.btn-sm', 'Upload .proto', h('input', { type: 'file', accept: '.proto', multiple: true, hidden: true, onchange: async (e) => { for (const f of e.target.files) g.protos.push({ name: f.name, text: await readFileText(f) }); st.services = null; ctx.markDirty(); render(); } }))));
  };
  render();
  return wrap;
}

async function sendGrpc(tab, text) {
  const st = stateOf(tab);
  if (st.session?.state !== 'open') { toast('Start the stream first', 'warn'); return; }
  try { await api.post(`/api/sessions/${st.session.id}/send`, { json: text, interpolate: true, environmentId: activeEnvId(), collectionId: tab.collectionId }); } catch (e) { toast(e.message, 'error'); }
}

const grpcClass = (code) => (code === 0 ? 'st-2' : [3, 5, 6, 9, 11].includes(code) ? 'st-4' : 'st-5');

export function grpcResponse(tab, ctx) {
  const st = stateOf(tab);
  if (st.invoking) return [h('div.resp-empty', h('span.spinner.big'), h('p', 'Calling…'))];
  if (st.session) {
    const end = st.grpcEnd || st.log.find((e) => e.type === 'close' || e.type === 'error');
    const open = st.session.state === 'open';
    return [h('div.resp-status',
      end ? h(`span.status-pill.${grpcClass(end.code)}`, `${end.status || 'ended'}${end.code != null ? ` (${end.code})` : ''}`) : h('span.status-pill.st-3', open ? '● Streaming' : 'Ended'),
      end?.message ? h('span.resp-err', end.message) : null, end?.timeMs != null ? h('span.meta', fmtMs(end.timeMs)) : null,
      h('span.meta', `↓ ${st.log.filter((e) => e.dir === 'in').length} in`), h('span.meta', `↑ ${st.log.filter((e) => e.dir === 'out' && e.type === 'message').length} out`),
      h('span.spacer'), h('button.btn.btn-sm', { type: 'button', onclick: () => copyText(JSON.stringify(st.log, null, 2), 'Log copied') }, 'Copy log')),
    messageLog(st.log, '', false)];
  }
  const res = st.result;
  if (!res) return [h('div.resp-empty', h('p.muted', 'Load the services (⟳), pick a method, then Invoke.'), h('p.muted.small', 'Unary and server-streaming calls return here; client and bidirectional streams open a live console.'))];
  if (res.error) return [h('div.error-box', h('strong', 'The call failed'), h('p.mono', res.error))];
  if (!['body', 'headers', 'request'].includes(tab.resp)) tab.resp = 'body';
  const panel = h('div.resp-panel');
  const tabs = [['body', `Response${res.messages.length > 1 ? ` (${res.messages.length} messages)` : ''}`], ['headers', 'Headers & trailers'], ['request', 'Call details']];
  const status = h('div.resp-status',
    h(`span.status-pill.${grpcClass(res.code)}`, `${res.status} (${res.code})`),
    res.message && res.code !== 0 ? h('span.resp-err', res.message) : null,
    h('span.meta', h('span.muted', 'Time '), fmtMs(res.timeMs)),
    h('span.meta', h('span.muted', 'Size '), fmtBytes(res.responseBytes)),
    h('span.spacer'), h('button.btn.btn-sm', { type: 'button', onclick: () => copyText(JSON.stringify(res.messages.length === 1 ? res.messages[0] : res.messages, null, 2), 'Response copied') }, 'Copy'));
  const sub = h('div.subtabs', { role: 'tablist' }, tabs.map(([id, l]) => h(`button.subtab${tab.resp === id ? '.on' : ''}`, { type: 'button', role: 'tab', onclick: () => { tab.resp = id; ctx.rerenderResponse(); } }, l)));
  if (tab.resp === 'headers') {
    const rows = (o) => Object.entries(o || {}).filter(([k]) => !k.startsWith(':')).map(([k, v]) => h('tr', h('td.mono.hk', k), h('td.mono', String(v))));
    panel.append(h('h4', 'Response headers'), h('table.table.headers-table', h('tbody', rows(res.headers))), h('h4', 'Trailers'), h('table.table.headers-table', h('tbody', rows(res.trailers))));
  } else if (tab.resp === 'request') {
    panel.append(h('div.mono.sent-line', `${res.tls ? 'grpcs' : 'grpc'}://${res.target}${res.path}`), h('p.small.muted', `Request message ${fmtBytes(res.requestBytes)}`), h('h4', 'Metadata sent'), h('table.table.headers-table', h('tbody', (res.metadata || []).map(([k, v]) => h('tr', h('td.mono.hk', k), h('td.mono', v))))));
  } else {
    if (!res.messages.length) panel.append(h('p.muted', res.code === 0 ? 'The server returned no message.' : 'No response message.'));
    res.messages.forEach((msg, i) => {
      const pre = h('pre.code.resp-body');
      pre.innerHTML = highlightJson(JSON.stringify(msg, null, 2));
      panel.append(res.messages.length > 1 ? h('div', h('h4', `Message ${i + 1}`), pre) : pre);
    });
  }
  return [status, sub, panel];
}

/** New-request menu (the "+" next to the tabs). */
export function newRequestMenu(anchor, create) {
  menu(anchor, [
    { label: 'HTTP request', icon: '⇄', onClick: () => create('http') },
    { label: 'WebSocket', icon: '⇵', onClick: () => create('ws') },
    { label: 'Server-Sent Events', icon: '↓', onClick: () => create('sse') },
    { label: 'gRPC', icon: '◆', onClick: () => create('grpc') },
  ]);
}

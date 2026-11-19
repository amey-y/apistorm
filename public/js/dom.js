/* Small DOM toolkit: element builder, dialogs, menus, editors. */

export function h(tag, attrs, ...children) {
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(tag);
  const el = document.createElement(m?.[1] || 'div');
  if (m?.[2]) for (const part of m[2].match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1);
  }
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { children.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className += (el.className ? ' ' : '') + v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (['value', 'checked', 'disabled', 'selected', 'indeterminate', 'readOnly', 'spellcheck', 'hidden', 'multiple'].includes(k)) el[k] = v;
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
export function mount(el, ...children) { clear(el); append(el, children); return el; }

export const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function fmtBytes(n) {
  if (n == null) return '–';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
export function fmtMs(n) {
  if (n == null) return '–';
  if (n < 10) return `${n.toFixed(2)} ms`;
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(2)} s`;
}
export function fmtNum(n, d = 0) {
  if (n == null || Number.isNaN(n)) return '–';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: d });
}
export function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function debounce(fn, ms = 300) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* ---------------------------------------------------------------- toasts */

export function toast(msg, type = 'info', ms = 3500) {
  let host = $('#toasts');
  if (!host) { host = h('div#toasts'); document.body.append(host); }
  const icon = { info: 'ℹ', ok: '✔', error: '✖', warn: '⚠' }[type] || 'ℹ';
  const el = h(`div.toast.toast-${type}`, { role: 'status' }, h('span.toast-icon', icon), h('span', msg));
  host.append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, ms);
}

/* ---------------------------------------------------------------- modals */

export function modal({ title, body, actions = [], wide = false, onClose }) {
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const content = h('div.modal-body');
  const foot = h('div.modal-foot', actions.map((a) => h(`button.btn${a.primary ? '.btn-primary' : ''}${a.danger ? '.btn-danger' : ''}`, {
    type: 'button',
    onclick: async () => { const r = await a.onClick?.(api); if (r !== false) close(); },
  }, a.label)));
  const box = h(`div.modal${wide ? '.modal-wide' : ''}`, { role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div.modal-head', h('h2', title), h('button.icon-btn', { type: 'button', 'aria-label': 'Close', onclick: close }, '✕')),
    content, actions.length ? foot : null);
  const back = h('div.modal-back', { onmousedown: (e) => { if (e.target === back) close(); } }, box);
  const api = { close, el: content, box };
  if (typeof body === 'function') body(content, api); else if (body) append(content, [body]);
  document.body.append(back);
  document.addEventListener('keydown', onKey);
  setTimeout(() => box.querySelector('input:not([type=checkbox]),textarea,select')?.focus(), 30);
  return api;
}

export function confirmDialog(message, { okLabel = 'OK', danger = false, title = 'Confirm' } = {}) {
  return new Promise((resolve) => {
    let ok = false;
    modal({ title, body: h('p', message), onClose: () => resolve(ok), actions: [{ label: 'Cancel' }, { label: okLabel, primary: !danger, danger, onClick: () => { ok = true; } }] });
  });
}

export function promptDialog(title, value = '', { label = '', placeholder = '', okLabel = 'OK' } = {}) {
  return new Promise((resolve) => {
    let result = null;
    const input = h('input.input', { value, placeholder, onkeydown: (e) => { if (e.key === 'Enter') { result = input.value; m.close(); } } });
    const m = modal({ title, body: h('label.field', label ? h('span', label) : null, input), onClose: () => resolve(result), actions: [{ label: 'Cancel' }, { label: okLabel, primary: true, onClick: () => { result = input.value; } }] });
    setTimeout(() => input.select(), 40);
  });
}

/* ----------------------------------------------------------------- menus */

export function menu(anchor, items) {
  document.querySelectorAll('.popmenu').forEach((m) => m.remove());
  const el = h('div.popmenu', { role: 'menu' }, items.filter(Boolean).map((it) => it.sep ? h('div.popmenu-sep') : h(`button.popmenu-item${it.danger ? '.danger' : ''}`, {
    type: 'button', role: 'menuitem', disabled: it.disabled,
    onclick: (e) => { e.stopPropagation(); el.remove(); it.onClick?.(); },
  }, it.icon ? h('span.popmenu-icon', it.icon) : null, it.label, it.hint ? h('span.popmenu-hint', it.hint) : null)));
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth, hh = el.offsetHeight;
  el.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  el.style.top = `${r.bottom + hh + 4 > innerHeight ? Math.max(8, r.top - hh - 4) : r.bottom + 4}px`;
  const off = (e) => { if (!el.contains(e.target)) { el.remove(); document.removeEventListener('mousedown', off, true); } };
  setTimeout(() => document.addEventListener('mousedown', off, true), 0);
  el.querySelector('button')?.focus();
  el.addEventListener('keydown', (e) => {
    const btns = [...el.querySelectorAll('button:not([disabled])')];
    const i = btns.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length]?.focus(); }
    if (e.key === 'Escape') el.remove();
  });
  return el;
}

/* ---------------------------------------------------------------- inputs */

export function select(options, value, onChange, attrs = {}) {
  return h('select.input', { ...attrs, onchange: (e) => onChange(e.target.value) },
    options.map((o) => {
      const [v, label] = Array.isArray(o) ? o : typeof o === 'object' ? [o.value, o.label] : [o, o];
      return h('option', { value: v, selected: String(v) === String(value) }, label);
    }));
}

export function segmented(options, value, onChange, { label } = {}) {
  const el = h('div.segmented', { role: 'radiogroup', 'aria-label': label || '' });
  const render = (val) => mount(el, options.map(([v, l]) => h(`button.seg${v === val ? '.on' : ''}`, {
    type: 'button', role: 'radio', 'aria-checked': String(v === val),
    onclick: () => { render(v); onChange(v); },
  }, l)));
  render(value);
  return el;
}

export function numField(label, value, onChange, { min = 0, step = 1, suffix = '', hint = '', max } = {}) {
  return h('label.field', h('span', label, hint ? h('span.hint', { title: hint }, ' ⓘ') : null),
    h('div.input-suffix',
      h('input.input', { type: 'number', min, max, step, value: value ?? '', oninput: (e) => onChange(e.target.value === '' ? '' : Number(e.target.value)) }),
      suffix ? h('span.suffix', suffix) : null));
}

export function checkField(label, checked, onChange, hint) {
  return h('label.check', h('input', { type: 'checkbox', checked: !!checked, onchange: (e) => onChange(e.target.checked) }), h('span', label), hint ? h('span.hint', { title: hint }, ' ⓘ') : null);
}

/**
 * Key/value table editor. rows: [{key, value, enabled, type?, fileName?, data?}]
 * Mutates rows in place and calls onChange().
 */
export function kvEditor(rows, onChange, { keyPh = 'Key', valPh = 'Value', files = false, secrets = false, bulk = true } = {}) {
  const wrap = h('div.kv');
  let bulkMode = false;
  const ensureTrailing = () => {
    const last = rows[rows.length - 1];
    if (!last || last.key || last.value) rows.push({ key: '', value: '', enabled: true, ...(files ? { type: 'text' } : {}) });
  };
  const changed = () => { onChange?.(); };
  const render = () => {
    clear(wrap);
    if (bulkMode) {
      const ta = h('textarea.input.mono', {
        rows: Math.max(6, rows.length + 1), spellcheck: false,
        value: rows.filter((r) => r.key || r.value).map((r) => `${r.enabled === false ? '//' : ''}${r.key}:${r.value ?? ''}`).join('\n'),
        oninput: (e) => {
          const next = e.target.value.split('\n').filter((l) => l.trim()).map((l) => {
            const dis = l.startsWith('//');
            const s = dis ? l.slice(2) : l;
            const i = s.indexOf(':');
            return { key: (i < 0 ? s : s.slice(0, i)).trim(), value: i < 0 ? '' : s.slice(i + 1).trim(), enabled: !dis, ...(files ? { type: 'text' } : {}) };
          });
          rows.splice(0, rows.length, ...next);
          changed();
        },
      });
      wrap.append(h('div.kv-tools', h('span.muted', 'One per line as key:value. Prefix with // to disable.'), h('button.link', { type: 'button', onclick: () => { bulkMode = false; render(); } }, 'Table edit')), ta);
      return;
    }
    ensureTrailing();
    const table = h('div.kv-table');
    rows.forEach((r, i) => {
      const isLast = i === rows.length - 1;
      const valueCell = files && r.type === 'file'
        ? h('div.file-cell',
          h('input', {
            type: 'file', onchange: async (e) => {
              const f = e.target.files[0];
              if (!f) return;
              if (f.size > 20 * 1024 * 1024) { toast('Files over 20 MB are not supported', 'error'); return; }
              const b64 = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1] || ''); fr.readAsDataURL(f); });
              Object.assign(r, { fileName: f.name, contentType: f.type || 'application/octet-stream', data: b64 });
              changed(); render();
            },
          }),
          h('span.muted', r.fileName ? `${r.fileName}${r.data ? ` (${fmtBytes(Math.floor(r.data.length * 0.75))})` : ' (re-attach file)'}` : 'no file'))
        : h('input.input.mono', {
          value: r.value ?? '', placeholder: valPh, spellcheck: false, type: secrets && r.secret ? 'password' : 'text',
          oninput: (e) => { r.value = e.target.value; if (isLast) { changed(); render(); refocus(i, 'v'); } else changed(); },
        });
      table.append(h('div.kv-row', { dataset: { i } },
        h('input', { type: 'checkbox', 'aria-label': 'Enabled', checked: r.enabled !== false, style: isLast && !r.key && !r.value ? { visibility: 'hidden' } : null, onchange: (e) => { r.enabled = e.target.checked; changed(); } }),
        h('input.input.mono', {
          value: r.key ?? '', placeholder: keyPh, spellcheck: false,
          oninput: (e) => { r.key = e.target.value; if (isLast) { changed(); render(); refocus(i, 'k'); } else changed(); },
        }),
        files ? select([['text', 'Text'], ['file', 'File']], r.type || 'text', (v) => { r.type = v; changed(); render(); }, { class: 'kv-type', 'aria-label': 'Field type' }) : null,
        valueCell,
        secrets ? h('button.icon-btn', { type: 'button', title: r.secret ? 'Secret (masked)' : 'Mark as secret', 'aria-label': 'Toggle secret', onclick: () => { r.secret = !r.secret; changed(); render(); } }, r.secret ? '🔒' : '🔓') : null,
        h('button.icon-btn', { type: 'button', title: 'Remove', 'aria-label': 'Remove row', style: isLast ? { visibility: 'hidden' } : null, onclick: () => { rows.splice(i, 1); changed(); render(); } }, '✕')));
    });
    wrap.append(table);
    if (bulk) wrap.append(h('div.kv-tools', h('button.link', { type: 'button', onclick: () => { bulkMode = true; render(); } }, 'Bulk edit')));
  };
  const refocus = (i, which) => {
    const row = wrap.querySelector(`.kv-row[data-i="${i}"]`);
    const inp = row?.querySelectorAll('input.input')[which === 'k' ? 0 : 1];
    if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
  };
  render();
  wrap.refresh = render;
  return wrap;
}

/* --------------------------------------------------------------- utility */

export function download(filename, text, type = 'application/json') {
  const blob = text instanceof Blob ? text : new Blob([text], { type });
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export async function copyText(text, what = 'Copied to clipboard') {
  try { await navigator.clipboard.writeText(text); toast(what, 'ok', 1800); }
  catch {
    const ta = h('textarea', { value: text, style: { position: 'fixed', opacity: '0' } });
    document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast(what, 'ok', 1800);
  }
}

export function readFileText(file) {
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.onerror = rej; fr.readAsText(file); });
}

/** JSON syntax highlighting (returns HTML). Large documents are not highlighted for speed. */
export function highlightJson(text) {
  if (text.length > 400000) return escapeHtml(text);
  return escapeHtml(text).replace(/(&quot;(?:\\.|[^&\\]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, (m, str, colon, lit, num) => {
    if (str) return colon ? `<span class="j-key">${str}</span>${colon}` : `<span class="j-str">${str}</span>`;
    if (lit) return `<span class="j-lit">${lit}</span>`;
    if (num) return `<span class="j-num">${num}</span>`;
    return m;
  });
}

export function prettyMaybeJson(text) {
  try { return { pretty: JSON.stringify(JSON.parse(text), null, 2), json: true }; } catch { return { pretty: text, json: false }; }
}

export function prettyXml(xml) {
  if (xml.length > 300000) return xml;
  let pad = 0;
  return xml.replace(/>\s*</g, '>\n<').split('\n').map((line) => {
    if (/^<\/\w/.test(line)) pad = Math.max(0, pad - 1);
    const out = '  '.repeat(pad) + line;
    if (/^<\w[^>]*[^/]>.*$/.test(line) && !/<\/\w[^>]*>$/.test(line) && !/^<\?/.test(line)) pad++;
    return out;
  }).join('\n');
}

export function statusClass(status) {
  if (!status) return 'st-err';
  if (status < 300) return 'st-2';
  if (status < 400) return 'st-3';
  if (status < 500) return 'st-4';
  return 'st-5';
}

export function methodClass(m) { return 'm-' + String(m || 'GET').toLowerCase(); }

export function storageGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
export function storageSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
}

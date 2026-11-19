import { newRequest } from '../prepare.js';

/* ---------------------------------------------------------------- parsing */

function tokenize(input) {
  let s = input;
  // Chrome "Copy as cURL (cmd)" escapes everything with ^ : strip the carets first.
  if (/\^"/.test(s) || /\^\r?\n/.test(s)) s = s.replace(/\^\r?\n/g, ' ').replace(/\^(.)/g, '$1');
  // line continuations: bash "\", PowerShell "`"
  s = s.replace(/\\\r?\n/g, ' ').replace(/`\r?\n/g, ' ');
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    let tok = '';
    let had = false;
    while (i < s.length && !/\s/.test(s[i])) {
      const c = s[i];
      had = true;
      if (c === "'") {
        const j = s.indexOf("'", i + 1);
        if (j < 0) throw new Error('Unterminated single quote in cURL command');
        tok += s.slice(i + 1, j); i = j + 1;
      } else if (c === '$' && s[i + 1] === "'") {
        i += 2;
        while (i < s.length && s[i] !== "'") {
          if (s[i] === '\\') {
            const n = s[i + 1];
            const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '0': '\0', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v' };
            if (n === 'x') { tok += String.fromCharCode(parseInt(s.substr(i + 2, 2), 16)); i += 4; continue; }
            if (n === 'u') { tok += String.fromCharCode(parseInt(s.substr(i + 2, 4), 16)); i += 6; continue; }
            tok += map[n] ?? n; i += 2; continue;
          }
          tok += s[i++];
        }
        i++;
      } else if (c === '"') {
        i++;
        while (i < s.length && s[i] !== '"') {
          if (s[i] === '\\' && ['"', '\\', '$', '`'].includes(s[i + 1])) { tok += s[i + 1]; i += 2; continue; }
          if (s[i] === '\\' && s[i + 1] === '\n') { i += 2; continue; }
          tok += s[i++];
        }
        if (i >= s.length) throw new Error('Unterminated double quote in cURL command');
        i++;
      } else if (c === '\\') { tok += s[i + 1] ?? ''; i += 2; }
      else { tok += c; i++; }
    }
    if (had) tokens.push(tok);
  }
  return tokens;
}

const VALUE_SHORT = new Set(['X', 'H', 'd', 'F', 'u', 'A', 'b', 'e', 'm', 'o', 'x', 'T', 'w', 'E', 'r', 'c', 'K', 'U', 'y', 'Y', 'z', 'C', 'Q']);
const VALUE_LONG = new Set([
  'request', 'header', 'data', 'data-raw', 'data-binary', 'data-ascii', 'data-urlencode', 'json', 'form', 'form-string', 'user', 'user-agent',
  'cookie', 'referer', 'max-time', 'connect-timeout', 'output', 'proxy', 'url', 'cert', 'key', 'cacert', 'oauth2-bearer', 'retry', 'limit-rate',
  'resolve', 'write-out', 'upload-file', 'range', 'interface', 'unix-socket', 'cookie-jar', 'config', 'proxy-user', 'aws-sigv4', 'request-target',
]);

function looksLikeForm(s) {
  return !/[\r\n]/.test(s) && /^[^=&\s{}[\]]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(s);
}

/** Parse one cURL command into an ApiStorm request. */
export function parseCurl(cmd) {
  const t = tokenize(String(cmd).trim());
  if (!t.length || !/^curl(\.exe)?$/i.test(t[0].split(/[\\/]/).pop())) throw new Error('Not a cURL command (must start with "curl")');
  let method = null, url = null, insecure = false, timeoutMs = null, get = false, head = false, follow = true;
  const headers = [], data = [], form = [];
  let user = null, jsonMode = false;
  const notes = [];

  const take = (name, val) => {
    switch (name) {
      case 'X': case 'request': method = val.toUpperCase(); break;
      case 'H': case 'header': {
        const idx = val.indexOf(':');
        if (idx > 0) headers.push({ key: val.slice(0, idx).trim(), value: val.slice(idx + 1).trim(), enabled: true });
        else if (val.endsWith(';')) headers.push({ key: val.slice(0, -1).trim(), value: '', enabled: true });
        break;
      }
      case 'd': case 'data': case 'data-ascii':
        if (val.startsWith('@')) notes.push(`Body was read from file ${val.slice(1)}; paste its content manually.`);
        data.push(val.replace(/[\r\n]/g, '')); break;
      case 'data-raw': data.push(val); break;
      case 'data-binary':
        if (val.startsWith('@')) notes.push(`Body was read from file ${val.slice(1)}; paste its content manually.`);
        data.push(val); break;
      case 'json': data.push(val); jsonMode = true; break;
      case 'data-urlencode': {
        const eq = val.indexOf('=');
        if (eq > 0) data.push(val.slice(0, eq) + '=' + encodeURIComponent(val.slice(eq + 1)));
        else data.push(encodeURIComponent(eq === 0 ? val.slice(1) : val));
        break;
      }
      case 'F': case 'form': case 'form-string': {
        const eq = val.indexOf('=');
        const key = val.slice(0, eq), v = val.slice(eq + 1);
        if (name !== 'form-string' && v.startsWith('@')) {
          form.push({ key, type: 'file', fileName: v.slice(1).split(';')[0].split(/[\\/]/).pop(), data: '', enabled: true });
          notes.push(`Form field "${key}" referenced a file; re-attach it in the Body tab.`);
        } else form.push({ key, value: v.replace(/^"|"$/g, ''), type: 'text', enabled: true });
        break;
      }
      case 'u': case 'user': user = val; break;
      case 'A': case 'user-agent': headers.push({ key: 'User-Agent', value: val, enabled: true }); break;
      case 'b': case 'cookie': headers.push({ key: 'Cookie', value: val, enabled: true }); break;
      case 'e': case 'referer': headers.push({ key: 'Referer', value: val, enabled: true }); break;
      case 'm': case 'max-time': timeoutMs = Math.round(parseFloat(val) * 1000); break;
      case 'url': url = val; break;
      case 'oauth2-bearer': headers.push({ key: 'Authorization', value: 'Bearer ' + val, enabled: true }); break;
      default: break;
    }
  };

  for (let i = 1; i < t.length; i++) {
    const tok = t[i];
    if (tok.startsWith('--')) {
      const name = tok.slice(2);
      if (VALUE_LONG.has(name)) { take(name, t[++i] ?? ''); continue; }
      if (name === 'insecure') insecure = true;
      else if (name === 'get') get = true;
      else if (name === 'head') head = true;
      else if (name === 'location') follow = true;
      else if (name === 'compressed') { /* we always decompress */ }
      continue;
    }
    if (tok.startsWith('-') && tok.length > 1) {
      for (let j = 1; j < tok.length; j++) {
        const f = tok[j];
        if (VALUE_SHORT.has(f)) {
          const rest = tok.slice(j + 1);
          take(f, rest !== '' ? rest : (t[++i] ?? ''));
          break;
        }
        if (f === 'k') insecure = true;
        else if (f === 'G') get = true;
        else if (f === 'I') head = true;
        else if (f === 'L') follow = true;
      }
      continue;
    }
    if (url == null) url = tok;
  }
  if (!url) throw new Error('No URL found in cURL command');

  const req = newRequest();
  req.settings.insecure = insecure;
  req.settings.followRedirects = follow;
  if (timeoutMs) req.settings.timeoutMs = timeoutMs;

  let bodyStr = data.join('&');
  if (get && data.length) { url += (url.includes('?') ? '&' : '?') + bodyStr; bodyStr = ''; }

  // split query string into params (keep the base URL clean)
  const qi = url.indexOf('?');
  if (qi >= 0) {
    const qs = url.slice(qi + 1).split('#')[0];
    url = url.slice(0, qi);
    for (const part of qs.split('&')) {
      if (!part) continue;
      const eq = part.indexOf('=');
      const dec = (x) => { try { return decodeURIComponent(x.replace(/\+/g, ' ')); } catch { return x; } };
      req.params.push({ key: dec(eq < 0 ? part : part.slice(0, eq)), value: eq < 0 ? '' : dec(part.slice(eq + 1)), enabled: true });
    }
  }
  req.url = url;
  req.method = method || (head ? 'HEAD' : (bodyStr || form.length ? 'POST' : 'GET'));

  // auth
  const authIdx = headers.findIndex((h) => h.key.toLowerCase() === 'authorization');
  if (user != null) {
    const c = user.indexOf(':');
    req.auth = { type: 'basic', username: c < 0 ? user : user.slice(0, c), password: c < 0 ? '' : user.slice(c + 1) };
  } else if (authIdx >= 0 && /^bearer\s+/i.test(headers[authIdx].value)) {
    req.auth = { type: 'bearer', token: headers[authIdx].value.replace(/^bearer\s+/i, '') };
    headers.splice(authIdx, 1);
  } else req.auth = { type: 'none' };

  // body
  const ctIdx = headers.findIndex((h) => h.key.toLowerCase() === 'content-type');
  const ct = ctIdx >= 0 ? headers[ctIdx].value.toLowerCase() : '';
  if (form.length) {
    req.body = { ...req.body, mode: 'formdata', form };
    if (ctIdx >= 0 && ct.includes('multipart')) headers.splice(ctIdx, 1);
  } else if (bodyStr) {
    const trimmed = bodyStr.trim();
    if (jsonMode || ct.includes('json') || ((!ct) && /^[[{]/.test(trimmed))) {
      let raw = bodyStr;
      try { raw = JSON.stringify(JSON.parse(bodyStr), null, 2); } catch { /* keep as-is */ }
      req.body = { ...req.body, mode: 'json', raw };
      if (ctIdx >= 0 && ct === 'application/json') headers.splice(ctIdx, 1);
      if (jsonMode && !headers.some((h) => h.key.toLowerCase() === 'accept')) headers.push({ key: 'Accept', value: 'application/json', enabled: true });
    } else if ((!ct || ct.includes('x-www-form-urlencoded')) && looksLikeForm(bodyStr)) {
      const dec = (x) => { try { return decodeURIComponent(x.replace(/\+/g, ' ')); } catch { return x; } };
      req.body = {
        ...req.body, mode: 'urlencoded',
        form: bodyStr.split('&').map((p) => { const e = p.indexOf('='); return { key: dec(p.slice(0, e)), value: dec(p.slice(e + 1)), enabled: true }; }),
      };
      if (ctIdx >= 0) headers.splice(ctIdx, 1);
    } else if (ct.includes('xml')) req.body = { ...req.body, mode: 'xml', raw: bodyStr };
    else req.body = { ...req.body, mode: 'text', raw: bodyStr };
  }
  req.headers = headers;
  let host = '';
  try { host = new URL(/^[a-z]+:\/\//i.test(url) ? url : 'http://' + url).pathname; } catch { host = url; }
  req.name = `${req.method} ${host.length > 1 ? host : url}`.slice(0, 80);
  if (notes.length) req.description = notes.join('\n');
  return req;
}

/** Split text containing one or more cURL commands. */
export function splitCurls(text) {
  const src = String(text).replace(/\r\n/g, '\n');
  const starts = [];
  const re = /(^|\n)\s*(curl(?:\.exe)?)\s/gi;
  let m;
  while ((m = re.exec(src))) {
    const idx = m.index + m[1].length;
    // skip if previous line ends with a continuation char (then "curl" is an argument)
    const before = src.slice(0, idx).replace(/\s+$/, '');
    if (/[\\^`]$/.test(before)) continue;
    starts.push(idx);
  }
  return starts.map((s, i) => src.slice(s, starts[i + 1] ?? src.length).trim()).filter(Boolean);
}

/* ------------------------------------------------------------- generation */

const qBash = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : "'" + String(s).replace(/'/g, "'\\''") + "'");
const qCmd = (s) => '"' + String(s).replace(/"/g, '\\"') + '"';

/** prep = output of prepareRequest (resolved or raw). shell: bash | cmd */
export function toCurl(prep, { shell = 'bash', multiline = true, insecure = false } = {}) {
  const q = shell === 'cmd' ? qCmd : qBash;
  const parts = ['curl'];
  if (prep.method !== 'GET' || (prep.body && prep.body.length)) parts.push(`-X ${prep.method}`);
  parts.push(q(prep.url));
  for (const [k, v] of prep.headers) {
    if (k.toLowerCase() === 'content-length') continue;
    parts.push(`-H ${q(`${k}: ${v}`)}`);
  }
  if (prep.basicAuth) parts.push(`-u ${q(`${prep.basicAuth.username}:${prep.basicAuth.password}`)}`);
  if (prep.formFields) {
    for (const f of prep.formFields) parts.push(`-F ${q(f.type === 'file' ? `${f.key}=@${f.fileName || 'file'}` : `${f.key}=${f.value ?? ''}`)}`);
  } else if (prep.body && prep.body.length) {
    const ct = (prep.headers.find(([k]) => k.toLowerCase() === 'content-type') || [])[1] || '';
    if (/multipart\/form-data/i.test(ct)) parts.push(`--data-binary ${q('@body.bin')}`);
    else parts.push(`--data-raw ${q(prep.body.toString('utf8'))}`);
  }
  if (insecure) parts.push('-k');
  const sep = multiline ? (shell === 'cmd' ? ' ^\n  ' : ' \\\n  ') : ' ';
  return parts.join(sep);
}

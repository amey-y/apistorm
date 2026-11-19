import { toCurl } from './curl.js';

const js = (s) => JSON.stringify(s);
const py = (s) => JSON.stringify(s); // JSON string literals are valid Python string literals (incl. escapes)
const ps = (s) => "'" + String(s).replace(/'/g, "''") + "'";

function bodyText(prep) {
  return prep.body && prep.body.length ? prep.body.toString('utf8') : null;
}
function contentType(prep) {
  return ((prep.headers.find(([k]) => k.toLowerCase() === 'content-type') || [])[1] || '').toLowerCase();
}
function isJson(prep) {
  const b = bodyText(prep);
  if (!b || !contentType(prep).includes('json')) return false;
  try { JSON.parse(b); return true; } catch { return false; }
}

const generators = {
  'curl-bash': { label: 'cURL (bash)', gen: (p, o) => toCurl(p, { shell: 'bash', insecure: o.insecure }) },
  'curl-cmd': { label: 'cURL (Windows cmd)', gen: (p, o) => toCurl(p, { shell: 'cmd', insecure: o.insecure }) },
  fetch: {
    label: 'JavaScript (fetch)',
    gen: (p) => {
      const headers = Object.fromEntries(p.headers.filter(([k]) => !(p.formFields && /content-type/i.test(k))));
      if (p.basicAuth) headers.Authorization = 'Basic ' + Buffer.from(`${p.basicAuth.username}:${p.basicAuth.password}`).toString('base64');
      const lines = [`const res = await fetch(${js(p.url)}, {`, `  method: ${js(p.method)},`, `  headers: ${JSON.stringify(headers, null, 2).replace(/\n/g, '\n  ')},`];
      if (p.formFields) {
        const fd = p.formFields.map((f) => f.type === 'file' ? `form.append(${js(f.key)}, fileInput.files[0]); // ${f.fileName || 'file'}` : `form.append(${js(f.key)}, ${js(f.value ?? '')});`);
        lines.unshift('const form = new FormData();', ...fd, '');
        lines.push('  body: form,');
      } else if (bodyText(p) != null) {
        lines.push(isJson(p) ? `  body: JSON.stringify(${JSON.stringify(JSON.parse(bodyText(p)), null, 2).replace(/\n/g, '\n  ')}),` : `  body: ${js(bodyText(p))},`);
      }
      lines.push('});', 'console.log(res.status, await res.text());');
      return lines.join('\n');
    },
  },
  python: {
    label: 'Python (requests)',
    gen: (p, o) => {
      const lines = ['import requests', '', `url = ${py(p.url)}`];
      const headers = p.headers.filter(([k]) => !(p.formFields && /content-type/i.test(k)));
      lines.push('headers = {', ...headers.map(([k, v]) => `    ${py(k)}: ${py(v)},`), '}');
      const args = ['url', 'headers=headers'];
      if (p.basicAuth) args.push(`auth=(${py(p.basicAuth.username)}, ${py(p.basicAuth.password)})`);
      if (p.formFields) {
        lines.push('data = {', ...p.formFields.filter((f) => f.type !== 'file').map((f) => `    ${py(f.key)}: ${py(f.value ?? '')},`), '}');
        const files = p.formFields.filter((f) => f.type === 'file');
        if (files.length) { lines.push('files = {', ...files.map((f) => `    ${py(f.key)}: open(${py(f.fileName || 'file')}, "rb"),`), '}'); args.push('files=files'); }
        args.push('data=data');
      } else if (bodyText(p) != null) {
        lines.push(`payload = ${py(bodyText(p))}`);
        args.push('data=payload.encode("utf-8")');
      }
      if (o.insecure) args.push('verify=False');
      lines.push('', `response = requests.request(${py(p.method)}, ${args.join(', ')}, timeout=30)`, 'print(response.status_code)', 'print(response.text)');
      return lines.join('\n');
    },
  },
  powershell: {
    label: 'PowerShell',
    gen: (p, o) => {
      const lines = ['$headers = @{'];
      for (const [k, v] of p.headers) if (!/^content-type$/i.test(k)) lines.push(`  ${ps(k)} = ${ps(v)}`);
      if (p.basicAuth) lines.push(`  'Authorization' = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(${ps(p.basicAuth.username + ':' + p.basicAuth.password)}))`);
      lines.push('}');
      const args = [`-Uri ${ps(p.url)}`, `-Method ${p.method}`, '-Headers $headers'];
      const ct = (p.headers.find(([k]) => k.toLowerCase() === 'content-type') || [])[1];
      if (p.formFields) {
        lines.push('$form = @{', ...p.formFields.map((f) => f.type === 'file' ? `  ${ps(f.key)} = Get-Item ${ps(f.fileName || 'file')}` : `  ${ps(f.key)} = ${ps(f.value ?? '')}`), '}');
        args.push('-Form $form');
      } else if (bodyText(p) != null) {
        lines.push(`$body = @'\n${bodyText(p)}\n'@`);
        args.push('-Body $body');
        if (ct) args.push(`-ContentType ${ps(ct)}`);
      }
      if (o.insecure) args.push('-SkipCertificateCheck');
      lines.push(`$response = Invoke-WebRequest ${args.join(' ')}`, '$response.StatusCode', '$response.Content');
      return lines.join('\n');
    },
  },
  httpie: {
    label: 'HTTPie',
    gen: (p, o) => {
      const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
      const parts = ['http', o.insecure ? '--verify=no' : null, p.formFields ? '--multipart' : null, p.method, q(p.url)].filter(Boolean);
      for (const [k, v] of p.headers) if (!(p.formFields && /content-type/i.test(k))) parts.push(q(`${k}:${v}`));
      if (p.basicAuth) parts.splice(1, 0, `-a ${q(p.basicAuth.username + ':' + p.basicAuth.password)}`);
      if (p.formFields) for (const f of p.formFields) parts.push(f.type === 'file' ? q(`${f.key}@${f.fileName || 'file'}`) : q(`${f.key}=${f.value ?? ''}`));
      const b = bodyText(p);
      return (b != null && !p.formFields ? `printf '%s' ${q(b)} | ` : '') + parts.join(' \\\n  ');
    },
  },
};

export const CODEGEN_LANGS = Object.entries(generators).map(([id, g]) => ({ id, label: g.label }));

export function generateCode(lang, prep, opts = {}) {
  const g = generators[lang];
  if (!g) throw Object.assign(new Error(`Unknown language ${lang}`), { status: 400 });
  return g.gen(prep, opts);
}

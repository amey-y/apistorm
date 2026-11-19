/**
 * Dependency-free YAML 1.2 parser covering what real-world API specs use:
 * block mappings/sequences, "- key: value" items, flow collections ([..] / {..}, multi-line),
 * plain / single / double quoted scalars (incl. multi-line), block scalars (| > with chomping and
 * indentation indicators), comments, anchors (&a), aliases (*a), merge keys (<<), tags (ignored),
 * document markers (--- / ...). Multiple documents: the first one is returned.
 */

class YamlError extends Error {
  constructor(msg, line) { super(`YAML error${line != null ? ` (line ${line + 1})` : ''}: ${msg}`); this.line = line; }
}

const isBlank = (l) => /^\s*(#.*)?$/.test(l);
const indentOf = (l) => l.length - l.replace(/^ +/, '').length;

/** Remove a trailing comment (" #...") that is outside quotes. */
function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (q === '"' && c === '\\') { i++; continue; }
      if (c === q) { if (q === "'" && s[i + 1] === "'") { i++; continue; } q = null; }
      continue;
    }
    if (c === '"' || c === "'") { if (i === 0 || /[\s[{,:]/.test(s[i - 1])) q = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
  }
  return s.trimEnd();
}

/** If the content is "key: value" return { key, rest }, else null. */
function splitKey(content) {
  let i = 0;
  let key;
  if (content[0] === '"' || content[0] === "'") {
    const q = content[0];
    i = 1;
    while (i < content.length) {
      if (q === '"' && content[i] === '\\') { i += 2; continue; }
      if (content[i] === q) { if (q === "'" && content[i + 1] === "'") { i += 2; continue; } break; }
      i++;
    }
    if (i >= content.length) return null;
    const raw = content.slice(0, i + 1);
    let j = i + 1;
    while (content[j] === ' ') j++;
    if (content[j] !== ':' || (content[j + 1] !== undefined && !/\s/.test(content[j + 1]))) return null;
    key = parseQuoted(raw);
    return { key, rest: content.slice(j + 1).trim() };
  }
  if (/^[[{]/.test(content) || content.startsWith('- ') || content === '-' || content.startsWith('#')) return null;
  for (i = 0; i < content.length; i++) {
    const c = content[i];
    if (c === '#' && i > 0 && /\s/.test(content[i - 1])) return null;
    if (c === ':' && (i + 1 === content.length || /\s/.test(content[i + 1]))) {
      key = content.slice(0, i).trim();
      if (key === '') return null;
      return { key, rest: content.slice(i + 1).trim() };
    }
  }
  return null;
}

function parseQuoted(s) {
  if (s[0] === "'") return s.slice(1, -1).replace(/''/g, "'");
  let out = '';
  for (let i = 1; i < s.length - 1; i++) {
    const c = s[i];
    if (c !== '\\') { out += c; continue; }
    const n = s[++i];
    const map = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', '0': '\0', b: '\b', f: '\f', e: '\x1b', ' ': ' ', N: '\u0085', _: ' ', a: '\x07', v: '\v' };
    if (n === 'x') { out += String.fromCharCode(parseInt(s.substr(i + 1, 2), 16)); i += 2; }
    else if (n === 'u') { out += String.fromCharCode(parseInt(s.substr(i + 1, 4), 16)); i += 4; }
    else if (n === 'U') { out += String.fromCodePoint(parseInt(s.substr(i + 1, 8), 16)); i += 8; }
    else out += map[n] ?? n;
  }
  return out;
}

export function resolvePlain(s) {
  if (/^(null|Null|NULL|~|)$/.test(s)) return null;
  if (/^(true|True|TRUE)$/.test(s)) return true;
  if (/^(false|False|FALSE)$/.test(s)) return false;
  if (/^[-+]?\d+$/.test(s)) { const n = Number(s); return Number.isSafeInteger(n) ? n : s; }
  if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s, 16);
  if (/^0o[0-7]+$/.test(s)) return parseInt(s.slice(2), 8);
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(s)) return Number(s);
  if (/^[-+]?\.(inf|Inf|INF)$/.test(s)) return s.startsWith('-') ? -Infinity : Infinity;
  if (/^\.(nan|NaN|NAN)$/.test(s)) return NaN;
  return s;
}

class Parser {
  constructor(text) {
    this.lines = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/\t/g, '  ').split('\n');
    this.i = 0;
    this.anchors = Object.create(null);
    // document boundaries: skip directives and the first "---", stop at "..." or the next "---"
    let start = 0;
    while (start < this.lines.length && (isBlank(this.lines[start]) || this.lines[start].startsWith('%'))) start++;
    if (/^---(\s|$)/.test(this.lines[start] || '')) {
      const rest = this.lines[start].slice(3).trim();
      if (rest && !rest.startsWith('#')) this.lines[start] = rest; else start++;
    }
    let end = this.lines.length;
    for (let k = start; k < this.lines.length; k++) if (/^(---|\.\.\.)(\s|$)/.test(this.lines[k])) { end = k; break; }
    this.lines = this.lines.slice(0, end);
    this.i = start;
  }

  skip() { while (this.i < this.lines.length && isBlank(this.lines[this.i])) this.i++; }

  parse() {
    this.skip();
    if (this.i >= this.lines.length) return null;
    const v = this.node(-1);
    this.skip();
    if (this.i < this.lines.length) throw new YamlError(`unexpected content "${this.lines[this.i].trim().slice(0, 40)}"`, this.i);
    return v;
  }

  /** Parse the node starting at the current line if its indent > parentIndent. */
  node(parentIndent) {
    this.skip();
    if (this.i >= this.lines.length) return null;
    const line = this.lines[this.i];
    const ind = indentOf(line);
    if (ind <= parentIndent) return null;
    const content = line.slice(ind);
    if (content === '-' || content.startsWith('- ')) return this.seq(ind);
    if (splitKey(stripComment(content))) return this.map(ind);
    // a standalone scalar / flow collection / alias, possibly with anchor/tag
    this.i++;
    return this.inline(stripComment(content), ind, parentIndent);
  }

  map(ind) {
    const obj = {};
    while (true) {
      this.skip();
      if (this.i >= this.lines.length) break;
      const line = this.lines[this.i];
      const li = indentOf(line);
      if (li < ind) break;
      if (li > ind) throw new YamlError('bad indentation of a mapping entry', this.i);
      const content = stripComment(line.slice(ind));
      if (content === '-' || content.startsWith('- ')) break;
      const kv = splitKey(content);
      if (!kv) throw new YamlError(`expected "key: value", got "${content.slice(0, 40)}"`, this.i);
      this.i++;
      const value = this.valueAfterKey(kv.rest, ind);
      if (kv.key === '<<') {
        const srcs = Array.isArray(value) ? value : [value];
        for (const s of srcs) if (s && typeof s === 'object') for (const [k, v] of Object.entries(s)) if (!(k in obj)) obj[k] = v;
      } else obj[kv.key] = value;
    }
    return obj;
  }

  /** Value of "key: <rest>" where the key sits at indent `ind`. */
  valueAfterKey(rest, ind) {
    const { anchor, rest: r } = this.props(rest);
    let v;
    if (r === '') {
      this.skip();
      const next = this.lines[this.i];
      // block sequences may sit at the same indent as their key
      if (next !== undefined && indentOf(next) === ind && /^-( |$)/.test(next.slice(ind))) v = this.seq(ind);
      else v = this.node(ind);
    } else v = this.inline(r, ind, ind);
    if (anchor) this.anchors[anchor] = v;
    return v;
  }

  seq(ind) {
    const arr = [];
    while (true) {
      this.skip();
      if (this.i >= this.lines.length) break;
      const line = this.lines[this.i];
      const li = indentOf(line);
      if (li !== ind) { if (li > ind) throw new YamlError('bad indentation of a sequence entry', this.i); break; }
      const content = line.slice(ind);
      if (!(content === '-' || content.startsWith('- '))) break;
      const after = content.slice(1).replace(/^ +/, '');
      const itemIndent = ind + (content.length - after.length);
      const afterNc = stripComment(after);
      if (afterNc === '') { this.i++; arr.push(this.node(ind)); continue; }
      const { anchor, rest } = this.props(afterNc);
      if (anchor && rest === '') { this.i++; const v = this.node(ind); this.anchors[anchor] = v; arr.push(v); continue; }
      const off = afterNc.length - rest.length;
      if (rest.startsWith('- ') || rest === '-' || splitKey(rest)) {
        // re-read this line as a nested block whose indent is the item content column
        this.lines[this.i] = ' '.repeat(itemIndent + off) + after.slice(off);
        const v = rest.startsWith('-') ? this.seq(itemIndent + off) : this.map(itemIndent + off);
        if (anchor) this.anchors[anchor] = v;
        arr.push(v);
        continue;
      }
      this.i++;
      const v = this.inline(rest, ind, ind);
      if (anchor) this.anchors[anchor] = v;
      arr.push(v);
    }
    return arr;
  }

  /** Strip anchor (&a) and tag (!x / !!x) properties. */
  props(s) {
    let anchor = null;
    let rest = s;
    for (let guard = 0; guard < 3; guard++) {
      const m = /^(&[^\s,[\]{}]+|![^\s]*)\s*/.exec(rest);
      if (!m) break;
      if (m[1][0] === '&') anchor = m[1].slice(1);
      rest = rest.slice(m[0].length);
    }
    return { anchor, rest };
  }

  /** A value written on the same line as its key / dash. `ind` = indent of the owner line. */
  inline(s, ind, parentIndent) {
    const { anchor, rest } = this.props(s);
    let v;
    if (rest.startsWith('*')) v = this.alias(rest.slice(1).trim());
    else if (/^[|>]/.test(rest)) v = this.blockScalar(rest, parentIndent);
    else if (rest[0] === '[' || rest[0] === '{') v = this.flowFrom(rest);
    else if (rest[0] === '"' || rest[0] === "'") v = this.quotedFrom(rest);
    else v = this.plainFrom(rest, parentIndent);
    if (anchor) this.anchors[anchor] = v;
    return v;
  }

  alias(name) {
    if (!(name in this.anchors)) throw new YamlError(`unknown alias *${name}`, this.i - 1);
    return this.anchors[name];
  }

  /** Plain scalar, with continuation lines (more indented, not starting a key or item). */
  plainFrom(s, parentIndent) {
    let text = s;
    while (this.i < this.lines.length) {
      const l = this.lines[this.i];
      if (isBlank(l)) {
        // a blank line inside a multi-line plain scalar becomes a newline
        let k = this.i; while (k < this.lines.length && isBlank(this.lines[k])) k++;
        if (k < this.lines.length && indentOf(this.lines[k]) > parentIndent) { text += '\n'; this.i = k; continue; }
        break;
      }
      if (indentOf(l) <= parentIndent) break;
      // any more-indented line continues the scalar (a key or an item cannot follow a scalar value)
      const t = stripComment(l.trim());
      text += (text.endsWith('\n') ? '' : ' ') + t;
      this.i++;
    }
    return text.includes('\n') || text !== s ? text : resolvePlain(s.trim());
  }

  quotedFrom(s) {
    const q = s[0];
    let buf = s;
    // gather lines until the closing quote
    const closed = (b) => {
      for (let i = 1; i < b.length; i++) {
        if (q === '"' && b[i] === '\\') { i++; continue; }
        if (b[i] === q) { if (q === "'" && b[i + 1] === "'") { i++; continue; } return i; }
      }
      return -1;
    };
    let end = closed(buf);
    while (end < 0) {
      if (this.i >= this.lines.length) throw new YamlError('unterminated quoted string', this.i - 1);
      const t = this.lines[this.i++].trim();
      buf = buf.replace(/\\$/, '') + (buf.endsWith('\\') ? '' : t === '' ? '\n' : (buf.endsWith('\n') ? '' : ' ')) + t;
      end = closed(buf);
    }
    const trailing = stripComment(buf.slice(end + 1)).trim();
    if (trailing) throw new YamlError(`unexpected text after quoted string: "${trailing}"`, this.i - 1);
    return parseQuoted(buf.slice(0, end + 1));
  }

  blockScalar(header, parentIndent) {
    const m = /^([|>])([+-]?)(\d?)([+-]?)\s*(#.*)?$/.exec(header);
    if (!m) throw new YamlError(`bad block scalar header "${header}"`, this.i - 1);
    const folded = m[1] === '>';
    const chomp = m[2] || m[4];
    const explicit = m[3] ? Number(m[3]) : 0;
    const raw = [];
    let blockIndent = explicit ? parentIndent + explicit : 0;
    while (this.i < this.lines.length) {
      const l = this.lines[this.i];
      if (l.trim() === '') { raw.push(''); this.i++; continue; }
      const li = indentOf(l);
      if (!blockIndent) { if (li <= Math.max(parentIndent, -1)) break; blockIndent = li; }
      if (li < blockIndent) break;
      raw.push(l.slice(blockIndent));
      this.i++;
    }
    // trailing blank lines belong to chomping, not content
    let trail = 0;
    while (raw.length && raw[raw.length - 1] === '') { raw.pop(); trail++; }
    let text;
    if (!folded) text = raw.join('\n');
    else {
      text = '';
      for (let k = 0; k < raw.length; k++) {
        const line = raw[k];
        if (k === 0) { text = line; continue; }
        const prev = raw[k - 1];
        if (line === '') text += '\n';
        else if (prev === '' || /^\s/.test(line) || /^\s/.test(prev)) text += (prev === '' ? '' : '\n') + line;
        else text += ' ' + line;
      }
    }
    if (!raw.length) return chomp === '+' ? '\n'.repeat(trail) : '';
    if (chomp === '-') return text;
    if (chomp === '+') return text + '\n' + '\n'.repeat(trail);
    return text + '\n';
  }

  /** Flow collection possibly spanning several lines. */
  flowFrom(s) {
    let buf = s;
    const balanced = (b) => {
      let depth = 0, q = null;
      for (let i = 0; i < b.length; i++) {
        const c = b[i];
        if (q) { if (q === '"' && c === '\\') { i++; continue; } if (c === q) q = null; continue; }
        if (c === '"' || c === "'") q = c;
        else if (c === '[' || c === '{') depth++;
        else if (c === ']' || c === '}') depth--;
        else if (c === '#' && /\s/.test(b[i - 1] || ' ')) break;
      }
      return depth <= 0;
    };
    while (!balanced(buf)) {
      if (this.i >= this.lines.length) throw new YamlError('unterminated flow collection', this.i - 1);
      buf += ' ' + stripComment(this.lines[this.i++].trim());
    }
    const fp = new FlowParser(stripComment(buf), this);
    const v = fp.value();
    fp.ws();
    if (fp.pos < fp.s.length) throw new YamlError(`unexpected "${fp.s.slice(fp.pos, fp.pos + 20)}" after flow collection`, this.i - 1);
    return v;
  }
}

class FlowParser {
  constructor(s, owner) { this.s = s; this.pos = 0; this.owner = owner; }
  ws() { while (this.pos < this.s.length && /\s/.test(this.s[this.pos])) this.pos++; }
  value() {
    this.ws();
    const c = this.s[this.pos];
    if (c === '[') return this.seq();
    if (c === '{') return this.map();
    if (c === '"' || c === "'") return this.quoted();
    if (c === '*') { this.pos++; return this.owner.alias(this.token()); }
    if (c === '&' || c === '!') {
      const name = this.token();
      this.ws();
      const v = this.value();
      if (name.startsWith('&')) this.owner.anchors[name.slice(1)] = v;
      return v;
    }
    return resolvePlain(this.plain().trim());
  }
  token() { const st = this.pos; while (this.pos < this.s.length && !/[\s,[\]{}]/.test(this.s[this.pos])) this.pos++; return this.s.slice(st, this.pos); }
  plain() {
    const st = this.pos;
    while (this.pos < this.s.length) {
      const c = this.s[this.pos];
      if (c === ',' || c === ']' || c === '}') break;
      if (c === ':' && /[\s,\]}]/.test(this.s[this.pos + 1] || ' ')) break;
      this.pos++;
    }
    return this.s.slice(st, this.pos);
  }
  quoted() {
    const q = this.s[this.pos];
    const st = this.pos++;
    while (this.pos < this.s.length) {
      if (q === '"' && this.s[this.pos] === '\\') { this.pos += 2; continue; }
      if (this.s[this.pos] === q) { if (q === "'" && this.s[this.pos + 1] === "'") { this.pos += 2; continue; } break; }
      this.pos++;
    }
    this.pos++;
    return parseQuoted(this.s.slice(st, this.pos));
  }
  seq() {
    this.pos++;
    const out = [];
    while (true) {
      this.ws();
      if (this.s[this.pos] === ']') { this.pos++; return out; }
      const st = this.pos;
      const v = this.value();
      this.ws();
      // single-pair mapping inside a sequence: [a: 1]
      if (this.s[this.pos] === ':') { this.pos++; out.push({ [String(v ?? this.s.slice(st, this.pos - 1).trim())]: this.value() }); this.ws(); }
      else out.push(v);
      if (this.s[this.pos] === ',') { this.pos++; continue; }
      if (this.s[this.pos] === ']') { this.pos++; return out; }
      throw new YamlError(`expected "," or "]" in flow sequence near "${this.s.slice(this.pos, this.pos + 20)}"`);
    }
  }
  map() {
    this.pos++;
    const out = {};
    while (true) {
      this.ws();
      if (this.s[this.pos] === '}') { this.pos++; return out; }
      const c = this.s[this.pos];
      const key = c === '"' || c === "'" ? this.quoted() : this.plain().trim();
      this.ws();
      let v = null;
      if (this.s[this.pos] === ':') { this.pos++; this.ws(); v = this.s[this.pos] === ',' || this.s[this.pos] === '}' ? null : this.value(); }
      if (key === '<<' && v && typeof v === 'object') { for (const [k, x] of Object.entries(v)) if (!(k in out)) out[k] = x; }
      else out[String(key)] = v;
      this.ws();
      if (this.s[this.pos] === ',') { this.pos++; continue; }
      if (this.s[this.pos] === '}') { this.pos++; return out; }
      throw new YamlError(`expected "," or "}" in flow mapping near "${this.s.slice(this.pos, this.pos + 20)}"`);
    }
  }
}

export function parseYaml(text) {
  return new Parser(text).parse();
}

/** Heuristic: does this text look like YAML (rather than JSON or a cURL command)? */
export function looksLikeYaml(text) {
  const t = String(text).trim();
  if (!t || t[0] === '{' || t[0] === '[' || /^curl\s/i.test(t)) return false;
  return /^(---|%YAML|[\w"'$./-][^\n]*:(\s|$)|- )/m.test(t);
}

/** Minimal YAML emitter (used for exporting OpenAPI specs as YAML). */
export function toYaml(value, indent = 0) {
  const pad = ' '.repeat(indent);
  const scalar = (v) => {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'boolean' || typeof v === 'number') return String(v);
    const s = String(v);
    if (s.includes('\n')) return '|-\n' + s.split('\n').map((l) => pad + '  ' + l).join('\n');
    if (s === '' || /^[\s]|[\s]$|^[-?:,[\]{}#&*!|>'"%@`]|: | #|^(true|false|null|yes|no|on|off|~)$/i.test(s) || resolvePlain(s) !== s) return JSON.stringify(s);
    return s;
  };
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return value.map((v) => {
      if (v && typeof v === 'object' && (Array.isArray(v) ? v.length : Object.keys(v).length)) {
        const inner = toYaml(v, indent + 2);
        return `${pad}- ${inner.slice(indent + 2)}`;
      }
      return `${pad}- ${v && typeof v === 'object' ? (Array.isArray(v) ? '[]' : '{}') : scalar(v)}`;
    }).join('\n');
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) return '{}';
    return keys.map((k) => {
      const v = value[k];
      const key = /^[\w.$/{}-][\w .$/{}()-]*$/.test(k) && resolvePlain(k) === k ? k : JSON.stringify(k);
      if (v && typeof v === 'object' && (Array.isArray(v) ? v.length : Object.keys(v).length)) return `${pad}${key}:\n${toYaml(v, indent + 2)}`;
      if (v && typeof v === 'object') return `${pad}${key}: ${Array.isArray(v) ? '[]' : '{}'}`;
      return `${pad}${key}: ${scalar(v)}`;
    }).join('\n');
  }
  return pad + scalar(value);
}

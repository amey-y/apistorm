/*
 * Protocol Buffers without dependencies: .proto parser, binary codec with proto3 JSON mapping
 * (including well-known types), JSON templates, and FileDescriptorProto import (for reflection).
 *
 * Registry = { messages: Map<fullName, Message>, enums: Map<fullName, Enum>, services: Map<fullName, Service> }
 *   Message = { fullName, fields: Field[], mapEntry? }
 *   Field   = { name, jsonName, number, type, typeName?, repeated, map?: { keyType, valueType, valueTypeName }, oneof?, packed? }
 *   Enum    = { fullName, values: Map<name, number>, names: Map<number, name> }
 *   Service = { fullName, name, methods: [{ name, inputType, outputType, clientStreaming, serverStreaming }] }
 */

const SCALARS = new Set(['double', 'float', 'int32', 'int64', 'uint32', 'uint64', 'sint32', 'sint64', 'fixed32', 'fixed64', 'sfixed32', 'sfixed64', 'bool', 'string', 'bytes']);
const VARINT = new Set(['int32', 'int64', 'uint32', 'uint64', 'sint32', 'sint64', 'bool', 'enum']);
const FIXED64 = new Set(['double', 'fixed64', 'sfixed64']);
const FIXED32 = new Set(['float', 'fixed32', 'sfixed32']);
const camel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

export const newRegistry = () => ({ messages: new Map(), enums: new Map(), services: new Map() });

/* ================================================================= parser */

function tokenize(src) {
  const toks = [];
  let i = 0, line = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); const chunk = src.slice(i, e < 0 ? src.length : e + 2); line += (chunk.match(/\n/g) || []).length; i = e < 0 ? src.length : e + 2; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1, s = '';
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') { s += src[j + 1]; j += 2; } else s += src[j++]; }
      toks.push({ t: 'str', v: s, line }); i = j + 1; continue;
    }
    const m = /^(?:[A-Za-z_.][\w.]*|-?(?:0x[0-9a-fA-F]+|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+|inf|nan))/.exec(src.slice(i, i + 200));
    if (m && m[0]) { toks.push({ t: /^-?[\d.]/.test(m[0]) && !/^\.[A-Za-z_]/.test(m[0]) ? 'num' : 'id', v: m[0], line }); i += m[0].length; continue; }
    toks.push({ t: 'sym', v: c, line }); i++;
  }
  return toks;
}

class ProtoParser {
  constructor(text, file) { this.toks = tokenize(text); this.p = 0; this.file = file; }
  peek(o = 0) { return this.toks[this.p + o]; }
  next() { const t = this.toks[this.p++]; if (!t) throw this.err('unexpected end of file'); return t; }
  err(msg, t = this.toks[this.p]) { return new Error(`${this.file}:${t?.line ?? '?'}: ${msg}`); }
  expect(v) { const t = this.next(); if (t.v !== v) throw this.err(`expected "${v}" but found "${t.v}"`, t); return t; }
  accept(v) { if (this.peek()?.v === v) { this.p++; return true; } return false; }
  skipStatement() { let depth = 0; for (;;) { const t = this.next(); if (t.v === '{' || t.v === '[' || t.v === '(') depth++; else if (t.v === '}' || t.v === ']' || t.v === ')') depth--; else if (t.v === ';' && depth <= 0) return; if (depth < 0) return; } }
  skipBlock() { this.expect('{'); let depth = 1; while (depth) { const t = this.next(); if (t.v === '{') depth++; else if (t.v === '}') depth--; } }

  parseFile() {
    const f = { package: '', imports: [], messages: [], enums: [], services: [] };
    while (this.p < this.toks.length) {
      const t = this.next();
      switch (t.v) {
        case 'syntax': case 'edition': this.skipStatement(); break;
        case 'package': f.package = this.next().v; this.expect(';'); break;
        case 'import': { if (['public', 'weak'].includes(this.peek().v)) this.next(); f.imports.push(this.next().v); this.expect(';'); break; }
        case 'option': this.skipStatement(); break;
        case 'message': f.messages.push(this.parseMessage()); break;
        case 'enum': f.enums.push(this.parseEnum()); break;
        case 'service': f.services.push(this.parseService()); break;
        case 'extend': this.next(); this.skipBlock(); break;
        case ';': break;
        default: throw this.err(`unexpected "${t.v}"`, t);
      }
    }
    return f;
  }

  parseFieldOptions(field) {
    if (!this.accept('[')) return;
    for (;;) {
      const name = this.next().v;
      this.expect('=');
      const val = this.next();
      if (name === 'json_name') field.jsonName = val.v;
      if (name === 'packed') field.packed = val.v === 'true';
      if (this.accept(']')) break;
      this.expect(',');
    }
  }

  parseMessage() {
    const m = { name: this.next().v, fields: [], messages: [], enums: [], oneofs: [] };
    this.expect('{');
    while (!this.accept('}')) {
      const t = this.peek();
      if (t.v === ';') { this.next(); continue; }
      if (t.v === 'message') { this.next(); m.messages.push(this.parseMessage()); continue; }
      if (t.v === 'enum') { this.next(); m.enums.push(this.parseEnum()); continue; }
      if (['option', 'reserved', 'extensions'].includes(t.v)) { this.next(); this.skipStatement(); continue; }
      if (t.v === 'extend') { this.next(); this.next(); this.skipBlock(); continue; }
      if (t.v === 'oneof') {
        this.next();
        const name = this.next().v;
        this.expect('{');
        while (!this.accept('}')) {
          if (this.peek().v === 'option') { this.next(); this.skipStatement(); continue; }
          if (this.peek().v === ';') { this.next(); continue; }
          const f = this.parseField();
          f.oneof = name;
          m.fields.push(f);
        }
        continue;
      }
      if (t.v === 'map') {
        this.next();
        this.expect('<');
        const keyType = this.next().v;
        this.expect(',');
        const valueRef = this.next().v;
        this.expect('>');
        const name = this.next().v;
        this.expect('=');
        const number = Number(this.next().v);
        const f = { name, number, type: 'map', map: { keyType, valueRef } };
        this.parseFieldOptions(f);
        this.expect(';');
        m.fields.push(f);
        continue;
      }
      m.fields.push(this.parseField());
    }
    return m;
  }

  parseField() {
    let label = null;
    if (['repeated', 'optional', 'required'].includes(this.peek().v)) label = this.next().v;
    const typeRef = this.next().v;
    if (typeRef === 'group') throw this.err('proto2 groups are not supported');
    const name = this.next().v;
    this.expect('=');
    const number = Number(this.next().v);
    const f = { name, number, typeRef, repeated: label === 'repeated' };
    this.parseFieldOptions(f);
    this.expect(';');
    return f;
  }

  parseEnum() {
    const e = { name: this.next().v, values: [] };
    this.expect('{');
    while (!this.accept('}')) {
      const t = this.next();
      if (t.v === ';') continue;
      if (t.v === 'option' || t.v === 'reserved') { this.skipStatement(); continue; }
      this.expect('=');
      const n = this.next().v;
      e.values.push([t.v, Number(n)]);
      if (this.peek().v === '[') this.skipStatement(); else this.expect(';');
    }
    return e;
  }

  parseService() {
    const s = { name: this.next().v, methods: [] };
    this.expect('{');
    while (!this.accept('}')) {
      const t = this.next();
      if (t.v === ';') continue;
      if (t.v === 'option') { this.skipStatement(); continue; }
      if (t.v !== 'rpc') throw this.err(`unexpected "${t.v}" in service`, t);
      const name = this.next().v;
      this.expect('(');
      const cs = this.accept('stream');
      const input = this.next().v;
      this.expect(')');
      this.expect('returns');
      this.expect('(');
      const ss = this.accept('stream');
      const output = this.next().v;
      this.expect(')');
      if (this.peek().v === '{') this.skipBlock(); else this.expect(';');
      s.methods.push({ name, inputRef: input, outputRef: output, clientStreaming: cs, serverStreaming: ss });
    }
    return s;
  }
}

/** Parse one or more .proto files ([{ name, text }]) into a registry (well-known types are built in). */
export function parseProtos(files, reg = withWellKnownTypes(newRegistry())) {
  const pending = [];
  for (const file of files) {
    const f = new ProtoParser(file.text, file.name || 'input.proto').parseFile();
    const pkg = f.package;
    const addEnum = (scope, e) => {
      const full = scope ? `${scope}.${e.name}` : e.name;
      reg.enums.set(full, { fullName: full, values: new Map(e.values), names: new Map(e.values.map(([n, v]) => [v, n]).reverse()) });
    };
    const addMsg = (scope, m) => {
      const full = scope ? `${scope}.${m.name}` : m.name;
      const msg = { fullName: full, fields: [] };
      reg.messages.set(full, msg);
      for (const e of m.enums) addEnum(full, e);
      for (const n of m.messages) addMsg(full, n);
      for (const fd of m.fields) {
        const field = { name: fd.name, jsonName: fd.jsonName || camel(fd.name), number: fd.number, repeated: !!fd.repeated, oneof: fd.oneof || null, packed: fd.packed };
        msg.fields.push(field);
        pending.push({ scope: full, field, fd });
      }
    };
    for (const e of f.enums) addEnum(pkg, e);
    for (const m of f.messages) addMsg(pkg, m);
    for (const s of f.services) {
      const full = pkg ? `${pkg}.${s.name}` : s.name;
      reg.services.set(full, { fullName: full, name: s.name, methods: s.methods.map((x) => ({ ...x, scope: pkg })) });
    }
  }
  const resolve = (scope, ref) => {
    if (ref.startsWith('.')) { const n = ref.slice(1); return reg.messages.has(n) || reg.enums.has(n) ? n : null; }
    const parts = scope ? scope.split('.') : [];
    for (let i = parts.length; i >= 0; i--) {
      const cand = [...parts.slice(0, i), ref].join('.');
      if (reg.messages.has(cand) || reg.enums.has(cand)) return cand;
    }
    return null;
  };
  const typeOf = (scope, ref, where) => {
    if (SCALARS.has(ref)) return { type: ref };
    const n = resolve(scope, ref);
    if (!n) throw new Error(`Unknown type "${ref}" used in ${where}. Add the .proto file that defines it.`);
    return { type: reg.messages.has(n) ? 'message' : 'enum', typeName: n };
  };
  for (const { scope, field, fd } of pending) {
    if (fd.type === 'map') {
      const v = typeOf(scope, fd.map.valueRef, `${scope}.${fd.name}`);
      field.type = 'map';
      field.map = { keyType: fd.map.keyType, valueType: v.type, valueTypeName: v.typeName };
    } else Object.assign(field, typeOf(scope, fd.typeRef, `${scope}.${fd.name}`));
  }
  for (const s of reg.services.values()) {
    for (const m of s.methods) {
      if (m.inputType) continue;
      m.inputType = typeOf(m.scope, m.inputRef, `${s.fullName}/${m.name}`).typeName;
      m.outputType = typeOf(m.scope, m.outputRef, `${s.fullName}/${m.name}`).typeName;
    }
  }
  return reg;
}

/* ================================================================== codec */

class Writer {
  constructor() { this.chunks = []; this.len = 0; }
  push(b) { this.chunks.push(b); this.len += b.length; }
  varint(v) {
    let n = BigInt.asUintN(64, BigInt(v));
    const out = [];
    while (n > 127n) { out.push(Number(n & 127n) | 128); n >>= 7n; }
    out.push(Number(n));
    this.push(Buffer.from(out));
  }
  tag(num, wt) { this.varint((num << 3) | wt); }
  bytes(b) { this.varint(b.length); this.push(b); }
  fixed32(v, kind) { const b = Buffer.alloc(4); if (kind === 'float') b.writeFloatLE(Number(v)); else if (kind === 'sfixed32') b.writeInt32LE(Number(v)); else b.writeUInt32LE(Number(v) >>> 0); this.push(b); }
  fixed64(v, kind) { const b = Buffer.alloc(8); if (kind === 'double') b.writeDoubleLE(Number(v)); else if (kind === 'sfixed64') b.writeBigInt64LE(BigInt(v)); else b.writeBigUInt64LE(BigInt.asUintN(64, BigInt(v))); this.push(b); }
  finish() { return Buffer.concat(this.chunks, this.len); }
}

class Reader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  get done() { return this.pos >= this.buf.length; }
  varint() {
    let r = 0n, shift = 0n;
    for (;;) {
      if (this.pos >= this.buf.length) throw new Error('Truncated varint');
      const b = this.buf[this.pos++];
      r |= BigInt(b & 127) << shift;
      if (!(b & 128)) return r;
      shift += 7n;
      if (shift > 70n) throw new Error('Varint too long');
    }
  }
  bytes() { const n = Number(this.varint()); if (this.pos + n > this.buf.length) throw new Error('Truncated length-delimited field'); const b = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return b; }
  skip(wt) {
    if (wt === 0) this.varint();
    else if (wt === 1) this.pos += 8;
    else if (wt === 2) this.bytes();
    else if (wt === 5) this.pos += 4;
    else if (wt === 3) { for (;;) { const t = Number(this.varint()); if ((t & 7) === 4) break; this.skip(t & 7); } }
    else throw new Error(`Unknown wire type ${wt}`);
  }
}

const zigzag = (v) => { const n = BigInt(v); return (n << 1n) ^ (n >> 63n); };
const unzig = (n) => (n >> 1n) ^ -(n & 1n);

function toBigIntLike(v, field) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') { if (!Number.isInteger(v)) throw new Error(`${field}: expected an integer, got ${v}`); return BigInt(v); }
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return BigInt(v.trim());
  if (typeof v === 'boolean') return v ? 1n : 0n;
  throw new Error(`${field}: expected an integer, got ${JSON.stringify(v)}`);
}

function writeScalar(w, type, v, num, where, reg, typeName) {
  switch (type) {
    case 'string': w.tag(num, 2); w.bytes(Buffer.from(String(v), 'utf8')); return;
    case 'bytes': w.tag(num, 2); w.bytes(Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'base64')); return;
    case 'bool': w.tag(num, 0); w.varint(v === true || v === 'true' || v === 1 ? 1 : 0); return;
    case 'enum': w.tag(num, 0); w.varint(enumNumber(reg, typeName, v, where)); return;
    case 'sint32': case 'sint64': w.tag(num, 0); w.varint(zigzag(toBigIntLike(v, where))); return;
    case 'int32': case 'int64': case 'uint32': case 'uint64': w.tag(num, 0); w.varint(toBigIntLike(v, where)); return;
    case 'double': w.tag(num, 1); w.fixed64(numberLike(v, where), 'double'); return;
    case 'fixed64': case 'sfixed64': w.tag(num, 1); w.fixed64(toBigIntLike(v, where), type); return;
    case 'float': w.tag(num, 5); w.fixed32(numberLike(v, where), 'float'); return;
    case 'fixed32': case 'sfixed32': w.tag(num, 5); w.fixed32(Number(toBigIntLike(v, where)), type); return;
    default: throw new Error(`Unsupported type ${type}`);
  }
}
const numberLike = (v, where) => { const n = typeof v === 'string' ? (v === 'NaN' ? NaN : v === 'Infinity' ? Infinity : v === '-Infinity' ? -Infinity : Number(v)) : Number(v); if (Number.isNaN(n) && v !== 'NaN') throw new Error(`${where}: expected a number, got ${JSON.stringify(v)}`); return n; };
function enumNumber(reg, typeName, v, where) {
  if (typeof v === 'number') return v;
  const e = reg.enums.get(typeName);
  if (e && e.values.has(String(v))) return e.values.get(String(v));
  if (/^-?\d+$/.test(String(v))) return Number(v);
  throw new Error(`${where}: "${v}" is not a value of enum ${typeName}${e ? ` (${[...e.values.keys()].join(', ')})` : ''}`);
}

function packedValue(w, type, v, where, reg, typeName) {
  switch (type) {
    case 'bool': w.varint(v ? 1 : 0); break;
    case 'enum': w.varint(enumNumber(reg, typeName, v, where)); break;
    case 'sint32': case 'sint64': w.varint(zigzag(toBigIntLike(v, where))); break;
    case 'int32': case 'int64': case 'uint32': case 'uint64': w.varint(toBigIntLike(v, where)); break;
    case 'double': w.fixed64(numberLike(v, where), 'double'); break;
    case 'fixed64': case 'sfixed64': w.fixed64(toBigIntLike(v, where), type); break;
    case 'float': w.fixed32(numberLike(v, where), 'float'); break;
    case 'fixed32': case 'sfixed32': w.fixed32(Number(toBigIntLike(v, where)), type); break;
  }
}

/** JSON (proto3 JSON mapping, camelCase or original field names) -> protobuf bytes */
export function encodeMessage(reg, typeName, obj, path = typeName) {
  const wk = WKT_ENCODE[typeName];
  if (wk) obj = wk(obj, path);
  const msg = reg.messages.get(typeName);
  if (!msg) throw new Error(`Unknown message type ${typeName}`);
  if (obj === null || obj === undefined) obj = {};
  if (typeof obj !== 'object' || Array.isArray(obj)) throw new Error(`${path}: expected a JSON object`);
  const known = new Set(msg.fields.flatMap((f) => [f.name, f.jsonName]));
  for (const k of Object.keys(obj)) if (!known.has(k)) throw new Error(`${path}: unknown field "${k}" (fields: ${msg.fields.map((f) => f.jsonName).join(', ') || 'none'})`);
  const w = new Writer();
  for (const f of msg.fields) {
    const v = obj[f.jsonName] !== undefined ? obj[f.jsonName] : obj[f.name];
    if (v === undefined || (v === null && !(f.type === 'message' && f.typeName === 'google.protobuf.Value'))) continue;
    const where = `${path}.${f.jsonName}`;
    if (f.type === 'map') {
      if (typeof v !== 'object' || Array.isArray(v)) throw new Error(`${where}: expected an object for a map field`);
      for (const [k, val] of Object.entries(v)) {
        const ew = new Writer();
        const key = f.map.keyType === 'bool' ? k === 'true' : f.map.keyType === 'string' ? k : k;
        writeScalar(ew, f.map.keyType, key, 1, `${where}[key]`, reg);
        if (f.map.valueType === 'message') { ew.tag(2, 2); ew.bytes(encodeMessage(reg, f.map.valueTypeName, val, `${where}.${k}`)); }
        else writeScalar(ew, f.map.valueType, val, 2, `${where}.${k}`, reg, f.map.valueTypeName);
        w.tag(f.number, 2); w.bytes(ew.finish());
      }
      continue;
    }
    const list = f.repeated ? (Array.isArray(v) ? v : (() => { throw new Error(`${where}: expected an array`); })()) : [v];
    if (f.repeated && f.packed !== false && (VARINT.has(f.type) || FIXED32.has(f.type) || FIXED64.has(f.type))) {
      if (!list.length) continue;
      const pw = new Writer();
      list.forEach((x, i) => packedValue(pw, f.type, x, `${where}[${i}]`, reg, f.typeName));
      w.tag(f.number, 2); w.bytes(pw.finish());
      continue;
    }
    list.forEach((x, i) => {
      const wh = f.repeated ? `${where}[${i}]` : where;
      if (f.type === 'message') { w.tag(f.number, 2); w.bytes(encodeMessage(reg, f.typeName, x, wh)); }
      else writeScalar(w, f.type, x, f.number, wh, reg, f.typeName);
    });
  }
  return w.finish();
}

function readScalar(r, type, wt) {
  switch (type) {
    case 'string': return r.bytes().toString('utf8');
    case 'bytes': return Buffer.from(r.bytes());
    case 'bool': return r.varint() !== 0n;
    case 'int32': return Number(BigInt.asIntN(32, r.varint()));
    case 'uint32': return Number(BigInt.asUintN(32, r.varint()));
    case 'enum': return Number(BigInt.asIntN(32, r.varint()));
    case 'int64': return BigInt.asIntN(64, r.varint());
    case 'uint64': return BigInt.asUintN(64, r.varint());
    case 'sint32': return Number(unzig(r.varint()));
    case 'sint64': return unzig(r.varint());
    case 'double': { const v = r.buf.readDoubleLE(r.pos); r.pos += 8; return v; }
    case 'fixed64': { const v = r.buf.readBigUInt64LE(r.pos); r.pos += 8; return v; }
    case 'sfixed64': { const v = r.buf.readBigInt64LE(r.pos); r.pos += 8; return v; }
    case 'float': { const v = r.buf.readFloatLE(r.pos); r.pos += 4; return v; }
    case 'fixed32': { const v = r.buf.readUInt32LE(r.pos); r.pos += 4; return v; }
    case 'sfixed32': { const v = r.buf.readInt32LE(r.pos); r.pos += 4; return v; }
    default: r.skip(wt); return undefined;
  }
}

function jsonScalar(reg, type, v, typeName) {
  if (typeof v === 'bigint') return v.toString();
  if (Buffer.isBuffer(v)) return v.toString('base64');
  if (type === 'enum') return reg.enums.get(typeName)?.names.get(v) ?? v;
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
  return v;
}
const defaultFor = (reg, f) => {
  if (f.type === 'map') return {};
  if (f.repeated) return [];
  if (f.type === 'message') return null;
  if (f.type === 'enum') { const e = reg.enums.get(f.typeName); return e ? e.names.get(0) ?? 0 : 0; }
  if (f.type === 'string' || f.type === 'bytes') return '';
  if (f.type === 'bool') return false;
  if (['int64', 'uint64', 'sint64', 'fixed64', 'sfixed64'].includes(f.type)) return '0';
  return 0;
};

/** protobuf bytes -> JSON. opts.defaults: include zero values of scalar fields (default true). */
export function decodeMessage(reg, typeName, buf, opts = {}) {
  const msg = reg.messages.get(typeName);
  if (!msg) throw new Error(`Unknown message type ${typeName}`);
  const byNum = new Map(msg.fields.map((f) => [f.number, f]));
  const out = {};
  const r = new Reader(buf);
  while (!r.done) {
    const tag = Number(r.varint());
    const num = tag >>> 3, wt = tag & 7;
    const f = byNum.get(num);
    if (!f) { r.skip(wt); continue; }
    if (f.type === 'map') {
      const er = new Reader(r.bytes());
      let k, v;
      while (!er.done) {
        const t2 = Number(er.varint());
        if ((t2 >>> 3) === 1) k = jsonScalar(reg, f.map.keyType, readScalar(er, f.map.keyType, t2 & 7));
        else if ((t2 >>> 3) === 2) v = f.map.valueType === 'message' ? decodeMessage(reg, f.map.valueTypeName, er.bytes(), opts) : jsonScalar(reg, f.map.valueType, readScalar(er, f.map.valueType, t2 & 7), f.map.valueTypeName);
        else er.skip(t2 & 7);
      }
      (out[f.jsonName] ||= {})[String(k ?? defaultFor(reg, { type: f.map.keyType }))] = v ?? (f.map.valueType === 'message' ? {} : defaultFor(reg, { type: f.map.valueType, typeName: f.map.valueTypeName }));
      continue;
    }
    let vals;
    if (wt === 2 && f.type !== 'string' && f.type !== 'bytes' && f.type !== 'message') {
      const pr = new Reader(r.bytes());
      vals = [];
      while (!pr.done) vals.push(jsonScalar(reg, f.type, readScalar(pr, f.type, f.type === 'double' || f.type === 'fixed64' || f.type === 'sfixed64' ? 1 : FIXED32.has(f.type) ? 5 : 0), f.typeName));
    } else if (f.type === 'message') vals = [decodeMessage(reg, f.typeName, r.bytes(), opts)];
    else vals = [jsonScalar(reg, f.type, readScalar(r, f.type, wt), f.typeName)];
    if (f.repeated) (out[f.jsonName] ||= []).push(...vals);
    else out[f.jsonName] = vals[vals.length - 1];
  }
  if (opts.defaults !== false) for (const f of msg.fields) if (out[f.jsonName] === undefined && !f.oneof && !(f.type === 'message' && !f.repeated)) out[f.jsonName] = defaultFor(reg, f);
  const wk = WKT_DECODE[typeName];
  return wk ? wk(out, opts) : out;
}

/** Example JSON for a message type (used to pre-fill the request editor). */
export function templateFor(reg, typeName, depth = 0) {
  const wk = WKT_TEMPLATE[typeName];
  if (wk !== undefined) return typeof wk === 'function' ? wk() : wk;
  const msg = reg.messages.get(typeName);
  if (!msg) return {};
  const out = {};
  const seenOneof = new Set();
  for (const f of msg.fields) {
    if (f.oneof) { if (seenOneof.has(f.oneof)) continue; seenOneof.add(f.oneof); }
    let v;
    if (f.type === 'message') v = depth > 3 ? {} : templateFor(reg, f.typeName, depth + 1);
    else if (f.type === 'map') v = { key: f.map.valueType === 'message' ? (depth > 3 ? {} : templateFor(reg, f.map.valueTypeName, depth + 1)) : defaultFor(reg, { type: f.map.valueType, typeName: f.map.valueTypeName }) };
    else v = defaultFor(reg, { ...f, repeated: false });
    out[f.jsonName] = f.repeated ? [v] : v;
  }
  return out;
}

/* ===================================================== well-known types */

const WKT_PROTO = `
syntax = "proto3";
package google.protobuf;
message Empty {}
message Timestamp { int64 seconds = 1; int32 nanos = 2; }
message Duration { int64 seconds = 1; int32 nanos = 2; }
message DoubleValue { double value = 1; }
message FloatValue { float value = 1; }
message Int64Value { int64 value = 1; }
message UInt64Value { uint64 value = 1; }
message Int32Value { int32 value = 1; }
message UInt32Value { uint32 value = 1; }
message BoolValue { bool value = 1; }
message StringValue { string value = 1; }
message BytesValue { bytes value = 1; }
message Struct { map<string, Value> fields = 1; }
message Value { oneof kind { NullValue null_value = 1; double number_value = 2; string string_value = 3; bool bool_value = 4; Struct struct_value = 5; ListValue list_value = 6; } }
enum NullValue { NULL_VALUE = 0; }
message ListValue { repeated Value values = 1; }
message FieldMask { repeated string paths = 1; }
message Any { string type_url = 1; bytes value = 2; }
`;

const WRAPPERS = ['DoubleValue', 'FloatValue', 'Int64Value', 'UInt64Value', 'Int32Value', 'UInt32Value', 'BoolValue', 'StringValue', 'BytesValue'];
const WKT_ENCODE = {
  'google.protobuf.Timestamp': (v, p) => {
    if (typeof v !== 'string') return v;
    const ms = Date.parse(v);
    if (Number.isNaN(ms)) throw new Error(`${p}: invalid RFC 3339 timestamp "${v}"`);
    const frac = /\.(\d+)/.exec(v)?.[1] || '';
    return { seconds: String(Math.floor(ms / 1000)), nanos: Number((frac + '000000000').slice(0, 9)) };
  },
  'google.protobuf.Duration': (v, p) => {
    if (typeof v !== 'string') return v;
    const m = /^(-?)(\d+)(?:\.(\d{1,9}))?s$/.exec(v.trim());
    if (!m) throw new Error(`${p}: invalid duration "${v}" (use e.g. "1.5s")`);
    const sign = m[1] ? -1 : 1;
    return { seconds: String(sign * Number(m[2])), nanos: sign * Number(((m[3] || '') + '000000000').slice(0, 9)) };
  },
  'google.protobuf.Struct': (v) => (v && typeof v === 'object' && !('fields' in v && Object.keys(v).length === 1) ? { fields: v } : v),
  'google.protobuf.Value': (v) => {
    if (v === null) return { nullValue: 'NULL_VALUE' };
    if (typeof v === 'number') return { numberValue: v };
    if (typeof v === 'string') return { stringValue: v };
    if (typeof v === 'boolean') return { boolValue: v };
    if (Array.isArray(v)) return { listValue: v };
    return { structValue: v };
  },
  'google.protobuf.ListValue': (v) => (Array.isArray(v) ? { values: v } : v),
  'google.protobuf.FieldMask': (v) => (typeof v === 'string' ? { paths: v.split(',').filter(Boolean) } : v),
};
for (const w of WRAPPERS) WKT_ENCODE[`google.protobuf.${w}`] = (v) => (v !== null && typeof v === 'object' && !Buffer.isBuffer(v) ? v : { value: v });

const WKT_DECODE = {
  'google.protobuf.Timestamp': (o) => new Date(Number(o.seconds || 0) * 1000 + Math.floor((o.nanos || 0) / 1e6)).toISOString(),
  'google.protobuf.Duration': (o) => `${Number(o.seconds || 0) + (o.nanos || 0) / 1e9}s`,
  'google.protobuf.Struct': (o) => o.fields || {},
  'google.protobuf.Value': (o) => ('structValue' in o ? o.structValue : 'listValue' in o ? o.listValue : 'numberValue' in o ? o.numberValue : 'stringValue' in o ? o.stringValue : 'boolValue' in o ? o.boolValue : null),
  'google.protobuf.ListValue': (o) => o.values || [],
  'google.protobuf.FieldMask': (o) => (o.paths || []).join(','),
  'google.protobuf.Empty': () => ({}),
};
for (const w of WRAPPERS) WKT_DECODE[`google.protobuf.${w}`] = (o) => o.value;
const WKT_TEMPLATE = {
  'google.protobuf.Timestamp': () => new Date().toISOString(), 'google.protobuf.Duration': '1s', 'google.protobuf.Struct': {}, 'google.protobuf.Value': null,
  'google.protobuf.ListValue': [], 'google.protobuf.FieldMask': '', 'google.protobuf.Empty': {},
  'google.protobuf.StringValue': '', 'google.protobuf.BoolValue': false, 'google.protobuf.Int32Value': 0, 'google.protobuf.Int64Value': '0', 'google.protobuf.DoubleValue': 0,
};

let wktCache = null;
export function withWellKnownTypes(reg) {
  if (!wktCache) { wktCache = newRegistry(); parseProtos([{ name: 'google/protobuf/well_known.proto', text: WKT_PROTO }], wktCache); }
  for (const k of ['messages', 'enums']) for (const [n, v] of wktCache[k]) if (!reg[k].has(n)) reg[k].set(n, v);
  return reg;
}

/* ============================================ descriptors (for reflection) */

export const DESCRIPTOR_PROTO = `
syntax = "proto2";
package google.protobuf;
message FileDescriptorProto { optional string name = 1; optional string package = 2; repeated string dependency = 3; repeated DescriptorProto message_type = 4; repeated EnumDescriptorProto enum_type = 5; repeated ServiceDescriptorProto service = 6; optional string syntax = 12; }
message DescriptorProto { optional string name = 1; repeated FieldDescriptorProto field = 2; repeated DescriptorProto nested_type = 3; repeated EnumDescriptorProto enum_type = 4; optional MessageOptions options = 7; repeated OneofDescriptorProto oneof_decl = 8; }
message MessageOptions { optional bool map_entry = 7; }
message FieldDescriptorProto { optional string name = 1; optional int32 number = 3; optional int32 label = 4; optional int32 type = 5; optional string type_name = 6; optional FieldOptions options = 8; optional int32 oneof_index = 9; optional string json_name = 10; optional bool proto3_optional = 17; }
message FieldOptions { optional bool packed = 2; }
message OneofDescriptorProto { optional string name = 1; }
message EnumDescriptorProto { optional string name = 1; repeated EnumValueDescriptorProto value = 2; }
message EnumValueDescriptorProto { optional string name = 1; optional int32 number = 2; }
message ServiceDescriptorProto { optional string name = 1; repeated MethodDescriptorProto method = 2; }
message MethodDescriptorProto { optional string name = 1; optional string input_type = 2; optional string output_type = 3; optional bool client_streaming = 5; optional bool server_streaming = 6; }
`;
let descReg = null;
export function descriptorRegistry() {
  if (!descReg) descReg = parseProtos([{ name: 'descriptor.proto', text: DESCRIPTOR_PROTO }], newRegistry());
  return descReg;
}

const TYPE_NUM = { 1: 'double', 2: 'float', 3: 'int64', 4: 'uint64', 5: 'int32', 6: 'fixed64', 7: 'fixed32', 8: 'bool', 9: 'string', 10: 'group', 11: 'message', 12: 'bytes', 13: 'uint32', 14: 'enum', 15: 'sfixed32', 16: 'sfixed64', 17: 'sint32', 18: 'sint64' };

/** Add serialized FileDescriptorProtos (Buffers) to a registry. */
export function addFileDescriptors(reg, buffers) {
  const dr = descriptorRegistry();
  const files = buffers.map((b) => decodeMessage(dr, 'google.protobuf.FileDescriptorProto', b, { defaults: false }));
  const mapEntries = new Set();
  const addEnum = (scope, e) => {
    const full = scope ? `${scope}.${e.name}` : e.name;
    const vals = (e.value || []).map((v) => [v.name, v.number || 0]);
    reg.enums.set(full, { fullName: full, values: new Map(vals), names: new Map(vals.map(([n, v]) => [v, n]).reverse()) });
  };
  const addMsg = (scope, d) => {
    const full = scope ? `${scope}.${d.name}` : d.name;
    if (d.options?.mapEntry) mapEntries.add(full);
    reg.messages.set(full, {
      fullName: full,
      mapEntry: !!d.options?.mapEntry,
      fields: (d.field || []).map((f) => ({
        name: f.name, jsonName: f.jsonName || camel(f.name), number: f.number, type: TYPE_NUM[f.type] || 'bytes',
        typeName: f.typeName ? f.typeName.replace(/^\./, '') : undefined, repeated: f.label === 3,
        oneof: f.oneofIndex !== undefined && !f.proto3Optional ? d.oneofDecl?.[f.oneofIndex]?.name || null : null,
        packed: f.options?.packed,
      })),
    });
    for (const e of d.enumType || []) addEnum(full, e);
    for (const n of d.nestedType || []) addMsg(full, n);
  };
  for (const fd of files) {
    const pkg = fd.package || '';
    for (const m of fd.messageType || []) addMsg(pkg, m);
    for (const e of fd.enumType || []) addEnum(pkg, e);
    for (const s of fd.service || []) {
      const full = pkg ? `${pkg}.${s.name}` : s.name;
      reg.services.set(full, { fullName: full, name: s.name, methods: (s.method || []).map((m) => ({ name: m.name, inputType: m.inputType.replace(/^\./, ''), outputType: m.outputType.replace(/^\./, ''), clientStreaming: !!m.clientStreaming, serverStreaming: !!m.serverStreaming })) });
    }
  }
  // repeated map-entry messages become map fields
  for (const m of reg.messages.values()) {
    for (const f of m.fields) {
      if (f.type === 'message' && f.repeated && mapEntries.has(f.typeName)) {
        const e = reg.messages.get(f.typeName);
        const [k, v] = [e.fields.find((x) => x.number === 1), e.fields.find((x) => x.number === 2)];
        f.type = 'map'; f.repeated = false; f.map = { keyType: k.type, valueType: v.type, valueTypeName: v.typeName };
      }
    }
  }
  return files.map((f) => ({ name: f.name, dependencies: f.dependency || [] }));
}

/** Summary for the UI. */
export function describeServices(reg) {
  return [...reg.services.values()].filter((s) => !s.fullName.startsWith('grpc.reflection.')).map((s) => ({
    name: s.fullName,
    methods: s.methods.map((m) => ({ name: m.name, inputType: m.inputType, outputType: m.outputType, clientStreaming: m.clientStreaming, serverStreaming: m.serverStreaming, template: templateFor(reg, m.inputType) })),
  }));
}

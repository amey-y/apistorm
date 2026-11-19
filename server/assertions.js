import { getPath } from './util.js';

/**
 * Assertion: { type, path?, op, value, enabled }
 *  type: status | responseTime | bodyContains | jsonPath | header
 *  op:   eq | neq | lt | lte | gt | gte | contains | notContains | exists | notExists | matches | in
 *
 * Extraction: { var, from: json|header|regex|status, path }
 */

export function needsBody(assertions = [], extract = []) {
  return assertions.some((a) => a.enabled !== false && ['bodyContains', 'jsonPath'].includes(a.type))
    || extract.some((x) => x.enabled !== false && ['json', 'regex'].includes(x.from));
}

function parseJsonSafe(text) {
  try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false }; }
}

function compare(actual, op, expected) {
  const num = (x) => (typeof x === 'number' ? x : Number(x));
  const str = (x) => (x == null ? '' : typeof x === 'object' ? JSON.stringify(x) : String(x));
  switch (op) {
    case 'exists': return actual !== undefined && actual !== null;
    case 'notExists': return actual === undefined || actual === null;
    case 'eq': return str(actual) === str(expected);
    case 'neq': return str(actual) !== str(expected);
    case 'lt': return num(actual) < num(expected);
    case 'lte': return num(actual) <= num(expected);
    case 'gt': return num(actual) > num(expected);
    case 'gte': return num(actual) >= num(expected);
    case 'contains': return str(actual).includes(str(expected));
    case 'notContains': return !str(actual).includes(str(expected));
    case 'in': return str(expected).split(',').map((s) => s.trim()).includes(str(actual));
    case 'matches': try { return new RegExp(expected).test(str(actual)); } catch { return false; }
    default: return false;
  }
}

function statusMatches(status, op, expected) {
  // shorthand like "2xx" or "200,201" or "2xx,404"
  if ((op === 'eq' || op === 'in' || !op) && /x/i.test(String(expected))) {
    return String(expected).split(',').some((p) => {
      p = p.trim().toLowerCase();
      return p.length === 3 && [...p].every((ch, i) => ch === 'x' || ch === String(status)[i]);
    });
  }
  if (!op || op === 'eq') op = String(expected).includes(',') ? 'in' : 'eq';
  return compare(status, op, expected);
}

const label = (a) => {
  const v = a.value ?? '';
  switch (a.type) {
    case 'status': return `Status ${a.op || 'eq'} ${v}`;
    case 'responseTime': return `Response time ${a.op || 'lt'} ${v} ms`;
    case 'bodyContains': return `Body contains "${v}"`;
    case 'jsonPath': return `${a.path} ${a.op || 'eq'}${['exists', 'notExists'].includes(a.op) ? '' : ' ' + v}`;
    case 'header': return `Header ${a.path} ${a.op || 'exists'}${['exists', 'notExists'].includes(a.op) ? '' : ' ' + v}`;
    default: return a.type;
  }
};

/** res: result of sendHttp; bodyText optional (string). */
export function runAssertions(assertions = [], res, bodyText) {
  const out = [];
  let json;
  for (const a of assertions) {
    if (!a || a.enabled === false) continue;
    let pass = false, actual;
    try {
      switch (a.type) {
        case 'status': actual = res.status; pass = statusMatches(res.status, a.op, a.value); break;
        case 'responseTime': actual = res.timings?.total; pass = compare(actual, a.op || 'lt', a.value); break;
        case 'bodyContains': actual = undefined; pass = (bodyText || '').includes(String(a.value ?? '')); break;
        case 'jsonPath': {
          if (json === undefined) json = parseJsonSafe(bodyText || '');
          if (!json.ok) { actual = '(body is not JSON)'; pass = a.op === 'notExists'; break; }
          actual = getPath(json.value, a.path);
          pass = compare(actual, a.op || 'eq', a.value);
          break;
        }
        case 'header': actual = res.headers?.[String(a.path || '').toLowerCase()]; pass = compare(actual, a.op || 'exists', a.value); break;
        default: actual = undefined; pass = false;
      }
    } catch (e) { pass = false; actual = e.message; }
    out.push({ name: a.name || label(a), pass, actual: typeof actual === 'object' && actual != null ? JSON.stringify(actual).slice(0, 300) : actual });
  }
  return out;
}

export function runExtract(rules = [], res, bodyText) {
  const vars = {};
  let json;
  for (const x of rules) {
    if (!x || x.enabled === false || !x.var) continue;
    let v;
    try {
      if (x.from === 'json') {
        if (json === undefined) { try { json = JSON.parse(bodyText || ''); } catch { json = null; } }
        v = json == null ? undefined : getPath(json, x.path);
      } else if (x.from === 'header') v = res.headers?.[String(x.path || '').toLowerCase()];
      else if (x.from === 'regex') { const m = new RegExp(x.path).exec(bodyText || ''); v = m ? (m[1] ?? m[0]) : undefined; }
      else if (x.from === 'status') v = res.status;
    } catch { v = undefined; }
    if (v !== undefined) vars[x.var] = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
  }
  return vars;
}

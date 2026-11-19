/**
 * 5-field cron expressions (minute hour day-of-month month day-of-week), local time.
 * Supports *, lists (1,5), ranges (1-5), steps (*\/15, 1-30/5), month/day names and
 * the shortcuts @hourly @daily @midnight @weekly @monthly @yearly @annually.
 */

const SHORTCUTS = { '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *' };
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTHS, offset: 1 },
  { name: 'day of week', min: 0, max: 7, names: DAYS, offset: 0 },
];

function parseField(src, f) {
  const set = new Set();
  const val = (s) => {
    const lower = s.toLowerCase();
    if (f.names && f.names.includes(lower)) return f.names.indexOf(lower) + f.offset;
    if (!/^\d+$/.test(s)) throw new Error(`Invalid ${f.name} value "${s}"`);
    const n = Number(s);
    if (n < f.min || n > f.max) throw new Error(`${f.name} value ${n} is out of range ${f.min}-${f.max}`);
    return n;
  };
  for (const part of src.split(',')) {
    const [range, stepS] = part.split('/');
    const step = stepS === undefined ? 1 : Number(stepS);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid step in "${part}"`);
    let lo, hi;
    if (range === '*') { lo = f.min; hi = f.max; }
    else if (range.includes('-')) { const [a, b] = range.split('-'); lo = val(a); hi = val(b); if (lo > hi) throw new Error(`Invalid range "${range}"`); }
    else { lo = val(range); hi = stepS === undefined ? lo : f.max; }
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return set;
}

export function parseCron(expr) {
  const e = String(expr || '').trim();
  const src = SHORTCUTS[e.toLowerCase()] || e;
  const parts = src.split(/\s+/);
  if (parts.length !== 5) throw new Error('A cron expression needs 5 fields: minute hour day-of-month month day-of-week');
  const sets = parts.map((p, i) => parseField(p, FIELDS[i]));
  if (sets[4].has(7)) { sets[4].delete(7); sets[4].add(0); }
  return { minute: sets[0], hour: sets[1], dom: sets[2], month: sets[3], dow: sets[4], domStar: parts[2] === '*', dowStar: parts[4] === '*', source: src };
}

function dayMatches(c, d) {
  const domOk = c.dom.has(d.getDate());
  const dowOk = c.dow.has(d.getDay());
  if (c.domStar && c.dowStar) return true;
  if (c.domStar) return dowOk;
  if (c.dowStar) return domOk;
  return domOk || dowOk; // classic cron: either matches when both are restricted
}

/** Next matching time strictly after `after` (Date). Returns null if none within ~5 years. */
export function nextCron(exprOrParsed, after = new Date()) {
  const c = typeof exprOrParsed === 'string' ? parseCron(exprOrParsed) : exprOrParsed;
  const d = new Date(after.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = after.getTime() + 5 * 366 * 24 * 3600 * 1000;
  while (d.getTime() <= limit) {
    if (!c.month.has(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0, 0, 0); continue; }
    if (!dayMatches(c, d)) { d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); continue; }
    if (!c.hour.has(d.getHours())) { d.setHours(d.getHours() + 1, 0, 0, 0); continue; }
    if (!c.minute.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1, 0, 0); continue; }
    return d;
  }
  return null;
}

export function nextCronTimes(expr, n = 5, after = new Date()) {
  const c = parseCron(expr);
  const out = [];
  let t = after;
  for (let i = 0; i < n; i++) { t = nextCron(c, t); if (!t) break; out.push(t); }
  return out;
}

/** Short human description for common patterns. */
export function describeCron(expr) {
  let c;
  try { c = parseCron(expr); } catch (e) { return e.message; }
  const [mi, ho, dom, mo, dow] = c.source.split(/\s+/);
  const pad = (n) => String(n).padStart(2, '0');
  const list = (set, names) => [...set].sort((a, b) => a - b).map((v) => (names ? names[v] : v)).join(', ');
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const monthNames = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  let time;
  if (mi === '*' && ho === '*') time = 'every minute';
  else if (/^\*\/\d+$/.test(mi) && ho === '*') time = `every ${mi.slice(2)} minutes`;
  else if (/^\d+$/.test(mi) && ho === '*') time = `every hour at minute ${mi}`;
  else if (/^\d+$/.test(mi) && /^\*\/\d+$/.test(ho)) time = `every ${ho.slice(2)} hours at minute ${mi}`;
  else if (/^\d+$/.test(mi) && /^[\d,]+$/.test(ho)) time = `at ${[...c.hour].sort((a, b) => a - b).map((h) => `${pad(h)}:${pad(mi)}`).join(', ')}`;
  else time = `at minute ${list(c.minute)} past hour ${list(c.hour)}`;
  const parts = [time];
  if (dow !== '*') parts.push(`on ${list(c.dow, dayNames)}`);
  if (dom !== '*') parts.push(`on day ${list(c.dom)} of the month`);
  if (mo !== '*') parts.push(`in ${list(c.month, monthNames)}`);
  return parts.join(' ');
}

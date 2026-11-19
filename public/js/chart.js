import { h, fmtNum, clear } from './dom.js';

/*
 * Canvas charts for the load-test dashboard. Colors come from CSS custom properties, so the
 * light/dark themes just work. Every chart has a hover layer (crosshair or per-mark tooltip).
 *
 *   TimeChart      time series: line | area | bar | stacked-bar | stacked-area
 *   HeatmapChart   latency heatmap (time × latency bucket, sequential single-hue ramp)
 *   CategoryChart  grouped bars over categories (horizontal or vertical)
 */

export const TYPE_LABELS = { line: 'Line', area: 'Area', bar: 'Bars', 'stacked-bar': 'Stacked', 'stacked-area': 'Stacked area', grouped: 'Bars', heatmap: 'Heatmap' };

class BaseChart {
  constructor({ title, unit = '', height = 190, legend = [], note = '' }) {
    this.unit = unit;
    this.canvas = h('canvas.chart-canvas', { role: 'img', 'aria-label': `${title} chart` });
    this.tip = h('div.chart-tip', { hidden: true });
    this.legendEl = h('div.chart-legend');
    this.tools = h('div.chart-tools');
    this.titleEl = h('figcaption.chart-title', h('span', title, unit ? h('span.muted', ` (${unit})`) : null), this.tools);
    this.box = h('div.chart-box', { style: { height: `${height}px` } }, this.canvas, this.tip);
    this.noteEl = note ? h('div.chart-note.muted.small', note) : null;
    this.el = h('figure.chart', this.titleEl, this.legendEl, this.box, this.noteEl);
    this.setLegend(legend);
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    this.canvas.addEventListener('pointerleave', () => { this.hover = null; this.tip.hidden = true; this.draw(); });
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(this.canvas);
  }

  setLegend(items) {
    clear(this.legendEl);
    if (items.length < 2) return;
    for (const s of items) {
      const sw = s.dash
        ? h('i.legend-swatch.dash', { style: { borderTopColor: `var(${s.color})` } })
        : h('i.legend-swatch', { style: { background: `var(${s.color})` } });
      this.legendEl.append(h('span.legend-item', sw, s.label));
    }
  }

  css(name) { return getComputedStyle(this.el).getPropertyValue(name).trim() || '#888'; }

  prep() {
    const c = this.canvas;
    const r = c.getBoundingClientRect();
    const W = r.width, H = r.height;
    if (!W || !H) return null;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.font = '11px system-ui, sans-serif';
    return { g, W, H };
  }

  emptyMessage(g, W, H, msg = 'Waiting for data…') {
    g.fillStyle = this.css('--text-muted'); g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(msg, W / 2, H / 2);
  }

  showTip(x, rows, head) {
    this.tip.hidden = false;
    this.tip.replaceChildren(h('div.tip-head', head), ...rows.map((r) => h('div.tip-row', r.color ? h('i.legend-swatch', { style: { background: `var(${r.color})` } }) : null, h('span', r.label), h('b', r.value))));
    const bw = this.canvas.getBoundingClientRect().width;
    const tw = this.tip.offsetWidth;
    this.tip.style.left = `${x + 14 + tw > bw ? Math.max(0, x - tw - 14) : x + 14}px`;
    this.tip.style.top = '6px';
  }

  destroy() { this.ro.disconnect(); }
}

/* ----------------------------------------------------------- time series */

export class TimeChart extends BaseChart {
  /**
   * series: [{ key, label, color: '--series-1', dash?: [5,4], noFill?: bool }]
   * data:   [{ t, [key]: number|null }]
   */
  constructor({ title, unit, series, type = 'line', yFormat, height, note }) {
    super({ title, unit, height, legend: series, note });
    this.series = series;
    this.type = type;
    this.data = [];
    this.yFormat = yFormat || ((v) => fmtNum(v, v < 10 ? 1 : 0));
  }

  setSeries(series) { this.series = series; this.setLegend(series); this.draw(); }
  setType(t) { this.type = t; this.draw(); }
  setData(data) { this.data = data; this.draw(); }

  get stacked() { return this.type.startsWith('stacked'); }

  geometry(W, H) {
    const L = 46, R = 10, T = 8, B = 20;
    const ts = this.data.map((d) => d.t);
    const minT = ts.length ? Math.min(...ts) : 0;
    const maxT = Math.max(minT + 10, ts.length ? Math.max(...ts) : 10);
    let maxV = 0;
    for (const d of this.data) {
      if (this.stacked) { let s = 0; for (const ser of this.series) s += d[ser.key] || 0; maxV = Math.max(maxV, s); }
      else for (const ser of this.series) if (d[ser.key] != null && d[ser.key] > maxV) maxV = d[ser.key];
    }
    maxV = niceMax(maxV || 1);
    const bars = this.type === 'bar' || this.type === 'stacked-bar';
    // bars need half a slot of padding on both ends
    const pad = bars ? 0.5 : 0;
    const span = maxT - minT + 2 * pad;
    const x = (t) => L + ((t - minT + pad) / span) * (W - L - R);
    return { L, R, T, B, minT, maxT, maxV, bars, slot: (W - L - R) / span, x, y: (v) => T + (1 - v / maxV) * (H - T - B), invX: (px) => minT - pad + ((px - L) / (W - L - R)) * span };
  }

  draw() {
    const p = this.prep();
    if (!p) return;
    const { g, W, H } = p;
    const s = this.geometry(W, H);
    const grid = this.css('--chart-grid'), muted = this.css('--text-muted'), surface = this.css('--surface-1');
    g.lineWidth = 1; g.fillStyle = muted; g.textAlign = 'right'; g.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const v = (s.maxV * i) / 4;
      const yy = Math.round(s.y(v)) + 0.5;
      g.strokeStyle = grid; g.beginPath(); g.moveTo(s.L, yy); g.lineTo(W - s.R, yy); g.stroke();
      g.fillText(this.yFormat(v), s.L - 6, yy);
    }
    g.textAlign = 'center'; g.textBaseline = 'top';
    const step = niceStep((s.maxT - s.minT) / Math.max(2, Math.floor((W - s.L - s.R) / 70)));
    for (let t = Math.ceil(s.minT / step) * step; t <= s.maxT; t += step) g.fillText(fmtDur(t), s.x(t), H - s.B + 5);
    if (!this.data.length) return this.emptyMessage(g, W, H);

    const base = s.y(0);
    if (s.bars) {
      const n = this.stacked ? 1 : this.series.length;
      const groupW = Math.max(1, s.slot * 0.8);
      const bw = Math.max(1, (groupW - (n - 1) * 1) / n);
      for (const d of this.data) {
        let acc = 0;
        this.series.forEach((ser, i) => {
          const v = d[ser.key];
          if (v == null || v <= 0) return;
          g.fillStyle = this.css(ser.color);
          let x0, y0, y1;
          if (this.stacked) { x0 = s.x(d.t) - groupW / 2; y1 = s.y(acc); acc += v; y0 = s.y(acc); }
          else { x0 = s.x(d.t) - groupW / 2 + i * (bw + 1); y0 = s.y(v); y1 = base; }
          const hgt = Math.max(1, y1 - y0 - (this.stacked && acc !== v ? 1 : 0));
          roundTop(g, x0, y0, this.stacked ? groupW : bw, hgt, Math.min(2, bw / 2));
        });
      }
    } else {
      const stackBase = new Map(this.data.map((d) => [d.t, 0]));
      const series = this.series;
      for (const ser of series) {
        const pts = [];
        for (const d of this.data) {
          let v = d[ser.key];
          if (this.stacked) { const b0 = stackBase.get(d.t); const v2 = b0 + (v || 0); pts.push([d.t, v2, b0]); stackBase.set(d.t, v2); }
          else pts.push([d.t, v, 0]);
        }
        const color = this.css(ser.color);
        // fill (area types)
        if ((this.type === 'area' || this.stacked) && !ser.noFill) {
          g.fillStyle = color;
          g.globalAlpha = this.stacked ? 0.55 : 0.16;
          let open = false;
          let seg = [];
          const flush = () => {
            if (seg.length < 1) return;
            g.beginPath();
            g.moveTo(s.x(seg[0][0]), s.y(seg[0][1]));
            for (const q of seg) g.lineTo(s.x(q[0]), s.y(q[1]));
            for (let k = seg.length - 1; k >= 0; k--) g.lineTo(s.x(seg[k][0]), s.y(seg[k][2]));
            g.closePath(); g.fill();
            seg = [];
          };
          for (const q of pts) { if (q[1] == null) { flush(); open = false; continue; } seg.push(q); open = true; }
          if (open) flush();
          g.globalAlpha = 1;
        }
        g.strokeStyle = color; g.lineWidth = 2; g.lineJoin = 'round'; g.lineCap = 'round';
        g.setLineDash(ser.dash || []);
        g.beginPath();
        let pen = false;
        for (const [t, v] of pts) {
          if (v == null) { pen = false; continue; }
          if (pen) g.lineTo(s.x(t), s.y(v)); else { g.moveTo(s.x(t), s.y(v)); pen = true; }
        }
        g.stroke();
        g.setLineDash([]);
        if (pts.filter((q) => q[1] != null).length === 1) { const q = pts.find((z) => z[1] != null); g.fillStyle = color; g.beginPath(); g.arc(s.x(q[0]), s.y(q[1]), 3, 0, Math.PI * 2); g.fill(); }
      }
    }
    if (this.hover) {
      const d = this.hover;
      const xx = Math.round(s.x(d.t)) + 0.5;
      g.strokeStyle = muted; g.lineWidth = 1;
      g.beginPath(); g.moveTo(xx, s.T); g.lineTo(xx, H - s.B); g.stroke();
      if (!s.bars) {
        let acc = 0;
        for (const ser of this.series) {
          const v = d[ser.key];
          if (v == null) continue;
          acc += v;
          g.fillStyle = this.css(ser.color); g.strokeStyle = surface; g.lineWidth = 2;
          g.beginPath(); g.arc(xx, s.y(this.stacked ? acc : v), 4.5, 0, Math.PI * 2); g.fill(); g.stroke();
        }
      }
    }
  }

  onMove(e) {
    if (!this.data.length) return;
    const r = this.canvas.getBoundingClientRect();
    const s = this.geometry(r.width, r.height);
    const t = s.invX(e.clientX - r.left);
    let best = this.data[0];
    for (const d of this.data) if (Math.abs(d.t - t) < Math.abs(best.t - t)) best = d;
    this.hover = best;
    this.draw();
    const rows = this.series.map((ser) => ({ color: ser.color, label: ser.label, value: best[ser.key] == null ? '–' : `${this.yFormat(best[ser.key])}${this.unit ? ' ' + this.unit : ''}` }));
    if (this.stacked) rows.push({ label: 'Total', value: `${this.yFormat(this.series.reduce((a, ser) => a + (best[ser.key] || 0), 0))}` });
    this.showTip(s.x(best.t), rows, `t = ${fmtDur(best.t)}`);
  }
}

/* --------------------------------------------------------------- heatmap */

export class HeatmapChart extends BaseChart {
  /** data: [{ t, heat: [counts per bucket] }], edges: upper bucket edges in ms */
  constructor({ title, height = 210 }) {
    super({ title, unit: 'requests per latency bucket', height, note: 'Stronger color = more requests. Each column is one second, each row a latency range.' });
    this.data = []; this.edges = [];
  }
  setData(data, edges) { this.data = data.filter((d) => Array.isArray(d.heat)); this.edges = edges || this.edges; this.draw(); }

  rowLabel(i) {
    const e = this.edges;
    if (i >= e.length) return `> ${fmtMsShort(e[e.length - 1])}`;
    return `≤ ${fmtMsShort(e[i])}`;
  }

  geometry(W, H) {
    const L = 58, R = 10, T = 6, B = 20;
    const rows = this.edges.length + 1;
    const ts = this.data.map((d) => d.t);
    const minT = ts.length ? Math.min(...ts) : 0;
    const maxT = Math.max(minT + 10, ts.length ? Math.max(...ts) : 10);
    const cols = maxT - minT + 1;
    // hide rows above the slowest observed bucket (keeps the useful range readable)
    let top = 0;
    for (const d of this.data) d.heat.forEach((c, i) => { if (c > 0 && i > top) top = i; });
    const shown = Math.min(rows, Math.max(top + 2, 5));
    const cw = (W - L - R) / cols, rh = (H - T - B) / shown;
    return { L, R, T, B, minT, maxT, shown, cw, rh, x: (t) => L + (t - minT) * cw, y: (row) => H - B - (row + 1) * rh };
  }

  draw() {
    const p = this.prep();
    if (!p) return;
    const { g, W, H } = p;
    if (!this.data.length || !this.edges.length) return this.emptyMessage(g, W, H);
    const s = this.geometry(W, H);
    const muted = this.css('--text-muted');
    let max = 1;
    for (const d of this.data) for (const c of d.heat) if (c > max) max = c;
    const color = this.css('--series-1');
    const surface = this.css('--surface-1');
    for (const d of this.data) {
      for (let r = 0; r < s.shown; r++) {
        const c = d.heat[r] || 0;
        if (!c) continue;
        // sequential single-hue ramp: opacity grows with log(count)
        g.globalAlpha = 0.12 + 0.88 * (Math.log1p(c) / Math.log1p(max));
        g.fillStyle = color;
        g.fillRect(s.x(d.t) + 0.5, s.y(r) + 0.5, Math.max(1, s.cw - 1), Math.max(1, s.rh - 1));
      }
    }
    g.globalAlpha = 1;
    g.fillStyle = muted; g.textAlign = 'right'; g.textBaseline = 'middle';
    for (let r = 0; r < s.shown; r++) if (s.rh >= 11 || r % 2 === 0) g.fillText(this.rowLabel(r), s.L - 6, s.y(r) + s.rh / 2);
    g.textAlign = 'center'; g.textBaseline = 'top';
    const step = niceStep((s.maxT - s.minT) / Math.max(2, Math.floor((W - s.L - s.R) / 70)));
    for (let t = Math.ceil(s.minT / step) * step; t <= s.maxT; t += step) g.fillText(fmtDur(t), s.x(t) + s.cw / 2, H - s.B + 5);
    if (this.hover) {
      g.strokeStyle = this.css('--text'); g.lineWidth = 1.5;
      g.strokeRect(s.x(this.hover.t) + 0.5, s.y(this.hover.row) + 0.5, Math.max(2, s.cw - 1), Math.max(2, s.rh - 1));
      g.strokeStyle = surface;
    }
  }

  onMove(e) {
    if (!this.data.length) return;
    const r = this.canvas.getBoundingClientRect();
    const s = this.geometry(r.width, r.height);
    const t = Math.floor(s.minT + (e.clientX - r.left - s.L) / s.cw);
    const row = Math.floor((r.height - s.B - (e.clientY - r.top)) / s.rh);
    const d = this.data.find((x) => x.t === t);
    if (!d || row < 0 || row >= s.shown) { this.hover = null; this.tip.hidden = true; this.draw(); return; }
    this.hover = { t, row };
    this.draw();
    const total = d.heat.reduce((a, b) => a + b, 0);
    const c = d.heat[row] || 0;
    const lo = row === 0 ? '0' : fmtMsShort(this.edges[row - 1]);
    const range = row >= this.edges.length ? `> ${fmtMsShort(this.edges[this.edges.length - 1])}` : `${lo} – ${fmtMsShort(this.edges[row])}`;
    this.showTip(s.x(t) + s.cw, [{ label: 'Latency', value: range }, { label: 'Requests', value: fmtNum(c) }, { label: 'Share of second', value: `${total ? fmtNum((c / total) * 100, 1) : 0}%` }], `t = ${fmtDur(t)}`);
  }
}

/* ------------------------------------------------------- category / bars */

export class CategoryChart extends BaseChart {
  /** series: [{key,label,color}], data: [{label, [key]: number}] */
  constructor({ title, unit, series, horizontal = true, height = 200, yFormat, note }) {
    super({ title, unit, height, legend: series, note });
    this.series = series; this.horizontal = horizontal; this.data = [];
    this.yFormat = yFormat || ((v) => fmtNum(v, v < 10 ? 1 : 0));
  }
  setData(data) {
    this.data = data;
    if (this.horizontal) this.box.style.height = `${Math.max(120, 30 + data.length * (8 + this.series.length * 9))}px`;
    this.draw();
  }

  geometry(W, H) {
    let maxV = 0;
    for (const d of this.data) for (const s of this.series) if (d[s.key] > maxV) maxV = d[s.key];
    maxV = niceMax(maxV || 1);
    if (this.horizontal) {
      const L = Math.min(170, Math.max(70, W * 0.3)), R = 12, T = 4, B = 20;
      const band = (H - T - B) / Math.max(1, this.data.length);
      return { L, R, T, B, maxV, band, v: (x) => L + (x / maxV) * (W - L - R) };
    }
    const L = 46, R = 10, T = 8, B = 34;
    const band = (W - L - R) / Math.max(1, this.data.length);
    return { L, R, T, B, maxV, band, v: (x) => T + (1 - x / maxV) * (H - T - B) };
  }

  draw() {
    const p = this.prep();
    if (!p) return;
    const { g, W, H } = p;
    if (!this.data.length) return this.emptyMessage(g, W, H, 'No data yet');
    const s = this.geometry(W, H);
    const grid = this.css('--chart-grid'), muted = this.css('--text-muted'), text = this.css('--text-2');
    const n = this.series.length;
    g.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const v = (s.maxV * i) / 4;
      g.strokeStyle = grid; g.fillStyle = muted;
      if (this.horizontal) {
        const xx = Math.round(s.v(v)) + 0.5;
        g.beginPath(); g.moveTo(xx, s.T); g.lineTo(xx, H - s.B); g.stroke();
        g.textAlign = 'center'; g.textBaseline = 'top'; g.fillText(this.yFormat(v), xx, H - s.B + 5);
      } else {
        const yy = Math.round(s.v(v)) + 0.5;
        g.beginPath(); g.moveTo(s.L, yy); g.lineTo(W - s.R, yy); g.stroke();
        g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillText(this.yFormat(v), s.L - 6, yy);
      }
    }
    this.data.forEach((d, i) => {
      const inner = s.band * 0.78;
      const bw = Math.max(1, (inner - (n - 1)) / n);
      const start = i * s.band + (s.band - inner) / 2;
      const isHover = this.hover === i;
      this.series.forEach((ser, k) => {
        const v = d[ser.key];
        if (v == null) return;
        g.fillStyle = this.css(ser.color);
        g.globalAlpha = this.hover == null || isHover ? 1 : 0.55;
        if (this.horizontal) {
          const y0 = s.T + start + k * (bw + 1);
          roundRight(g, s.L, y0, Math.max(1, s.v(v) - s.L), bw, Math.min(2, bw / 2));
        } else {
          const x0 = s.L + start + k * (bw + 1);
          roundTop(g, x0, s.v(v), bw, Math.max(1, s.v(0) - s.v(v)), Math.min(2, bw / 2));
        }
      });
      g.globalAlpha = 1;
      g.fillStyle = text;
      if (this.horizontal) {
        g.textAlign = 'right'; g.textBaseline = 'middle';
        g.fillText(ellipsize(g, d.label, s.L - 10), s.L - 6, s.T + i * s.band + s.band / 2);
      } else if (this.data.length <= 24 || i % Math.ceil(this.data.length / 12) === 0) {
        g.textAlign = 'center'; g.textBaseline = 'top';
        g.fillText(ellipsize(g, d.label, Math.max(30, s.band * 2)), s.L + i * s.band + s.band / 2, H - s.B + 5);
      }
    });
  }

  onMove(e) {
    if (!this.data.length) return;
    const r = this.canvas.getBoundingClientRect();
    const s = this.geometry(r.width, r.height);
    const pos = this.horizontal ? e.clientY - r.top - s.T : e.clientX - r.left - s.L;
    const i = Math.floor(pos / s.band);
    if (i < 0 || i >= this.data.length) { this.hover = null; this.tip.hidden = true; this.draw(); return; }
    this.hover = i;
    this.draw();
    const d = this.data[i];
    this.showTip(this.horizontal ? Math.min(r.width - 160, s.L + 20) : s.L + i * s.band + s.band, this.series.map((ser) => ({ color: ser.color, label: ser.label, value: d[ser.key] == null ? '–' : `${this.yFormat(d[ser.key])}${this.unit ? ' ' + this.unit : ''}` })), d.label);
  }
}

/* --------------------------------------------------------------- helpers */

function roundTop(g, x, y, w, hgt, r) {
  r = Math.max(0, Math.min(r, w / 2, hgt));
  g.beginPath();
  g.moveTo(x, y + hgt); g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
  g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r); g.lineTo(x + w, y + hgt);
  g.closePath(); g.fill();
}
function roundRight(g, x, y, w, hgt, r) {
  r = Math.max(0, Math.min(r, hgt / 2, w));
  g.beginPath();
  g.moveTo(x, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + hgt - r); g.quadraticCurveTo(x + w, y + hgt, x + w - r, y + hgt); g.lineTo(x, y + hgt);
  g.closePath(); g.fill();
}
function ellipsize(g, text, max) {
  text = String(text);
  if (g.measureText(text).width <= max) return text;
  while (text.length > 1 && g.measureText(text + '…').width > max) text = text.slice(0, -1);
  return text + '…';
}
function niceMax(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}
function niceStep(raw) {
  for (const s of [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]) if (raw <= s) return s;
  return 7200;
}
export function fmtDur(t) {
  t = Math.round(t);
  if (t < 60) return `${t}s`;
  const m = Math.floor(t / 60), sec = t % 60;
  if (m < 60) return sec ? `${m}m${sec}s` : `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ''}`;
}
function fmtMsShort(ms) { return ms >= 1000 ? `${ms / 1000}s` : `${ms}ms`; }

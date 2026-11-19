const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, d = 0) => (n == null ? '–' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: 0 }));

/** Small static SVG line chart (no JS) for the printable report. series: [{name, color, values:[{t,v}]}] */
function lineChart(series, { unit = '', height = 180 } = {}) {
  const W = 720, H = height, L = 48, R = 12, T = 12, B = 24;
  const all = series.flatMap((s) => s.values.filter((p) => p.v != null));
  if (!all.length) return '<p class="muted">No data</p>';
  const maxT = Math.max(1, ...all.map((p) => p.t));
  const maxV = Math.max(1, ...all.map((p) => p.v)) * 1.1;
  const x = (t) => L + (t / maxT) * (W - L - R);
  const y = (v) => T + (1 - v / maxV) * (H - T - B);
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const v = maxV * f;
    return `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 4}" class="ax" text-anchor="end">${fmt(v, v < 10 ? 1 : 0)}</text>`;
  }).join('');
  const xt = [0, 0.25, 0.5, 0.75, 1].map((f) => `<text x="${x(maxT * f)}" y="${H - 6}" class="ax" text-anchor="middle">${fmt(maxT * f)}s</text>`).join('');
  const paths = series.map((s) => {
    let d = '', pen = false;
    for (const p of s.values) {
      if (p.v == null) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`;
      pen = true;
    }
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  }).join('');
  const legend = series.length > 1 ? `<div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>` : '';
  return `${legend}<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="${esc(series.map((s) => s.name).join(', '))}${unit ? ' (' + unit + ')' : ''}">${grid}${xt}${paths}</svg>`;
}

export function renderReport(r) {
  const s = r.summary || {};
  const L = s.latency || {};
  const tl = (r.timeline || []).filter((p) => !p.partial);
  const statusRows = Object.entries(s.status || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${fmt(v)}</td><td class="n">${fmt((v / Math.max(1, s.count)) * 100, 2)}%</td></tr>`).join('');
  const perRows = (r.perRequest || []).map((p) => `<tr><td>${esc(p.name)}</td><td class="n">${fmt(p.count)}</td><td class="n">${fmt(p.errorRate, 2)}%</td><td class="n">${fmt(p.latency.avg, 1)}</td><td class="n">${fmt(p.latency.p50, 1)}</td><td class="n">${fmt(p.latency.p95, 1)}</td><td class="n">${fmt(p.latency.p99, 1)}</td><td class="n">${fmt(p.latency.max, 1)}</td></tr>`).join('');
  const thrRows = (r.thresholds || []).map((t) => `<tr><td>${esc(t.metric)} ${esc(t.op)} ${esc(t.value)}</td><td class="n">${fmt(t.actual, 2)}</td><td>${t.pass ? '<b class="ok">✔ pass</b>' : '<b class="bad">✖ fail</b>'}</td></tr>`).join('');
  const errRows = Object.entries(s.errors || {}).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${fmt(v)}</td></tr>`).join('');
  const cb = r.callbacks || {};
  const c = r.config || {};
  const load = c.mode === 'rate'
    ? (c.useStages ? `Stages: ${(c.stages || []).map((x) => `${x.durationSec}s→${x.tps} TPS`).join(', ')}` : `${c.tps} TPS for ${c.durationSec}s${c.rampUpSec ? ` (ramp-up ${c.rampUpSec}s)` : ''}`) + `, max in-flight ${c.maxInFlight} (${c.saturation})`
    : `${c.vus} VUs${c.durationSec ? ` for ${c.durationSec}s` : ''}${c.iterations ? `, ${c.iterations} iterations` : ''}${c.rateLimit ? `, capped at ${c.rateLimit}/s` : ''}${c.thinkTimeMs ? `, think ${c.thinkTimeMs}ms` : ''}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Load test report</title>
<style>
:root{--bg:#fcfcfb;--fg:#0b0b0b;--mut:#52514e;--line:#e4e3df;--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--crit:#d03b3b;--good:#0ca30c}
@media (prefers-color-scheme:dark){:root{--bg:#1a1a19;--fg:#f0efec;--mut:#c3c2b7;--line:#3a3936;--s1:#3987e5;--s2:#d95926;--s3:#199e70}}
body{background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:24px 16px}
main{max-width:860px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}
.muted{color:var(--mut)}.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:16px 0}
.tile{border:1px solid var(--line);border-radius:8px;padding:10px 12px}.tile b{display:block;font-size:20px;font-variant-numeric:tabular-nums}.tile span{color:var(--mut);font-size:12px}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.chart{width:100%;height:auto}.grid{stroke:var(--line);stroke-width:1}.ax{fill:var(--mut);font-size:11px}
.legend{display:flex;gap:14px;font-size:12px;color:var(--mut)}.legend i{display:inline-block;width:10px;height:3px;border-radius:2px;margin-right:6px;vertical-align:middle}
.ok{color:var(--good)}.bad{color:var(--crit)}code{font-size:12px}
</style></head><body><main>
<h1>${esc(r.name || 'Load test')}</h1>
<div class="muted">${esc(r.startedAt)} · ${fmt(r.elapsedSec, 1)}s · status <b>${esc(r.status)}</b>${r.reason ? ' · ' + esc(r.reason) : ''}${r.thresholds?.length ? ` · thresholds ${r.passed ? '<b class="ok">✔ passed</b>' : '<b class="bad">✖ failed</b>'}` : ''}</div>
<div class="muted">Target: ${esc(r.target?.collection || r.target?.requests?.[0]?.name || '')}${r.target?.environment ? ' · env ' + esc(r.target.environment) : ''} · ${esc(load)}</div>
<div class="tiles">
<div class="tile"><b>${fmt(s.count)}</b><span>requests</span></div>
<div class="tile"><b>${fmt(s.rps, 1)}</b><span>avg req/s</span></div>
<div class="tile"><b>${fmt(s.errorRate, 2)}%</b><span>failed (${fmt(s.failed)})</span></div>
<div class="tile"><b>${fmt(L.p50, 1)} ms</b><span>p50 latency</span></div>
<div class="tile"><b>${fmt(L.p95, 1)} ms</b><span>p95 latency</span></div>
<div class="tile"><b>${fmt(L.p99, 1)} ms</b><span>p99 latency</span></div>
<div class="tile"><b>${fmt(r.live?.dropped)}</b><span>dropped iterations</span></div>
${cb.tracked ? `<div class="tile"><b>${fmt(cb.received)}/${fmt(cb.tracked)}</b><span>callbacks (p95 ${fmt(cb.latency?.p95, 0)} ms)</span></div>` : ''}
</div>
<h2>Throughput (requests completed per second)</h2>
${lineChart([{ name: 'completed/s', color: 'var(--s1)', values: tl.map((p) => ({ t: p.t, v: p.completed })) }, ...(tl.some((p) => p.target) ? [{ name: 'target/s', color: 'var(--s2)', values: tl.map((p) => ({ t: p.t, v: p.target })) }] : [])])}
<h2>Latency per second (ms)</h2>
${lineChart([{ name: 'p50', color: 'var(--s1)', values: tl.map((p) => ({ t: p.t, v: p.p50 })) }, { name: 'p95', color: 'var(--s2)', values: tl.map((p) => ({ t: p.t, v: p.p95 })) }, { name: 'p99', color: 'var(--s3)', values: tl.map((p) => ({ t: p.t, v: p.p99 })) }], { unit: 'ms' })}
<h2>Failed requests per second</h2>
${lineChart([{ name: 'failed/s', color: 'var(--crit)', values: tl.map((p) => ({ t: p.t, v: p.failed })) }])}
${thrRows ? `<h2>Thresholds</h2><table><tr><th>Threshold</th><th class="n">Actual</th><th>Result</th></tr>${thrRows}</table>` : ''}
<h2>Per request</h2><table><tr><th>Request</th><th class="n">Count</th><th class="n">Failed</th><th class="n">avg</th><th class="n">p50</th><th class="n">p95</th><th class="n">p99</th><th class="n">max</th></tr>${perRows}</table>
<h2>Status codes</h2><table><tr><th>Status</th><th class="n">Count</th><th class="n">Share</th></tr>${statusRows}</table>
${errRows ? `<h2>Errors</h2><table><tr><th>Error</th><th class="n">Count</th></tr>${errRows}</table>` : ''}
<h2>Timeline data</h2>
<table><tr><th class="n">t (s)</th><th class="n">target</th><th class="n">started</th><th class="n">completed</th><th class="n">failed</th><th class="n">dropped</th><th class="n">p50</th><th class="n">p95</th><th class="n">p99</th></tr>
${tl.map((p) => `<tr><td class="n">${p.t}</td><td class="n">${fmt(p.target, 1)}</td><td class="n">${fmt(p.started)}</td><td class="n">${fmt(p.completed)}</td><td class="n">${fmt(p.failed)}</td><td class="n">${fmt(p.dropped)}</td><td class="n">${fmt(p.p50, 1)}</td><td class="n">${fmt(p.p95, 1)}</td><td class="n">${fmt(p.p99, 1)}</td></tr>`).join('')}
</table>
<p class="muted">Generated by ApiStorm</p>
</main></body></html>`;
}

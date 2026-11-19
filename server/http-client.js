import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

const DEFAULT_HEADERS = [
  ['User-Agent', 'ApiStorm/1.2'],
  ['Accept', '*/*'],
  ['Accept-Encoding', 'gzip, deflate, br'],
];

/** Hosts that are this app's own callback receiver: requests to them get an origin marker so they are never mistaken for callbacks. */
export const selfHosts = new Set();

export const sharedAgents = {
  http: new http.Agent({ keepAlive: true, maxSockets: 64 }),
  https: new https.Agent({ keepAlive: true, maxSockets: 64 }),
};

export function createAgents({ keepAlive = true, maxSockets = Infinity } = {}) {
  return {
    http: new http.Agent({ keepAlive, maxSockets, maxFreeSockets: Math.min(maxSockets, 1024) }),
    https: new https.Agent({ keepAlive, maxSockets, maxFreeSockets: Math.min(maxSockets, 1024) }),
  };
}

export function destroyAgents(agents) {
  agents?.http?.destroy();
  agents?.https?.destroy();
}

function decompress(buf, enc) {
  enc = String(enc || '').toLowerCase().trim();
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf);
    if (enc === 'br') return zlib.brotliDecompressSync(buf);
    if (enc === 'deflate') { try { return zlib.inflateSync(buf); } catch { return zlib.inflateRawSync(buf); } }
    if (enc === 'zstd' && zlib.zstdDecompressSync) return zlib.zstdDecompressSync(buf);
  } catch { /* fall through and return raw bytes */ }
  return buf;
}

const r1 = (n) => (n == null ? null : Math.round(n * 100) / 100);

function once(prep, opts) {
  return new Promise((resolve) => {
    const u = new URL(prep.url);
    const isHttps = u.protocol === 'https:';
    const agents = opts.agents || sharedAgents;
    const headers = [...prep.headers];
    // raw header arrays bypass Node's automatic Host header
    if (!headers.some(([h]) => h.toLowerCase() === 'host')) headers.unshift(['Host', u.host]);
    if (selfHosts.has(u.host.toLowerCase())) headers.push(['X-ApiStorm-Origin', opts.origin || 'send']);
    if (opts.defaultHeaders !== false) {
      for (const [k, v] of DEFAULT_HEADERS) if (!headers.some(([h]) => h.toLowerCase() === k.toLowerCase())) headers.push([k, v]);
    }
    if (prep.body && !headers.some(([h]) => h.toLowerCase() === 'content-length')) headers.push(['Content-Length', String(prep.body.length)]);
    const flatHeaders = headers.flat();

    const t0 = performance.now();
    const t = { dns: null, connect: null, tls: null, ttfb: null, end: null };
    let reused = false;
    let finished = false;
    let bytesIn = 0;
    const finish = (out) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(out);
    };

    const req = (isHttps ? https : http).request({
      protocol: u.protocol,
      hostname: u.hostname.replace(/^\[|\]$/g, ''),
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: prep.method,
      headers: flatHeaders,
      agent: isHttps ? agents.https : agents.http,
      rejectUnauthorized: !opts.insecure,
      servername: isHttps && !/^[\d.]+$|:/.test(u.hostname) ? u.hostname : undefined,
    });

    const timer = setTimeout(() => {
      req.destroy(Object.assign(new Error(`Timeout after ${opts.timeoutMs} ms`), { code: 'ETIMEDOUT' }));
    }, opts.timeoutMs || 30000);

    if (opts.signal) {
      if (opts.signal.aborted) req.destroy(Object.assign(new Error('Request cancelled'), { code: 'ECANCELLED' }));
      else opts.signal.addEventListener('abort', () => req.destroy(Object.assign(new Error('Request cancelled'), { code: 'ECANCELLED' })), { once: true });
    }
    req.on('socket', (s) => {
      if (!s.connecting) { reused = true; return; }
      s.once('lookup', () => { t.dns = performance.now(); });
      s.once('connect', () => { t.connect = performance.now(); });
      s.once('secureConnect', () => { t.tls = performance.now(); });
    });

    req.on('response', (res) => {
      t.ttfb = performance.now();
      const chunks = [];
      const capture = opts.captureBody !== false;
      const max = opts.maxBodyBytes || 20 * 1024 * 1024;
      let truncated = false;
      res.on('data', (c) => {
        bytesIn += c.length;
        if (!capture) return;
        if (bytesIn > max) { truncated = true; return; }
        chunks.push(c);
      });
      res.on('end', () => {
        t.end = performance.now();
        let body = null;
        if (capture) body = decompress(Buffer.concat(chunks), res.headers['content-encoding']);
        const rawPairs = [];
        for (let i = 0; i < res.rawHeaders.length; i += 2) rawPairs.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
        finish({
          status: res.statusCode,
          statusText: res.statusMessage || '',
          httpVersion: res.httpVersion,
          headers: res.headers,
          headerPairs: rawPairs,
          body,
          truncated,
          bytesIn,
          bytesOut: prep.body ? prep.body.length : 0,
          reused,
          timings: {
            dns: t.dns != null ? r1(t.dns - t0) : null,
            connect: t.connect != null ? r1(t.connect - (t.dns ?? t0)) : null,
            tls: t.tls != null ? r1(t.tls - (t.connect ?? t0)) : null,
            ttfb: r1(t.ttfb - (t.tls ?? t.connect ?? t0)),
            download: r1(t.end - t.ttfb),
            total: r1(t.end - t0),
          },
        });
      });
      res.on('error', (e) => finish(errorResult(e, t0, bytesIn)));
      res.on('aborted', () => finish(errorResult(new Error('Response aborted'), t0, bytesIn)));
    });
    req.on('error', (e) => finish(errorResult(e, t0, bytesIn)));
    if (prep.body) req.end(prep.body); else req.end();
  });
}

function errorResult(e, t0, bytesIn) {
  let msg = e.message || String(e);
  if (e.code && !msg.includes(e.code)) msg = `${e.code}: ${msg}`;
  return { status: 0, error: msg, errorCode: e.code || 'ERROR', bytesIn, bytesOut: 0, timings: { total: r1(performance.now() - t0) } };
}

/**
 * Send a prepared request ({method,url,headers,body}).
 * opts: { timeoutMs, followRedirects, maxRedirects, insecure, agents, captureBody, maxBodyBytes }
 */
export async function sendHttp(prep, opts = {}) {
  const redirects = [];
  let cur = prep;
  let total = 0;
  for (let i = 0; ; i++) {
    const res = await once(cur, opts);
    if (res.error) { res.redirects = redirects; res.finalUrl = cur.url; res.timings.total = Math.round((total + (res.timings.total || 0)) * 100) / 100; return res; }
    total += res.timings.total || 0;
    res.timings.total = total;
    const loc = res.headers?.location;
    if (opts.followRedirects !== false && loc && [301, 302, 303, 307, 308].includes(res.status) && i < (opts.maxRedirects ?? 10)) {
      redirects.push({ status: res.status, url: cur.url, location: loc });
      const next = new URL(loc, cur.url).toString();
      const toGet = res.status === 303 || ((res.status === 301 || res.status === 302) && cur.method === 'POST');
      let headers = cur.headers;
      if (toGet) headers = headers.filter(([k]) => !/^content-(type|length)$/i.test(k));
      if (new URL(next).host !== new URL(cur.url).host) headers = headers.filter(([k]) => !/^(authorization|cookie)$/i.test(k));
      cur = { method: toGet ? 'GET' : cur.method, url: next, headers, body: toGet ? null : cur.body };
      continue;
    }
    res.timings.total = Math.round(total * 100) / 100;
    res.redirects = redirects;
    res.finalUrl = cur.url;
    return res;
  }
}

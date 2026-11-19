async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  get: (p) => call('GET', p),
  post: (p, b = {}) => call('POST', p, b),
  put: (p, b = {}) => call('PUT', p, b),
  del: (p) => call('DELETE', p),
};

/** Server-sent events with automatic reconnection (handled by EventSource). */
export function connectEvents(handlers, onState) {
  const es = new EventSource('/api/events');
  for (const [type, fn] of Object.entries(handlers)) {
    es.addEventListener(type, (e) => { try { fn(JSON.parse(e.data)); } catch (err) { console.error(err); } });
  }
  es.onopen = () => onState?.(true);
  es.onerror = () => onState?.(false);
  return es;
}

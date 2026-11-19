import http from 'node:http';
import { shortId } from './util.js';

const httpError = (status, message) => Object.assign(new Error(message), { status });

/**
 * Additional callback receivers on their own ports. Every listener serves the normal
 * /cb/<bin>/... routes; with a "default bin" set, any other path is recorded into that bin too,
 * so third parties can call e.g. http://host:9001/webhook without the /cb/<bin> prefix.
 */
export class ListenerManager {
  constructor({ store, hub, defaultHost = '127.0.0.1', reservedPorts = [], emit = () => {}, onChange = () => {}, portTaken = () => null }) {
    this.portTaken = portTaken;
    this.store = store;
    this.hub = hub;
    this.defaultHost = defaultHost;
    this.reserved = new Set(reservedPorts.map(Number));
    this.emit = emit;
    this.onChange = onChange;
    this.servers = new Map(); // id -> { server, error }
    this.status = new Map();  // id -> { running, error }
  }

  configs() { return this.store.get('listeners', []); }
  save(list) { this.store.set('listeners', list); this.onChange(); this.emit('listeners-changed', {}); }

  list() {
    return this.configs().map((l) => ({ ...l, running: this.servers.has(l.id), error: this.status.get(l.id)?.error || null }));
  }

  baseUrl(l) {
    return (l.publicBase || `http://localhost:${l.port}`).replace(/\/$/, '');
  }

  validate(data, id) {
    const port = Number(data.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw httpError(400, 'Port must be a number between 1 and 65535');
    if (this.reserved.has(port)) throw httpError(400, `Port ${port} is already used by ApiStorm itself`);
    if (this.configs().some((l) => l.port === port && l.id !== id)) throw httpError(409, `A listener on port ${port} already exists`);
    const taken = this.portTaken(port, id);
    if (taken) throw httpError(409, `Port ${port} is already used by ${taken}`);
    if (data.defaultBin && !/^[A-Za-z0-9_.-]{1,64}$/.test(data.defaultBin)) throw httpError(400, 'Default bin may contain letters, digits, "-", "_" and "." only');
    if (data.publicBase) { try { new URL(data.publicBase); } catch { throw httpError(400, 'Public base URL is not a valid URL'); } }
    return port;
  }

  async create(data) {
    const l = {
      id: shortId(),
      name: String(data.name || `Port ${data.port}`).slice(0, 60),
      port: this.validate(data),
      host: data.host || this.defaultHost,
      defaultBin: data.defaultBin || '',
      publicBase: data.publicBase || '',
      enabled: data.enabled !== false,
      createdAt: new Date().toISOString(),
    };
    if (l.defaultBin) this.hub.ensureBin(l.defaultBin);
    this.save([...this.configs(), l]);
    if (l.enabled) await this.start(l.id).catch(() => {});
    return this.list().find((x) => x.id === l.id);
  }

  async update(id, data) {
    const list = this.configs();
    const i = list.findIndex((l) => l.id === id);
    if (i < 0) throw httpError(404, 'Listener not found');
    const merged = { ...list[i], ...data, id };
    merged.port = this.validate(merged, id);
    if (merged.defaultBin) this.hub.ensureBin(merged.defaultBin);
    const needsRestart = this.servers.has(id) && (merged.port !== list[i].port || merged.host !== list[i].host);
    list[i] = merged;
    this.save(list);
    if (needsRestart) { await this.stop(id); await this.start(id).catch(() => {}); }
    if (!merged.enabled && this.servers.has(id)) await this.stop(id);
    if (merged.enabled && !this.servers.has(id)) await this.start(id).catch(() => {});
    return this.list().find((x) => x.id === id);
  }

  async remove(id) {
    await this.stop(id);
    this.save(this.configs().filter((l) => l.id !== id));
    this.status.delete(id);
  }

  start(id) {
    const l = this.configs().find((x) => x.id === id);
    if (!l) return Promise.reject(httpError(404, 'Listener not found'));
    if (this.servers.has(id)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const cur = this.configs().find((x) => x.id === id) || l;
        this.hub.handle(req, res, { defaultBin: cur.defaultBin, listener: cur.name }).catch((e) => { if (!res.headersSent) { res.writeHead(500); res.end(e.message); } });
      });
      server.keepAliveTimeout = 65000;
      server.once('error', (e) => {
        const msg = e.code === 'EADDRINUSE' ? `Port ${l.port} is already in use` : e.code === 'EACCES' ? `No permission to use port ${l.port}` : e.message;
        this.status.set(id, { running: false, error: msg });
        this.emit('listeners-changed', {});
        reject(httpError(409, msg));
      });
      server.listen(l.port, l.host || this.defaultHost, () => {
        this.servers.set(id, server);
        this.status.set(id, { running: true, error: null });
        this.onChange();
        this.emit('listeners-changed', {});
        resolve();
      });
    });
  }

  stop(id) {
    const s = this.servers.get(id);
    if (!s) return Promise.resolve();
    this.servers.delete(id);
    this.status.set(id, { running: false, error: null });
    this.onChange();
    this.emit('listeners-changed', {});
    return new Promise((resolve) => { s.close(() => resolve()); s.closeAllConnections?.(); });
  }

  async startAll() {
    const results = [];
    for (const l of this.configs()) if (l.enabled) results.push(await this.start(l.id).then(() => null, (e) => `${l.name}: ${e.message}`));
    return results.filter(Boolean);
  }

  async stopAll() { for (const id of [...this.servers.keys()]) await this.stop(id); }

  /** Running listener whose default bin is `bin` (so callback URLs can point at that port). */
  forBin(bin) {
    return this.configs().find((l) => l.defaultBin === bin && this.servers.has(l.id)) || null;
  }

  ports() { return [...this.servers.keys()].map((id) => this.configs().find((l) => l.id === id)).filter(Boolean); }
}

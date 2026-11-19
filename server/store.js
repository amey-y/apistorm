import fs from 'node:fs';
import path from 'node:path';

/** Tiny JSON-file persistence with debounced atomic writes. */
export class Store {
  constructor(dir) {
    this.dir = dir;
    this.cache = new Map();
    this.timers = new Map();
    fs.mkdirSync(dir, { recursive: true });
  }
  file(name) { return path.join(this.dir, name + '.json'); }
  get(name, fallback) {
    if (this.cache.has(name)) return this.cache.get(name);
    let val = fallback;
    try { val = JSON.parse(fs.readFileSync(this.file(name), 'utf8')); }
    catch (e) {
      if (e.code !== 'ENOENT') {
        // keep a copy of the unreadable file instead of silently overwriting it
        try { fs.copyFileSync(this.file(name), this.file(name) + '.corrupt-' + Date.now()); } catch {}
      }
    }
    this.cache.set(name, val);
    return val;
  }
  set(name, val, { immediate = false } = {}) {
    this.cache.set(name, val);
    if (immediate) return this.flush(name);
    if (this.timers.has(name)) return; // throttled: a write is already scheduled and will pick up the latest value
    this.timers.set(name, setTimeout(() => this.flush(name), 300));
  }
  flush(name) {
    clearTimeout(this.timers.get(name));
    this.timers.delete(name);
    const tmp = this.file(name) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.cache.get(name), null, 1));
    fs.renameSync(tmp, this.file(name));
  }
  remove(name) {
    clearTimeout(this.timers.get(name));
    this.timers.delete(name);
    this.cache.delete(name);
    try { fs.unlinkSync(this.file(name)); } catch {}
  }
  flushAll() { for (const name of [...this.timers.keys()]) this.flush(name); }
}

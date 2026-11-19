#!/usr/bin/env node
// Backwards-compatible entry point: `node server/index.js [--port ...]` starts the web UI.
import { main } from '../cli.js';

main(['serve', ...process.argv.slice(2)]).then((code) => { if (code !== undefined) process.exit(code); });

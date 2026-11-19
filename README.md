# ApiStorm

A Postman-style API client for **HTTP, WebSocket, Server-Sent Events and gRPC**, with Postman-compatible scripting,
OAuth 2.0 / JWT / HMAC / AWS signing, a load-testing engine, a scheduler, delivery-report (callback) tracking and mock servers.
It runs locally as a web app, from the command line, or in Docker. It needs only Node.js 20 or newer and has **no npm dependencies**.

## Three ways to run it

### 1. As an app (web GUI)

```bash
cd ApiStorm
npm start                      # same as: node cli.js serve
# open http://localhost:7070
```

### 2. From the command line (headless, CI friendly)

```bash
node cli.js help
# or install the "apistorm" command once:  npm link

# load test a URL at 200 TPS for 1 minute with a 10 s ramp-up, fail the build if p95 >= 300 ms
apistorm run --url https://api.example.com/health --tps 200 --duration 1m --ramp 10s \
             --threshold "p95<300" --threshold "errorRate<1" --report report.html

# bulk send: every request of an OpenAPI (YAML) spec, 500 iterations, 20 at a time
apistorm run openapi.yaml --var baseUrl=https://staging.example.com --vus 20 --iterations 500 --fail-on-error

# replay a cURL command with CSV data, ramping-rate profile
apistorm run --curl "curl -X POST https://api.example.com/orders -d '{\"user\":\"{{user}}\"}'" \
             --stages "30s:10,2m:100,30s:0" --data-file users.csv

# run a load test saved in the web UI, store the result so it shows up in the Runs tab
apistorm run --preset "Checkout soak" --save

# single request
apistorm send "curl https://httpbin.org/json" -i

# convert between formats
apistorm convert postman_collection.json --to openapi-yaml -o openapi.yaml
apistorm convert openapi.yaml --to k6 -o script.js
```

`run` exits with **0** when it passed, **1** when thresholds failed or the test was aborted, and **2** on usage errors.

### 3. With Docker

```bash
docker compose up -d --build           # http://localhost:7070
# protect the UI when others can reach it:
APISTORM_USER=admin APISTORM_PASSWORD=change-me docker compose up -d

# or plain docker
docker build -t apistorm .
docker run -d -p 7070:7070 -p 7071:7071 -p 7100-7110:7100-7110 -v apistorm-data:/data apistorm

# the image also runs the CLI
docker run --rm apistorm run --url https://api.example.com/health --tps 50 --duration 30s
docker run --rm -v "$PWD:/work" -w /work apistorm run openapi.yaml --vus 5 --iterations 100 --report /work/report.html
```

Data lives in the `/data` volume. Set `TZ` (for example `TZ=Asia/Kolkata`) so cron schedules use your local time.

### Ports and options

| Port | What | Default bind |
|------|------|--------------|
| 7070 | Web UI and control API | 127.0.0.1 (0.0.0.0 in Docker) |
| 7071 | Primary callback / webhook receiver and mock server | 127.0.0.1 (0.0.0.0 in Docker) |
| any | Extra callback listeners you add in the UI (Docker publishes 7100-7110) | per listener |

| Flag | Environment variable | Default |
|------|----------------------|---------|
| `--port` | `APISTORM_PORT` | 7070 |
| `--host` | `APISTORM_HOST` | 127.0.0.1 |
| `--cb-port` | `APISTORM_CB_PORT` | 7071 |
| `--cb-host` | `APISTORM_CB_HOST` | 127.0.0.1 |
| `--data-dir` | `APISTORM_DATA` | ./data |
| `--user` / `--password` | `APISTORM_USER` / `APISTORM_PASSWORD` | off (Basic auth for the UI) |
| – | `APISTORM_SCRIPTS` | on (`off` disables pre-request and post-response scripts) |

When the UI listens on anything other than localhost, set a password: the API can send requests anywhere.
`/api/health` stays open for health checks, and callback ports never require the password because webhooks have to reach them.

## Features

### Requests
- All common methods, query params, headers, and bodies: JSON, text, XML, form URL-encoded, multipart with files, GraphQL.
- Auth: Bearer, Basic, API key, or inherited from the collection.
- `{{variables}}` from environments, collection variables and globals, plus dynamic values such as `{{$uuid}}`, `{{$timestamp}}`,
  `{{$randomInt(1,100)}}`, `{{$randomEmail}}` and `{{$callbackUrl}}`.
- Checks on status, time, JSON path, headers and body. Extract values into variables to chain requests.
- Response viewer with pretty JSON/XML, HTML preview, images, a timing breakdown, redirects and the exact request sent.
- Code generation: cURL (bash and cmd), fetch, Python, PowerShell, HTTPie, k6.

### Scripts (Postman compatible)
- A **pre-request** and a **post-response** script per request, plus collection-level scripts that run for every request.
- The familiar `pm` API: `pm.environment`, `pm.collectionVariables`, `pm.globals`, `pm.variables`, `pm.iterationData`,
  `pm.request` (change URL, headers, body), `pm.response` (`json()`, `code`, `headers`, `responseTime`), `pm.test` with chai-style `pm.expect`,
  `await pm.sendRequest(...)`, `pm.execution.skipRequest()` and `setNextRequest()` for collection flows, plus `console.log`.
- `CryptoJS` (HmacSHA256, SHA256, MD5, Base64/Hex encoders), `utils.hmac/hash/uuid/base64` and `require('crypto-js' | 'crypto' | 'uuid')`.
- **Imported Postman collections now run their scripts as they are.**
- Scripts run in single sends, bulk sends, load tests (variables set by scripts are shared within the run) and schedules.
  The response has a **Console** tab with logs and errors, and script tests appear next to the regular checks.
- Snippets for common jobs: HMAC signature headers, fetching a token first, saving a message id, checking fields.
- Security: scripts run in a separate V8 context with a time limit, but **this is not a sandbox**. Anyone who can edit scripts can run code with the server's privileges.
  On a shared server, protect the UI with a password (`APISTORM_USER` / `APISTORM_PASSWORD`) and only give access to trusted colleagues,
  or turn scripts off with `APISTORM_SCRIPTS=off`.

### Authentication
- Bearer, Basic, API key, plus:
- **OAuth 2.0**: client credentials, password, and authorization code with PKCE (sign in through a pop-up; the redirect URI is `<ApiStorm URL>/oauth2/callback`).
  Tokens are cached, refreshed before they expire, and shared by every request with the same settings, so a load test fetches **one** token, not one per request.
- **JWT generated per request**: HS256/384/512, RS*, PS*, ES*, EdDSA, payload with `{{variables}}`, automatic `iat`/`exp`/`jti`, optional reuse window.
- **HMAC signing**: configurable string-to-sign (`{method}`, `{pathAndQuery}`, `{timestamp}`, `{bodySha256}`, `{nonce}`…), secret encoding,
  output encoding and extra headers. The "Sent request" tab shows the exact string that was signed.
- **AWS Signature v4** (verified against the official AWS example).
- All of them can be set once on a collection and inherited by its requests.

### WebSocket, SSE and gRPC
- Pick the protocol next to the URL, or use the **＋** next to the tabs.
- **WebSocket**: custom headers and auth on the handshake, subprotocols, text/JSON/binary messages, saved messages, ping, a live log with filtering.
- **Server-Sent Events**: GET or POST streams with headers, body and auth; events with their name and id in a live log.
- **gRPC**: unary, server streaming, client streaming and bidirectional calls over TLS or plaintext, metadata, deadlines, OAuth 2.0/JWT auth.
  The schema comes from **server reflection** or from `.proto` files you upload (no compiler needed; Google well-known types are built in).
  Messages use the standard protobuf JSON mapping, and the editor fills in a template for the chosen method.
- Load tests support HTTP requests only for now.

### Mock servers
- **Mocks** tab → **From OpenAPI** (JSON or YAML, file, paste or URL): every operation becomes a route that answers with the spec's example or a generated sample,
  under the spec's base path, on its own port. Optionally creates a matching collection whose `{{baseUrl}}` points at the mock.
- Path parameters (`/messages/{id}`), response templates (`{{request.params.id}}`, `{{request.body.to}}`, `{{$uuid}}`), per-route status and headers.
- **Request validation** against the spec's schema (400 with the list of problems), **latency** with jitter, and **error injection** (for example 5% → 503).
- Every request a mock receives is logged in the Callbacks tab.

### Import and export
- **Import** (auto-detected, by paste, file drop or **URL**): cURL commands, Postman collections and environments,
  **OpenAPI 3.x and Swagger 2.0 in JSON or YAML**, HAR, ApiStorm exports (JSON or YAML).
  The YAML parser is built in and has been checked against the GitHub (11 MB) and Stripe public specs.
- **Export**: ApiStorm JSON/YAML, Postman v2.1, **OpenAPI 3 (JSON or YAML)**, cURL script, k6 script, workspace backup.

### Load testing
- **Fixed rate** (open model) with ramp-up or multi-stage profiles, or **virtual users** (closed model) with iteration counts for bulk sends.
- **Throttle**: max in-flight with drop or queue, rate limit, think time and jitter.
- Collection flows with variables passed between steps, CSV/JSON test data, thresholds, auto-abort and graceful stop.
- **Several tests at once**: each gets a tab above the dashboard, and **Overview** compares all live tests on one chart.
  Saved tests can be started together (Load test → Manage saved tests → tick several → Start selected). The limit is set in Settings.
- **Configurable charts**: pick panels with "＋ Add chart" and switch each panel between line, area, bars or stacked.
  Lay them out in 1-3 columns. Available panels:
  throughput vs target, latency percentiles, average/max latency, status codes per second, failed and dropped,
  concurrency, started vs completed, data transfer, callbacks per second, callback latency, **latency heatmap**,
  **latency distribution**, **latency by request**.
- **↺ Reset stats** zeroes the numbers and charts of a running test, for example after warm-up, without stopping it.
  **⌫ Clear** removes a finished test from the dashboard. **Clear all** in Runs deletes saved results. Every reset and clear asks for confirmation first.
- Results are saved to Runs, with comparison and exports as an HTML report, JSON or a per-second CSV.

### Schedules
- Schedule a **single request**, a **bulk send** (collection × iterations × concurrency) or a **load test**.
- Triggers: once at a date/time, every N minutes/hours/days, a **cron expression** (with a live preview of the next runs), or manual.
- Each schedule has its own environment, keeps a run history, and can skip a run while the previous one is still going.
- An optional **notification webhook** posts a summary after each run, or only on failure. The payload works with Slack, Teams, Discord and Mattermost incoming webhooks.
- Schedules run inside the server process, so keep it running. The Docker container is a good home for that.

### Callbacks and webhooks
- **Bins** record every request sent to `http://localhost:7071/cb/<bin>/…` and reply with a configurable mock response (status, headers, body templates, delay).
- **Listener ports**: start extra receivers on any port (Callbacks → Listener ports → ＋ Port).
  With a *default bin*, every path on that port is recorded, for example `http://host:9001/webhook`. This is useful for partners that need a fixed URL, or for mocking several services at once.
  `{{$callbackUrl(bin)}}` automatically points at the listener dedicated to that bin.
- **Correlation**: `{{$callbackUrl}}` or `{{$requestId}}` in a request links the incoming callback to the request and measures end-to-end latency, also during load tests.
- **Delivery reports (DLR) matched by the API's own id**: when an API returns its own id (for example `messageId`) and later posts a delivery report containing it,
  set the request to *match by a value from the response* (request Settings → Callbacks & delivery reports → `$.messageId`) and tell the bin where the id and status are
  in the report (bin ⚙ Settings → Correlation field / Status field; JSON path, form field, query parameter, header or regex).
  Reports that arrive before the submit response are still matched.
  Load tests then show DLR latency percentiles, timeouts and a count per status (DELIVRD, UNDELIV, …).
- To receive callbacks from the internet, tunnel a port (`cloudflared tunnel --url http://localhost:7071` or `ngrok http 7071`)
  and set **Settings → Public callback base URL**, or a listener's public base URL.

## Recipe: bulk SMS with delivery reports

1. **Environment**: add `smsApi`, `apiKey` or OAuth settings, and `dlrUrl` = your callback URL (for example `http://<apistorm-host>:7071/cb/dlr`,
   or a listener port / tunnel URL your SMS platform can reach).
2. **Request** `POST {{smsApi}}/messages` with body `{"to": "{{phone}}", "text": "Code {{$randomDigits(6)}}", "callbackUrl": "{{dlrUrl}}"}`,
   a check `status = 202`, and Settings → *match callbacks by a value from the response* → `$.messageId`.
3. **Bin `dlr`** → ⚙ Settings → Correlation field `$.messageId`, Status field `$.status` (or the fields your DLR uses).
4. **Load test** → load a CSV of phone numbers, choose 50 TPS for 5 minutes (or Virtual users + Iterations = number of messages for a bulk send),
   enable *Track async callbacks*, and add thresholds such as `p95 < 300 ms` and `callback timeouts < 1 %`.
5. Watch submit latency, DLR latency and the DELIVRD/UNDELIV breakdown live; schedule the same test nightly from the Schedules tab,
   or run it in CI with `apistorm run --preset "Bulk SMS" --fail-on-error`.

## Tests

```bash
npm test
```

There are 42 tests. They cover YAML parsing, every converter, assertions, histogram accuracy, TPS accuracy, throttling, VU flows,
callback correlation under load, auto-abort, cron, the scheduler, stats reset, the CLI parser, an end-to-end server test,
the script engine (pm API, chai assertions, timeouts, pm.sendRequest, flow control), OAuth 2.0 token sharing, JWT/SigV4 test vectors,
delivery-report matching under load (including reports that arrive early), WebSocket and SSE clients, protobuf encoding,
gRPC (all four call types, errors, metadata, reflection) and OpenAPI mock servers.

## Notes
- A single Node process sustained 6,000 TPS against a local target. For more, run several CLI instances or export to k6.
- Scripts run in-process (see the security note above). Turn them off with `APISTORM_SCRIPTS=off` where needed.
- gRPC: compressed messages and proto2 groups are not supported.
- Only load-test systems you own or are allowed to test.

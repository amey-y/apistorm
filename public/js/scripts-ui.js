/* Script editors, snippets, console output, and the advanced auth forms (OAuth 2.0, JWT, HMAC, AWS SigV4). */
import { h, clear, mount, toast, select, kvEditor, numField, checkField, copyText, fmtTime } from './dom.js';
import { api } from './api.js';
import { state, activeEnvId, on } from './state.js';

const PRE_SNIPPETS = [
  ['Set an environment variable', "pm.environment.set('key', 'value');"],
  ['Set a variable for this request only', "pm.variables.set('key', 'value');"],
  ['Random phone number from a list', "const numbers = ['+15550001', '+15550002', '+15550003'];\npm.variables.set('phone', numbers[Math.floor(Math.random() * numbers.length)]);"],
  ['Unique client reference', "pm.variables.set('clientRef', `${Date.now()}-${utils.randomHex(6)}`);"],
  ['HMAC-SHA256 signature header', "const ts = Math.floor(Date.now() / 1000).toString();\nconst body = pm.variables.replaceIn(pm.request.body.raw || '');\nconst sig = CryptoJS.HmacSHA256(`${ts}.${body}`, pm.environment.get('apiSecret')).toString(CryptoJS.enc.Hex);\npm.request.headers.upsert({ key: 'X-Timestamp', value: ts });\npm.request.headers.upsert({ key: 'X-Signature', value: sig });"],
  ['Fetch a token first (pm.sendRequest)', "const res = await pm.sendRequest({\n  url: pm.environment.get('authUrl'),\n  method: 'POST',\n  header: { 'Content-Type': 'application/json' },\n  body: { mode: 'raw', raw: JSON.stringify({ key: pm.environment.get('apiKey') }) },\n});\npm.environment.set('token', res.json().token);"],
  ['Skip this request conditionally', "if (!pm.iterationData.get('phone')) pm.execution.skipRequest();"],
  ['Log the resolved URL', "console.log(pm.variables.replaceIn(pm.request.url.toString()));"],
];
const POST_SNIPPETS = [
  ['Status code is 2xx', "pm.test('Status is 2xx', () => pm.response.to.be.success);"],
  ['Status code is 202', "pm.test('Accepted', () => pm.response.to.have.status(202));"],
  ['Response time below 500 ms', "pm.test('Fast enough', () => pm.expect(pm.response.responseTime).to.be.below(500));"],
  ['JSON field equals a value', "pm.test('Message queued', () => {\n  const j = pm.response.json();\n  pm.expect(j.status).to.eql('queued');\n});"],
  ['Save the message id', "pm.environment.set('messageId', pm.response.json().messageId);"],
  ['Check fields and types', "pm.test('Has a message id', () => {\n  const j = pm.response.json();\n  pm.expect(j).to.have.property('messageId').that.is.a('string');\n  pm.expect(j.parts).to.be.a('number').and.to.be.at.least(1);\n});"],
  ['Every item has a status', "pm.test('All recipients accepted', () => {\n  for (const r of pm.response.json().results) pm.expect(r.status).to.be.oneOf(['queued', 'accepted']);\n});"],
  ['Header is present', "pm.test('Has request id', () => pm.response.to.have.header('X-Request-Id'));"],
  ['Jump to another request (collection flows)', "pm.execution.setNextRequest('Get delivery status'); // null stops the iteration"],
];

export function scriptsPanel(scripts, changed, { note = '', collection = false } = {}) {
  scripts.pre ??= ''; scripts.post ??= '';
  const wrap = h('div.scripts');
  let phase = 'pre';
  const render = () => {
    clear(wrap);
    const disabled = state.info && state.info.scriptsEnabled === false;
    const ta = h('textarea.input.mono.code-area.script-area', {
      rows: 12, spellcheck: false, value: scripts[phase], 'aria-label': phase === 'pre' ? 'Pre-request script' : 'Post-response script',
      placeholder: phase === 'pre' ? '// runs before the request is sent\n// e.g. pm.environment.set(\'ts\', Date.now())' : '// runs after the response arrives\n// e.g. pm.test(\'ok\', () => pm.response.to.have.status(200))',
      oninput: (e) => { scripts[phase] = e.target.value; changed(); },
      onkeydown: (e) => { if (e.key === 'Tab') { e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); scripts[phase] = ta.value; changed(); } },
    });
    const insert = (code) => { const pos = ta.selectionStart ?? ta.value.length; const pre = ta.value.slice(0, pos); const sep = pre && !pre.endsWith('\n') ? '\n' : ''; ta.setRangeText(sep + code + '\n', pos, ta.selectionEnd ?? pos, 'end'); scripts[phase] = ta.value; changed(); ta.focus(); };
    wrap.append(
      disabled ? h('div.error-box.small', 'Scripts are disabled on this server (APISTORM_SCRIPTS=off). They are saved but not executed.') : null,
      h('div.row-gap',
        h('div.segmented', { role: 'radiogroup', 'aria-label': 'Script' }, [['pre', `Pre-request${scripts.pre.trim() ? ' •' : ''}`], ['post', `Post-response${scripts.post.trim() ? ' •' : ''}`]].map(([id, l]) => h(`button.seg${phase === id ? '.on' : ''}`, { type: 'button', role: 'radio', 'aria-checked': String(phase === id), onclick: () => { phase = id; render(); } }, l))),
        h('span.muted.small', collection ? 'Runs for every request in this collection (before the request\'s own script).' : note || 'Postman-compatible pm API. Runs in single sends, bulk sends, load tests and schedules.')),
      h('div.script-grid', ta,
        h('div.snippets', h('div.small.muted', 'Snippets (click to insert)'), (phase === 'pre' ? PRE_SNIPPETS : POST_SNIPPETS).map(([label, code]) => h('button.snippet', { type: 'button', title: code, onclick: () => insert(code) }, label)),
          h('details.small', h('summary', 'Available in scripts'), h('ul.api-list',
            ['pm.environment / collectionVariables / globals .get .set .unset', 'pm.variables.get/.set/.replaceIn', 'pm.iterationData.get (CSV row)', 'pm.request.url / .method / .headers.upsert / .body.raw',
              'pm.response.code / .json() / .text() / .headers.get / .responseTime', 'pm.test(name, fn) and pm.expect(x) (chai style)', 'await pm.sendRequest(req)', 'pm.execution.skipRequest() / setNextRequest(name)',
              'console.log / warn / error', 'CryptoJS (HmacSHA256, SHA256, MD5, enc.Base64/Hex)', 'utils.hmac / hash / uuid / base64 / randomHex', "require('crypto-js' | 'crypto' | 'uuid')"].map((x) => h('li.mono', x)))))));
  };
  render();
  return wrap;
}

/** Console tab: logs, errors and test results of the scripts of one send. */
export function consoleView(scripts) {
  const all = [...(scripts?.pre || []).map((s) => ({ ...s, phase: 'pre-request' })), ...(scripts?.post || []).map((s) => ({ ...s, phase: 'post-response' }))];
  if (!all.length) return h('p.muted', 'No scripts ran for this request. Add them in the Scripts tab.');
  return h('div.console', all.map((s) => h('div.console-block',
    h('div.console-head', h('b', `${s.phase} script`), h('span.muted.small', ` (${s.source})`), s.skipRequest ? h('span.badge', 'skipped request') : null),
    s.error ? h('div.console-line.error', '✖ ', s.error) : null,
    s.logs.map((l) => h(`div.console-line.${l.level}`, h('span.console-level', l.level), h('span.mono', l.text))),
    !s.logs.length && !s.error ? h('div.muted.small', 'No output.') : null)));
}

/* ------------------------------------------------------------- auth forms */

const field = (auth, changed, label, key, { ph = '', type = 'text', mono = true, hint = '' } = {}) => h('label.field', h('span', label, hint ? h('span.hint', { title: hint }, ' ⓘ') : null),
  h(`input.input${mono ? '.mono' : ''}`, { type, value: auth[key] ?? '', placeholder: ph, spellcheck: false, oninput: (e) => { auth[key] = e.target.value; changed(); } }));
const area = (auth, changed, label, key, { ph = '', rows = 4 } = {}) => h('label.field', h('span', label), h('textarea.input.mono', { rows, value: auth[key] ?? '', placeholder: ph, spellcheck: false, oninput: (e) => { auth[key] = e.target.value; changed(); } }));

export const ADVANCED_AUTH = [['oauth2', 'OAuth 2.0'], ['jwt', 'JWT (generated per request)'], ['hmac', 'HMAC signature'], ['awsv4', 'AWS Signature v4']];

export function advancedAuthFields(auth, changed, rerender, ctx = {}) {
  if (auth.type === 'oauth2') return oauth2Fields(auth, changed, rerender, ctx);
  if (auth.type === 'jwt') {
    auth.algorithm ||= 'HS256';
    const hmacAlg = /^HS/.test(auth.algorithm);
    return h('div',
      h('div.form-grid',
        h('label.field', h('span', 'Algorithm'), select((state.info?.jwtAlgorithms || ['HS256']).map((a) => [a, a]), auth.algorithm, (v) => { auth.algorithm = v; changed(); rerender(); })),
        numField('Expires in', auth.expiresIn ?? 300, (v) => { auth.expiresIn = v; changed(); }, { min: 0, suffix: 's', hint: 'Adds an "exp" claim. 0 = no expiry.' }),
        numField('Reuse token for', auth.reuseSeconds ?? 0, (v) => { auth.reuseSeconds = v; changed(); }, { min: 0, suffix: 's', hint: 'Sign once and reuse for this long (saves CPU in load tests with RSA/EC keys). 0 = new token per request.' })),
      hmacAlg ? [field(auth, changed, 'Secret', 'secret', { ph: '{{jwtSecret}}', type: 'password' }), checkField('Secret is base64 encoded', auth.secretBase64, (v) => { auth.secretBase64 = v; changed(); })]
        : area(auth, changed, 'Private key (PEM)', 'privateKey', { ph: '-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----', rows: 5 }),
      area(auth, changed, 'Payload (JSON, {{variables}} allowed)', 'payload', { ph: '{\n  "iss": "{{clientId}}",\n  "sub": "sms-sender"\n}', rows: 5 }),
      area(auth, changed, 'Extra header fields (JSON)', 'header', { ph: '{ "kid": "key-1" }', rows: 2 }),
      h('div.form-grid',
        checkField('Add "iat" (issued at)', auth.addIat !== false, (v) => { auth.addIat = v; changed(); }),
        checkField('Add "jti" (unique id)', auth.addJti, (v) => { auth.addJti = v; changed(); })),
      placement(auth, changed, rerender, 'token'));
  }
  if (auth.type === 'hmac') {
    auth.stringToSign ??= '{method}\\n{pathAndQuery}\\n{timestamp}\\n{bodySha256}';
    auth.headerName ??= 'X-Signature';
    auth.headerValue ??= '{signature}';
    auth.extraHeaders ??= [{ key: 'X-Timestamp', value: '{timestamp}', enabled: true }];
    return h('div',
      h('div.form-grid',
        h('label.field', h('span', 'Algorithm'), select([['sha256', 'HMAC-SHA256'], ['sha512', 'HMAC-SHA512'], ['sha1', 'HMAC-SHA1'], ['md5', 'HMAC-MD5']], auth.algorithm || 'sha256', (v) => { auth.algorithm = v; changed(); })),
        h('label.field', h('span', 'Secret encoding'), select([['utf8', 'Plain text'], ['base64', 'Base64'], ['hex', 'Hex']], auth.secretEncoding || 'utf8', (v) => { auth.secretEncoding = v; changed(); })),
        h('label.field', h('span', 'Signature encoding'), select([['hex', 'Hex'], ['base64', 'Base64'], ['base64url', 'Base64url']], auth.outputEncoding || 'hex', (v) => { auth.outputEncoding = v; changed(); }))),
      field(auth, changed, 'Secret', 'secret', { ph: '{{apiSecret}}', type: 'password' }),
      area(auth, changed, 'String to sign', 'stringToSign', { rows: 3 }),
      h('p.muted.small', 'Placeholders: {method} {url} {host} {path} {query} {pathAndQuery} {body} {bodySha256} {bodySha256Base64} {bodyMd5} {bodyMd5Base64} {timestamp} {timestampMs} {isoTimestamp} {httpDate} {nonce} {contentType}. Use \\n for new lines. {{variables}} work too.'),
      h('div.form-grid', field(auth, changed, 'Signature header', 'headerName', { ph: 'X-Signature' }), field(auth, changed, 'Header value', 'headerValue', { ph: 'HMAC {signature}' }),
        field(auth, changed, 'Also as query parameter (optional)', 'queryParam', { ph: 'signature' })),
      h('h4', 'Extra headers (same timestamp/nonce as the signature)'),
      kvEditor(auth.extraHeaders, changed, { keyPh: 'Header', valPh: '{timestamp}', bulk: false }),
      h('p.muted.small', 'The "Sent request" tab of the response shows the exact string that was signed, which helps when the server rejects the signature.'));
  }
  if (auth.type === 'awsv4') {
    return h('div',
      h('div.form-grid', field(auth, changed, 'Access key', 'accessKey', { ph: '{{awsAccessKey}}' }), field(auth, changed, 'Secret key', 'secretKey', { ph: '{{awsSecretKey}}', type: 'password' })),
      h('div.form-grid', field(auth, changed, 'Region', 'region', { ph: 'us-east-1' }), field(auth, changed, 'Service', 'service', { ph: 'execute-api, sns, s3…' }), field(auth, changed, 'Session token (optional)', 'sessionToken', { ph: '{{awsSessionToken}}' })),
      checkField('Unsigned payload (S3 streaming uploads)', auth.unsignedPayload, (v) => { auth.unsignedPayload = v; changed(); }));
  }
  return null;
}

function placement(auth, changed, rerender, what) {
  return h('div.form-grid',
    h('label.field', h('span', `Add ${what} to`), select([['header', 'Header'], ['query', 'Query parameter']], auth.addTo || 'header', (v) => { auth.addTo = v; changed(); rerender(); })),
    (auth.addTo || 'header') === 'header'
      ? [field(auth, changed, 'Header name', 'headerName', { ph: 'Authorization' }), field(auth, changed, 'Prefix', 'prefix', { ph: 'Bearer' })]
      : field(auth, changed, 'Query parameter', 'queryParam', { ph: what === 'token' ? 'token' : 'access_token' }));
}

function oauth2Fields(auth, changed, rerender, ctx) {
  auth.grantType ||= 'client_credentials';
  auth.clientAuth ||= 'basic';
  const g = auth.grantType;
  const tokenBox = h('div.token-box');
  const body = () => ({ auth, environmentId: activeEnvId(), collectionId: ctx.collectionId || null });
  const showToken = (t) => mount(tokenBox, t
    ? [h('div.row-gap', h('span.status-pill.sm.st-2', '✔ token'), h('span.small', t.expiresAt ? `expires ${fmtTime(new Date(t.expiresAt).toISOString())}` : 'no expiry given'), t.hasRefreshToken ? h('span.badge', 'refresh token') : null, h('span.muted.small', t.scope || '')),
      h('div.row-gap', h('code.token-preview', `${t.accessToken.slice(0, 24)}…${t.accessToken.slice(-8)}`), h('button.btn.btn-sm', { type: 'button', onclick: () => copyText(t.accessToken, 'Token copied') }, 'Copy'),
        h('button.btn.btn-sm', { type: 'button', onclick: async () => { await api.del(`/api/oauth2/tokens/${t.key}`); showToken(null); } }, 'Clear'))]
    : h('p.muted.small', 'No cached token yet. It is fetched automatically on the first request and shared by all requests (and load-test iterations) with the same settings.'));
  const getToken = async () => {
    try {
      if (g === 'authorization_code') {
        const { url, redirectUri } = await api.post('/api/oauth2/authorize', body());
        const w = window.open(url, 'apistorm-oauth', 'width=520,height=720');
        if (!w) { toast('Allow pop-ups for ApiStorm to sign in', 'warn'); return; }
        toast(`Sign in in the pop-up. Redirect URI: ${redirectUri}`, 'info', 6000);
        const off = on('oauth2-token', async () => { off(); const { token } = await api.post('/api/oauth2/token', { ...body(), peek: true }); showToken(token); toast('Signed in, token stored', 'ok'); });
        return;
      }
      const { token } = await api.post('/api/oauth2/token', { ...body(), force: true });
      showToken(token);
      toast('New access token received', 'ok');
    } catch (e) { toast(e.message, 'error', 7000); }
  };
  api.post('/api/oauth2/token', { ...body(), peek: true }).then((r) => showToken(r.token)).catch(() => showToken(null));
  return h('div',
    h('div.form-grid',
      h('label.field', h('span', 'Grant type'), select([['client_credentials', 'Client credentials'], ['password', 'Password'], ['authorization_code', 'Authorization code (+PKCE)']], g, (v) => { auth.grantType = v; changed(); rerender(); })),
      h('label.field', h('span', 'Client authentication'), select([['basic', 'Basic auth header'], ['body', 'In the request body']], auth.clientAuth, (v) => { auth.clientAuth = v; changed(); }))),
    g === 'authorization_code' ? field(auth, changed, 'Authorization URL', 'authUrl', { ph: 'https://auth.example.com/oauth2/authorize' }) : null,
    field(auth, changed, 'Token URL', 'tokenUrl', { ph: 'https://auth.example.com/oauth2/token' }),
    h('div.form-grid', field(auth, changed, 'Client ID', 'clientId', { ph: '{{clientId}}' }), field(auth, changed, 'Client secret', 'clientSecret', { ph: '{{clientSecret}}', type: 'password' })),
    g === 'password' ? h('div.form-grid', field(auth, changed, 'Username', 'username'), field(auth, changed, 'Password', 'password', { type: 'password' })) : null,
    h('div.form-grid', field(auth, changed, 'Scope', 'scope', { ph: 'sms.send sms.read' }), field(auth, changed, 'Audience (optional)', 'audience', { ph: 'https://api.example.com' })),
    g === 'authorization_code' ? [field(auth, changed, 'Redirect URI (optional)', 'redirectUri', { ph: `${location.origin}/oauth2/callback` }), h('p.muted.small', `Register ${location.origin}/oauth2/callback as a redirect URI with your identity provider.`)] : null,
    h('h4', 'Extra token request parameters'), kvEditor((auth.extraParams ||= []), changed, { keyPh: 'Parameter', valPh: 'Value', bulk: false }),
    placement(auth, changed, rerender, 'access token'),
    h('div.row-gap', h('button.btn.btn-primary.btn-sm', { type: 'button', onclick: getToken }, g === 'authorization_code' ? 'Sign in & get token' : 'Get new token')),
    tokenBox);
}

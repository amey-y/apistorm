import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCurl, splitCurls, toCurl } from '../server/converters/curl.js';
import { fromPostman, toPostman } from '../server/converters/postman.js';
import { fromOpenApi } from '../server/converters/openapi.js';
import { fromHar } from '../server/converters/har.js';
import { toK6 } from '../server/converters/k6.js';
import { generateCode } from '../server/converters/codegen.js';
import { prepareRequest, buildContext, newRequest } from '../server/prepare.js';
import { interpolate } from '../server/template.js';
import { runAssertions, runExtract } from '../server/assertions.js';

test('parses a bash cURL with headers, JSON body and query', () => {
  const r = parseCurl(`curl -X POST 'https://api.example.com/v1/users?page=2&q=a%20b' \\
    -H 'Content-Type: application/json' -H "Authorization: Bearer abc123" \\
    --data-raw '{"name":"Ann","tags":["x"]}' -k --compressed`);
  assert.equal(r.method, 'POST');
  assert.equal(r.url, 'https://api.example.com/v1/users');
  assert.deepEqual(r.params.map((p) => [p.key, p.value]), [['page', '2'], ['q', 'a b']]);
  assert.equal(r.auth.type, 'bearer');
  assert.equal(r.auth.token, 'abc123');
  assert.equal(r.body.mode, 'json');
  assert.deepEqual(JSON.parse(r.body.raw), { name: 'Ann', tags: ['x'] });
  assert.equal(r.settings.insecure, true);
});

test('parses Chrome "copy as cURL (cmd)" format', () => {
  const r = parseCurl('curl ^"https://example.com/api^?a=1^&b=2^" ^\n  -H ^"accept: application/json^" ^\n  --data-raw ^"^{^\\^"k^\\^":^\\^"v^\\^"^}^"');
  assert.equal(r.url, 'https://example.com/api');
  assert.equal(r.params.length, 2);
  assert.equal(r.body.mode, 'json');
  assert.deepEqual(JSON.parse(r.body.raw), { k: 'v' });
});

test('parses form data, basic auth, -G and combined short flags', () => {
  const r = parseCurl("curl -sSL -u bob:s3cret -d 'a=1' -d 'b=two words' https://x.io/form");
  assert.equal(r.method, 'POST');
  assert.equal(r.auth.type, 'basic');
  assert.equal(r.auth.password, 's3cret');
  assert.equal(r.body.mode, 'urlencoded');
  assert.deepEqual(r.body.form.map((f) => f.value), ['1', 'two words']);
  const g = parseCurl("curl -G https://x.io/s -d q=test");
  assert.equal(g.method, 'GET');
  assert.equal(g.params[0].value, 'test');
  const f = parseCurl("curl https://x.io/up -F name=joe -F file=@/tmp/a.png");
  assert.equal(f.body.mode, 'formdata');
  assert.equal(f.body.form[1].type, 'file');
});

test('splits multiple cURL commands', () => {
  const parts = splitCurls("curl https://a.com/1\n\ncurl -X POST https://a.com/2 \\\n  -d 'x=1'\ncurl https://a.com/3");
  assert.equal(parts.length, 3);
  assert.ok(parts[1].includes("x=1"));
});

test('cURL round trip keeps method, headers and body', () => {
  const req = newRequest({ method: 'PUT', url: 'https://h.io/x', headers: [{ key: 'X-A', value: "it's", enabled: true }], body: { mode: 'json', raw: '{"a":1}', form: [] }, auth: { type: 'none' } });
  const curl = toCurl(prepareRequest(req, buildContext({})));
  const back = parseCurl(curl);
  assert.equal(back.method, 'PUT');
  assert.equal(back.headers.find((h) => h.key === 'X-A').value, "it's");
  assert.deepEqual(JSON.parse(back.body.raw), { a: 1 });
});

test('interpolates variables with precedence and dynamic values', () => {
  const ctx = { layers: [{ a: 'runtime' }, { a: 'data', b: 'data-b' }, { c: '{{b}}-nested' }] };
  assert.equal(interpolate('{{a}} {{b}} {{c}} {{missing}}', ctx), 'runtime data-b data-b-nested {{missing}}');
  const v = interpolate('{{$randomInt(5,5)}}|{{$uuid}}', {});
  assert.match(v, /^5\|[0-9a-f-]{36}$/);
  const c2 = { callbackBase: 'http://cb' };
  const url = interpolate('{{$callbackUrl(pay)}}', c2);
  assert.equal(url, `http://cb/cb/pay/${c2.requestId}`);
  assert.equal(interpolate('{{$requestId}}', c2), c2.requestId);
});

test('Postman v2.1 import/export round trip', () => {
  const pm = {
    info: { name: 'Shop', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    variable: [{ key: 'base', value: 'https://shop.io' }],
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{tok}}' }] },
    item: [{
      name: 'Orders',
      item: [{
        name: 'Create order',
        event: [{ listen: 'test', script: { exec: ['pm.test("ok", () => pm.response.to.have.status(201));', 'pm.environment.set("orderId", pm.response.json().data.id);'] } }],
        request: { method: 'POST', header: [{ key: 'X-K', value: '1' }], url: { raw: '{{base}}/orders?x=1', query: [{ key: 'x', value: '1' }] }, body: { mode: 'raw', raw: '{"a":1}', options: { raw: { language: 'json' } } } },
      }],
    }],
  };
  const col = fromPostman(pm);
  assert.equal(col.requests.length, 1);
  const r = col.requests[0];
  assert.equal(r.folder, 'Orders');
  assert.equal(r.url, '{{base}}/orders');
  assert.equal(r.params[0].key, 'x');
  assert.equal(r.body.mode, 'json');
  assert.equal(r.auth.type, 'inherit');
  assert.equal(col.auth.type, 'bearer');
  assert.match(r.scripts.post, /to\.have\.status\(201\)/);
  assert.match(r.scripts.post, /pm\.environment\.set\("orderId"/);
  assert.equal(r.assertions.length, 0);
  const out = toPostman(col);
  assert.equal(out.item[0].name, 'Orders');
  assert.equal(out.item[0].item[0].request.url.raw, '{{base}}/orders?x=1');
  assert.equal(fromPostman(out).requests[0].body.raw, '{"a":1}');
});

test('OpenAPI 3 import builds requests with sample bodies', () => {
  const spec = {
    openapi: '3.0.0', info: { title: 'Pets' }, servers: [{ url: 'https://pets.io/v1' }],
    components: { securitySchemes: { b: { type: 'http', scheme: 'bearer' } }, schemas: { Pet: { type: 'object', properties: { name: { type: 'string', example: 'Rex' }, age: { type: 'integer' } } } } },
    paths: {
      '/pets/{petId}': { get: { summary: 'Get pet', tags: ['pets'], parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'integer', example: 7 } }, { name: 'full', in: 'query', schema: { type: 'boolean' } }], responses: { 200: {} } } },
      '/pets': { post: { operationId: 'addPet', requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } }, responses: { 201: {} } } },
    },
  };
  const col = fromOpenApi(spec);
  assert.equal(col.requests.length, 2);
  const get = col.requests.find((r) => r.method === 'GET');
  assert.equal(get.url, '{{baseUrl}}/pets/{{petId}}');
  assert.equal(get.folder, 'pets');
  assert.ok(col.variables.some((v) => v.key === 'petId' && v.value === '7'));
  const post = col.requests.find((r) => r.method === 'POST');
  assert.deepEqual(JSON.parse(post.body.raw), { name: 'Rex', age: 0 });
  assert.equal(post.assertions[0].value, '201');
  assert.equal(col.auth.type, 'bearer');
});

test('HAR import', () => {
  const col = fromHar({ log: { entries: [{ request: { method: 'POST', url: 'https://a.io/x?y=1', headers: [{ name: ':authority', value: 'a.io' }, { name: 'X-T', value: '1' }], queryString: [{ name: 'y', value: '1' }], postData: { mimeType: 'application/json', text: '{"q":1}' } } }] } });
  const r = col.requests[0];
  assert.equal(r.url, 'https://a.io/x');
  assert.equal(r.headers.length, 1);
  assert.equal(r.body.mode, 'json');
});

test('k6 export produces a script with scenario, checks and variables', () => {
  const req = newRequest({ name: 'Login', method: 'POST', url: '{{base}}/login', body: { mode: 'json', raw: '{"id":"{{$uuid}}"}', form: [] }, assertions: [{ type: 'status', op: 'eq', value: '2xx' }], extract: [{ var: 'token', from: 'json', path: '$.token' }] });
  const s = toK6({ requests: [req], environment: { variables: [{ key: 'base', value: 'https://x.io' }] }, config: { mode: 'rate', tps: 20, durationSec: 30, rampUpSec: 10, thresholds: [{ metric: 'p95', op: '<', value: 300 }] } });
  assert.match(s, /ramping-arrival-rate/);
  assert.match(s, /"p\(95\)<300"/);
  assert.match(s, /\$\{v\["base"\] \?\? ''\}\/login/);
  assert.match(s, /dyn\("uuid"\)/);
  assert.match(s, /v\["token"\]/);
  // the generated script must be valid JavaScript (imports/exports stripped for the syntax check)
  const body = s.replace(/^import .*$/gm, '').replace('export const options', 'const options').replace('export default function', 'function main');
  assert.doesNotThrow(() => new Function(body));
});

test('code generators produce output for every language', () => {
  const prep = prepareRequest(newRequest({ method: 'POST', url: 'https://x.io/a', headers: [{ key: 'A', value: 'b' }], body: { mode: 'json', raw: '{"a":1}', form: [] }, auth: { type: 'basic', username: 'u', password: 'p' } }), buildContext({}));
  for (const lang of ['curl-bash', 'curl-cmd', 'fetch', 'python', 'powershell', 'httpie']) {
    const code = generateCode(lang, prep, {});
    assert.ok(code.length > 20, lang);
    assert.ok(code.includes('https://x.io/a'), lang);
  }
});

test('assertions and extraction', () => {
  const res = { status: 201, headers: { 'x-id': 'abc' }, timings: { total: 120 } };
  const body = '{"data":{"items":[{"id":5}],"token":"t0k"}}';
  const out = runAssertions([
    { type: 'status', value: '2xx' }, { type: 'status', op: 'eq', value: '200,201' }, { type: 'responseTime', op: 'lt', value: '100' },
    { type: 'jsonPath', path: '$.data.items[0].id', op: 'eq', value: '5' }, { type: 'jsonPath', path: '$.data.items.length', op: 'gte', value: '1' },
    { type: 'header', path: 'X-Id', op: 'exists' }, { type: 'bodyContains', value: 't0k' },
  ], res, body);
  assert.deepEqual(out.map((x) => x.pass), [true, true, false, true, true, true, true]);
  assert.deepEqual(runExtract([{ var: 't', from: 'json', path: 'data.token' }, { var: 'h', from: 'header', path: 'x-id' }, { var: 'r', from: 'regex', path: '"id":(\\d+)' }], res, body), { t: 't0k', h: 'abc', r: '5' });
});

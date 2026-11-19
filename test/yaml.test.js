import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml, toYaml, looksLikeYaml } from '../server/yaml.js';

const PETSTORE = `openapi: "3.0.0"
info:
  version: 1.0.0
  title: Swagger Petstore   # trailing comment
  description: >
    A sample API that uses a petstore
    as an example.

    Second paragraph.
  license:
    name: MIT
servers:
  - url: http://petstore.swagger.io/v1
    variables: {}
tags: [pets, store]
paths:
  /pets:
    get:
      summary: List all pets
      operationId: listPets
      tags:
      - pets
      parameters:
        - name: limit
          in: query
          description: 'How many items to return at one time (max 100)'
          required: false
          schema:
            type: integer
            format: int32
            maximum: 100
      responses:
        '200':
          description: A paged array of pets
          headers:
            x-next:
              description: "A link to the next page\\nof responses"
              schema:
                type: string
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Pets"
        default:
          description: unexpected error
    post:
      summary: Create a pet
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/Pet'
            example: {name: "Rex", tag: dog, ids: [1, 2, 3]}
      responses:
        201:
          description: Null response
  /pets/{petId}:
    get:
      parameters:
        - name: petId
          in: path
          required: true
          schema: &idSchema
            type: string
            example: abc-1
components:
  schemas:
    Base: &base
      type: object
      required:
        - id
    Pet:
      <<: *base
      properties:
        id:
          type: integer
        name:
          type: string
        notes:
          type: string
          example: |
            line one
              indented
            line three
    Pets:
      type: array
      items:
        $ref: "#/components/schemas/Pet"
`;

test('parses an OpenAPI YAML document', () => {
  const d = parseYaml(PETSTORE);
  assert.equal(d.openapi, '3.0.0');
  assert.equal(d.info.version, '1.0.0');
  assert.equal(d.info.title, 'Swagger Petstore');
  assert.equal(d.info.description, 'A sample API that uses a petstore as an example.\nSecond paragraph.\n');
  assert.deepEqual(d.servers, [{ url: 'http://petstore.swagger.io/v1', variables: {} }]);
  assert.deepEqual(d.tags, ['pets', 'store']);
  const get = d.paths['/pets'].get;
  assert.deepEqual(get.tags, ['pets']);
  assert.equal(get.parameters[0].schema.maximum, 100);
  assert.equal(get.parameters[0].required, false);
  assert.equal(get.parameters[0].description, 'How many items to return at one time (max 100)');
  assert.equal(get.responses['200'].headers['x-next'].description, 'A link to the next page\nof responses');
  assert.equal(get.responses['200'].content['application/json'].schema.$ref, '#/components/schemas/Pets');
  assert.deepEqual(d.paths['/pets'].post.requestBody.content['application/json'].example, { name: 'Rex', tag: 'dog', ids: [1, 2, 3] });
  assert.ok('201' in d.paths['/pets'].post.responses);
  assert.equal(d.paths['/pets/{petId}'].get.parameters[0].schema.example, 'abc-1');
  assert.equal(d.components.schemas.Pet.type, 'object');
  assert.deepEqual(d.components.schemas.Pet.required, ['id']);
  assert.equal(d.components.schemas.Pet.properties.notes.example, 'line one\n  indented\nline three\n');
});

test('scalars, chomping, nested sequences, multi-line flow and quotes', () => {
  const d = parseYaml(`
a: ~
b: yes
c: 0x1F
d: -1.5e3
e: "quoted: # not a comment"
f: 'it''s'
g: |-
  keep
  lines
h: >+
  folded

i:
  - - x
    - y
  - [1, {k: v}]
  - key: 1
    other: 2
j: [a,
    b, c]
k: plain text
  continued here
url: http://example.com:8080/x#frag
empty:
list_same_indent:
- one
- two
`);
  assert.equal(d.a, null);
  assert.equal(d.b, 'yes'); // YAML 1.2: yes is a string
  assert.equal(d.c, 31);
  assert.equal(d.d, -1500);
  assert.equal(d.e, 'quoted: # not a comment');
  assert.equal(d.f, "it's");
  assert.equal(d.g, 'keep\nlines');
  assert.equal(d.h, 'folded\n\n');
  assert.deepEqual(d.i, [['x', 'y'], [1, { k: 'v' }], { key: 1, other: 2 }]);
  assert.deepEqual(d.j, ['a', 'b', 'c']);
  assert.equal(d.k, 'plain text continued here');
  assert.equal(d.url, 'http://example.com:8080/x#frag');
  assert.equal(d.empty, null);
  assert.deepEqual(d.list_same_indent, ['one', 'two']);
});

test('reports errors with line numbers', () => {
  assert.throws(() => parseYaml('a: 1\nb: [1, 2\nc: 3'), /line/);
  assert.throws(() => parseYaml('a:\n  - x\n  b: 1'), /line/);
  assert.throws(() => parseYaml('a: *missing'), /unknown alias/);
});

test('toYaml output parses back to the same value', () => {
  const v = { openapi: '3.0.3', info: { title: 'T: x', version: '1.0' }, paths: { '/a/{id}': { get: { tags: ['x'], responses: { 200: { description: 'ok\nmulti' } } } } }, list: [{ a: 1, b: [true, null] }, 'str', '123'], empty: {}, e2: [] };
  const back = parseYaml(toYaml(v));
  assert.deepEqual(back, JSON.parse(JSON.stringify(v)));
});

test('detects YAML text', () => {
  assert.ok(looksLikeYaml('openapi: 3.0.0\ninfo:\n  title: x'));
  assert.ok(!looksLikeYaml('{"a":1}'));
  assert.ok(!looksLikeYaml('curl https://x'));
});

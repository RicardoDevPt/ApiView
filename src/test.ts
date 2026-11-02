// Self-check: `npm test`, or `node out/test.js <spec.yaml>` to also smoke-test a real spec.
import * as assert from 'assert';
import * as fs from 'fs';
import { parse } from 'yaml';
import { defaultBroker, listChannels, renderAsyncSpec, topicFilter } from './asyncapi';
import { topicMatches } from './mqtt';
import { listOperations, renderPage, renderSpec } from './render';
import { buildRequest, exampleOf, renderTryIt } from './tryit';

const spec = {
    openapi: '3.1.0',
    info: { title: 'Test <API>', version: '1.0' },
    paths: {
        '/nodes/{id}': {
            parameters: [{ $ref: '#/components/parameters/Id' }],
            get: {
                tags: ['Nodes'],
                summary: 'Get node',
                responses: {
                    '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } },
                    '404': { $ref: '#/components/responses/NotFound' },
                },
            },
            put: {
                tags: ['Nodes'],
                requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } },
                responses: { '204': { description: 'updated' } },
            },
        },
    },
    components: {
        parameters: { Id: { name: 'id', in: 'path', required: true, schema: { type: 'string' } } },
        responses: { NotFound: { description: 'missing thing' } },
        schemas: {
            Node: {
                type: 'object',
                required: ['name'],
                properties: {
                    name: { type: 'string', enum: ['a', 'b'] },
                    children: { type: 'array', items: { $ref: '#/components/schemas/Node' } },
                },
            },
        },
    },
};

const { html, count } = renderSpec(spec);
assert.strictEqual(count, 2);
assert.ok(html.includes('Test &lt;API&gt;'), 'title escaped');
assert.ok(html.includes('/nodes/{id}'));
assert.ok(html.includes('>id<'), 'path-level $ref param rendered');
assert.ok(html.includes('missing thing'), 'response $ref resolved');
assert.ok(html.includes('>name<') && html.includes('enum: &quot;a&quot;, &quot;b&quot;'), 'schema fields rendered');
assert.ok(html.includes('↻ Node'), 'recursive schema cut off');
assert.ok(!html.includes('$ref'), 'no raw $ref leaks');
for (const name of ['Parameters', 'Request body', 'Responses']) {
    assert.ok(html.includes(`<details class="part" data-id="get /nodes/{id}|${name}">`) || html.includes(`<details class="part" data-id="put /nodes/{id}|${name}">`), `${name} collapsible`);
}
assert.ok(!/<details class="part"[^>]*open/.test(html), 'sections collapsed by default');
assert.deepStrictEqual(
    listOperations(spec).map((o) => `${o.tag} ${o.method} ${o.path} ${o.pathParams.length}`),
    ['Nodes get /nodes/{id} 1', 'Nodes put /nodes/{id} 1'],
);
// Try it: defaults, dropdowns, limits, and request assembly.
const body = {
    type: 'object',
    required: ['mode', 'count'],
    properties: {
        mode: { type: 'string', enum: ['fast', 'slow'], default: 'slow' },
        count: { type: 'integer', minimum: 1, maximum: 10 },
        ratio: { type: 'number', exclusiveMinimum: 0 },
        inner: { type: 'object', properties: { on: { type: 'boolean' } } },
        tags: { type: 'array', items: { type: 'string' } },
    },
};
assert.deepStrictEqual(exampleOf(body, {}), { mode: 'slow', count: 1, ratio: 0.1, inner: { on: false }, tags: [''] });
assert.deepStrictEqual(exampleOf({ $ref: '#/components/schemas/Node' }, spec), { name: 'a', children: [null] }, 'recursive example terminates');
const form = renderTryIt('post /x/{id}', 'post', '/x/{id}', [{ name: 'id', in: 'path', schema: { type: 'string' } }], { required: true, content: { 'application/json': { schema: body } } }, {}, 'http://h:1/api');
assert.ok(/<select data-kind="enum"[^>]*required>/.test(form) && form.includes('<option value="&quot;slow&quot;" selected>slow</option>'), 'enum dropdown with default');
assert.ok(form.includes('min="1" max="10"') && form.includes('step="1"'), 'integer limits');
assert.ok(form.includes('data-xmin="0"'), 'exclusive limit');
assert.ok(form.includes('value="http://h:1/api"'), 'base prefilled');
assert.ok(html.indexOf('|Try it') < html.indexOf('|Parameters'), 'Try it before Parameters');
const f = (inn: string, path: string[], kind: string, value: string, required = false) => ({ in: inn, path, kind, value, required });
assert.deepStrictEqual(
    buildRequest('http://h:1/api/', 'post', '/x/{id}', [
        f('path', ['id'], 'string', 'a b', true),
        f('query', ['n'], 'json', '[1,2]'),
        f('query', ['skip'], 'string', ''),
        f('body', ['mode'], 'enum', '"fast"', true),
        f('body', ['inner', 'on'], 'enum', 'true'),
        f('body', ['ratio'], 'number', ''),
    ]),
    { method: 'POST', url: 'http://h:1/api/x/a%20b?n=1&n=2', headers: { 'Content-Type': 'application/json' }, body: '{"mode":"fast","inner":{"on":true}}' },
);
assert.strictEqual(buildRequest('http://h', 'get', '/y', []).body, undefined, 'no body when nothing set');
assert.ok(renderPage({ foo: 1 }, 'n').includes('Not an OpenAPI/AsyncAPI document'));
assert.ok(renderPage(spec, 'n').includes('<button id="star" title="Add to favorites">☆</button>'), 'unstarred by default');
assert.ok(renderPage(spec, 'n', '', true).includes('<button id="star" class="on" title="Remove from favorites">★</button>'), 'starred');

// AsyncAPI: channels listed by topic, messages' payload schemas resolved, Subscribe form instead of Send.
const asyncV3 = {
    asyncapi: '3.0.0',
    info: { title: 'Events', version: '1' },
    servers: { mqtt: { host: 'broker:1883', protocol: 'mqtt' } },
    channels: {
        Devices: { address: '/app/devices/{id}', description: 'device events', messages: { Opened: { $ref: '#/components/messages/Opened' } } },
        Plain: { messages: {} },
    },
    components: { messages: { Opened: { payload: { type: 'object', properties: { value: { type: 'integer' } } } } } },
};
assert.deepStrictEqual(listChannels(asyncV3).map((c) => `${c.key} ${c.path}`), ['Devices /app/devices/{id}', 'Plain Plain']);
const ahtml = renderAsyncSpec(asyncV3, 'mqtt://broker:1883').html;
assert.ok(ahtml.includes('<form class="mqtt" data-id="mqtt /app/devices/{id}">') && ahtml.includes('value="/app/devices/+"'), 'subscribe form with wildcard topic');
assert.ok(ahtml.includes('>value<') && !ahtml.includes('$ref'), 'message payload resolved');
assert.ok(renderPage(asyncV3, 'n').includes('form class="mqtt"'), 'renderPage dispatches AsyncAPI');
assert.strictEqual(defaultBroker(asyncV3), 'mqtt://broker:1883');
assert.strictEqual(topicFilter('/a/{x}/b/{y}'), '/a/+/b/+');
const asyncV2 = { asyncapi: '2.6.0', channels: { 'a/b': { subscribe: { message: { oneOf: [{ name: 'X', payload: { type: 'string' } }, { name: 'Y' }] } } } } };
assert.deepStrictEqual(listChannels(asyncV2).map((c) => c.path), ['a/b']);
assert.ok(renderAsyncSpec(asyncV2).html.includes('|msg:X') && renderAsyncSpec(asyncV2).html.includes('|msg:Y'), 'v2 oneOf messages');
for (const [filter, topic, ok] of [
    ['/app/x', '/app/x', true],
    ['/app/+', '/app/x', true],
    ['/app/+', '/app/x/y', false],
    ['/app/#', '/app/x/y', true],
    ['#', 'a', true],
    ['/app/x', '/app/y', false],
    ['a/b/c', 'a/b', false],
] as const) assert.strictEqual(topicMatches(filter, topic), ok, `${filter} ~ ${topic}`);

const file = process.argv[2];
if (file) {
    const real = parse(fs.readFileSync(file, 'utf8'));
    if (real.asyncapi) {
        const out = renderAsyncSpec(real);
        assert.strictEqual(out.count, Object.keys(real.channels ?? {}).length);
        assert.ok(!out.html.includes('class="err">unresolved'), 'all refs resolved');
        console.log(`${file}: ${out.count} channels, ${out.html.length} bytes`);
        console.log('ok');
        process.exit(0);
    }
    const expected = Object.values<any>(real.paths ?? {}).reduce(
        (n, item) => n + Object.keys(item).filter((k) => ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'].includes(k)).length,
        0,
    );
    const out = renderSpec(real);
    assert.strictEqual(out.count, expected);
    assert.ok(!out.html.includes('class="err">unresolved'), 'all refs resolved');
    console.log(`${file}: ${out.count} endpoints, ${out.html.length} bytes`);
}
console.log('ok');

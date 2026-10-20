#!/usr/bin/env node
/*
 * FirePHP Console MV3 — tests/protocol.test.js
 * Tests del parser con cabeceras reales generadas por firephp-core 0.5, Monolog 3
 * (FirePHPHandler) y ChromePhp 4.1, más casos sintéticos.
 *
 * Uso:  node tests/protocol.test.js
 *
 * Versión: 1.0.0
 *
 * Historial de versiones:
 *   1.0.0 (2026-10-19) Versión inicial.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const P = require('../src/lib/protocol.js');

let passed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log('  ✔ ' + name);
    } catch (err) {
        console.log('  ✘ ' + name + '\n    ' + err.message);
        process.exitCode = 1;
    }
}

function loadFixture(name) {
    return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')
        .split(/\r?\n/)
        .filter(function (l) { return l.indexOf(': ') > 0; })
        .map(function (l) {
            const i = l.indexOf(': ');
            return { name: l.slice(0, i), value: l.slice(i + 2) };
        });
}

console.log('firephp-core 0.5');
const core = P.parseResponseHeaders(loadFixture('core.headers'));
test('sin avisos', function () { assert.deepStrictEqual(core.warnings, []); });
test('12 mensajes en orden', function () {
    assert.deepStrictEqual(core.messages.map(function (m) { return m.kind; }), [
        'log', 'log', 'log', 'log', 'group-start', 'log', 'group-end', 'table', 'trace', 'dump', 'exception', 'log'
    ]);
});
test('niveles', function () {
    assert.deepStrictEqual(core.messages.slice(0, 4).map(function (m) { return m.level; }), ['log', 'info', 'warn', 'error']);
});
test('unicode escapado', function () { assert.strictEqual(core.messages[2].values[0].v, 'Cuidado ñandú €'); });
test('grupo plegado', function () { assert.strictEqual(core.messages[4].collapsed, true); assert.strictEqual(core.messages[4].label, 'Grupo 1'); });
test('objeto PHP con visibilidad, static y recursión', function () {
    const o = core.messages[5].values[0];
    assert.strictEqual(o.t, 'obj');
    assert.strictEqual(o.cls, 'Foo');
    const byKey = {};
    o.entries.forEach(function (e) { byKey[e.k] = e; });
    assert.strictEqual(byKey.b.vis, 'protected');
    assert.strictEqual(byKey.c.vis, 'private');
    assert.strictEqual(byKey.s.st, true);
    assert.strictEqual(byKey.self.v.t, 'note');
});
test('tabla con cabecera', function () {
    const t = core.messages[7];
    assert.strictEqual(t.label, 'Tabla');
    assert.deepStrictEqual(t.table.header, ['Col1', 'Col2']);
    assert.strictEqual(t.table.rows.length, 2);
});
test('traza', function () { assert.strictEqual(core.messages[8].trace.frames[0].fn, 'trace'); });
test('dump', function () { assert.strictEqual(core.messages[9].label, 'miDump'); });
test('excepción', function () {
    assert.strictEqual(core.messages[10].trace.cls, 'RuntimeException');
    assert.strictEqual(core.messages[10].trace.message, 'Boom');
    assert.strictEqual(core.messages[10].level, 'error');
});
test('mensaje multiparte de 18 KB', function () {
    assert.strictEqual(core.messages[11].values[0].v.length, 18000);
});

console.log('Monolog FirePHPHandler');
const mono = P.parseResponseHeaders(loadFixture('monolog.headers'));
test('3 mensajes con canal como etiqueta', function () {
    assert.strictEqual(mono.messages.length, 3);
    assert.strictEqual(mono.messages[0].label, 'app');
    assert.deepStrictEqual(mono.messages.map(function (m) { return m.level; }), ['log', 'warn', 'error']);
});

console.log('ChromeLogger (ChromePhp 4.1)');
const cl = P.parseResponseHeaders(loadFixture('chromephp.headers'));
test('mensajes y backtrace', function () {
    assert.deepStrictEqual(cl.warnings, []);
    assert.strictEqual(cl.messages[0].label, 'hola');
    assert.strictEqual(cl.messages[0].line, 3);
    assert.strictEqual(cl.messages[1].level, 'warn');
});
test('tabla de objetos', function () {
    const t = cl.messages.find(function (m) { return m.kind === 'table'; });
    assert.deepStrictEqual(t.table.header, ['a', 'b']);
    assert.strictEqual(t.table.rows[1][0].v, 3);
});
test('desactivable', function () {
    assert.strictEqual(P.parseResponseHeaders(loadFixture('chromephp.headers'), { chromeLogger: false }).messages.length, 0);
});

console.log('Casos sintéticos');
test('partes desordenadas y nombres en minúsculas (HTTP/2)', function () {
    const body = JSON.stringify([{ Type: 'LOG' }, 'abcdefghij']);
    const a = body.slice(0, 10), b = body.slice(10, 20), c = body.slice(20);
    const r = P.parseResponseHeaders([
        { name: 'x-wf-1-1-1-3', value: '|' + c + '|' },
        { name: 'x-wf-1-1-1-1', value: body.length + '|' + a + '|\\' },
        { name: 'x-wf-protocol-1', value: P.PROTO_JSONSTREAM },
        { name: 'x-wf-1-1-1-2', value: '|' + b + '|\\' },
        { name: 'x-wf-1-structure-1', value: 'http://meta.firephp.org/Wildfire/Structure/FirePHP/FirebugConsole/0.1' }
    ]);
    assert.deepStrictEqual(r.warnings, []);
    assert.strictEqual(r.messages[0].values[0].v, 'abcdefghij');
});
test('UTF-8 sin escapar recibido como Latin-1', function () {
    const json = JSON.stringify([{ Type: 'INFO' }, 'Cádiz']);
    const latin1 = unescape(encodeURIComponent(json));
    const r = P.parseResponseHeaders({
        'X-Wf-Protocol-1': P.PROTO_JSONSTREAM,
        'X-Wf-1-Structure-1': 'http://meta.firephp.org/Wildfire/Structure/FirePHP/FirebugConsole/0.1',
        'X-Wf-1-1-1-1': latin1.length + '|' + latin1 + '|'
    });
    assert.deepStrictEqual(r.warnings, []);
    assert.strictEqual(r.messages[0].values[0].v, 'Cádiz');
});
test('protocolo Insight (component 0.1.0)', function () {
    const meta = JSON.stringify({ priority: 'warn', label: 'Insight', file: '/a.php', line: 3 });
    const data = JSON.stringify({
        origin: { type: 'reference', value: 0 },
        instances: [{ type: 'dictionary', meta: { 'lang.class': 'Bar' }, value: { x: { type: 'string', value: '5', meta: { 'lang.type': 'integer' }, 'lang.visibility': 'private' } } }]
    });
    const payload = meta.replace(/\|/g, '\\|') + '|' + data;
    const r = P.parseResponseHeaders({
        'X-Wf-Protocol-1': P.PROTO_COMPONENT,
        'X-Wf-1-1-Receiver': 'http://registry.pinf.org/cadorn.org/insight/@meta/receiver/console/page/0',
        'X-Wf-1-1-1-Sender': 'http://example/sender',
        'X-Wf-1-1-1-1': payload.length + '|' + payload + '|',
        'X-Wf-1-Index': '1'
    });
    assert.deepStrictEqual(r.warnings, []);
    const m = r.messages[0];
    assert.strictEqual(m.level, 'warn');
    assert.strictEqual(m.values[0].cls, 'Bar');
    assert.strictEqual(m.values[0].entries[0].vis, 'private');
    assert.strictEqual(m.values[0].entries[0].v.v, 5);
});
test('sin cabeceras → vacío', function () {
    const r = P.parseResponseHeaders([{ name: 'Content-Type', value: 'text/html' }]);
    assert.strictEqual(r.messages.length, 0);
});
test('JSON roto no rompe el resto', function () {
    const ok = JSON.stringify([{ Type: 'LOG' }, 'ok']);
    const r = P.parseResponseHeaders({
        'X-Wf-Protocol-1': P.PROTO_JSONSTREAM,
        'X-Wf-1-1-1-1': '5|{bad}|',
        'X-Wf-1-1-1-2': ok.length + '|' + ok + '|'
    });
    assert.strictEqual(r.messages.length, 2);
    assert.strictEqual(r.messages[1].values[0].v, 'ok');
});

console.log('\n' + passed + ' tests OK' + (process.exitCode ? ' (con fallos)' : ''));

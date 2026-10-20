/*
 * FirePHP Console MV3 — protocol.js
 * Parser de los protocolos de logging servidor → navegador:
 *   - Wildfire JsonStream 0.2  (FirePHPCore 0.x, firephp/firephp-core, Monolog FirePHPHandler)
 *   - Wildfire "component" 0.1.0 (FirePHP 1.0 / Insight)
 *   - ChromeLogger (X-ChromeLogger-Data / X-ChromePhp-Data)
 *
 * Módulo puro (sin APIs de navegador): se usa en la página DevTools y en los tests de Node.
 *
 * Versión: 1.0.0
 *
 * Historial de versiones:
 *   1.0.0 (2026-10-19) Versión inicial. Reescritura del parser de wildfire-for-js:
 *                      - JsonStream 0.2 con mensajes multiparte, consola (LOG/INFO/WARN/ERROR,
 *                        GROUP_START/END, TABLE, TRACE, EXCEPTION) y estructura Dump.
 *                      - Protocolo component 0.1.0 (Insight) con decodificación del grafo.
 *                      - ChromeLogger con columnas log/backtrace/type.
 *                      - Corrección de cabeceras UTF-8 recibidas como Latin-1.
 *                      - Tolerancia a discrepancias de longitud (bytes PHP vs. caracteres JS).
 *
 * Licencia: OSL-3.0 (derivado de firephp-for-browser-devtools, © Christoph Dorn).
 */
(function (root) {
    'use strict';

    const PROTO_JSONSTREAM = 'http://meta.wildfirehq.org/Protocol/JsonStream/0.2';
    const PROTO_COMPONENT = 'http://registry.pinf.org/cadorn.org/wildfire/@meta/protocol/component/0.1.0';
    const STRUCT_DUMP = 'http://meta.firephp.org/Wildfire/Structure/FirePHP/Dump/0.1';

    // ------------------------------------------------------------------
    // Utilidades
    // ------------------------------------------------------------------

    /** Cabeceras UTF-8 que Chrome entrega interpretadas como Latin-1. */
    function fixEncoding(s) {
        if (typeof s !== 'string') return s;
        if (/[\u0080-ÿ]/.test(s) && !/[Ā-￿]/.test(s)) {
            try { return decodeURIComponent(escape(s)); } catch (e) { /* no era UTF-8 */ }
        }
        return s;
    }

    function utf8Length(s) {
        try { return unescape(encodeURIComponent(s)).length; } catch (e) { return s.length; }
    }

    function lengthMatches(expected, text) {
        expected = parseInt(expected, 10);
        return expected === text.length || expected === utf8Length(text);
    }

    function normHeaders(headers) {
        // Acepta [{name, value}] o {name: value}
        if (!Array.isArray(headers)) {
            headers = Object.keys(headers || {}).map(function (k) { return { name: k, value: headers[k] }; });
        }
        return headers.map(function (h) {
            return { name: String(h.name).toLowerCase(), value: fixEncoding(String(h.value)) };
        });
    }

    function levelFrom(type) {
        switch (String(type || '').toLowerCase()) {
            case 'info': return 'info';
            case 'warn': case 'warning': return 'warn';
            case 'error': case 'exception': case 'assert': return 'error';
            case 'debug': return 'debug';
            default: return 'log';
        }
    }

    // ------------------------------------------------------------------
    // Modelo de valores normalizado (lo que pinta el panel)
    //   {t:'null'} {t:'bool',v} {t:'num',v} {t:'str',v} {t:'note',v} {t:'res',v}
    //   {t:'arr', items:[V]}
    //   {t:'map', entries:[{k, v:V}]}
    //   {t:'obj', cls, entries:[{k, v:V, vis, st, und}]}
    // ------------------------------------------------------------------

    const NOTE_RE = /^\*\* (Recursion|Max .*Depth|Object Depth|Excluded).*\*\*$/i;
    const RES_RE = /^\*\* (Resource id #\d+.*)\*\*$/i;

    /** Valores codificados por FirePHPCore (claves "public:x", "__className"). */
    function fromFirePHP(x) {
        if (x === null || x === undefined) return { t: 'null' };
        if (typeof x === 'boolean') return { t: 'bool', v: x };
        if (typeof x === 'number') return { t: 'num', v: x };
        if (typeof x === 'string') {
            let m;
            if (NOTE_RE.test(x)) return { t: 'note', v: x.replace(/^\*\*\s*|\s*\*\*$/g, '') };
            if ((m = RES_RE.exec(x))) return { t: 'res', v: m[1].trim() };
            return { t: 'str', v: x };
        }
        if (Array.isArray(x)) return { t: 'arr', items: x.map(fromFirePHP) };
        if (typeof x === 'object') {
            if (typeof x.__className === 'string') {
                const entries = [];
                Object.keys(x).forEach(function (key) {
                    if (key === '__className') return;
                    const parts = key.split(':');
                    const name = parts[parts.length - 1];
                    const mods = parts.slice(0, -1);
                    entries.push({
                        k: name,
                        v: fromFirePHP(x[key]),
                        vis: mods.find(function (p) { return p === 'public' || p === 'protected' || p === 'private'; }) || (mods.indexOf('undeclared') >= 0 ? 'public' : null),
                        st: mods.indexOf('static') >= 0,
                        und: mods.indexOf('undeclared') >= 0
                    });
                });
                return { t: 'obj', cls: x.__className, entries: entries };
            }
            return {
                t: 'map',
                entries: Object.keys(x).map(function (k) { return { k: k, v: fromFirePHP(x[k]) }; })
            };
        }
        return { t: 'str', v: String(x) };
    }

    /** Valores codificados por ChromePhp ("___class_name", claves "public x"). */
    function fromChromeLogger(x) {
        if (x === null || x === undefined) return { t: 'null' };
        if (typeof x === 'boolean') return { t: 'bool', v: x };
        if (typeof x === 'number') return { t: 'num', v: x };
        if (typeof x === 'string') {
            if (/^recursion - parent object/i.test(x)) return { t: 'note', v: x };
            return { t: 'str', v: x };
        }
        if (Array.isArray(x)) return { t: 'arr', items: x.map(fromChromeLogger) };
        if (typeof x === 'object') {
            if (typeof x.___class_name === 'string') {
                const entries = [];
                Object.keys(x).forEach(function (key) {
                    if (key === '___class_name') return;
                    const m = /^(public|protected|private)( static)? (.+)$/.exec(key);
                    entries.push(m
                        ? { k: m[3], v: fromChromeLogger(x[key]), vis: m[1], st: !!m[2], und: false }
                        : { k: key, v: fromChromeLogger(x[key]), vis: null, st: false, und: false });
                });
                return { t: 'obj', cls: x.___class_name, entries: entries };
            }
            return {
                t: 'map',
                entries: Object.keys(x).map(function (k) { return { k: k, v: fromChromeLogger(x[k]) }; })
            };
        }
        return { t: 'str', v: String(x) };
    }

    /** Grafo Insight {origin, instances} (FirePHP 1.0). */
    function fromInsight(graph) {
        if (!graph || typeof graph !== 'object') return fromFirePHP(graph);
        if (!graph.origin && !graph.type) return fromFirePHP(graph);
        const instances = graph.instances || [];
        const seen = new Set();

        function meta(node, name) {
            if (!node) return undefined;
            if (node.meta && node.meta[name] !== undefined) return node.meta[name];
            return node[name];
        }

        function dec(node, depth) {
            if (node === null || node === undefined) return { t: 'null' };
            if (typeof node !== 'object') return fromFirePHP(node);
            if (depth > 200) return { t: 'note', v: 'Max Depth' };
            if (node.notice && !node.type) return { t: 'note', v: node.notice };
            const ltype = meta(node, 'lang.type');
            switch (node.type) {
                case 'constant':
                    if (node.value === 'null' || node.value === 'undefined') return { t: 'null' };
                    if (node.value === 'true' || node.value === 'false') return { t: 'bool', v: node.value === 'true' };
                    return { t: 'str', v: String(node.value) };
                case 'string':
                case 'text': {
                    const v = node.value !== undefined ? node.value : (node.string !== undefined ? node.string : node.text);
                    if (ltype === 'integer' || ltype === 'float') return { t: 'num', v: Number(v) };
                    if (ltype === 'resource') return { t: 'res', v: String(v) };
                    if (meta(node, 'encoder.trimmed') || meta(node, 'encoder.notice')) return { t: 'note', v: String(v) };
                    return { t: 'str', v: String(v) };
                }
                case 'array':
                    if (!Array.isArray(node.value)) return { t: 'note', v: (node.value && node.value.notice) || 'array' };
                    return { t: 'arr', items: node.value.map(function (n) { return dec(n, depth + 1); }) };
                case 'map':
                    if (!Array.isArray(node.value)) return { t: 'note', v: (node.value && node.value.notice) || 'map' };
                    return {
                        t: 'map',
                        entries: node.value.map(function (pair) {
                            const k = dec(pair[0], depth + 1);
                            return { k: k.v !== undefined ? String(k.v) : '?', v: dec(pair[1], depth + 1) };
                        })
                    };
                case 'reference': {
                    const id = typeof node.value === 'number' ? node.value : node.instance;
                    if (seen.has(id)) return { t: 'note', v: 'Recursion (' + (meta(instances[id], 'lang.class') || '#' + id) + ')' };
                    seen.add(id);
                    const out = dec(instances[id], depth + 1);
                    seen.delete(id);
                    return out;
                }
                case 'dictionary': {
                    const cls = meta(node, 'lang.class');
                    const value = node.value || {};
                    if (value.notice && Object.keys(value).length === 1) return { t: 'note', v: value.notice };
                    const entries = Object.keys(value).map(function (k) {
                        const child = value[k];
                        return {
                            k: k,
                            v: dec(child, depth + 1),
                            vis: (child && (child['lang.visibility'] || meta(child, 'lang.visibility'))) || null,
                            st: !!(child && (child['lang.static'] || meta(child, 'lang.static'))),
                            und: !!(child && (child['lang.undeclared'] || meta(child, 'lang.undeclared')))
                        };
                    });
                    if (cls) return { t: 'obj', cls: cls, entries: entries };
                    return { t: 'map', entries: entries.map(function (e) { return { k: e.k, v: e.v }; }) };
                }
                default:
                    if (node.origin) return dec(node.origin, depth + 1);
                    return fromFirePHP(node);
            }
        }
        return dec(graph.origin || graph, 0);
    }

    /** Convierte un valor normalizado a JS plano (para "Copiar como JSON"). */
    function toPlain(v) {
        switch (v.t) {
            case 'null': return null;
            case 'bool': case 'num': case 'str': return v.v;
            case 'note': return '** ' + v.v + ' **';
            case 'res': return 'resource(' + v.v + ')';
            case 'arr': return v.items.map(toPlain);
            case 'map': {
                const o = {};
                v.entries.forEach(function (e) { o[e.k] = toPlain(e.v); });
                return o;
            }
            case 'obj': {
                const o = { __class: v.cls };
                v.entries.forEach(function (e) {
                    o[(e.st ? 'static ' : '') + (e.vis && e.vis !== 'public' ? e.vis + ' ' : '') + e.k] = toPlain(e.v);
                });
                return o;
            }
        }
        return null;
    }

    // ------------------------------------------------------------------
    // Ensamblado de mensajes multiparte (común a los dos protocolos Wildfire)
    // ------------------------------------------------------------------

    /**
     * parts: [{index, rec, sender, value}] — value ya sin prefijo.
     * splitPart(value) → {len, body, cont} | null
     */
    function assemble(parts, splitPart, warnings) {
        parts.sort(function (a, b) { return a.index - b.index; });
        const open = {}; // por receptor
        const done = [];
        parts.forEach(function (p) {
            const m = splitPart(p.value);
            if (!m) {
                warnings.push('Parte de mensaje no válida (#' + p.index + '): ' + p.value.slice(0, 120));
                return;
            }
            const key = p.rec;
            if (m.len !== '' && !m.cont) {
                if (open[key]) {
                    warnings.push('Mensaje multiparte incompleto antes de #' + p.index);
                    delete open[key];
                }
                if (!lengthMatches(m.len, m.body)) {
                    warnings.push('Longitud declarada ' + m.len + ' ≠ ' + m.body.length + ' en #' + p.index + ' (se acepta igualmente)');
                }
                done.push({ index: p.index, rec: p.rec, sender: p.sender, body: m.body });
            } else if (m.len !== '' && m.cont) {
                open[key] = { index: p.index, rec: p.rec, sender: p.sender, len: m.len, body: m.body };
            } else if (open[key]) {
                open[key].body += m.body;
                if (!m.cont) {
                    const o = open[key];
                    delete open[key];
                    if (!lengthMatches(o.len, o.body)) {
                        warnings.push('Longitud declarada ' + o.len + ' ≠ ' + o.body.length + ' en multiparte #' + o.index + ' (se acepta igualmente)');
                    }
                    done.push({ index: o.index, rec: o.rec, sender: o.sender, body: o.body });
                }
            } else {
                warnings.push('Parte huérfana de mensaje multiparte (#' + p.index + ')');
            }
        });
        Object.keys(open).forEach(function (k) {
            warnings.push('Mensaje multiparte sin terminar (#' + open[k].index + ')');
        });
        return done.sort(function (a, b) { return a.index - b.index; });
    }

    // ------------------------------------------------------------------
    // JsonStream 0.2
    // ------------------------------------------------------------------

    function parseJsonStream(entries, out) {
        const receivers = {};
        const senders = {};
        const parts = [];
        entries.forEach(function (e) {
            const k = e.key.split('-');
            if (k[0] === 'index') return;
            if (k[0] === 'structure') { receivers[k[1]] = e.value; return; }
            if (k[0] === 'plugin') { senders[k[1]] = e.value; return; }
            if (k.length === 3 && /^\d+$/.test(k[2])) {
                parts.push({ rec: k[0], sender: k[1], index: parseInt(k[2], 10), value: e.value });
            }
        });

        const msgs = assemble(parts, function (value) {
            const m = /^(\d*)\|([\s\S]*)\|(\\)?$/.exec(value);
            return m ? { len: m[1] || '', body: m[2], cont: !!m[3] } : null;
        }, out.warnings);

        msgs.forEach(function (raw) {
            let json;
            try {
                json = JSON.parse(raw.body);
            } catch (err) {
                out.warnings.push('JSON no válido en mensaje #' + raw.index + ': ' + err.message);
                out.messages.push({ kind: 'log', level: 'error', label: 'JSON no válido', values: [{ t: 'str', v: raw.body }], source: 'firephp' });
                return;
            }
            const sender = senders[raw.sender] || null;
            if (receivers[raw.rec] === STRUCT_DUMP) {
                Object.keys(json || {}).forEach(function (key) {
                    out.messages.push({ kind: 'dump', level: 'log', label: key, values: [fromFirePHP(json[key])], source: 'firephp', sender: sender });
                });
                return;
            }
            if (!(Array.isArray(json) && json.length === 2 && json[0] && typeof json[0] === 'object' && json[0].Type)) {
                out.messages.push({ kind: 'log', level: 'log', label: null, values: [fromFirePHP(json)], source: 'firephp', sender: sender });
                return;
            }
            out.messages.push(consoleMessage(json[0], json[1], sender));
        });
    }

    function frameFrom(f) {
        f = f || {};
        return {
            cls: f.class || f.Class || '',
            type: f.type || f.Type || '',
            fn: f.function || f.Function || '',
            file: f.file || f.File || '',
            line: f.line || f.Line || '',
            args: Array.isArray(f.args || f.Args) ? (f.args || f.Args).map(fromFirePHP) : []
        };
    }

    function consoleMessage(meta, data, sender) {
        const type = String(meta.Type).toUpperCase();
        const msg = {
            kind: 'log',
            level: levelFrom(type),
            label: meta.Label !== undefined && meta.Label !== null && meta.Label !== '' ? String(meta.Label) : null,
            file: meta.File || null,
            line: meta.Line || null,
            source: 'firephp',
            sender: sender
        };
        switch (type) {
            case 'GROUP_START':
                msg.kind = 'group-start';
                msg.collapsed = meta.Collapsed === true || meta.Collapsed === 'true';
                msg.color = meta.Color || null;
                break;
            case 'GROUP_END':
                msg.kind = 'group-end';
                break;
            case 'TABLE': {
                msg.kind = 'table';
                let rows = Array.isArray(data) ? data.slice() : [];
                if (rows.length === 2 && typeof rows[0] === 'string' && Array.isArray(rows[1])) {
                    msg.label = msg.label || rows[0];
                    rows = rows[1].slice();
                }
                const header = Array.isArray(rows[0]) ? rows.shift() : [];
                msg.table = {
                    header: header.map(function (h) { return String(h); }),
                    rows: rows.map(function (r) { return (Array.isArray(r) ? r : [r]).map(fromFirePHP); })
                };
                break;
            }
            case 'TRACE':
            case 'EXCEPTION': {
                msg.kind = type === 'TRACE' ? 'trace' : 'exception';
                data = data || {};
                const frames = (Array.isArray(data.Trace) ? data.Trace : []).map(frameFrom);
                if (type === 'TRACE') {
                    frames.unshift(frameFrom(data));
                } else if (!frames.length || frames[0].file !== data.File || String(frames[0].line) !== String(data.Line)) {
                    frames.unshift({ cls: '', type: '', fn: '', file: data.File || '', line: data.Line || '', args: [] });
                }
                msg.trace = {
                    cls: type === 'EXCEPTION' ? (data.Class || 'Exception') : null,
                    message: data.Message !== undefined ? String(data.Message) : '',
                    file: data.File || '',
                    line: data.Line || '',
                    frames: frames
                };
                break;
            }
            default:
                msg.values = [fromFirePHP(data)];
        }
        return msg;
    }

    // ------------------------------------------------------------------
    // Component 0.1.0 (Insight / FirePHP 1.0)
    // ------------------------------------------------------------------

    function parseComponent(entries, out) {
        const receivers = {};
        const parts = [];
        entries.forEach(function (e) {
            const k = e.key.split('-');
            if (k[0] === 'index') return;
            if (k[1] === 'receiver') { receivers[k[0]] = e.value; return; }
            if (k[2] === 'sender') return;
            if (k.length === 3 && /^\d+$/.test(k[2])) {
                parts.push({ rec: k[0], sender: k[1], index: parseInt(k[2], 10), value: e.value });
            }
        });

        const msgs = assemble(parts, function (value) {
            if (value.charAt(0) === '~') value = value.slice(1);
            const i = value.indexOf('|');
            if (i < 0) return null;
            if (value.slice(-2) === '|\\') return { len: value.slice(0, i), body: value.slice(i + 1, -2), cont: true };
            if (value.slice(-1) === '|') return { len: value.slice(0, i), body: value.slice(i + 1, -1), cont: false };
            return null;
        }, out.warnings);

        msgs.forEach(function (raw) {
            const recv = receivers[raw.rec] || '';
            // Separar meta|data por el primer "|" no escapado
            let i = -1;
            do { i = raw.body.indexOf('|', i + 1); } while (i > 0 && raw.body.charAt(i - 1) === '\\');
            if (i < 0) {
                out.warnings.push('Mensaje Insight sin separador meta|data (#' + raw.index + ')');
                return;
            }
            let meta = {};
            let data = null;
            try {
                const metaStr = raw.body.slice(0, i).replace(/\\\|/g, '|').replace(/&!10;/g, '\n');
                meta = metaStr ? JSON.parse(metaStr) : {};
                const dataStr = raw.body.slice(i + 1).replace(/&!10;/g, '\\n');
                data = dataStr ? JSON.parse(dataStr) : null;
            } catch (err) {
                out.warnings.push('JSON Insight no válido (#' + raw.index + '): ' + err.message);
                return;
            }
            if (!/console|insight/.test(recv)) {
                // receptores de control (selective, plugin…): no son mensajes de consola
                return;
            }
            const msg = {
                kind: 'log',
                level: levelFrom(meta.priority),
                label: meta.label || null,
                file: meta.file || null,
                line: meta.line || null,
                source: 'insight',
                sender: null
            };
            if (meta['group.start']) {
                msg.kind = 'group-start';
                msg.label = meta['group.title'] || msg.label;
                msg.collapsed = !meta['group.expand'];
            } else if (meta['group.end']) {
                msg.kind = 'group-end';
            } else {
                msg.values = [fromInsight(data)];
            }
            out.messages.push(msg);
        });
    }

    // ------------------------------------------------------------------
    // ChromeLogger
    // ------------------------------------------------------------------

    function decodeBase64Utf8(b64) {
        const bin = (typeof atob === 'function') ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
        try { return decodeURIComponent(escape(bin)); } catch (e) { return bin; }
    }

    function parseChromeLogger(value, out) {
        let data;
        try {
            data = JSON.parse(decodeBase64Utf8(value.trim()));
        } catch (err) {
            out.warnings.push('Cabecera ChromeLogger no válida: ' + err.message);
            return;
        }
        const cols = data.columns || ['log', 'backtrace', 'type'];
        (data.rows || []).forEach(function (row) {
            const r = {};
            cols.forEach(function (c, i) { r[c] = row[i]; });
            const type = String(r.type || 'log');
            const args = Array.isArray(r.log) ? r.log : [r.log];
            const msg = { kind: 'log', level: levelFrom(type), label: null, file: null, line: null, source: 'chromelogger', sender: null };
            if (typeof r.backtrace === 'string') {
                const m = /^(.+?)\s*:\s*(\d+)\s*$/.exec(r.backtrace);
                if (m) { msg.file = m[1]; msg.line = parseInt(m[2], 10); } else { msg.file = r.backtrace; }
            }
            if (type === 'group' || type === 'groupCollapsed') {
                msg.kind = 'group-start';
                msg.collapsed = type === 'groupCollapsed';
                msg.label = args.length ? args.map(function (a) { return typeof a === 'string' ? a : JSON.stringify(a); }).join(' ') : 'Grupo';
            } else if (type === 'groupEnd') {
                msg.kind = 'group-end';
            } else if (type === 'table' && Array.isArray(args[0])) {
                const rows = args[0];
                const header = [];
                rows.forEach(function (row) {
                    if (row && typeof row === 'object' && !Array.isArray(row)) {
                        Object.keys(row).forEach(function (k) { if (header.indexOf(k) < 0) header.push(k); });
                    }
                });
                msg.kind = 'table';
                msg.table = {
                    header: header.length ? header : [],
                    rows: rows.map(function (row) {
                        if (Array.isArray(row)) return row.map(fromChromeLogger);
                        if (row && typeof row === 'object') return header.map(function (k) { return fromChromeLogger(row[k]); });
                        return [fromChromeLogger(row)];
                    })
                };
            } else {
                // Primer argumento string → etiqueta si hay más argumentos (equivale a console.log(label, data))
                if (args.length > 1 && typeof args[0] === 'string') {
                    msg.label = args[0];
                    msg.values = args.slice(1).map(fromChromeLogger);
                } else {
                    msg.values = args.map(fromChromeLogger);
                }
            }
            out.messages.push(msg);
        });
    }

    // ------------------------------------------------------------------
    // API pública
    // ------------------------------------------------------------------

    /**
     * Analiza las cabeceras de una respuesta HTTP.
     * @param headers [{name, value}] | {name: value}
     * @param opts {chromeLogger: bool}
     * @returns {messages: [], warnings: [], raw: [{name, value}], protocols: []}
     */
    function parseResponseHeaders(headers, opts) {
        opts = opts || {};
        const hs = normHeaders(headers);
        const out = { messages: [], warnings: [], raw: [], protocols: [] };

        const wf = hs.filter(function (h) { return h.name.indexOf('x-wf-') === 0; });
        if (wf.length) {
            out.raw = out.raw.concat(wf);
            const protocols = {};
            const byProto = {};
            wf.forEach(function (h) {
                let m;
                if ((m = /^x-wf-protocol-(\d+)$/.exec(h.name))) {
                    protocols[m[1]] = h.value.trim();
                } else if ((m = /^x-wf-(\d+)-(.+)$/.exec(h.name))) {
                    (byProto[m[1]] = byProto[m[1]] || []).push({ key: m[2], value: h.value });
                }
            });
            Object.keys(byProto).forEach(function (pid) {
                const uri = protocols[pid];
                out.protocols.push(uri || '(desconocido #' + pid + ')');
                try {
                    if (uri === PROTO_JSONSTREAM) parseJsonStream(byProto[pid], out);
                    else if (uri === PROTO_COMPONENT) parseComponent(byProto[pid], out);
                    else out.warnings.push('Protocolo Wildfire no soportado: ' + (uri || 'sin cabecera X-Wf-Protocol-' + pid));
                } catch (err) {
                    out.warnings.push('Error analizando protocolo ' + uri + ': ' + err.message);
                }
            });
        }

        if (opts.chromeLogger !== false) {
            hs.forEach(function (h) {
                if (h.name === 'x-chromelogger-data' || h.name === 'x-chromephp-data') {
                    out.raw.push(h);
                    out.protocols.push('ChromeLogger');
                    parseChromeLogger(h.value, out);
                }
            });
        }
        return out;
    }

    const api = {
        VERSION: '1.0.0',
        parseResponseHeaders: parseResponseHeaders,
        fromFirePHP: fromFirePHP,
        fromChromeLogger: fromChromeLogger,
        fromInsight: fromInsight,
        toPlain: toPlain,
        fixEncoding: fixEncoding,
        PROTO_JSONSTREAM: PROTO_JSONSTREAM,
        PROTO_COMPONENT: PROTO_COMPONENT
    };

    root.FirePHPProtocol = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

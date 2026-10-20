/*
 * FirePHP Console MV3 — panel.js
 * Interfaz del panel "FirePHP" de DevTools: lista de peticiones con sus mensajes,
 * árbol de variables PHP, tablas, trazas/excepciones, grupos, filtros y enlaces al editor.
 *
 * Sustituye a los "reps" (console/layout/inspector/…​.rep.js + domplate/riot) del
 * proyecto original por DOM nativo sin dependencias ni paso de build.
 *
 * Versión: 1.0.1
 *
 * Historial de versiones:
 *   1.0.1 (2026-10-20) Interruptor de host: corrección de permisos (settings.js 1.0.1);
 *                      al desactivar se revoca el permiso; se refresca al conceder permisos
 *                      desde otra ventana.
 *   1.0.0 (2026-10-19) Versión inicial.
 *
 * Licencia: OSL-3.0
 */
(function () {
    'use strict';

    const $ = function (id) { return document.getElementById(id); };
    const P = window.FirePHPProtocol;
    const tabId = chrome.devtools.inspectedWindow.tabId;

    const state = {
        store: null,
        options: Object.assign({}, FPSettings.DEFAULT_OPTIONS),
        filter: '',
        levels: { log: true, info: true, warn: true, error: true },
        collapsedReqs: new Set(),
        host: null,
        hostEnabled: false,
        counts: { log: 0, info: 0, warn: 0, error: 0 }
    };

    if (chrome.devtools.panels.themeName === 'dark') document.body.classList.add('theme-dark');

    // ------------------------------------------------------------------
    // Utilidades DOM
    // ------------------------------------------------------------------

    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined && text !== null) e.textContent = text;
        return e;
    }

    let toastTimer = null;
    function toast(text) {
        const t = $('toast');
        t.textContent = text;
        t.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { t.hidden = true; }, 1600);
    }

    function copyText(text) {
        const done = function () { toast('Copiado al portapapeles'); };
        const fallback = function () {
            const ta = el('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); done(); } catch (e) { toast('No se pudo copiar'); }
            ta.remove();
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done, fallback);
        } else {
            fallback();
        }
    }

    function basename(f) {
        return String(f).split(/[\\/]/).pop();
    }

    function shortUrl(url) {
        try {
            const u = new URL(url);
            return (u.pathname || '/') + (u.search || '');
        } catch (e) {
            return url;
        }
    }

    // ------------------------------------------------------------------
    // Renderizado de valores
    // ------------------------------------------------------------------

    const STR_PREVIEW = 60;

    function isComplex(v) {
        return v && (v.t === 'arr' || v.t === 'map' || v.t === 'obj');
    }

    function sizeOf(v) {
        return v.t === 'arr' ? v.items.length : v.entries.length;
    }

    function typeLabel(v) {
        if (v.t === 'obj') return v.cls;
        return 'array(' + sizeOf(v) + ')';
    }

    /** Vista previa en una línea, con presupuesto de caracteres. */
    function previewInto(parent, v, budget, nested) {
        switch (v.t) {
            case 'null': parent.appendChild(el('span', 'v-null', 'null')); return 4;
            case 'bool': parent.appendChild(el('span', 'v-bool', String(v.v))); return 5;
            case 'num': parent.appendChild(el('span', 'v-num', String(v.v))); return String(v.v).length;
            case 'res': parent.appendChild(el('span', 'v-res', v.v)); return v.v.length;
            case 'note': parent.appendChild(el('span', 'v-note', v.v)); return v.v.length;
            case 'str': {
                let s = v.v.replace(/\n/g, '↵');
                if (s.length > STR_PREVIEW) s = s.slice(0, STR_PREVIEW) + '…';
                parent.appendChild(el('span', 'v-str', '"' + s + '"'));
                return s.length + 2;
            }
        }
        // complejo
        const lbl = typeLabel(v);
        if (nested) {
            parent.appendChild(el('span', v.t === 'obj' ? 'v-cls' : 'v-type', lbl));
            return lbl.length;
        }
        parent.appendChild(el('span', v.t === 'obj' ? 'v-cls' : 'v-type', lbl + ' '));
        const isArr = v.t === 'arr';
        parent.appendChild(el('span', 'v-punc', isArr ? '[' : '{'));
        let used = lbl.length + 2;
        const list = isArr ? v.items : v.entries;
        for (let i = 0; i < list.length; i++) {
            if (used > budget) {
                parent.appendChild(el('span', 'v-punc', '…'));
                break;
            }
            if (i) parent.appendChild(el('span', 'v-punc', ', '));
            if (!isArr) {
                const e = list[i];
                const k = el('span', 'v-key' + (e.vis && e.vis !== 'public' ? ' vis-' + e.vis : ''), e.k);
                parent.appendChild(k);
                parent.appendChild(el('span', 'v-punc', ': '));
                used += e.k.length + 2;
                used += previewInto(parent, e.v, budget - used, true);
            } else {
                used += previewInto(parent, list[i], budget - used, true);
            }
            used += 2;
        }
        parent.appendChild(el('span', 'v-punc', isArr ? ']' : '}'));
        return used;
    }

    /**
     * Renderiza un valor. top=true → strings sin comillas (como console.log).
     * expandDepth: niveles a expandir automáticamente.
     */
    function renderValue(v, top, expandDepth) {
        if (!isComplex(v)) {
            if (v.t === 'str') return longString(v.v, top);
            const s = el('span', 'v-inline');
            previewInto(s, v, 100, false);
            return s;
        }
        const wrap = el('span', 'tree');
        const head = el('span', 'tree-head');
        const size = sizeOf(v);
        if (!size) {
            head.classList.add('empty');
            previewInto(head, v, 100, false);
            wrap.appendChild(head);
            return wrap;
        }
        const arrow = el('span', 'arrow', '▶');
        head.appendChild(arrow);
        const prev = el('span', 'tree-prev');
        previewInto(prev, v, 90, false);
        head.appendChild(prev);
        wrap.appendChild(head);
        let kids = null;

        function toggle(force) {
            const open = force !== undefined ? force : !wrap.classList.contains('open');
            if (open && !kids) {
                kids = el('div', 'tree-kids');
                buildChildren(kids, v, Math.max(0, (expandDepth || 0) - 1));
                wrap.appendChild(kids);
            }
            wrap.classList.toggle('open', open);
            arrow.textContent = open ? '▼' : '▶';
        }
        head.addEventListener('click', function (ev) {
            ev.stopPropagation();
            if (ev.altKey) {
                // Alt+click: expandir recursivamente
                toggle(true);
                wrap.querySelectorAll('.tree:not(.open) > .tree-head').forEach(function (h) { h.click(); });
            } else {
                toggle();
            }
        });
        if (expandDepth > 0) toggle(true);
        return wrap;
    }

    const STR_MAX = 1000;

    /** String con recorte para textos largos y botón «mostrar todo». */
    function longString(text, top) {
        const q = top ? '' : '"';
        const s = el('span', top ? 'v-str-top' : 'v-str');
        if (text.length <= STR_MAX) {
            s.textContent = q + text + q;
            return s;
        }
        s.textContent = q + text.slice(0, STR_MAX) + '…';
        const more = el('button', 'more-btn', '+' + (text.length - STR_MAX).toLocaleString('es-ES') + ' caracteres');
        more.title = 'Mostrar el texto completo (' + text.length.toLocaleString('es-ES') + ' caracteres)';
        more.addEventListener('click', function (ev) {
            ev.stopPropagation();
            s.textContent = q + text + q;
        });
        s.appendChild(more);
        return s;
    }

    function buildChildren(container, v, expandDepth) {
        const list = v.t === 'arr' ? v.items.map(function (x, i) { return { k: String(i), v: x, idx: true }; }) : v.entries;
        const MAX = 500;
        list.slice(0, MAX).forEach(function (e) {
            const row = el('div', 'prop');
            const k = el('span', 'v-key' + (e.idx ? ' idx' : '') + (e.vis ? ' vis-' + e.vis : '') + (e.und ? ' und' : ''));
            if (e.st) k.appendChild(el('span', 'mod', 'static '));
            if (e.vis && e.vis !== 'public') k.appendChild(el('span', 'mod', e.vis + ' '));
            k.appendChild(document.createTextNode(e.k));
            if (e.vis) k.title = (e.st ? 'static ' : '') + e.vis + (e.und ? ' (no declarada)' : '');
            row.appendChild(k);
            row.appendChild(el('span', 'v-punc', ': '));
            row.appendChild(renderValue(e.v, false, expandDepth));
            container.appendChild(row);
        });
        if (list.length > MAX) {
            container.appendChild(el('div', 'prop more', '… ' + (list.length - MAX) + ' elementos más (usa «Copiar» para obtenerlos todos)'));
        }
    }

    // ------------------------------------------------------------------
    // Ubicación (fichero:línea) y editor
    // ------------------------------------------------------------------

    function locationLink(file, line) {
        if (!file) return null;
        const a = el('a', 'loc', basename(file) + (line ? ':' + line : ''));
        a.href = '#';
        a.title = file + (line ? ':' + line : '') + (state.options.editorUrl ? '\nClick: abrir en el editor · Alt+click: copiar ruta' : '\nClick: copiar ruta');
        a.addEventListener('click', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            const url = !ev.altKey && FPSettings.editorLink(state.options.editorUrl, file, line, state.options.pathMap);
            if (url) {
                chrome.runtime.sendMessage({ type: 'open-editor', url: url, tabId: tabId });
            } else {
                copyText(FPSettings.mapPath(String(file), state.options.pathMap) + (line ? ':' + line : ''));
            }
        });
        return a;
    }

    // ------------------------------------------------------------------
    // Mensajes
    // ------------------------------------------------------------------

    function messageText(msg) {
        // Texto plano para el filtro
        if (msg._text !== undefined) return msg._text;
        let t = (msg.label || '') + ' ' + (msg.file || '');
        try {
            if (msg.values) t += ' ' + JSON.stringify(msg.values.map(P.toPlain));
            if (msg.trace) t += ' ' + (msg.trace.cls || '') + ' ' + msg.trace.message;
            if (msg.table) t += ' ' + JSON.stringify(msg.table.header) + JSON.stringify(msg.table.rows.map(function (r) { return r.map(P.toPlain); }));
        } catch (e) { /* valores enormes */ }
        msg._text = t.slice(0, 20000).toLowerCase();
        return msg._text;
    }

    function messagePlain(msg) {
        const o = { level: msg.level };
        if (msg.label) o.label = msg.label;
        if (msg.file) o.file = msg.file + (msg.line ? ':' + msg.line : '');
        if (msg.values) o.value = msg.values.length === 1 ? P.toPlain(msg.values[0]) : msg.values.map(P.toPlain);
        if (msg.table) o.table = { header: msg.table.header, rows: msg.table.rows.map(function (r) { return r.map(P.toPlain); }) };
        if (msg.trace) o.trace = {
            class: msg.trace.cls, message: msg.trace.message, file: msg.trace.file, line: msg.trace.line,
            frames: msg.trace.frames.map(function (f) {
                return { call: (f.cls || '') + (f.type || '') + (f.fn || ''), file: f.file, line: f.line, args: f.args.map(P.toPlain) };
            })
        };
        return o;
    }

    function passesFilter(msg) {
        if (!state.levels[msg.level === 'debug' ? 'log' : msg.level]) return false;
        if (state.filter && messageText(msg).indexOf(state.filter) < 0) return false;
        return true;
    }

    function renderMessage(msg) {
        const row = el('div', 'msg lvl-' + msg.level + ' kind-' + msg.kind);
        row.appendChild(el('span', 'ico'));
        const body = el('div', 'body');
        const expand = state.options.autoExpandDepth | 0;

        if (msg.kind === 'table') {
            if (msg.label) body.appendChild(el('div', 'label table-title', msg.label));
            body.appendChild(renderTable(msg.table));
        } else if (msg.kind === 'trace' || msg.kind === 'exception') {
            body.appendChild(renderTrace(msg));
        } else {
            if (msg.label) body.appendChild(el('span', 'label', msg.label + (msg.values && msg.values.length ? ':' : '')));
            (msg.values || []).forEach(function (v) {
                body.appendChild(renderValue(v, true, msg.kind === 'dump' ? Math.max(1, expand) : expand));
            });
        }
        row.appendChild(body);

        const side = el('span', 'side');
        const copy = el('button', 'act', '⧉');
        copy.title = 'Copiar como JSON';
        copy.addEventListener('click', function (ev) {
            ev.stopPropagation();
            copyText(JSON.stringify(messagePlain(msg), null, 2));
        });
        side.appendChild(copy);
        const loc = locationLink(msg.file, msg.line);
        if (loc) side.appendChild(loc);
        row.appendChild(side);
        return row;
    }

    function renderTable(table) {
        const wrap = el('div', 'table-wrap');
        const t = el('table', 'fp-table');
        if (table.header && table.header.length) {
            const tr = t.createTHead().insertRow();
            table.header.forEach(function (h) { tr.appendChild(el('th', null, h)); });
        }
        const tb = t.createTBody();
        table.rows.slice(0, 1000).forEach(function (r) {
            const tr = tb.insertRow();
            r.forEach(function (v) { tr.insertCell().appendChild(renderValue(v, false, 0)); });
        });
        wrap.appendChild(t);
        if (table.rows.length > 1000) wrap.appendChild(el('div', 'more', '… ' + (table.rows.length - 1000) + ' filas más'));
        return wrap;
    }

    function renderTrace(msg) {
        const tr = msg.trace;
        const box = el('div', 'trace');
        const head = el('div', 'trace-head');
        const arrow = el('span', 'arrow', '▼');
        head.appendChild(arrow);
        if (tr.cls) head.appendChild(el('span', 'exc-cls', tr.cls));
        if (tr.cls && tr.message) head.appendChild(el('span', 'v-punc', ': '));
        head.appendChild(el('span', 'exc-msg', tr.message || (msg.kind === 'trace' ? 'Traza' : '')));
        if (msg.label) head.appendChild(el('span', 'label-soft', ' — ' + msg.label));
        box.appendChild(head);

        const frames = el('table', 'frames');
        tr.frames.forEach(function (f, i) {
            const row = frames.insertRow();
            row.insertCell().appendChild(el('span', 'frame-n', '#' + i));
            const call = row.insertCell();
            call.className = 'frame-call';
            if (f.fn) {
                call.appendChild(el('span', 'v-cls', (f.cls || '') + (f.type || '')));
                call.appendChild(el('span', 'fn', f.fn));
                call.appendChild(el('span', 'v-punc', '('));
                f.args.forEach(function (a, j) {
                    if (j) call.appendChild(el('span', 'v-punc', ', '));
                    call.appendChild(renderValue(a, false, 0));
                });
                call.appendChild(el('span', 'v-punc', ')'));
            } else {
                call.appendChild(el('span', 'v-note', '{main}'));
            }
            const lc = row.insertCell();
            const l = locationLink(f.file, f.line);
            if (l) lc.appendChild(l);
        });
        box.appendChild(frames);
        head.addEventListener('click', function () {
            const hidden = frames.classList.toggle('hidden');
            arrow.textContent = hidden ? '▶' : '▼';
        });
        if (msg.kind === 'trace' && tr.frames.length > 8) head.click();
        return box;
    }

    /** Construye los mensajes de una petición respetando grupos. Devuelve nº de visibles. */
    function renderMessages(container, messages) {
        const stack = [{ body: container, groupEl: null, visible: 0 }];
        messages.forEach(function (msg) {
            const top = stack[stack.length - 1];
            if (msg.kind === 'group-start') {
                const g = el('div', 'group' + (msg.collapsed ? ' collapsed' : ''));
                if (msg.color) g.style.setProperty('--group-color', msg.color);
                const gh = el('div', 'group-head lvl-' + msg.level);
                const arrow = el('span', 'arrow', msg.collapsed ? '▶' : '▼');
                gh.appendChild(arrow);
                gh.appendChild(el('span', 'group-title', msg.label || 'Grupo'));
                const loc = locationLink(msg.file, msg.line);
                if (loc) gh.appendChild(loc);
                gh.addEventListener('click', function () {
                    const c = g.classList.toggle('collapsed');
                    arrow.textContent = c ? '▶' : '▼';
                });
                const gb = el('div', 'group-body');
                g.appendChild(gh);
                g.appendChild(gb);
                top.body.appendChild(g);
                stack.push({ body: gb, groupEl: g, visible: 0, titleMatch: !!state.filter && (msg.label || '').toLowerCase().indexOf(state.filter) >= 0 });
                return;
            }
            if (msg.kind === 'group-end') {
                if (stack.length > 1) closeGroup(stack);
                return;
            }
            countLevel(msg.level);
            if (!passesFilter(msg)) return;
            top.body.appendChild(renderMessage(msg));
            stack.forEach(function (s) { s.visible++; });
        });
        while (stack.length > 1) closeGroup(stack);
        return stack[0].visible;
    }

    function closeGroup(stack) {
        const g = stack.pop();
        if (!g.visible && isFiltering() && !g.titleMatch) g.groupEl.classList.add('hidden');
    }

    function isFiltering() {
        return !!state.filter || !Object.keys(state.levels).every(function (k) { return state.levels[k]; });
    }

    function countLevel(level) {
        const k = level === 'debug' ? 'log' : level;
        if (state.counts[k] !== undefined) state.counts[k]++;
    }

    // ------------------------------------------------------------------
    // Peticiones
    // ------------------------------------------------------------------

    function renderEntry(entry) {
        if (entry.type === 'nav') {
            const n = el('div', 'nav-marker');
            n.appendChild(el('span', null, 'Navegación → '));
            n.appendChild(el('span', 'nav-url', entry.url));
            return n;
        }
        const p = entry.parsed;
        const block = el('div', 'req');
        block.dataset.id = entry.id;
        if (state.collapsedReqs.has(entry.id)) block.classList.add('collapsed');

        const head = el('div', 'req-head');
        const arrow = el('span', 'arrow', state.collapsedReqs.has(entry.id) ? '▶' : '▼');
        head.appendChild(arrow);
        head.appendChild(el('span', 'method', entry.method));
        const u = el('span', 'url', shortUrl(entry.url));
        u.title = entry.url;
        head.appendChild(u);
        head.appendChild(el('span', 'status' + (entry.status >= 400 ? ' bad' : ''), String(entry.status || '')));
        if (entry.resourceType && entry.resourceType !== 'document') head.appendChild(el('span', 'rtype', entry.resourceType));
        const real = p.messages.filter(function (m) { return m.kind !== 'group-start' && m.kind !== 'group-end'; });
        head.appendChild(el('span', 'count', real.length + ' msg'));
        if (p.warnings.length) {
            const w = el('span', 'pwarn', '⚠ ' + p.warnings.length);
            w.title = p.warnings.join('\n');
            head.appendChild(w);
        }
        head.appendChild(el('span', 'time', entry.time + ' ms'));

        const acts = el('span', 'req-acts');
        const bRaw = el('button', 'act', 'raw');
        bRaw.title = 'Ver cabeceras originales';
        const bCopy = el('button', 'act', '⧉');
        bCopy.title = 'Copiar los mensajes de esta petición como JSON';
        acts.appendChild(bRaw);
        acts.appendChild(bCopy);
        head.appendChild(acts);
        block.appendChild(head);

        const body = el('div', 'req-body');
        const visible = renderMessages(body, p.messages);
        p.warnings.forEach(function (w) {
            if (!state.filter) body.appendChild(el('div', 'parse-warn', '⚠ ' + w));
        });
        block.appendChild(body);

        const raw = el('pre', 'raw hidden');
        raw.textContent = p.raw.map(function (h) { return h.name + ': ' + h.value; }).join('\n') || '(sin cabeceras de logging)';
        block.appendChild(raw);

        head.addEventListener('click', function (ev) {
            if (ev.target.closest('.req-acts')) return;
            const c = block.classList.toggle('collapsed');
            arrow.textContent = c ? '▶' : '▼';
            if (c) state.collapsedReqs.add(entry.id); else state.collapsedReqs.delete(entry.id);
        });
        bRaw.addEventListener('click', function () { raw.classList.toggle('hidden'); });
        bCopy.addEventListener('click', function () {
            copyText(JSON.stringify({
                url: entry.url, method: entry.method, status: entry.status,
                messages: p.messages.filter(function (m) { return m.kind !== 'group-end'; }).map(messagePlain),
                warnings: p.warnings
            }, null, 2));
        });

        if (isFiltering() && !visible) block.classList.add('hidden');
        if (!real.length && !p.warnings.length && !state.options.showEmptyRequests) block.classList.add('hidden');
        return block;
    }

    // ------------------------------------------------------------------
    // Render global
    // ------------------------------------------------------------------

    function isAtBottom() {
        const l = $('log');
        return l.scrollHeight - l.scrollTop - l.clientHeight < 40;
    }

    function updateCounts() {
        Object.keys(state.counts).forEach(function (k) {
            const b = document.querySelector('[data-count="' + k + '"]');
            if (b) b.textContent = state.counts[k];
        });
    }

    function updateEmpty() {
        const any = $('log').querySelector('.req:not(.hidden)');
        $('empty').hidden = !!any;
        const st = state.store && state.store.stats;
        let txt;
        if (!state.host) {
            txt = 'Abre una página http:// o https:// para empezar.';
        } else if (!state.hostEnabled) {
            txt = 'FirePHP no está activado para ' + state.host + '. Actívalo con el interruptor de la barra y recarga la página.';
        } else if (st && st.requests && !st.withHeaders) {
            txt = 'Se han visto ' + st.requests + ' peticiones, pero ninguna trae cabeceras X-Wf-* ni X-ChromeLogger-Data. ' +
                  'Comprueba que el código PHP llama a FirePHP y que la salida no se envía antes de las cabeceras (usa ob_start()).';
        } else if (st && st.withHeaders && !any) {
            txt = 'Ningún mensaje coincide con el filtro.';
        } else {
            txt = 'Activo en ' + state.host + '. Esperando mensajes… (recarga la página si ya se había cargado)';
        }
        $('emptyText').textContent = txt;
    }

    function renderAll() {
        const log = $('log');
        const keepBottom = isAtBottom();
        log.textContent = '';
        state.counts = { log: 0, info: 0, warn: 0, error: 0 };
        if (state.store) {
            const frag = document.createDocumentFragment();
            state.store.entries.forEach(function (e) {
                if (e.type === 'nav' && !state.options.preserveLog) return;
                frag.appendChild(renderEntry(e));
            });
            log.appendChild(frag);
        }
        updateCounts();
        updateEmpty();
        if (keepBottom) log.scrollTop = log.scrollHeight;
    }

    function appendEntry(entry) {
        if (entry.type === 'nav' && !state.options.preserveLog) return;
        const log = $('log');
        const keepBottom = isAtBottom();
        log.appendChild(renderEntry(entry));
        updateCounts();
        updateEmpty();
        if (keepBottom) log.scrollTop = log.scrollHeight;
    }

    // ------------------------------------------------------------------
    // Host de la página inspeccionada
    // ------------------------------------------------------------------

    async function refreshHost(url) {
        if (url === undefined) {
            url = await new Promise(function (resolve) {
                chrome.devtools.inspectedWindow.eval('location.href', function (res) { resolve(typeof res === 'string' ? res : null); });
            });
        }
        state.host = url ? FPSettings.hostFromUrl(url) : null;
        state.hostEnabled = !!(state.host && await FPSettings.isSiteEnabled(state.host) && await FPSettings.hasHostPermission(state.host));
        $('hostName').textContent = state.host || '(sin host)';
        $('hostEnabled').checked = state.hostEnabled;
        $('hostEnabled').disabled = !state.host;
        $('hostToggle').classList.toggle('on', state.hostEnabled);
        updateEmpty();
    }

    function showBanner(html, actions) {
        const b = $('banner');
        b.textContent = '';
        b.appendChild(el('span', null, html));
        (actions || []).forEach(function (a) {
            const btn = el('button', 'banner-btn', a.label);
            btn.addEventListener('click', a.onClick);
            b.appendChild(btn);
        });
        const x = el('button', 'banner-x', '×');
        x.addEventListener('click', function () { b.hidden = true; });
        b.appendChild(x);
        b.hidden = false;
    }

    function reloadPage() {
        $('banner').hidden = true;
        chrome.devtools.inspectedWindow.reload({ ignoreCache: true });
    }

    $('hostEnabled').addEventListener('change', async function (ev) {
        const want = ev.target.checked;
        const host = state.host;
        if (!host) return;
        try {
            if (want) {
                let granted = false;
                if (chrome.permissions && chrome.permissions.request) {
                    try {
                        granted = await FPSettings.requestHostPermission(host);
                    } catch (err) {
                        granted = null; // no permitido desde DevTools en esta versión de Chrome
                    }
                } else {
                    granted = null;
                }
                if (granted === null) {
                    ev.target.checked = false;
                    await FPSettings.setSiteEnabled(host, true);
                    chrome.runtime.sendMessage({ type: 'open-enable-page', host: host });
                    showBanner('Se ha abierto una pestaña para conceder el permiso de ' + host + '. Después, vuelve aquí y recarga.', [
                        { label: 'Recargar', onClick: reloadPage }
                    ]);
                    return;
                }
                if (!granted) {
                    ev.target.checked = false;
                    showBanner('Permiso denegado para ' + host + '.');
                    return;
                }
            }
            await FPSettings.setSiteEnabled(host, want);
            if (!want) await FPSettings.removeHostPermission(host);
            await chrome.runtime.sendMessage({ type: 'sync-rules' });
            await refreshHost();
            if (want) {
                showBanner('FirePHP activado para ' + host + '. Recarga para recibir los mensajes.', [
                    { label: 'Recargar ahora', onClick: reloadPage }
                ]);
            } else {
                $('banner').hidden = true;
            }
        } catch (err) {
            ev.target.checked = !want;
            showBanner('Error: ' + (err && err.message || err));
        }
    });

    // ------------------------------------------------------------------
    // Toolbar
    // ------------------------------------------------------------------

    $('btnClear').addEventListener('click', function () {
        if (state.store) state.store.clear();
    });
    $('btnReload').addEventListener('click', reloadPage);
    $('btnOptions').addEventListener('click', function () {
        chrome.runtime.sendMessage({ type: 'open-options' });
    });
    $('preserveLog').addEventListener('change', function (ev) {
        FPSettings.setOptions({ preserveLog: ev.target.checked });
    });
    $('btnExpandAll').addEventListener('click', function () {
        const reqs = Array.prototype.slice.call(document.querySelectorAll('.req'));
        const anyOpen = reqs.some(function (r) { return !r.classList.contains('collapsed'); });
        reqs.forEach(function (r) {
            r.classList.toggle('collapsed', anyOpen);
            r.querySelector('.req-head .arrow').textContent = anyOpen ? '▶' : '▼';
            const id = +r.dataset.id;
            if (anyOpen) state.collapsedReqs.add(id); else state.collapsedReqs.delete(id);
        });
    });

    let filterTimer = null;
    $('filter').addEventListener('input', function (ev) {
        clearTimeout(filterTimer);
        filterTimer = setTimeout(function () {
            state.filter = ev.target.value.trim().toLowerCase();
            renderAll();
        }, 150);
    });

    document.querySelectorAll('.lvl-btn').forEach(function (b) {
        b.addEventListener('click', function (ev) {
            const lvl = b.dataset.level;
            if (ev.ctrlKey || ev.metaKey) {
                // Ctrl+click: solo este nivel
                Object.keys(state.levels).forEach(function (k) { state.levels[k] = k === lvl; });
            } else {
                state.levels[lvl] = !state.levels[lvl];
            }
            document.querySelectorAll('.lvl-btn').forEach(function (x) {
                x.classList.toggle('on', state.levels[x.dataset.level]);
            });
            renderAll();
        });
    });

    document.addEventListener('keydown', function (ev) {
        if ((ev.ctrlKey || ev.metaKey) && ev.key === 'l') {
            ev.preventDefault();
            if (state.store) state.store.clear();
        } else if ((ev.ctrlKey || ev.metaKey) && ev.key === 'f') {
            ev.preventDefault();
            $('filter').focus();
        }
    });

    // ------------------------------------------------------------------
    // Conexión con el store de devtools.js
    // ------------------------------------------------------------------

    if (chrome.permissions && chrome.permissions.onAdded) {
        chrome.permissions.onAdded.addListener(function () { refreshHost(); });
        chrome.permissions.onRemoved.addListener(function () { refreshHost(); });
    }

    window.FPAttach = function (store) {
        if (state.store === store) return;
        state.store = store;
        state.options = store.options;
        $('preserveLog').checked = !!state.options.preserveLog;
        store.subscribe(function (type, data) {
            switch (type) {
                case 'entry': appendEntry(data); break;
                case 'clear': state.collapsedReqs.clear(); renderAll(); break;
                case 'trimmed': renderAll(); break;
                case 'stats': updateEmpty(); break;
                case 'navigated': refreshHost(data); break;
                case 'sites': refreshHost(); break;
                case 'options':
                    state.options = data;
                    $('preserveLog').checked = !!data.preserveLog;
                    renderAll();
                    break;
            }
        });
        refreshHost(store.pageUrl || undefined);
        renderAll();
    };
})();

/*
 * FirePHP Console MV3 — devtools.js
 *
 * Se ejecuta en cuanto se abre DevTools (aunque el panel FirePHP no esté visible),
 * así que es aquí donde se escuchan las respuestas con chrome.devtools.network
 * (equivalente MV3 del antiguo webRequest.onHeadersReceived del background MV2).
 * Las respuestas se analizan con FirePHPProtocol y se guardan en un "store" que el
 * panel consulta al mostrarse.
 *
 * Versión: 1.0.0
 *
 * Historial de versiones:
 *   1.0.0 (2026-10-19) Versión inicial: captura de cabeceras, recarga desde HAR al abrir,
 *                      limpieza al navegar (o conservación), límite de peticiones.
 *
 * Licencia: OSL-3.0
 */
(function () {
    'use strict';

    const store = {
        entries: [],          // {type:'request', ...} | {type:'nav', ...}
        listeners: new Set(),
        options: Object.assign({}, FPSettings.DEFAULT_OPTIONS),
        stats: { requests: 0, withHeaders: 0 },
        pageUrl: null,
        seq: 0,

        subscribe: function (fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
        emit: function (type, data) {
            this.listeners.forEach(function (fn) {
                try { fn(type, data); } catch (e) { console.error(e); }
            });
        },
        clear: function () {
            this.entries = [];
            this.stats = { requests: 0, withHeaders: 0 };
            this.emit('clear');
        }
    };

    const seen = new Set();

    function hasLoggingHeaders(headers) {
        for (let i = 0; i < headers.length; i++) {
            const n = String(headers[i].name).toLowerCase();
            if (n.indexOf('x-wf-') === 0 || n === 'x-chromelogger-data' || n === 'x-chromephp-data') return true;
        }
        return false;
    }

    function onRequest(har) {
        try {
            const key = har.startedDateTime + ' ' + har.request.url;
            if (seen.has(key)) return;
            seen.add(key);
            if (seen.size > 20000) seen.clear();

            store.stats.requests++;
            const headers = (har.response && har.response.headers) || [];
            const has = hasLoggingHeaders(headers);
            if (!has && !store.options.showEmptyRequests) {
                store.emit('stats', store.stats);
                return;
            }
            let parsed = { messages: [], warnings: [], raw: [], protocols: [] };
            if (has) {
                store.stats.withHeaders++;
                parsed = FirePHPProtocol.parseResponseHeaders(headers, { chromeLogger: store.options.chromeLogger });
            }
            const entry = {
                type: 'request',
                id: ++store.seq,
                url: har.request.url,
                method: har.request.method,
                status: har.response.status,
                time: Math.round(har.time || 0),
                started: har.startedDateTime,
                resourceType: har._resourceType || '',
                parsed: parsed
            };
            store.entries.push(entry);
            trim();
            store.emit('entry', entry);
        } catch (err) {
            console.error('[FirePHP] Error procesando petición:', err);
        }
    }

    function trim() {
        const max = Math.max(20, store.options.maxRequests | 0);
        let reqs = 0;
        for (let i = store.entries.length - 1; i >= 0; i--) {
            if (store.entries[i].type === 'request' && ++reqs > max) {
                store.entries.splice(0, i + 1);
                store.emit('trimmed');
                break;
            }
        }
    }

    chrome.devtools.network.onRequestFinished.addListener(onRequest);

    chrome.devtools.network.onNavigated.addListener(function (url) {
        store.pageUrl = url;
        if (!store.options.preserveLog) store.clear();
        const nav = { type: 'nav', id: ++store.seq, url: url, at: Date.now() };
        store.entries.push(nav);
        store.emit('entry', nav);
        store.emit('navigated', url);
    });

    // Opciones
    FPSettings.getOptions().then(function (o) {
        store.options = o;
        store.emit('options', o);
        // Peticiones ocurridas antes de que esta página terminara de cargar
        chrome.devtools.network.getHAR(function (har) {
            (har && har.entries || []).forEach(onRequest);
        });
    });
    chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local') return;
        if (changes.options) {
            store.options = Object.assign({}, FPSettings.DEFAULT_OPTIONS, changes.options.newValue || {});
            store.emit('options', store.options);
        }
        if (changes.sites) store.emit('sites');
    });

    chrome.devtools.inspectedWindow.eval('location.href', function (href) {
        if (typeof href === 'string') store.pageUrl = href;
    });

    // Panel
    chrome.devtools.panels.create('FirePHP', 'icons/icon16.png', 'panel.html', function (panel) {
        panel.onShown.addListener(function (win) {
            if (win && typeof win.FPAttach === 'function') win.FPAttach(store);
        });
    });

    // Accesible para depuración desde la consola de DevTools-on-DevTools
    window.FPStore = store;
})();

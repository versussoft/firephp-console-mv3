/*
 * FirePHP Console MV3 — settings.js
 * Acceso compartido a la configuración (chrome.storage.local) desde el service worker,
 * el popup, las opciones y el panel DevTools.
 *
 * Versión: 1.0.1
 *
 * Historial de versiones:
 *   1.0.1 (2026-10-20) Corrección: el permiso se pedía como "*://host/*", que Chrome rechaza
 *                      ("Only permissions specified in the manifest may be requested") porque
 *                      el manifest declara http y https por separado. Ahora se piden
 *                      "http://host/*" y "https://host/*" (originPatterns).
 *   1.0.0 (2026-10-19) Versión inicial: opciones globales, activación por host,
 *                      utilidades de permisos de host y mapeo de rutas para el editor.
 *
 * Licencia: OSL-3.0
 */
(function (root) {
    'use strict';

    const DEFAULT_OPTIONS = {
        // Cabeceras de petición (vía declarativeNetRequest)
        sendFirePHPHeader: true,     // X-FirePHP-Version: 0.4
        sendUserAgent: true,         // añade "FirePHP/0.5" al User-Agent
        announceInsight: false,      // cabeceras de anuncio Wildfire para FirePHP 1.0 / Insight
        insightAuthKey: '',          // authkey del anuncio Insight
        // Respuesta
        chromeLogger: true,          // interpretar X-ChromeLogger-Data
        // Panel
        preserveLog: false,
        showEmptyRequests: false,
        maxRequests: 300,
        autoExpandDepth: 0,
        // Editor: plantilla con {file} y {line}. Ej: vscode://file/{file}:{line}
        editorUrl: '',
        // Mapeo de rutas servidor → local, una por línea: /var/www/app => /home/yo/app
        pathMap: ''
    };

    const EDITOR_PRESETS = {
        '': 'Ninguno (copiar ruta al portapapeles)',
        'vscode://file/{file}:{line}': 'Visual Studio Code',
        'vscodium://file/{file}:{line}': 'VSCodium',
        'phpstorm://open?file={file}&line={line}': 'PhpStorm',
        'idea://open?file={file}&line={line}': 'IntelliJ IDEA',
        'subl://open?url=file://{file}&line={line}': 'Sublime Text',
        'txmt://open?url=file://{file}&line={line}': 'TextMate',
        'nvim://open?file={file}&line={line}': 'Neovim (handler nvim://)'
    };

    function normalizeHost(host) {
        return String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    }

    function hostFromUrl(url) {
        try {
            const u = new URL(url);
            if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
            return normalizeHost(u.hostname);
        } catch (e) {
            return null;
        }
    }

    /**
     * Patrones de permiso para un host. Deben estar contenidos, cada uno por separado,
     * en optional_host_permissions del manifest (http y https por separado): un patrón
     * "*://host/*" no lo está y Chrome lo rechaza.
     */
    function originPatterns(host) {
        host = normalizeHost(host);
        // IPv6 entre corchetes en el patrón
        if (host.indexOf(':') >= 0) host = '[' + host + ']';
        return ['http://' + host + '/*', 'https://' + host + '/*'];
    }

    async function getAll() {
        const data = await chrome.storage.local.get(['options', 'sites']);
        return {
            options: Object.assign({}, DEFAULT_OPTIONS, data.options || {}),
            sites: data.sites || {}
        };
    }

    async function getOptions() {
        return (await getAll()).options;
    }

    async function setOptions(patch) {
        const cur = await getOptions();
        await chrome.storage.local.set({ options: Object.assign(cur, patch) });
    }

    async function isSiteEnabled(host) {
        const all = await getAll();
        const s = all.sites[normalizeHost(host)];
        return !!(s && s.enabled);
    }

    async function setSiteEnabled(host, enabled) {
        host = normalizeHost(host);
        const all = await getAll();
        if (enabled) {
            all.sites[host] = { enabled: true, since: all.sites[host] && all.sites[host].since || Date.now() };
        } else {
            delete all.sites[host];
        }
        await chrome.storage.local.set({ sites: all.sites });
    }

    async function hasHostPermission(host) {
        try {
            return await chrome.permissions.contains({ origins: originPatterns(host) });
        } catch (e) {
            return false;
        }
    }

    /** Debe llamarse dentro de un gesto de usuario (click). */
    async function requestHostPermission(host) {
        if (await hasHostPermission(host)) return true;
        return chrome.permissions.request({ origins: originPatterns(host) });
    }

    async function removeHostPermission(host) {
        try {
            return await chrome.permissions.remove({ origins: originPatterns(host) });
        } catch (e) {
            return false;
        }
    }

    function parsePathMap(text) {
        return String(text || '').split(/\r?\n/).map(function (l) {
            const m = /^\s*(.+?)\s*=>\s*(.+?)\s*$/.exec(l);
            return (m && l.trim().charAt(0) !== '#') ? { from: m[1], to: m[2] } : null;
        }).filter(Boolean);
    }

    function mapPath(file, pathMapText) {
        const maps = parsePathMap(pathMapText);
        for (let i = 0; i < maps.length; i++) {
            if (file.indexOf(maps[i].from) === 0) return maps[i].to + file.slice(maps[i].from.length);
        }
        return file;
    }

    function editorLink(template, file, line, pathMapText) {
        if (!template || !file) return null;
        const local = mapPath(String(file), pathMapText);
        return template
            .replace(/\{file\}/g, encodeURI(local).replace(/[?#&]/g, encodeURIComponent))
            .replace(/\{line\}/g, encodeURIComponent(String(line || 1)));
    }

    root.FPSettings = {
        VERSION: '1.0.1',
        DEFAULT_OPTIONS: DEFAULT_OPTIONS,
        EDITOR_PRESETS: EDITOR_PRESETS,
        normalizeHost: normalizeHost,
        hostFromUrl: hostFromUrl,
        originPatterns: originPatterns,
        getAll: getAll,
        getOptions: getOptions,
        setOptions: setOptions,
        isSiteEnabled: isSiteEnabled,
        setSiteEnabled: setSiteEnabled,
        hasHostPermission: hasHostPermission,
        removeHostPermission: removeHostPermission,
        requestHostPermission: requestHostPermission,
        mapPath: mapPath,
        editorLink: editorLink
    };
})(typeof globalThis !== 'undefined' ? globalThis : this);

/*
 * FirePHP Console MV3 — background.js (service worker)
 *
 * Sustituye al background page MV2 del proyecto original. En MV3 ya no existe
 * webRequestBlocking, así que las cabeceras de petición que pide el servidor PHP
 * (X-FirePHP-Version, User-Agent "FirePHP/x.y" y, opcionalmente, el anuncio
 * Wildfire de Insight) se inyectan con reglas dinámicas de declarativeNetRequest,
 * limitadas a los hosts que el usuario ha activado y para los que ha concedido permiso.
 *
 * La lectura de las cabeceras de respuesta NO se hace aquí: la hace la página DevTools
 * con chrome.devtools.network, que no depende del ciclo de vida del service worker.
 *
 * Versión: 1.0.0
 *
 * Historial de versiones:
 *   1.0.0 (2026-10-19) Versión inicial: reglas DNR por host, icono de estado por pestaña,
 *                      apertura de enlaces de editor y página de activación.
 *
 * Licencia: OSL-3.0
 */
importScripts('lib/settings.js');

const RULE_ID = 1;
const ALL_RESOURCE_TYPES = [
    'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
    'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport',
    'webbundle', 'other'
];

const INSIGHT_RECEIVERS = [
    'http://meta.firephp.org/Wildfire/Structure/FirePHP/FirebugConsole/0.1',
    'http://meta.firephp.org/Wildfire/Structure/FirePHP/Dump/0.1',
    'http://registry.pinf.org/cadorn.org/insight/@meta/receiver/insight/selective/0',
    'http://registry.pinf.org/cadorn.org/insight/@meta/receiver/console/request/0',
    'http://registry.pinf.org/cadorn.org/insight/@meta/receiver/console/page/0',
    'http://registry.pinf.org/cadorn.org/insight/@meta/receiver/console/firephp/0'
];

function insightAnnounceHeaders(authKey) {
    const payload = '|' + JSON.stringify({ authkey: authKey || '', receivers: INSIGHT_RECEIVERS });
    return [
        { header: 'X-Wf-Protocol-1', operation: 'set', value: 'http://registry.pinf.org/cadorn.org/wildfire/@meta/protocol/announce/0.1.0' },
        { header: 'X-Wf-1-1', operation: 'set', value: payload.length + '|' + payload + '|' },
        { header: 'X-Wf-1-Index', operation: 'set', value: '1' }
    ];
}

let syncing = Promise.resolve();

function syncRules() {
    // Serializa las sincronizaciones para no pisar reglas en cambios rápidos
    syncing = syncing.then(doSyncRules).catch(function (err) {
        console.error('[FirePHP] Error sincronizando reglas:', err);
    });
    return syncing;
}

async function doSyncRules() {
    const { options, sites } = await FPSettings.getAll();
    const hosts = [];
    for (const host of Object.keys(sites)) {
        if (sites[host] && sites[host].enabled && await FPSettings.hasHostPermission(host)) {
            hosts.push(host);
        }
    }

    const requestHeaders = [];
    if (options.sendFirePHPHeader) {
        requestHeaders.push({ header: 'X-FirePHP-Version', operation: 'set', value: '0.4' });
    }
    if (options.sendUserAgent) {
        requestHeaders.push({ header: 'User-Agent', operation: 'append', value: 'FirePHP/0.5' });
    }
    if (options.announceInsight) {
        requestHeaders.push.apply(requestHeaders, insightAnnounceHeaders(options.insightAuthKey));
    }

    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const addRules = [];
    if (hosts.length && requestHeaders.length) {
        addRules.push({
            id: RULE_ID,
            priority: 1,
            action: { type: 'modifyHeaders', requestHeaders: requestHeaders },
            condition: { requestDomains: hosts, resourceTypes: ALL_RESOURCE_TYPES }
        });
    }
    await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: existing.map(function (r) { return r.id; }),
        addRules: addRules
    });
    await refreshAllIcons();
}

// ------------------------------------------------------------------
// Icono de estado por pestaña
// ------------------------------------------------------------------

async function refreshIcon(tabId, url) {
    const host = FPSettings.hostFromUrl(url || '');
    let state = 'off';
    if (host && await FPSettings.isSiteEnabled(host)) {
        state = (await FPSettings.hasHostPermission(host)) ? 'on' : 'noperm';
    }
    try {
        await chrome.action.setIcon({
            tabId: tabId,
            path: state === 'on'
                ? { 16: 'icons/icon16.png', 48: 'icons/icon48_enabled.png' }
                : { 16: 'icons/icon16_disabled.png', 48: 'icons/icon48_disabled.png' }
        });
        await chrome.action.setBadgeText({ tabId: tabId, text: state === 'noperm' ? '!' : '' });
        await chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: '#d93025' });
        await chrome.action.setTitle({
            tabId: tabId,
            title: !host ? 'FirePHP Console' :
                state === 'on' ? 'FirePHP activo en ' + host :
                state === 'noperm' ? 'FirePHP: falta permiso para ' + host :
                'FirePHP desactivado en ' + host
        });
    } catch (e) {
        // La pestaña puede haberse cerrado entretanto
    }
}

async function refreshAllIcons() {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map(function (t) { return refreshIcon(t.id, t.url); }));
}

chrome.tabs.onActivated.addListener(function (info) {
    chrome.tabs.get(info.tabId).then(function (t) { refreshIcon(t.id, t.url); }).catch(function () {});
});
chrome.tabs.onUpdated.addListener(function (tabId, change, tab) {
    if (change.url || change.status === 'loading') refreshIcon(tabId, tab.url);
});

// ------------------------------------------------------------------
// Eventos de ciclo de vida y configuración
// ------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(syncRules);
chrome.runtime.onStartup.addListener(syncRules);
chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local' && (changes.options || changes.sites)) syncRules();
});
chrome.permissions.onAdded.addListener(syncRules);
chrome.permissions.onRemoved.addListener(syncRules);

// ------------------------------------------------------------------
// Mensajes desde panel / popup
// ------------------------------------------------------------------

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    (async function () {
        switch (msg && msg.type) {
            case 'open-editor':
                // Un esquema externo (vscode://, phpstorm://…) lanza el manejador del sistema
                // sin abandonar la página inspeccionada.
                if (typeof msg.tabId === 'number') {
                    await chrome.tabs.update(msg.tabId, { url: msg.url });
                } else {
                    await chrome.tabs.create({ url: msg.url, active: false });
                }
                return { ok: true };
            case 'open-enable-page':
                await chrome.tabs.create({
                    url: chrome.runtime.getURL('popup.html') + '?host=' + encodeURIComponent(msg.host) + '&standalone=1'
                });
                return { ok: true };
            case 'open-options':
                await chrome.runtime.openOptionsPage();
                return { ok: true };
            case 'reload-tab':
                await chrome.tabs.reload(msg.tabId, { bypassCache: !!msg.bypassCache });
                return { ok: true };
            case 'sync-rules':
                await syncRules();
                return { ok: true };
            case 'get-rules':
                return { rules: await chrome.declarativeNetRequest.getDynamicRules() };
        }
        return { ok: false, error: 'mensaje desconocido' };
    })().then(sendResponse, function (err) {
        sendResponse({ ok: false, error: String(err && err.message || err) });
    });
    return true; // respuesta asíncrona
});

syncRules();

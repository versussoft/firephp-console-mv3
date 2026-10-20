/*
 * FirePHP Console MV3 — popup.js
 * Activa/desactiva FirePHP para el host de la pestaña activa. Pide el permiso de host
 * dentro del gesto de click (requisito de chrome.permissions.request).
 * También se usa como página independiente (?host=…&standalone=1) cuando el panel
 * DevTools no puede pedir permisos por sí mismo.
 *
 * Versión: 1.0.1
 *
 * Historial de versiones:
 *   1.0.1 (2026-10-20) Corrección del error "Only permissions specified in the manifest may be
 *                      requested" (ver settings.js 1.0.1). La activación se guarda ANTES de pedir
 *                      el permiso: si el popup se cierra al mostrarse el diálogo de Chrome, el
 *                      service worker aplica las reglas al recibir permissions.onAdded.
 *                      Al desactivar se revoca también el permiso del host.
 *   1.0.0 (2026-10-19) Versión inicial.
 *
 * Licencia: OSL-3.0
 */
(async function () {
    'use strict';
    const $ = function (id) { return document.getElementById(id); };
    const params = new URLSearchParams(location.search);
    const standalone = params.get('standalone') === '1';

    let tab = null;
    let host = params.get('host') ? FPSettings.normalizeHost(params.get('host')) : null;
    if (!host) {
        [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        host = tab && FPSettings.hostFromUrl(tab.url || '');
    }
    if (standalone) document.body.classList.add('standalone');

    function openOptions() { chrome.runtime.openOptionsPage(); }
    $('options').addEventListener('click', openOptions);
    $('options2').addEventListener('click', openOptions);

    if (!host) {
        $('unsupported').hidden = false;
        return;
    }
    $('host').textContent = host;
    $('main').hidden = false;

    async function render(justChanged) {
        const enabled = await FPSettings.isSiteEnabled(host);
        const perm = await FPSettings.hasHostPermission(host);
        $('enabled').checked = enabled && perm;
        const st = $('status');
        st.className = 'status';
        if (enabled && perm) {
            st.textContent = 'Se envían las cabeceras FirePHP a ' + host + '.' + (justChanged ? ' Recarga la página para ver los mensajes.' : '');
            st.classList.add('ok');
        } else if (enabled && !perm) {
            st.textContent = 'Activado, pero falta el permiso de acceso al host. Vuelve a activar el interruptor para concederlo.';
            st.classList.add('warn');
        } else {
            st.textContent = 'Desactivado: el servidor no recibirá X-FirePHP-Version y normalmente no enviará mensajes.';
        }
        $('reload').hidden = !(justChanged && tab && !standalone);
    }

    $('enabled').addEventListener('change', async function (ev) {
        const want = ev.target.checked;
        try {
            if (want) {
                // 1) Guardar primero (el popup puede cerrarse al abrirse el diálogo de permiso)
                await FPSettings.setSiteEnabled(host, true);
                // 2) Pedir permiso dentro del gesto de click
                const granted = await FPSettings.requestHostPermission(host);
                if (!granted) {
                    await FPSettings.setSiteEnabled(host, false);
                    ev.target.checked = false;
                    $('status').textContent = 'Permiso denegado. Sin él no se pueden añadir las cabeceras FirePHP.';
                    $('status').className = 'status warn';
                    return;
                }
            } else {
                await FPSettings.setSiteEnabled(host, false);
                await FPSettings.removeHostPermission(host);
            }
            await chrome.runtime.sendMessage({ type: 'sync-rules' });
            await render(true);
            if (standalone && want) {
                $('status').textContent += ' Ya puedes cerrar esta pestaña.';
            }
        } catch (err) {
            if (want) await FPSettings.setSiteEnabled(host, false);
            ev.target.checked = false;
            $('status').textContent = 'Error: ' + (err && err.message || err);
            $('status').className = 'status warn';
        }
    });

    $('reload').addEventListener('click', async function () {
        if (tab) await chrome.tabs.reload(tab.id, { bypassCache: true });
        window.close();
    });

    render(false);
})();

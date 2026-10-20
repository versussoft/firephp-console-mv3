/*
 * FirePHP Console MV3 — options.js
 *
 * Versión: 1.0.1
 *
 * Historial de versiones:
 *   1.0.1 (2026-10-20) Corrección de permisos (settings.js 1.0.1). Cada host tiene ahora un
 *                      interruptor en lugar de botones; añadir un host a mano es opcional.
 *   1.0.0 (2026-10-19) Versión inicial: opciones, gestión de hosts y vista de reglas DNR.
 *
 * Licencia: OSL-3.0
 */
(async function () {
    'use strict';
    const $ = function (id) { return document.getElementById(id); };
    $('ver').textContent = 'v' + chrome.runtime.getManifest().version;

    let savedTimer = null;
    function flashSaved() {
        $('saved').hidden = false;
        clearTimeout(savedTimer);
        savedTimer = setTimeout(function () { $('saved').hidden = true; }, 1200);
    }

    // --- Opciones ---------------------------------------------------
    const preset = $('editorPreset');
    Object.keys(FPSettings.EDITOR_PRESETS).forEach(function (tpl) {
        const o = document.createElement('option');
        o.value = tpl;
        o.textContent = FPSettings.EDITOR_PRESETS[tpl];
        preset.appendChild(o);
    });
    const custom = document.createElement('option');
    custom.value = '__custom';
    custom.textContent = 'Personalizado…';
    preset.appendChild(custom);

    async function loadOptions() {
        const opts = await FPSettings.getOptions();
        document.querySelectorAll('[data-opt]').forEach(function (el) {
            const v = opts[el.dataset.opt];
            if (el.type === 'checkbox') el.checked = !!v;
            else el.value = v === undefined || v === null ? '' : v;
        });
        preset.value = Object.prototype.hasOwnProperty.call(FPSettings.EDITOR_PRESETS, opts.editorUrl) ? opts.editorUrl : '__custom';
    }

    document.querySelectorAll('[data-opt]').forEach(function (el) {
        el.addEventListener('change', async function () {
            let v = el.type === 'checkbox' ? el.checked : el.value;
            if (el.type === 'number') v = Math.max(+el.min || 0, Math.min(+el.max || 1e9, parseInt(el.value, 10) || 0));
            await FPSettings.setOptions({ [el.dataset.opt]: v });
            if (el.dataset.opt === 'editorUrl') {
                preset.value = Object.prototype.hasOwnProperty.call(FPSettings.EDITOR_PRESETS, v) ? v : '__custom';
            }
            flashSaved();
            setTimeout(showRules, 300);
        });
    });

    preset.addEventListener('change', async function () {
        if (preset.value === '__custom') return;
        document.querySelector('[data-opt="editorUrl"]').value = preset.value;
        await FPSettings.setOptions({ editorUrl: preset.value });
        flashSaved();
    });

    // --- Hosts ------------------------------------------------------
    async function renderSites() {
        const { sites } = await FPSettings.getAll();
        const tbody = $('sites');
        tbody.textContent = '';
        const hosts = Object.keys(sites).sort();
        if (!hosts.length) {
            const tr = tbody.insertRow();
            const td = tr.insertCell();
            td.colSpan = 3;
            td.className = 'hint';
            td.textContent = 'Ningún host activado todavía.';
            return;
        }
        for (const host of hosts) {
            const perm = await FPSettings.hasHostPermission(host);
            const tr = tbody.insertRow();
            tr.insertCell().textContent = host;
            const st = tr.insertCell();
            st.textContent = perm ? 'activo' : 'sin permiso (activa el interruptor)';
            st.className = perm ? 'ok' : 'warn';
            const act = tr.insertCell();
            const sw = document.createElement('label');
            sw.className = 'switch';
            sw.title = perm ? 'Desactivar' : 'Conceder permiso';
            const inp = document.createElement('input');
            inp.type = 'checkbox';
            inp.checked = perm;
            sw.appendChild(inp);
            sw.appendChild(Object.assign(document.createElement('span'), { className: 'slider' }));
            inp.addEventListener('change', async function () {
                try {
                    if (inp.checked) {
                        if (!await FPSettings.requestHostPermission(host)) inp.checked = false;
                    } else {
                        await FPSettings.setSiteEnabled(host, false);
                        await FPSettings.removeHostPermission(host);
                    }
                } catch (err) {
                    inp.checked = false;
                    alertError(err);
                }
                renderSites();
                setTimeout(showRules, 300);
            });
            act.appendChild(sw);
        }
    }

    function alertError(err) {
        $('addError').textContent = 'Error: ' + (err && err.message || err);
        $('addError').hidden = false;
    }

    $('addSite').addEventListener('submit', async function (ev) {
        ev.preventDefault();
        $('addError').hidden = true;
        const raw = $('newHost').value.trim();
        if (!raw) return;
        const host = FPSettings.hostFromUrl(/^https?:\/\//i.test(raw) ? raw : 'http://' + raw);
        if (!host) {
            alertError('host no válido');
            return;
        }
        try {
            await FPSettings.setSiteEnabled(host, true);
            if (await FPSettings.requestHostPermission(host)) {
                $('newHost').value = '';
            } else {
                await FPSettings.setSiteEnabled(host, false);
            }
        } catch (err) {
            await FPSettings.setSiteEnabled(host, false);
            alertError(err);
        }
        renderSites();
        setTimeout(showRules, 300);
    });

    // --- Diagnóstico ------------------------------------------------
    async function showRules() {
        try {
            const res = await chrome.runtime.sendMessage({ type: 'get-rules' });
            $('rules').textContent = res && res.rules && res.rules.length
                ? JSON.stringify(res.rules, null, 2)
                : '(ninguna — activa al menos un host)';
        } catch (e) {
            $('rules').textContent = 'No disponible: ' + e.message;
        }
    }

    chrome.permissions.onAdded.addListener(function () { renderSites(); setTimeout(showRules, 300); });
    chrome.storage.onChanged.addListener(function (changes) {
        if (changes.sites) { renderSites(); setTimeout(showRules, 300); }
    });

    await loadOptions();
    await renderSites();
    showRules();
})();

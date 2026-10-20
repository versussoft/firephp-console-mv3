# FirePHP Console MV3

Versión 1.0.1 · Extensión de Chrome (Manifest V3) que muestra en un panel de DevTools los mensajes que PHP envía en cabeceras HTTP con **FirePHP** (protocolo Wildfire), **FirePHP 1.0 / Insight** y **ChromeLogger**.

Es una reescritura de [firephp/firephp-for-browser-devtools](https://github.com/firephp/firephp-for-browser-devtools) (Manifest V2, abandonada desde 2020), sin dependencias ni paso de build: los ficheros de `src/` se cargan tal cual.

## Instalación

1. Abre `chrome://extensions` y activa **Modo de desarrollador**.
2. **Cargar descomprimida** → selecciona la carpeta `src/`.
3. Abre la web PHP, pulsa el icono de FirePHP (o abre DevTools → pestaña **FirePHP**) y activa el interruptor para ese host. Chrome pedirá permiso de acceso a ese host concreto.
4. Recarga la página.

Funciona igual en Edge, Brave, Vivaldi y demás navegadores Chromium ≥ 116.

## Compatibilidad en el lado PHP

| Librería | Protocolo | Estado |
|---|---|---|
| `firephp/firephp-core` 0.4 / 0.5 (`FirePHP::getInstance()`, `FB::log()`) | Wildfire JsonStream 0.2 | ✔ probado |
| Monolog `FirePHPHandler` | Wildfire JsonStream 0.2 | ✔ probado |
| `ccampbell/chromephp`, Monolog `ChromePHPHandler` | ChromeLogger | ✔ probado |
| `firephp/firephp` 1.0 (Insight) | Wildfire component 0.1.0 | ✔ mensajes de consola (activar el anuncio Insight en Opciones) |

Tipos soportados: `LOG`, `INFO`, `WARN`, `ERROR`, `DUMP`, `TABLE`, `TRACE`, `EXCEPTION`, `GROUP_START`/`GROUP_END` (con `Collapsed` y `Color`), mensajes multiparte de cualquier tamaño, objetos con visibilidad `public/protected/private/static`, recursión y profundidad máxima.

Recuerda que PHP debe enviar las cabeceras antes que el cuerpo: usa `ob_start()` al principio o `output_buffering` en `php.ini`.

## Qué cambia respecto a la versión MV2

| MV2 (original) | MV3 (esta) |
|---|---|
| `webRequestBlocking` + `onBeforeSendHeaders` para añadir `X-FirePHP-Version` y `FirePHP/x.y` al User-Agent | Reglas dinámicas de **`declarativeNetRequest`** (`modifyHeaders`) limitadas a los hosts activados |
| `webRequest.onHeadersReceived` en una background page persistente | **`chrome.devtools.network.onRequestFinished`** en la página DevTools: no depende del service worker, que en MV3 se duerme |
| Background page | **Service worker** sin estado (la configuración vive en `chrome.storage`) |
| `pageAction` | `action` con icono por pestaña (activo / inactivo / falta permiso) |
| Permiso `<all_urls>` | `optional_host_permissions`: se pide solo para cada host que actives |
| pinf.it + browserify + domplate + riot + CodeMirror | JavaScript plano, sin dependencias |

## Panel

- Mensajes agrupados por petición (página, `fetch`/XHR, iframes…), con método, estado y tiempo.
- Árbol de variables plegable (Alt+click expande recursivamente), tablas, trazas y excepciones.
- Filtro de texto (Ctrl+F) y por nivel (Ctrl+click en un nivel = solo ese nivel). Ctrl+L limpia.
- «Conservar» mantiene el log entre navegaciones.
- `raw` muestra las cabeceras originales; ⧉ copia el mensaje o la petición entera como JSON.
- Click en `fichero:línea` abre el editor configurado (VS Code, PhpStorm, Sublime…) con mapeo de rutas servidor ⇒ local, útil cuando PHP corre en otro servidor o en Docker. Sin editor configurado, copia la ruta.
- Tema claro/oscuro según DevTools.

## Opciones

Cabeceras a enviar (`X-FirePHP-Version`, User-Agent, anuncio Insight con authkey), interpretar ChromeLogger, máximo de peticiones guardadas, niveles a expandir automáticamente, plantilla del editor y mapeo de rutas. La sección **Diagnóstico** muestra las reglas `declarativeNetRequest` activas.

## Tests

```bash
node tests/protocol.test.js
```

Las cabeceras de `tests/fixtures/` se generaron con firephp-core 0.5.3, Monolog 3 y ChromePhp 4.1 a partir de los scripts de `tests/php/` (`composer install` y `php -S 127.0.0.1:8099 -t tests/php`).

## Limitaciones conocidas

- Los mensajes solo se capturan con DevTools abierto (igual que en el original). Si abres DevTools con la página ya cargada, recarga.
- No se ha portado el visor de ficheros remoto de Insight (`x-insight=serve`); los enlaces abren el fichero en tu editor local.

## Licencia

[Open Software License 3.0](https://opensource.org/licenses/OSL-3.0), como el proyecto original (© Christoph Dorn). Iconos procedentes del proyecto original. «FirePHP» es una marca de su autor; esta es una extensión no oficial.

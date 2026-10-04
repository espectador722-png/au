# Changelog — Eclipse Zone (eclipsezonehub.com)

## 2026-09-28 (Fix: slugs.json perdía juegos con título duplicado)

- `slugs.json` (título → slug, lo usa el bot para enlazar fichas) se quedaba solo con el primer juego cuando dos compartían título normalizado (568 entradas para 587 juegos). Ahora un título duplicado guarda un array de slugs en vez de pisar el anterior.
- `senpaibot/eclipse_data.py::game_url` acepta ese array (usa el primer slug — no hay forma de saber desde `slugs.json` cuál entrada del catálogo es cuál página).
- `d1/migrations/0001_views.sql`: schema de `ez-views` versionado en el repo (antes solo existía en un script suelto). Se agregó `idx_view_hourly_type_hour` — sin él, `GET /api/views/top` escaneaba toda `view_hourly`.
- `F95Pipeline/f95_publish.py`: quitada `_login_site()`, sin ningún uso desde que `exclusive-direct-link` pasó a scope `form` (ver entrada de seguridad del 2026-09-27).

## 2026-09-27 (Fix: canal del motor publicaba sin acortador)

El canal de cada motor (Ren'Py, Unity/Godot, RPG Maker) estaba en el grupo de "link directo", así que los juegos con acortador salían ahí sin acortar. Ahora es un canal con acortador: si el juego espera el de Brandon, el canal del motor también espera y se publica en `_post_pending` (al completar Brandon o a las 24 h), con `motorChannel` guardado en el pendiente. Sin acortador se publica al momento, como los demás canales normales. En sync con `F95Pipeline/f95_publish.py`.

## 2026-09-27 (Anuncios de actualización: mensajes largos)

- `AnnounceUpdate/announce_update.py` parte cualquier mensaje de más de 2000 caracteres (límite de Discord) entre bullets. El anuncio de Eclipse Tools v5.2.4 (35 novedades, 17k caracteres) se cortaba después de la intro en los 3 canales.
- `deploy.py` y `publish_tool.py` esperan hasta 10 min al script de anuncios (antes 60 s, poco para un anuncio partido en muchos mensajes).

## 2026-09-27 (Seguridad: exclusivos.json)

- `POST /api/admin/exclusive-direct-link` aceptaba una sesión de cualquier cuenta pública de la web: cualquiera que se registrara podía escribir `exclusivos.json`. Ahora exige sesión del formulario (scope `form`), el mismo nivel que ya se pide para escribir `juegos.json`. F95Pipeline pasó a usar ese login; antes fallaba siempre porque sus credenciales no eran de una cuenta pública.

## 2026-09-27 (Bot: borrar mensajes con el token de F95)

`senpaibot/WebServer.py`: `/api/announce` ahora devuelve el `message_id` del mensaje enviado, y `/api/delete-message` acepta el header `X-F95-Token` (antes solo servía con la sesión del panel). Permite que los scripts externos (pruebas de canales, AnnounceUpdate) borren lo que mandan.

## 2026-09-27 (Vistas: D1 en vez de GitLab)

- Las vistas de juegos y mangas se contaban bajando `stats/views_data.json` de GitLab, sumando en el navegador y subiendo el archivo entero: las visitas simultáneas se pisaban (había 1.956 vistas en total), cada visita era un commit y cualquiera podía escribir ese archivo por `/api/gl/*`.
- Ahora `home.js` manda cada visita (una por juego por sesión) con `sendBeacon` a `POST /api/view`, que la guarda en la base D1 `ez-views` (binding `EZ_VIEWS_DB`) con un UPSERT atómico. Nada se pisa.
- `GET /api/views`: totales (tabla `view_totals`, sembrada con las 1.957 vistas previas). `GET /api/views/top?hours=24`: los más vistos (tabla `view_hourly`; lo usa el bot para el juego del día). Un cron diario (00:10 ARG) borra los buckets por hora de más de 8 días.
- `stats/views_data.json` bloqueado en el proxy abierto.
- Primero se hizo con Workers Analytics Engine, pero leerlo exige un API token de Cloudflare que no se pudo crear. Se pasó a D1, que el Worker usa directo sin tokens (gratis: 100k filas escritas/día, 2 por visita). Las vistas contadas en AE durante esas horas se perdieron.
- `wrangler.toml`: `keep_vars = true` para que las variables cargadas en el dashboard no se borren en cada deploy.
- El generador escribe `public/slugs.json` (título → slug real de la ficha) para que el bot enlace sin adivinar slugs.
- Fix: entrar directo a una ficha (`/juego/slug/`, lo que llega desde Google o Discord) no contaba la vista: `home.js` solo se cargaba en la portada y `registerGameView` no existía en la ficha. Ahora `home.js` también carga en `juego` y `juegos`.

## 2026-09-27 (Bot: canal Ren'Py anuncia cada juego, hito cada 10)

`ScheduledPublishCog` (`senpaibot/cogs.py`): cada programado también se anuncia (link directo) en el canal de su motor (Ren'Py, Unity/Godot, RPG Maker, vía `_MOTOR_MILESTONE_MAP`), y el hito de Ren'Py pasa de cada 5 a cada 10 (`_MILESTONE_RENPY_UMBRAL`; clave `renpy_x5` se mantiene para no perder el contador). En sync con `F95Pipeline/f95_publish.py`.

## 2026-09-27 (Fix: pendientes de acortador daba "Ruta no encontrada")

`admin/juegos/pendientes.js` postea a `eclipsezonehub.com/api/f95-brandon-complete`, pero esa ruta vive en el bot (`WebServer.py`), no en el Worker, así que respondía 404 "Ruta no encontrada". Nuevo `proxyBrandonComplete` en `worker.js`: reenvía el POST (con `X-Brandon-Token`) a la URL del bot resuelta desde `railway_url.json`, igual que `proxyAiFill`.

## 2026-09-26 (Mangas: pestañas Eclipse Mangas / MangaDex / Favoritos)

- Mangas ahora tiene 3 pestañas, igual que Juegos: **Eclipse Mangas** (abre por defecto), **MangaDex** (lo que antes era "Todos") y **Favoritos**. Cada pestaña tiene su propia grilla (`#eclipseMangaGrid`, `#mangaGrid`, `#favMangaGrid`), así una carga de MangaDex en segundo plano no pisa lo que se ve en otra.
- Eclipse Mangas lee `eclipse_mangas.json` (GitLab `senpai1940/juegos`, vía Worker). Mientras no exista o esté vacío, muestra "Próximamente". Detalle y lector reusan los paneles de MangaDex (`showEclipseMangaDetail`, `openEclipseChapter`; `nextChapter`/`prevChapter` delegan en `eclipseStepChapter` cuando el capítulo es propio). Favoritos propios en `localStorage.eclipseMangaFavorites`. La carga desde el panel queda para más adelante.
- MangaDex (etiquetas y listado) se carga recién al abrir su pestaña, no al entrar a la web. Búsqueda, filtros y orden se ocultan en Eclipse y Favoritos.
- Fix: Favoritos filtraba solo la página de MangaDex cargada, así que los favoritos de otras páginas no aparecían. Ahora se piden por id (`/manga?ids[]=`).
- Reproductor de música: en celular (≤480px) pasa a la esquina de abajo, sobre la barra de navegación. Arriba tapaba las pestañas de Mangas y los filtros. Si el visitante ya lo había arrastrado, se respeta esa posición.

## 2026-09-26 (Calidad de vida: bienvenida, música, imágenes y títulos)

- Bienvenida (`onboarding.js`): ahora solo aparece en la portada (`/`), no al entrar directo a `/juegos/`, `/mangas/`, etc.
- Música (`radio.js`): ya no arranca sola con el primer clic. Por defecto queda pausada y solo suena si el visitante tocó play alguna vez (`eclipseZoneRadioPaused` = "0").
- Portada (`home.js`): las imágenes del carrusel y las portadas de mangas llevan `loading="lazy"`. Las 5 del carrusel (hasta 350 KB cada una) se bajaban siempre, aunque estuvieran fuera de pantalla.
- Plataformas: 161 juegos guardan `plataforma` (singular) como array (F95Pipeline/auto_upload), pero el generador solo esperaba `plataformas`. El array quedaba anidado y el título salía como "X Español APK" aunque el juego fuera de PC y Android. Nuevo `plataformasDe()` en generate-everything.js; `seoGameTitle` (main.js) ahora replica exactamente el título del generador (antes usaba otro formato, "X para PC,Android en Español"), y la ficha muestra "PC, Android".
- Versión en el título: la "v" se agrega solo si la versión empieza con un número ("S2 v10.0.1" ya no sale como "vS2 v10.0.1").

## 2026-09-26 (Panel: pendientes de Brandon con el flujo nuevo)

`admin/juegos/pendientes.js`: completar un pendiente manda `{id, acortadorPc, acortadorApk}` al bot, que es el único que postea y saca entradas de la lista; el panel recarga la lista en vez de guardarla. Cada tarjeta muestra el tiempo que queda de las 24 h (pasado ese plazo el bot lo anuncia con el acortador propio). Textos actualizados en `index.html`.

## 2026-09-26 (Worker: proxy de contadores de hitos para el bot)

Nueva ruta `GET/PUT /api/gh-bot/milestone-counters` (solo `X-Bot-Token`, con rate limit), que apunta a `senpai1940/milestone_counters.json`. La usa `ScheduledPublishCog` para sumar los juegos programados a los hitos de Discord. `proxyGithubPendientesBrandon` ahora acepta `opts.targetApi` para reusarse en esta ruta sin duplicarla; la ruta de pendientes de Brandon no cambia.

## 2026-09-22 (Reproductor de música flotante — port de Eclipse Launcher/Tools)

Parte 4 pendiente del pedido original ("más movimiento, más sincronización, más animaciones, que se distinga" + reproductor). Portada la misma mecánica ya usada en Eclipse Launcher (`launcher.js`) y Eclipse Tools (`app.js`, versión web de referencia usada acá por tener el HTML/CSS ya pensado para navegador): reproductor flotante con playlist fija, autoplay-gate (el primer intento de reproducir sin gesto real del usuario casi siempre lo bloquea el navegador — se reintenta con el próximo click/touch en cualquier parte del sitio), fade-in de volumen, botones pausar/siguiente, y posición arrastrable persistida en `localStorage`.

Nuevo: `js/radio.js` (playlist `ECLIPSE_RADIO_TRACKS`, `initEclipseRadio`, `wireRadioWidgetDrag` — mismo código que Tools, IDs con prefijo `eclipse-` para no chocar con nada existente). HTML del widget (`#eclipse-radio-widget`, `<audio id="eclipse-bg-audio">`) agregado a `index.html` fuera de las secciones que el router de la SPA oculta/muestra — por eso el audio sigue sonando al navegar entre Inicio/Juegos/Mangas/Noticias sin cortarse (decisión tomada con el usuario). CSS con las variables del tema (`--primary`, `--card-bg`, etc., nunca colores fijos — hay ~40 temas). Cargado en el grupo lazy `"idle"` (mismo mecanismo que analytics/onboarding/social-popup) y agregado a la lista de `Disallow` de `robots.txt` (no participa del render SEO-crítico, mismo criterio que esos otros scripts).

Verificado en Chrome real contra build local: el widget aparece, carga la primera pista, "Siguiente" cambia de tema, "Pausar/reproducir" pausa el audio real (`audio.paused`), y la pista sigue sonando igual al navegar Inicio → Juegos → Mangas sin recargar el documento.

## 2026-09-22 (Fix: /juegos/, /mangas/, /noticias/ quedaban en blanco al navegar entre secciones sin recargar)

Bug reportado por el usuario y reproducido en vivo (Chrome real, paso a paso): navegando entre secciones vía los botones del nav (`showGames`/`showMangas`/`showNews`, SPA client-side con `history.replaceState`, sin recargar el documento), la sección de destino quedaba en blanco o con estado mezclado de la sección anterior — pero recargar la página en la sección actual siempre la arreglaba. Patrón reportado: "solo funciona la página en la que recargué, las demás no".

Causa: `pageLoader.js` carga los scripts de cada sección (grupos `juegos`/`manga`/`noticias`) de forma lazy, pero **solo para el grupo que corresponde al `data-page` del HTML inicial**, una sola vez al cargar el documento. Como `showGames`/`showMangas`/`showNews` nunca disparaban la carga de scripts de la sección destino, si el usuario nunca había recargado el documento estando en esa sección, sus funciones de carga (`loadMangasContent`, `loadNoticiasContent`) no existían — quedaba el stub `console.warn("manga.js no cargado")` o directamente no se llamaba a nada.

Fix: `js/main.js` ahora expone `loadGroupSequential` globalmente (agregado a `js/pageLoader.js`) y `showGames`/`showMangas`/`showNews`/`showHome` cargan bajo demanda el grupo de scripts + disparan la función de carga de esa sección si todavía no tiene datos — mismo patrón que ya usaba `ensureDiscordPanel` para el panel de Discord. Encontrado y corregido en el camino: el primer intento pasaba el nombre de grupo completo (`"juego juegos"`, `"noticia noticias"`) al helper, pero el selector de `pageLoader.js` usa `[data-lazy-for~="grupo"]` (coincidencia de una sola palabra) — corregido a pasar solo `"juegos"`/`"noticias"` (la palabra que efectivamente matchea). Faltaba también `showHome` (`generateHomePanel` del grupo `"home"`) — reportado por el usuario tras el primer verificado ("juegos/mangas/noticias ya anda, falta inicio"), mismo mecanismo, mismo fix.

Verificado en Chrome real contra un build local (`python -m http.server` sirviendo `public/`): ciclo completo juegos → mangas → noticias → juegos → inicio sin recargar el documento, las 4 secciones cargan contenido real (cards/títulos visibles, sin blanco ni mezcla de estados).

## 2026-09-21 (v2.10.0 — Novedades para el usuario: animaciones, Exclusivos por género, sin Adsterra)

Se armó y publicó la entrada v2.10.0 en el sistema real de `/novedades` (`CHANGELOG` de `js/discord-settings-panels.js`, distinto del modal "Cambios del sitio" de `js/site-updates.js` que también existe en el sitio) — quedó desactualizado en v2.9.0 (10-sep) pese a varios cambios user-facing deployados después. `EZ_VERSION` bumpeado a `"2.10.0"` en `js/discord-settings-core.js`.

Items incluidos (redactados sin jerga técnica, a pedido del usuario, seleccionados de entre todo lo deployado el 21-sep): animaciones nuevas del sitio (nav/cards/modal/identidad visual), sección Exclusivos de Patreon ahora también por género completo, eliminación total de Adsterra, y mención de que el sitio carga más rápido/liviano (consecuencia indirecta del fix de robots.txt de SEO). Quedaron afuera a propósito los fixes internos de admin/backend (401 de Pendientes, acortadores, autocompletar con IA, cache de GitLab) — no los nota el usuario final.

## 2026-09-21 (Más animaciones/movimiento en el sitio público — nav, cards, modal, identidad visual)

Pedido del usuario: "más movimiento, más sincronización, más animaciones, que se distinga". Cubiertas las 4 áreas posibles a pedido explícito (no un subconjunto): micro-interacciones, cards/listados, navegación, identidad visual.

- **Micro-interacciones**: bounce en el ícono de corazón al marcar/desmarcar favorito (`favBounce`, `js/juegos-detail.js` + `css/juegos.css`); tap feedback (`scale(.88)`) en los botones del bottom-nav.
- **Cards**: entrada escalonada (`gameCardIn`, delay por índice hasta 12) al renderizar el grid de juegos; hover más marcado (`translateY(-6px) scale(1.015)` + halo con `var(--primary-rgb)`).
- **Navegación**: indicador deslizante (`mobileNavIndicator`) que se posiciona con `getBoundingClientRect` sobre el botón activo, enganchado a `_setActiveNav` (el mecanismo real de nav activa en `index.html`, no `updateNavButtons()` de `main.js` que es código muerto); apertura/cierre animado del modal de detalle de juego (`detailModalIn`/`detailModalOut`), con `closeGameDetail()` reescrito para animar la salida antes del `.remove()` real, con timeout de seguridad que nunca bloquea el cierre.
- **Identidad visual**: el glow (`logoPulse`) y el shimmer de texto (`shimmerText`) del logo, que ya existían sin protección, se envolvieron en `@media (prefers-reduced-motion: no-preference)` con estado final estático correcto fuera de la media query.

Regla aplicada a todo lo nuevo: ningún estado visible final depende de que una animación corra o termine (mismo criterio del incidente de julio con `discord-friends.css`). Verificado en Chrome real (`mcp__claude-in-chrome`, nunca el pane in-app que congela timelines): motion normal y con `prefers-reduced-motion` forzado (media query real vía el toggle `body.reduced-motion` del sitio + `matchMedia` forzado para la rama JS de `closeGameDetail`) — nada quedó invisible, congelado ni con clases colgadas. Sin errores de consola en ningún flujo probado. No deployado todavía — pendiente confirmación del usuario.

## 2026-09-21 (Panel admin unificado + sistema de juego/género exclusivo de Patreon reconstruido de raíz)

Pedido del usuario: UI de admin con todo lo de admin en un solo lugar, más la posibilidad de marcar contenido "solo Patreon" no solo por juego individual sino por género/categoría completa. Explorando el código se encontró que **el sistema de "juego exclusivo Patreon" ya existente estaba roto de punta a punta desde el 2026-08-04**: el Worker eliminó `/api/admin/exclusive-link` (y variantes) ese día, pero nada del frontend se limpió — `scripts/set-exclusive-link.js` (única forma de cargar el link real de un juego exclusivo) llamaba a un endpoint inexistente, y el panel `#exclusiveLinkPanel` de `admin/juegos/` aparentaba funcionar sin hacer nada. Ningún juego marcado exclusivo pudo haber tenido un link de descarga real funcionando en más de un mes.

En vez de reparar el endpoint viejo, se terminó una migración que había quedado documentada pero nunca implementada (comentario de worker.js): el checkbox "Juego exclusivo de Patreon" del formulario normal ahora guarda el juego completo (links incluidos) en `exclusivos.json` en vez de `juegos.json` con links vacíos — sin panel aparte, sin tokens manuales. `admin/juegos/form.js` (`loadGames`/`saveGame`/`deleteGame`) reescrito para leer/escribir ambos archivos según corresponda; `scripts/set-exclusive-link.js` y el panel `#exclusiveLinkPanel` (+ sus funciones muertas en `auth.js`) eliminados.

Nuevo: género/categoría completa marcable como "solo Patreon" (decisión del usuario: visible pero bloqueado, no oculto). `patreon-config.json` (nuevo archivo en el mismo repo de datos) guarda la lista; `worker.js` expone `GET/POST /api/admin/patreon-genres` (protegido, mismo `requireCommentsAdmin` que dashboard/reportes) y `GET /api/patreon-genres` público con cache de 5min. Nuevo panel `/admin/patreon/` (mismo esqueleto visual que los otros 4) para tildar categorías. `isGameLocked(game)` en `juegos-core.js` combina ambos mecanismos (flag individual O género en la lista). Cards bloqueadas muestran un candado (`bi-person-lock`) y oscurecen la imagen (`juegos-render.js`/`juegos.css`); la ficha de detalle (`juegos-detail.js`) oculta los links reales y pide conectar Patreon hasta verificar `EzPatreon.checkConnected()`.

Navegación cerrada entre los 5 paneles de admin (antes `admin/juegos/` no linkeaba de vuelta a `admin/dashboard/`). Bug encontrado y arreglado durante la verificación: `admin/` no estaba en `staticDirs` de `generate-everything.js` — el panel nuevo (y cualquier cambio futuro a los otros 4) nunca se hubiera copiado a `public/` en el próximo deploy; agregado. Segundo bug encontrado y arreglado: el ícono usado para el candado (`bi-lock-fill`) no existe en el subset local de Bootstrap Icons que sirve el sitio (`vendor/bootstrap-icons/`, 131 íconos recortados) — reemplazado por `bi-person-lock`, que sí está incluido. Verificado end-to-end en Chrome real (candado visible + oscurecido en card, gate de "Conectá con Patreon" en ficha, desbloqueo real con `checkConnected()` mockeado mostrando los links). No deployado todavía — pendiente confirmación del usuario para `wrangler deploy` (Worker) + `python scripts/deploy.py --pages`.

## 2026-09-21 (SEO — CSS no-crítico bloqueado a Googlebot; diagnóstico actualizado de indexación)

Re-diagnóstico completo en Search Console (el de julio había quedado desactualizado — el usuario reportó "perdí la guerra contra Google index otra vez"). Estado real verificado: **49 indexadas / 682 sin indexar** — peor que el pico de julio (109/615), y "Estadísticas de rastreo" mostraba **86% del crawl en "carga de recursos de página"** (JSON 32% + JS 29% + CSS 18% = 79%) vs solo 16% HTML — peor que el 66%/30% de julio. `site:eclipsezonehub.com/categoria/` da CERO resultados (0 de 107 páginas de categoría indexadas); `site:eclipsezonehub.com/juego/` casi ninguna de las 575.

Causa dominante confirmada: **557 de 682 páginas (82%) están en "Descubierta: actualmente sin indexar"** (validación "Correcto" — no es un error técnico, es Google decidiendo no gastar presupuesto de rastreo en ellas). Las otras dos causas ("Página con redirección": 18, "No se ha encontrado 404": 14) son errores reales pero chicos en comparación.

Hallazgo nuevo no cubierto en julio: el JS ya se lazy-carga por sección desde julio (`pageLoader.js`, `data-lazy-for`), pero el **CSS nunca recibió el mismo tratamiento** — las 16 hojas de `index.html` (~184KB) cargan sin condición en las 700+ páginas del sitio. Una ficha de `/juego/` carga también `home.css`, `manga.css`, `noticias.css`, `discord-settings.css`, `discord-friends.css`, `onboarding.css`, `social-popup.css` (~94KB) que no usa nunca.

Fix aplicado (paso 1, rápido y de bajo riesgo — mismo patrón que ya existía para JS): se agregaron 7 `Disallow` en `robots.txt` (generado desde `generate-everything.js`) para los CSS no-críticos de sección/paneles nunca visibles al cargar. Cada archivo se verificó standalone antes de bloquearlo (selectores propios, sin depender de layout global) — única excepción conocida: `discord-settings.css` define `.nav-acct-avatar`/`.nav-acct-status` (avatar de cuenta en la navbar móvil, visible en toda página), trade-off cosmético aceptado igual que ya se hizo con `discord-friends.js` en julio. Solo afecta a crawlers — usuarios reales ignoran robots.txt y siguen recibiendo el CSS normal vía `<link>`.

Deployado (`python scripts/deploy.py --pages`), verificado en producción. **Pendiente (paso 2, más trabajo)**: lazy-load real de CSS por sección (no solo bloqueo a crawlers) — mejoraría también velocidad real para usuarios, no solo crawl budget, pero con más riesgo de romper estilos si algo depende de un CSS "no crítico" que en realidad sí se usa en esa página. Efecto del fix de robots.txt no es inmediato — Google necesita volver a leer el archivo y ajustar su comportamiento de rastreo en los próximos días/semanas; hay que volver a chequear Search Console para confirmar impacto real.

## 2026-09-21 (Anuncios Adsterra eliminados por completo del sitio)

No daban ingresos reales, solo molestaban a los usuarios — se sacó todo el sistema, no solo se desactivó. Eliminados: `js/ads-adsterra.js`, `js/anti-adblock.js` (el wall que nagueaba a quien tenía adblock) y `css/ads.css`. Quitados todos los puntos de enganche en `index.html` (contenedores `.ez-ad`: banner de home, banner+native de juegos, banner de noticias, banner de detalle de juego) y en JS (`js/main.js`, `js/juegos-detail.js`, `js/juegos-render.js`, `js/noticias.js`): banner/native/social-bar por sección, popunder + smartlink al descargar o marcar favorito, in-grid banners cada 12 juegos, banner de detalle de noticia (generado dinámicamente en `noticias.js`). Limpiadas también las entradas `Disallow: /js/ads-adsterra.js` y `Disallow: /js/anti-adblock.js` de `robots.txt` (generado desde `generate-everything.js`) — ya no aplica, los archivos no existen. El link/botón de Patreon (apoyo del proyecto, no es un ad network de terceros) se dejó intacto a pedido explícito. Build local verificado sin errores ni referencias sueltas antes de desplegar. Deploy con `python scripts/deploy.py --pages` — no requirió tocar el Worker.

## 2026-09-21 (Panel admin: 401 en Pendientes, imágenes rotas, acortador PC+Android separado, Autocompletar con IA roto por Railway obsoleto)

**401 en `pendientes_brandon.json`**: el `GITHUB_TOKEN` secret del Worker estaba vencido/inválido (GitHub devolvía "Bad credentials", no era un problema de `requireSession`). Se roteó el token (`wrangler secret put GITHUB_TOKEN`, valor verificado antes por el usuario con `curl` propio).

**Imágenes rotas y entradas obsoletas en Pendientes**: `pendientes.js` hotlinkeaba `item.imagen` (URL de attachment de F95zone) en vez de pasar por el proxy `/api/img` ya existente — corregido el `<img src>`. Se limpiaron del JSON los juegos que ya no aplican, dejando `historial_hoy` intacto. Nota aparte: la imagen quedó "arreglada pero seguía viéndose rota" hasta bumpear el cache-buster (`pendientes.js?v=3`→`v4`) — el navegador cacheaba el JS viejo aunque el origin ya tenía el fix.

**"Copiar link para acortar" le daba a Brandon el link del hilo de F95 en vez de un link descargable**: causa raíz en `F95Pipeline/f95_publish.py` — `_queue_pending_for_brandon()` nunca recibía/guardaba los links propios de PC/Android (`linkPc`/`linkApk`), solo `thread_url`. Se conectaron esos valores (ya disponibles en el caller) y ahora se guardan en `pendientes_brandon.json`; el frontend muestra botones de copiar por plataforma cuando existen, con el link de F95 solo como fallback para entradas viejas.

**Pegar el acortador de Android y luego el de PC borraba el de Android (y Publicar/Programar dejaban de andar)**: un solo `<input>` compartido servía para ambas plataformas. Se separó en dos campos independientes (`pendienteAcortadorPc-N` / `pendienteAcortadorApk-N`) en `pendientes.js`, threadeados hasta el endpoint `/api/f95-brandon-complete` del bot (`senpaibot/WebServer.py`, acepta `acortadorPc`/`acortadorApk` con fallback al campo viejo `acortador`). Verificado en desktop y mobile. **Pendiente**: el cambio en `WebServer.py` vive en el repo pero necesita un redeploy del servicio en Railway para tomar efecto ahí.

**"Autocompletar con IA" roto (reportado como error de CORS)**: el error de CORS era síntoma, no causa — `admin/juegos/form.js` tenía hardcodeada una URL de Railway del bot (`web-production-b83ff.up.railway.app`) que había quedado obsoleta tras una rotación de cuenta Railway. Fix: nuevo proxy `/api/ai-fill-proxy` en `worker.js` que resuelve la URL vigente del bot leyendo `railway_url.json` en GitHub (mismo mecanismo ya usado por `F95Pipeline`/`AnnounceUpdate` del lado Python) antes de reenviar el POST con el token inyectado server-side. `form.js` ahora pega contra el proxy, no contra Railway directo — nunca más una URL de Railway hardcodeada en JS público. Verificado end-to-end en la UI real del formulario.

**Home/fichas de juego: "a veces carga todo, a veces no aparece nada" (juegos y mangas)**: causa raíz — `proxyGitlab()` en `worker.js` no cacheaba nada. Cada carga de página (home + las 700+ fichas, todos los visitantes) pegaba en vivo a la API de GitLab por `juegos.json`/`noticias.json`, todos compartiendo el mismo `GITLAB_TOKEN` del Worker. Cualquier lentitud/429/5xx transitorio del lado de GitLab dejaba a esa visita puntual sin contenido — `fetchWithFallback()` (main.js) ya reintenta con una 2da fuente, pero ambas fuentes terminan pegándole al mismo GitLab, así que un mal momento de GitLab tumbaba las dos por igual. Fix: cache de 90s en el Worker (Cache API de Cloudflare) para los GET no autenticados de `/api/gl/*` — no afecta `/api/gl-auth/*` (formulario) ni `/api/gl-bot/*` (bot), que siempre ven el dato más fresco. Verificado en producción (`Cache-Control: public, max-age=90` en la respuesta).

## 2026-09-10 (v2.9.0 — release de los fixes del 2026-09-08, nunca versionados)

Los 12 cambios del 2026-09-08 (ver entradas abajo) quedaron documentados acá pero nunca se reflejaron como versión nueva: ni en `EZ_VERSION` (`js/discord-settings-core.js`) ni en el array `CHANGELOG` que alimenta `/novedades` (`js/discord-settings-panels.js`) — ambos seguían en v2.8.0 (29 de julio). Se bumpeó `EZ_VERSION` a `"2.9.0"` y se agregó la entrada correspondiente al array `CHANGELOG` con los 6 puntos más visibles para el usuario (aviso de juego inexistente, ficha sin delay, preview de Discord/redes arreglado, logo duplicado, "Destacado del día" repetido, y rendimiento general — resumen de la minificación + purge de Bootstrap del 2026-09-08).

También se corrigió `scripts/deploy.py`: `_anunciar_en_discord()` resolvía el path a `AnnounceUpdate/announce_update.py` como si `Eclipse-Source/` estuviera DENTRO de `eclipse-main/` (`parents[1]`) — en realidad son carpetas hermanas dentro de `General/`, así que el anuncio automático de Main nunca se disparaba (fallaba en silencio, sin abortar el deploy). Ahora usa `parents[2]`. De paso se agregó `--version` (requerido junto con `--changelog`) porque el intro real de Main menciona la versión explícitamente ("la versión vX.X.X del eclipse zone ya fue liberada") — antes el script no tenía forma de pasarla.

## 2026-09-08 (Content-Security-Policy en modo Report-Only)

Faltaba un header CSP (el resto de headers de seguridad ya estaban bien: X-Frame-Options, HSTS, nosniff, Permissions-Policy). Se agregó `Content-Security-Policy-Report-Only` en `_headers` (generado desde `generate-everything.js`) — no bloquea nada todavía, solo reporta violaciones en la consola del navegador, porque el sitio usa bastante inline script/style y varios orígenes externos (ads, MangaDex, APIs de geolocalización de fallback) que había que verificar antes de aplicar la política real.

Verificado en producción navegando la home: apareció una sola violación — un script de un ad network (`effectivecpmnetwork.com`) intentando modificar el `<base>` del documento (`base-uri`), algo que normalmente no debería hacer un script de anuncios legítimo y que un CSP real bloquearía correctamente. No se detectaron falsos positivos de funcionalidad propia del sitio.

Pendiente: seguir observando la consola en distintas páginas (juego, manga, comentarios, checkout de descargas) antes de decidir pasar de `-Report-Only` al header real `Content-Security-Policy` que sí bloquea.

## 2026-09-08 (Ícono PWA 192x192 corregido + logging de errores JS del cliente)

El manifest (`manifest.json`) tenía `Eclipse.png` etiquetado como ícono de `512x512 maskable`, pero el archivo real es de 3000x1700 (no cuadrado) — Android/Chrome recortaban mal o mostraban el ícono genérico al instalar la PWA. Tampoco había ningún ícono de 192x192 (el tamaño estándar que Android espera además del maskable). Se generaron `icon-192.png` e `icon-512.png` reales a partir de `favicon.png` (500x500, sí es cuadrado) y se actualizó `CONFIG.pwaManifest.icons` en `generate-everything.js` para usarlos. Agregados a `CONFIG.staticFiles` para que el build los copie a `public/`.

También se agregó manejo global de errores JS no capturados en el cliente (`js/main.js`): listeners de `window.onerror`/`unhandledrejection` que mandan un POST a `/api/report-js-error` (nuevo endpoint en `worker.js`) con mensaje, archivo, línea y stack. El worker agrupa por hash de `mensaje|archivo|línea` en KV (`jserror:<hash>`, TTL 30 días) para que un mismo error repetido en muchos usuarios sume un contador en vez de generar entradas infinitas — sin envío de email (a diferencia de `reportBrokenLink`) para evitar spam si un error se dispara en bucle. Limitado a 10 reportes por carga de página como tope adicional del lado del cliente. Antes, cualquier error de JS en producción se perdía silenciosamente salvo que un usuario avisara manualmente.

## 2026-09-08 (Links externos sin rel=noopener + autocomplete en formularios de cuenta)

Revisando seguridad general: 5 links `target="_blank"` (Discord en `discord-settings-account.js` y `discord-settings-panels.js`, YouTube y Patreon en `discord-settings-panels.js`, y el botón de perfil del uploader en `index.html`) no tenían `rel="noopener"` — riesgo de "reverse tabnabbing" (la pestaña abierta puede manipular `window.opener` de la original). El resto de los `target="_blank"` del sitio (home.js, juegos-detail.js, social-popup.js) ya lo tenían bien. Agregado a los 5 que faltaban. De paso se corrigió un `class="ds-btnds-btn-ghost"` (sin espacio, dos clases pegadas) que quedó al hacer el cambio en el link de YouTube.

También se agregó `autocomplete` a los inputs de email/contraseña del modal de cuenta (`index.html`): `username`/`current-password` en login, `email`/`new-password` en registro y en reset de contraseña. Ayuda a que los password managers autocompleten/sugieran mejor; antes no tenían el atributo.

## 2026-09-08 (Link de juego roto/eliminado caía en la home sin ningún aviso — 404.html sin data-page)

Al revisar la página 404, se encontró que `/juego/<slug-que-no-existe>/` (el caso típico: F95Zone cambia una URL, o el juego se elimina del catálogo) devolvía el status HTTP 404 correcto, pero visualmente el usuario terminaba viendo la home cargar normal, sin ningún mensaje de que el link estaba roto. Causa raíz encadenada:

1. Cloudflare Pages sirve `404.html` para cualquier ruta sin archivo físico — hasta ahí es correcto.
2. Pero `404.html` se generaba como copia directa del template sin pasar por `buildHTML()`, así que le faltaba el atributo `data-page="juego"` que sí tienen las páginas de juego reales.
3. `js/pageLoader.js` decide qué scripts `data-lazy-src` cargar leyendo `document.body.dataset.page` — sin ese atributo, nunca carga `juegos-core.js`, y `handleGameRoute()` se queda siendo el stub vacío que define `main.js` como placeholder (`"handleGameRoute no implementado aún"`) mientras el archivo real no cargó.
4. Sin `handleGameRoute()` real, nada procesa la ruta `/juego/...` ni informa que el juego no existe — la SPA simplemente se queda en el estado inicial (home), sin errores visibles.

Fix: `404.html` ahora se genera con `data-page="juego"` (en `generate-everything.js`, al escribirlo). De paso, se agregó en `handleGameRoute()` (`js/juegos-core.js`) un `showToast("El juego que buscás no existe o fue eliminado", "error")` para el caso en que el slug no matchea ningún juego — antes ese camino solo redirigía a `/` en silencio. Verificado en producción con varios slugs inexistentes: ahora aparece el toast y navega al listado de juegos.

## 2026-09-08 (Delay artificial al abrir una ficha de juego por URL directa + comments.js duplicado)

Reportado por el usuario: al probar PageSpeed contra el link de un juego, la captura mostraba la home/listado en vez de la ficha pedida. Investigado: no es un bug del servidor (`curl` a `/juego/<slug>/` devuelve el HTML correcto con `__GAME_DATA__` embebido, sin redirect). La causa real está en `handleGameRoute()` (`js/juegos-core.js`): al cargar por URL directa, primero llama `showGames()` (pinta el listado de fondo) y recién 50-100ms después, vía `setTimeout`, abre el modal de la ficha (`showGameDetails`). En una carga normal ese delay es imperceptible, pero con el throttling de CPU que usa PageSpeed (4x-6x) se estira lo suficiente como para que la captura caiga en el medio y muestre el listado en vez de la ficha — y lo mismo le puede pasar a un usuario real con CPU/conexión lenta.

Los datos (`allGames`, `__GAME_DATA__`) ya están disponibles en el momento en que `handleGameRoute()` corre (se llama al final de `loadJuegosContent()`, después de poblar `allGames`), así que el `setTimeout` no protegía ninguna condición de carrera real — era un delay puramente artificial. Se eliminaron ambos `setTimeout` (el del camino con `__GAME_DATA__` prerenderizado y el del camino de fallback buscando en `allGames`), llamando `showGameDetails()` directamente. Verificado visualmente en local y en producción: la ficha aparece de inmediato al entrar por URL, sin flash del listado de fondo.

De paso, se encontró que `js/comments.js` estaba referenciado dos veces en `index.html`: una vez con `data-lazy-src` condicionado a `juego`/`juegos` (correcto), y otra vez con `<script src="/js/comments.js">` sin condición, cargándose siempre en TODA página del sitio (home, noticias, mangas) aunque solo se usa en fichas de juego. Se eliminó la segunda referencia incondicional — ahora `comments.js` solo se carga donde corresponde.

## 2026-09-08 (og:image en AVIF rompe el preview de link en Discord/Twitter/Facebook)

Detectado al revisar por qué el preview de un juego al compartir el link no se veía en algunas plataformas: `/api/img` (el proxy de imágenes del worker) hace passthrough del `Content-Type` del origen tal cual, y F95Zone sirve sus imágenes en AVIF por defecto (sin negociar por `Accept`, se confirmó con curl). AVIF es buen formato para el sitio en sí (navegadores modernos lo soportan y pesa menos), pero Discord/Twitter/Facebook mayormente no lo soportan para generar la preview de un link compartido (Open Graph).

Fix: `worker.js` → `proxyImage()` ahora acepta `&format=jpeg` como parámetro opt-in que activa `cf.image` (Cloudflare Image Resizing) en el `fetch()` al origen, forzando la respuesta a JPEG — sin tocar el comportamiento normal del proxy (que sigue sirviendo AVIF/lo que traiga el origen para el resto del sitio). `generate-everything.js` agrega `&format=jpeg` automáticamente solo al armar `og:image`/`twitter:image`. La key de KV se separó para no mezclar la variante JPEG con la cacheada normal.

**Pendiente de acción manual, no resuelto todavía**: `cf.image` requiere tener "Image Resizing" habilitado en el dashboard de Cloudflare (Speed → Optimization), lo cual puede implicar costo según el plan — no es algo activable por código. El código ya está desplegado y listo; falta que se habilite esa opción en el dashboard para que la transformación realmente tome efecto (se verificó con la ausencia del header `Cf-Resized` que hoy no está activa).

## 2026-09-08 (Script de minificación guardado como herramienta reutilizable)

La minificación de `js/*.js` y `css/*.css` (ver entrada de más abajo) se hizo con un script one-off en el scratchpad de la sesión. Se guardó como `scripts/minify.js` (terser + clean-css, misma configuración: `mangle:false` para JS) para poder re-minificar a mano cuando se edite algo en `js/`/`css/` en el futuro, en vez de tener que rearmar el script de cero. No se integró a `generate-everything.js`: `js/`/`css/` ya son la fuente minificada directamente (no hay una copia legible aparte guardada), así que minificar en cada build minificaría algo ya minificado sin beneficio y complicaría el debugging. Correr `node scripts/minify.js`, reconstruir, verificar visualmente y recién ahí desplegar.

## 2026-09-08 (CSS duplicado por @import redundante en style.css — causa real de la "duplicación" de PageSpeed)

Al minificar CSS (ver entrada siguiente), `clean-css` tiró warnings de `@import` apuntando a archivos "faltantes" — reveló que `css/style.css` todavía tenía 5 `@import url(...)` (`themes.css`, `themes-contrast.css`, `home.css`, `juegos.css`, `noticias.css`) sobrantes de cuando `style.css` era el único `<link>` del HTML. Cuando en una sesión anterior se agregó el `<link>` directo de cada uno de esos 5 archivos en `index.html` (fix de "CSS huérfano"), nadie sacó los `@import` correspondientes — cada uno de esos archivos se descargaba y parseaba DOS veces por carga de página, con el costo extra de que `@import` es render-blocking en cascada.

Esto es la causa real de la "duplicación" de CSS que PageSpeed había marcado y que en la auditoría del 2026-09-07 se descartó como falso positivo de caché del navegador — diagnóstico equivocado en su momento (solo se verificó que la HTML de producción tuviera un solo `<link>` versionado por archivo, sin revisar si algún CSS se auto-importaba a sí mismo vía otro). Corregido: se eliminaron los 5 `@import` de `style.css` (el orden de los `<link>` en `index.html` ya coincidía con el orden de esos `@import`, así que no cambia la cascada final). Verificado en producción tras el deploy: cada CSS ahora aparece una sola vez en Network con su hash `?v=` correspondiente.

## 2026-09-08 (Minificación de JS/CSS propios del sitio)

Pendiente de la auditoría PageSpeed: los 30 archivos de `js/*.js` y 16 de `css/*.css` propios del sitio se servían sin minificar. Minificados con `terser@5` (JS, `mangle: false` — deliberado: son scripts clásicos no-módulo que comparten scope global entre sí en secuencia, y el mangling de nombres podría romper referencias cruzadas entre archivos que terser no puede ver al procesar cada uno por separado) y `clean-css@5` (CSS, `level: 1`, conservador). Resultado: JS 623.3 KiB → 418.5 KiB (-32.9%), CSS 261.4 KiB → 180.7 KiB (-30.9%), sin errores de minificación (tras arreglar el `@import` de la entrada anterior, que antes generaba warnings).

Verificado antes de aplicar a producción: copia de `public/` con JS/CSS minificados servida en puerto local aparte, revisado visualmente home (stats, carrusel de últimos juegos, popups de comunidad/mensajes), `/juegos/` (pestañas, dropdown de orden, modal de "Filtros avanzados" completo), una ficha de juego (carrusel de imágenes) y `/mangas/` (grid, badges, géneros) — sin diferencias visuales ni funcionales, sin errores nuevos en consola (el único error visto, 405 en un recurso, es preexistente y no relacionado). Aplicado a `js/` y `css/` fuente, reconstruido y desplegado a producción.

Nota para el futuro: es un paso manual (como el purge de Bootstrap), no integrado a `generate-everything.js` — si se edita un `.js`/`.css` propio hay que re-minificar a mano y reverificar visualmente antes de desplegar.

## 2026-09-08 (CSS sin usar de Bootstrap/Bootstrap Icons — purgado con verificación visual)

Pendiente de la auditoría PageSpeed: `bootstrap.min.css` (227.5 KiB) y `bootstrap-icons.css` (96 KiB) traían la librería completa aunque el sitio usa solo una fracción de sus clases/íconos. Se había dejado sin tocar en sesiones anteriores por el riesgo de un purge automático mal configurado (el sitio referencia clases de Bootstrap desde varios `.js`, no solo desde el HTML estático — un análisis que solo mirara `index.html` habría purgado clases que sí se usan).

Proceso seguido (con `purgecss@8`, instalado como dependencia temporal, no agregada a `package.json`):
- Contenido analizado: `index.html` + los 30 archivos de `js/*.js` (no solo el HTML), para capturar las clases que arma el JS.
- Para `bootstrap.min.css`: safelist explícita de estados que Bootstrap-JS agrega en runtime y que nunca aparecen como texto literal (`show`, `fade`, `collapsing`, `dropdown-menu`, `carousel-item-*`, `modal-backdrop`, etc.) más una safelist "greedy" por prefijo para utilidades (`col-`, `d-`, `btn`, `nav`, `form-`, etc.) como red de seguridad adicional.
- Para `bootstrap-icons.css`: se generó la lista exacta de las 134 clases `bi-*` realmente referenciadas (grep sobre `index.html` + todo `js/*.js` — 119 de esas 134 solo aparecen en `.js`, confirmando que ignorar el JS habría sido un error grave) y se pasó como safelist literal.
- Resultado: `bootstrap.min.css` 227.5 KiB → 141.0 KiB (-38%), `bootstrap-icons.css` 96.0 KiB → 6.5 KiB (-93.2%).
- Verificación antes de aplicar a producción: se sirvió una copia de `public/` con ambos CSS purgados en un servidor local aparte, y se revisó visualmente home, `/juegos/` (pestañas, tarjetas, badge "Nuevo"), el dropdown de ordenamiento (abre y muestra las 2 opciones), el modal de "Filtros avanzados" completo (checkboxes, badges de servidor/plataforma, indicadores de estado con color), una ficha de juego (carrusel de imágenes, sistema de estrellas) y `/mangas/` (badges de clasificación +18, estado con color, tags de género) — sin diferencias visuales ni funcionales contra el CSS sin purgar.
- Aplicado: se reemplazaron `vendor/bootstrap/bootstrap.min.css` y `vendor/bootstrap-icons/bootstrap-icons.css` por las versiones purgadas (originales resguardados fuera del repo, no en `vendor/`, para que no terminaran copiados a `public/` por error). Reconstruido y desplegado; reverificado en producción (home y `/mangas/`) tras el deploy real, mismo resultado.

Nota para el futuro: si se agregan nuevos componentes de Bootstrap (un nuevo tipo de modal, un ícono `bi-*` no usado antes) hay que volver a correr este purge — de lo contrario esas clases nuevas quedarán fuera del CSS servido y se romperán silenciosamente. No se automatizó en `generate-everything.js` a propósito: cada purge necesita revisión visual, no debe correr desatendido en cada build.

## 2026-09-08 (Logo duplicado/parpadeando en el header — regresión del fix de CLS)

Bug reportado por el usuario con captura: aparecían dos logos en el header, uno de tamaño normal y otro grande "flotando" y parpadeando arriba de "EclipseZone". Regresión directa de un cambio de la sesión anterior (PageSpeed: animaciones no compuestas) — se había agregado un `<img class="header-logo-img-glow">` como hermano de `.header-logo-img`, animado con `opacity` para lograr el pulso del logo sin animar `filter` directo (que no es compositable).

Causa: el glow usa `position: absolute; inset: 0; width/height: 100%`, que se ajusta al **ancestro posicionado más cercano** — pero ese ancestro era `.header-logo` (el `<div>` que también contiene `.header-logo-text`, "EclipseZone"), no la imagen del logo. Al no tener su propio contenedor relativo del tamaño del logo, el glow se estiraba sobre el header entero, incluido el texto, y se veía como una segunda imagen grande parpadeando por encima.

Arreglado: se envolvió `.header-logo-img` y `.header-logo-img-glow` en un nuevo `<div class="header-logo-img-wrap">` con `position: relative` y el tamaño exacto del logo (`clamp(32px, 5vw, 52px)`, 48px en desktop ≥1024px) — ahora el glow solo se ajusta a esa área, no al header completo. Verificado en producción: `getBoundingClientRect()` del wrapper y del glow dan el mismo rect (32x32 en mobile), sin superposición visible.

## 2026-09-08 ("Destacado del día" repetido 4 veces en la home)

Bug reportado por el usuario con captura real: la home mostraba la sección "Destacado del día" (con la misma card "Total Maidness!") repetida 4 veces seguidas en vez de una sola.

Causa: `generateHomePanel()` (`js/home.js`) se llama varias veces por sesión a propósito (al entrar a home, al volver de otra sección, al terminar de cargar datos reales — ver comentario en `animateCounter`). Cada llamada hace `panel.innerHTML = components.join('')` para limpiar el panel, pero el "Destacado del día"/"Novedades de la semana" se insertaban DESPUÉS con `insertAdjacentHTML('afterend'/'beforeend', ...)`, sin limpiar nada antes. Si dos llamadas se solapaban en el tiempo (p. ej. una arrancada con datos de preview y otra que termina después con los datos reales), cada una sumaba su propia copia de esas dos secciones sin reemplazar la anterior — mismo patrón de fondo que el bug ya arreglado de los contadores animados, pero sin la misma protección.

Arreglado: antes de insertar, se eliminan del panel las secciones `.home-section-weekly`/`.home-section-highlight` que hayan quedado de una llamada anterior (`panel.querySelectorAll(...).forEach(el => el.remove())`). Se agregaron esas dos clases a `createWeeklySection()` y `createHighlightSection()` (antes ambas usaban solo la clase genérica `home-section`, sin forma de distinguirlas para poder limpiarlas selectivamente). Verificado en producción: 1 sola sección de cada una en el DOM tras la carga.


Historial de cambios reales (bugs y mejoras) al sitio y su generador estático (`generate-everything.js`). Formato: fecha, qué estaba roto o qué se agregó, y por qué importa.

## 2026-09-07 (Search Console: indexación de fichas de juego)

Auditoría completa de Search Console (Sitemaps, Indexación de páginas, robots.txt, Estadísticas de rastreo, Core Web Vitals): sitemap correcto (686 URLs, última lectura OK), robots.txt no bloquea nada relevante, servidor responde 97% con 200 y 177ms promedio — el sitio está técnicamente sano. El problema real: de 619 páginas, 545 no están indexadas — 445 nunca rastreadas ("Descubierta: sin indexar", típico de crawl budget con 560 fichas de juego casi idénticas en estructura) y 62 sí rastreadas pero rechazadas ("Rastreada: sin indexar"). Estadísticas de rastreo confirma el diagnóstico: 95% del presupuesto de rastreo de Google se va en revisar páginas ya conocidas, solo 5% en descubrir nuevas.

Se inspeccionó una de las 62 rechazadas (`/juego/ntr-hunter-hisakos-secret/`) tal como la ve Googlebot: HTML correcto y rápido, pero la sinopsis es la misma que usa F95zone y decenas de sitios espejo — contenido casi duplicado a nivel de toda la web, no un error técnico del sitio.

Fix aplicado en `generate-everything.js` (`buildJuegoHTML`):
- `juego.titulo` se normaliza con `.trim()` al entrar a la función — algunos títulos traían un espacio inicial desde el dato de origen, que se propagaba a `<title>`, `<h1>`, meta description y keywords (ej. " NTR Hunter..." en vez de "NTR Hunter...").
- Se agregó un párrafo nuevo y visible en `#seo-static` con datos que NO existen en F95zone ni en los sitios espejo: traductor(es) de Eclipse Zone, fecha de alta en el sitio y estado de la traducción — pensado para que Google tenga una señal real de que la ficha no es solo una copia de la sinopsis original.

También se revisó Enlaces (Search Console): **0 enlaces externos en total** — ningún otro sitio en la web enlaza a eclipsezonehub.com. Esto es probablemente la causa raíz más grande de todas: sin ningún backlink, Google no tiene señal de reputación externa para el dominio, lo que explica por qué prioriza tan poco su rastreo (95% "revisar lo conocido") y es más estricto con el contenido casi-duplicado de las fichas. El fix de contenido único ayuda a la parte de calidad, pero sin backlinks reales la indexación va a seguir lenta.

**Bug de runtime encontrado al medir performance del fix anterior:** al probar la ficha reparada en el navegador real, la pestaña mostraba "Juegos - Eclipse Zone" en vez del título del juego. Causa: `generate-everything.js` ya recorta `juego.titulo` con `.trim()` al generar `window.__GAME_DATA__` (fix de arriba), pero el JSON completo que carga en runtime (`juegos-core.js`, desde un repo externo de GitLab) sigue trayendo el título sin recortar. `handleGameRoute()` compara `window.__GAME_DATA__.titulo` (ya limpio) contra `allGames` (sucio) con igualdad estricta de string — al no coincidir, `showGameDetails()` cortaba en el `if (!game) return` antes de llegar a `updatePageTitle()`, dejando pisado el título genérico que puso `showGames()` un instante antes. Afectaba a cualquiera compartiendo el link de un juego con este problema, guardándolo en favoritos, o simplemente mirando la pestaña del navegador.

Arreglado en dos puntos:
- `js/juegos-core.js` (`adaptGames`): recorta `game.titulo` de cada juego del JSON crudo antes de procesarlo — arregla la causa de raíz para toda la lista, sin depender del repo externo.
- `js/juegos-detail.js` (`showGameDetails`): agregado un fallback por `slugify()` si la igualdad estricta de título no encuentra el juego — más tolerante a futuras diferencias de formato entre fuentes de datos.

Pendiente (no resuelto en esta sesión): evaluar si conviene sumar más contenido único (reseña propia, notas de traducción) a las 62 fichas específicas marcadas como rechazadas, buscar backlinks reales (foros, Reddit, agregadores) dado el hallazgo de 0 enlaces externos, y volver a pedir indexación desde Inspección de URLs una vez publicado el fix.

**Lazy-loading de scripts roto en TODO el sitio (bug real, no solo en mangas):**

`pageLoader.js` decide qué scripts (`juegos-core.js`, `noticias.js`, `manga.js`, etc.) cargar en cada página leyendo `document.body.dataset.page`. Ese atributo lo debía escribir `buildHTML()` en `generate-everything.js` a partir de un parámetro `pageType` — pero **ningún llamador de `buildHTML` pasaba ese parámetro**. Resultado: `<body>` salía sin `data-page` en absoluto en juego, juegos, noticia y noticias, y `pageLoader.js` nunca disparaba la carga de ningún grupo de scripts fuera de `"idle"`. Esto invalidaba por completo el sistema de carga condicional pensado para reducir el crawl budget de Googlebot (ver comentario de cabecera en `js/pageLoader.js`).

Arreglado: `buildJuegoHTML`, `buildNoticiaHTML`, `buildJuegosIndexHTML`, `buildHomeHTML` y `buildNoticiasIndexHTML` ahora pasan su `pageType` correspondiente (`juego`, `noticia`, `juegos`, `home`, `noticias`).

**`/mangas/` no tenía página estática propia:**

A diferencia de `/juegos/` y `/noticias/`, no existía generación de un `public/mangas/index.html` — la ruta estaba en `sitemap.xml`, `_redirects` y `_headers`, pero al visitarla Cloudflare Pages caía al `index.html` raíz (home), sin `data-page="manga"`, así que Googlebot nunca recibía el HTML que dispara la carga de `js/manga.js`.

Agregado: `buildMangasIndexHTML()` genera `public/mangas/index.html` con `data-page="manga"` (coincide con `data-lazy-for="manga"` en `index.html`). Sin listado de mangas embebido para SEO porque ese contenido viene de MangaDex en runtime (vía proxy `/api/md/*`), no hay datos propios del sitio que pre-renderizar ahí.

**Dos bugs más encontrados al probar el fix de arriba en un server local (`eclipse-static`, `public/`):**

1. `<script src="/js/pageLoader.js">` en `index.html` no tenía `defer`. Al ser un script síncrono y bloqueante, se ejecutaba en cuanto el parser lo encontraba — **antes** de que existieran en el DOM los `<script data-lazy-src>` de más abajo (ubicados varios cientos de líneas después). `document.querySelectorAll('script[data-lazy-src]...')` corría sobre un DOM incompleto y no encontraba nada: ningún grupo por tipo de página cargaba nunca, en ninguna página, sin importar el `data-page`. Arreglado agregando `defer` al script.
2. `data-lazy-for="juego,juegos"` y `data-lazy-for="noticia,noticias"` usaban coma como separador, pero `pageLoader.js` matchea esos valores con el selector CSS `[data-lazy-for~="..."]`, cuyo operador `~=` compara tokens separados por **espacio**, no coma. Un atributo `"juego,juegos"` es un solo token para CSS — nunca hace match ni contra `"juego"` ni contra `"juegos"`. Resultado: en `/juegos/`, `/noticias/`, fichas de juego y noticias individuales, `juegos-core.js`/`noticias.js` nunca cargaban (solo los grupos de una palabra, `"home"` y `"manga"`, funcionaban). Arreglado cambiando las comas por espacios en esos `data-lazy-for`.

Verificado en las 6 combinaciones de página (`/`, `/mangas/`, `/juegos/`, `/noticias/`, una ficha de juego, una noticia): `data-page` correcto y el grupo de scripts esperado carga en cada una.

**Sección "Artista del proyecto" (DanielW) en la home sin ningún estilo (bug reportado por el usuario):**

`css/home.css` existe (466 líneas: carrusel de juegos, secciones de home, stats, cards) pero **nunca estaba linkeado en `index.html`** — solo se cargaban `style.css`, `auth.css`, `manga.css`, etc., nunca `home.css`. Encima, ni siquiera `home.css` tenía reglas para las clases que genera `createArtistSection()` en `js/home.js` (`.artist-card`, `.artist-avatar-ring`, `.artist-avatar-placeholder`, `.artist-verified-badge`, `.artist-info`, `.artist-socials`, `.artist-social-btn`, etc.) — esas clases no existían en ningún `.css` del repo. Resultado: la sección se renderizaba como texto plano apilado sin layout, sin avatar, sin card, sin botones de redes sociales estilizados.

Arreglado: se agregó `<link href="/css/home.css" rel="stylesheet"/>` en `index.html`, y se escribieron las reglas `.artist-*` faltantes en `css/home.css` (avatar circular con anillo degradado, badge de verificado, card con info, botones de redes con color por red vía `--artist-color`). Verificado con estilos computados en el navegador: card en `display:flex`, anillo con gradiente, botones con padding/border-radius/color correctos.

## 2026-09-07 (PageSpeed Insights: LCP real de 27,4s en fichas de juego)

Siguiendo con la auditoría técnica (Search Console no reporta Core Web Vitals por falta de tráfico real/CrUX, así que se probó con datos de laboratorio vía PageSpeed Insights/Lighthouse sobre `/juego/ntr-hunter-hisakos-secret/` en mobile): Performance 43/100, LCP 27,4s (falla Core Web Vitals), CLS con riesgo, accesibilidad 77.

**LCP de 27,4s — causa real encontrada:** el elemento que Lighthouse mide como LCP es el primer slide del carrusel de imágenes de la ficha de juego (visible de inmediato al abrir la página, sin necesidad de scroll), pero `js/juegos-detail.js` lo generaba con `loading="lazy"` igual que el resto de los slides. El navegador trata `loading="lazy"` como señal de "no es urgente, esperá a que se necesite" y le baja la prioridad de descarga a la imagen — el propio Lighthouse lo marcó como "Retraso de carga de recursos" dominando el tiempo total, no la descarga en sí.

Arreglado en `js/juegos-detail.js` (dentro de la función que arma el carrusel, `images.forEach(...)`): solo el slide activo (`index === 0`, el que se ve al cargar) usa `loading="eager" fetchpriority="high"`; el resto del carrusel sigue en `loading="lazy"` (correcto, están ocultos hasta que el usuario navega el carrusel).

De paso se revisó `js/juegos-render.js` (grillas de tarjetas de juego) por el mismo patrón: la grilla principal (`renderGamesWithPagination`) ya tenía el mismo problema — las primeras 4 tarjetas (visibles sin scroll) se marcaban `loading="lazy"`. Arreglado igual: `index < 4` → eager + `fetchpriority="high"`, resto lazy. Las grillas de "Exclusivos" y "Favoritos" (`renderExclusiveGames`, `renderFavoriteGames`) se dejaron sin cambios a propósito: son paneles secundarios que el usuario abre después de la carga inicial, no compiten por el LCP de la primera pintura.

**Falso positivo descartado — "CSS duplicado":** las capturas de PageSpeed mostraban en "Solicitudes que bloquean el renderizado" tanto `/css/themes.css` (sin versionar) como `/css/themes.css?v=9652e607` (versionado) cargando en la misma página, y lo mismo para home.css/juegos.css/noticias.css/themes-contrast.css. Se investigó el mecanismo de cache-busting (`versionAssetRefs()` en `generate-everything.js`, línea ~1170): es una única función idempotente que reemplaza in-place, no puede generar un `<link>` duplicado por diseño. Se confirmó contra el HTML generado (`public/`) y contra producción en vivo (`curl` con user-agent real) que **solo existe la copia versionada** en ambos casos — un único `<link>` por archivo CSS. Conclusión: lo que vio PageSpeed fue una copia vieja servida desde el caché HTTP del propio navegador de análisis (mismo tipo de causa que el incidente de caché envenenada de julio 2026, pero del lado del cliente, no del servidor) — no es un bug del código actual, no requirió cambios.

Pendiente (no evaluado/resuelto en esta sesión, quedó fuera de alcance de la ruta de Search Console): tamaño de imágenes (`/Eclipse.png` de 1.6MB mostrado a 56x32px en el header, coberturas de F95zone sin redimensionar vía `/api/img`), cache-control corto (2h) en JS/CSS del sitio, CSS sin usar de bootstrap/bootstrap-icons, minificación de JS/CSS, animaciones CSS no compuestas con riesgo de CLS (`.header-logo-text`, `.header-logo-img`, `.ibs-logo-icon`, `#initialBlackScreen`, `.mobile-nav-btn`), accesibilidad (botones sin nombre accesible, iframes sin título, falta de landmark `main`, contraste insuficiente en algunos textos, `user-scalable=no` en el viewport).

## 2026-09-07 (PageSpeed: imagen del logo, cache-control, animaciones y accesibilidad)

Siguiendo con los pendientes de la auditoría PageSpeed anterior:

**`/Eclipse.png` sobredimensionado (1.6MB a 56x32px en el header):** el mismo archivo se usaba como logo del header/pantalla de carga (mostrado a ~52px) y como `og:image`/`twitter:image`/ícono PWA (que sí necesitan una imagen grande). Se generó `Eclipse-icon.png` (240x136, mismo aspect ratio 3000x1700 del original, 25KB vs 1.67MB — 98.5% menos) y se usa solo en los 3 lugares donde el logo se ve chico (`ibs-logo-icon` de la pantalla negra inicial, `ls-logo-img` de la pantalla de carga, `header-logo-img` del header). `og:image`, `twitter:image` y el ícono PWA siguen apuntando a `Eclipse.png` grande, que sigue siendo necesario ahí. Agregado a `staticFiles` en `generate-everything.js` para que se copie a `public/`.

**Cache-Control corto en `/css/*` y `/js/*` (max-age=3600, 1h):** el comentario original explicaba que no llevan `immutable` porque el nombre de archivo no tiene hash (solo el `?v=` de la URL que los referencia) — un intermediario de caché sirviendo por path sin considerar el query string causó el incidente de julio 2026. Se mantiene esa protección (no se agregó `immutable`) pero se subió max-age de 1h a 24h con `stale-while-revalidate` de 1h a 7 días: sigue siendo seguro porque cualquier archivo que cambia de contenido ya tiene una URL `?v=` nueva, y stale-while-revalidate revisa en segundo plano igual.

**Animaciones CSS no compuestas (riesgo de CLS/jank):** `ibsLogoGlow` (modal de bienvenida) animaba `box-shadow` directo y `logoPulse` (header, visible en TODA página, corre infinito) animaba `filter` — ninguna de las dos es compositable, fuerzan repintado en cada frame. Arreglado con la técnica de pseudo-elemento/elemento superpuesto animando solo `opacity` (sí compositable) con el efecto visual "fuerte" pre-calculado en ese elemento: `.ibs-logo-icon::before` para el glow del modal, `<img class="header-logo-img-glow">` (elemento hermano real, no pseudo-elemento, porque hace falta duplicar una imagen) para el pulso del header. `shimmerText` (gradiente de texto vía `background-position`) se dejó sin cambios: es un efecto de `background-clip: text` que no tiene equivalente real en transform/opacity sin cambiar el efecto visual — queda como limitación conocida de bajo impacto.

**Accesibilidad:**
- `user-scalable=no` en el `<meta viewport>` bloqueaba el zoom táctil — sin justificación real en un sitio de contenido (no es un juego con gestos), quitado.
- `<div class="container-fluid main-content">` (contenedor real de todos los paneles de página) ahora tiene `role="main"` — no había ningún landmark principal.
- Botones solo-ícono sin nombre accesible: controles del carrusel de imágenes de la ficha de juego (`aria-label="Imagen anterior/siguiente"`), cerrar detalle de manga, volver del lector de manga, cerrar filtros, cerrar ajustes de Discord, botón de búsqueda unificada — todos con `aria-label` agregado. Encontrados de forma sistemática (script que parsea cada `<button>` del HTML y chequea si le queda texto visible tras sacar tags/comentarios) en vez de revisar a ojo, para no dejar ninguno sin corregir.

No abordado en esta sesión (requiere más cuidado que un cambio directo, por el patrón de bugs reales ya vistos en este proyecto con cambios de assets no verificados): purgar CSS sin usar de `bootstrap.min.css`/`bootstrap-icons.css` (30.6 KiB + 13.1 KiB) — el sitio referencia clases de Bootstrap de forma dinámica en varios `.js` (agregadas vía `innerHTML`), así que un purge automático corre riesgo de sacar clases que sí se usan pero que un analizador estático no detecta; necesitaría una herramienta dedicada (PurgeCSS con safelist) y verificación visual completa del sitio, no un recorte a mano. Minificación de JS/CSS del sitio: mismo motivo, mejor con una herramienta de build dedicada que con edición manual.

**Auditoría completa de CSS sin linkear — 3 archivos más en la misma situación que `home.css`:**

Tras encontrar `home.css` huérfano, se comparó cada archivo de `css/` contra los `<link>` reales de `index.html`. Encontrados sin linkear:
- `css/juegos.css` (927 líneas) — grid y cards del listado de juegos (`.game-grid`, `.game-card`, etc.). `style.css` solo traía un ajuste suelto de `margin-bottom` para `.game-card`, no el estilo real.
- `css/noticias.css` (234 líneas) — estilos de la sección Noticias.
- `css/themes.css` (1460 líneas) — las ~40 paletas de tema seleccionables (`.theme-light`, `.theme-dark`, `.theme-midnight`, etc.). Como `<body>` trae `class="theme-midnight"` por defecto, **ningún tema tenía color aplicado**, en ninguna página del sitio.
- `css/themes-contrast.css` (509 líneas) — ajustes de contraste sobre esos temas.

Ningún JS quedó en la misma situación (se verificó que todo archivo en `js/` está referenciado, como `<script>` normal o `data-lazy-src`).

Arreglado: se agregaron los 4 `<link>` en `index.html`, con `themes.css`/`themes-contrast.css` después de `style.css` (necesitan ganar la cascada sobre las variables `:root` base). Verificado que las 4 hojas cargan (200 OK) en `document.styleSheets`.

**Bug crítico de SEO: ninguna página tenía `<h1>` ni texto real en el HTML crudo (confirmado con Search Console + comparación directa con un competidor que sí aparece en Google):**

Al investigar por qué el usuario no puede encontrar sus propios juegos en Google buscando por nombre (aunque el sitio SÍ está indexado — confirmado con `site:eclipsezonehub.com` y con Search Console: 574 páginas en el sitemap, sin acciones manuales, sin errores de rastreo), se encontró que:
- El fix de `pageType` de esta misma sesión (agregar `data-page="..."` al `<body>`) rompió sin querer la inyección del bloque `#seo-static` en `buildHTML()`: el código insertaba ese bloque buscando el string literal `<body class="theme-midnight">`, que ya no existía tal cual tras agregar `data-page`. Resultado: **cero páginas del sitio (juego, juegos, noticia, noticias, home, mangas) tenían el bloque `#seo-static` ni ningún `<h1>` en absoluto** — todo el contenido descriptivo (título, descripción, ficha técnica) dependía 100% de que se ejecutara JavaScript en runtime, algo que ni Google ni la comparación directa recompensan igual que HTML crudo.
- Comparando con `eroganso.com` (que sí aparece en Google buscando el mismo juego por nombre): esa página tiene un `<h1>` real, descripción completa y ficha técnica visibles directamente en el HTML, sin depender de JS. La de Eclipse Zone no tenía nada de eso.
- Aparte del bug de código: **el sistema de caché por hash del generador (`--no-cache` para desactivarlo) no detecta cambios en el propio código de `generate-everything.js`**, solo en los datos de cada juego/noticia — así que aunque el código ya estaba arreglado, dos regeneraciones seguidas sin `--no-cache` siguieron sirviendo el HTML viejo y roto. Hay que correr `node generate-everything.js --no-cache` después de tocar cualquier función `build*HTML`, o el fix no se aplica a las páginas ya generadas.

Arreglado: el `.replace()` de `#seo-static` ahora usa un regex (`/(<body[^>]*>)/`) que no depende del string exacto de `<body>`, así que sobrevive a futuros atributos agregados ahí. Verificado con `--no-cache`: las 560 fichas de juego, los 4 índices y la home ahora tienen `<h1>` y el bloque `#seo-static` completo en el HTML crudo.

**Desplegado a producción.** Se corrió `node generate-everything.js --no-cache` (560 juegos, 16 noticias, 580 URLs) y `wrangler pages deploy ./public --project-name eclipse --branch EclipseZone`. Confirmado real en Google buscando "Naruto The Trials of Menma" antes del deploy: 10 resultados en la primera página (itch.io, Patreon, F95zone, YouTube, Gaxload, LewdGames, liteapks, X, Juxia, PornGamesHub), todos con contenido igual de adulto que Eclipse Zone — esto descarta SafeSearch/filtrado por contenido +18 como causa, y confirma que el problema era la falta de `<h1>`/contenido real en el HTML crudo.

De paso se quitó el sufijo `| Eclipse Zone` del `<title>` de las fichas de juego (`generate-everything.js`, función de título de juego): ningún competidor lo hace así y no aportaba nada al usuario buscando el nombre del juego.

**Sufijo de marca quitado también de índices y noticias:** `/juegos/`, `/noticias/`, `/mangas/` y cada noticia individual traían "| Eclipse Zone" en `<h1>`/`<title>` igual que las fichas de juego. Se dejó únicamente en la home (`Eclipse Zone — Juegos y Mangas traducidos al español`), donde sí tiene sentido porque es la página de marca del sitio.

**Bug de links internos casi inexistentes, encontrado comparando 5 competidores reales (Ero Ganso, Erodeus, Hotzone18) que sí aparecen en Google buscando el nombre del juego:**

Con el navegador real se midió HTML crudo de fichas de juego de la competencia: Ero Ganso 84-272 links internos por página, Erodeus 58, Hotzone18 124. La ficha nuestra (`heroes-university-h`) tenía **1 solo link interno** (su propio canonical) — el bloque de "juegos relacionados" ya existía (`relatedJuegos()`, máx. 6) pero era muy por debajo de lo que la competencia genera automáticamente con las taxonomías de WordPress (los 3 competidores corren WordPress con plugins tipo Paid Memberships Pro / Popular Posts, que generan páginas de tag y widgets de relacionados sin código a mano).

Arreglado sin migrar a WordPress — se replicó el mecanismo en el generador estático:
- `relatedJuegos()` subido de 6 a 12 resultados por ficha.
- Nueva función `buildCategoriaHTML()`: genera `/categoria/<slug>/` para cada categoría con 8+ juegos (equivalente estático a una página de tag de WordPress), listando todos sus juegos con links reales. 106 páginas de categoría generadas de 209 categorías únicas (las demás quedaron fuera por tener muy pocos juegos — evita páginas "thin" sin contenido suficiente).
- Los géneros de cada ficha (antes `<span>` sin link) ahora enlazan a su página de categoría cuando esta existe.
- Sitemap pasó de 580 a 686 URLs.

Resultado verificado: la ficha de `heroes-university-h` pasó de 1 a 47 links internos en el HTML crudo. Desplegado a producción (`wrangler pages deploy`).

**Sistema de comentarios completo (`js/comments.js`, backend real en `worker.js` vía `/api/comments/*`) nunca se mostraba en ninguna ficha — el usuario recordaba haberlo implementado, y de hecho estaba entero:**

El módulo existía completo (post, like, reply, delete, todo con backend real en GitLab vía el Worker) y hasta tenía su contenedor ya preparado en `index.html` (`<div id="gameCommentsContainer">`, con el comentario "Sección de comentarios del juego"). Pero **`CommentsModule.render()` nunca se llamaba en ningún archivo** — solo se usaba la parte de estrellas/rating (`starLoad`/`starVote`) desde `juegos-extras.js`. `showGameDetails()` en `juegos-detail.js` armaba toda la ficha (imágenes, descripción, categorías, links de descarga, perfil del uploader) pero jamás invocaba el render de comentarios, así que el contenedor se quedaba vacío siempre, sin ningún error visible.

Arreglado: `showGameDetails()` ahora llama `CommentsModule.render('gameCommentsContainer', { type: 'game', id: game.titulo })` junto al resto del armado de la ficha.

**Bug más grave encontrado en esta misma revisión, probablemente preexistente y con impacto directo en SEO real: las fichas de juego NO abrían el modal al entrar por URL directa (`/juego/<slug>/`) — se quedaban en la home.** Esto es justamente cómo llega cualquier visita desde Google o un link compartido — el peor lugar posible para que fallara.

Causa: condición de carrera entre `main.js` (script normal, sin `defer`, se ejecuta primero) y `pageLoader.js` (con `defer`, carga `juegos-core.js` de forma asíncrona vía `data-lazy-src`). `main.js` dispara `loadAllContent()` en `DOMContentLoaded` y ahí comprueba `typeof loadJuegosContent === 'function'` UNA SOLA VEZ, de forma síncrona — si `juegos-core.js` todavía no había terminado de descargarse en ese instante exacto (dependiente de la velocidad de red, por eso "a veces funcionaba"), `loadJuegosContent` era `undefined`, `allGames` quedaba vacío para siempre en esa carga, y `handleGameRoute()` no tenía con qué mostrar el juego — la SPA caía silenciosamente a mostrar la home. Confirmado real navegando directo a `eclipsezonehub.com/juego/heroes-university-h/`: la página cargaba y se quedaba en el home en vez de abrir la ficha.

Arreglado sin reescribir el pipeline de carga: `pageLoader.js` ahora expone la promesa de `loadGroupSequential(page)` en `window.__pageScriptsReady` (antes se ejecutaba y se descartaba), y `loadAllContent()` en `main.js` espera esa promesa antes de comprobar si `loadJuegosContent` existe. Verificado en producción con cache-busting real (`fetch(..., {cache:'no-store'})` + recarga): el modal ahora abre correctamente en carga directa, con la ficha completa y la sección de comentarios visible ("Comentarios (0)", "Sé el primero en comentar").

Nota de caché: Cloudflare Pages sirve `/juego/*` con `stale-while-revalidate=86400` — después de cada deploy, el HTML puede tardar en reflejar el cambio si el navegador o el edge todavía tiene la versión vieja "stale" cacheada; forzar con `?_cb=<timestamp>` + `cache:'no-store'` para verificar contra el origin real sin esperar la revalidación.

**Pendiente:** ir a Search Console → Inspección de URLs → Solicitar indexación para las páginas más importantes, así Google recrawlea el HTML nuevo antes del próximo rastreo natural. El efecto en el ranking de búsqueda por nombre no es inmediato — Google necesita volver a rastrear e indexar cada URL. El bug de la ruta directa es candidato fuerte a explicar parte del problema de indexación original: si Googlebot alguna vez ejecutó JS sobre esa URL y vio la home en vez de la ficha, pudo haber indexado o entendido mal esa página.

## 2026-09-07 (continuación) — auditoría de funcionalidad completa nunca conectada

Tras los bugs de arriba (comentarios nunca renderizados, condición de carrera al abrir fichas), se pidió buscar más casos del mismo patrón: código completo y funcional que nadie invoca desde ningún botón/evento. Auditoría con grep sobre los 29 archivos de `js/` (definición vs uso real en el resto del proyecto). Se arreglaron los dos hallazgos de mayor impacto en UX:

**1. `customizeHomePanel()` en `js/home.js` — modal de personalización del home completo, sin ningún botón que lo abriera.** La función arma un modal con 6 toggles (carrusel, noticias, mangas, novedades, destacado, artista) que persisten en `localStorage` y regeneran el panel del home vía `applyHomePanelPrefs()` — pero no existía ningún elemento en `index.html` con `onclick="customizeHomePanel()"`. Agregado un botón "Personalizar" junto al botón "Actualizar" ya existente en `.home-controls`.

Al probarlo se encontró un **segundo bug independiente dentro de la misma función**: usaba `modal.style.display = 'flex'` / `'none'` para mostrar/ocultar el modal, pero `.mobile-modal` en `css/style.css` solo se hace visible con la clase `.show` (controla `opacity`/`pointer-events`, no solo `display`) — es el patrón que usan todos los demás modales del sitio (`juegos-detail.js`, `manga.js`, `noticias.js`, `juegos-search.js`, `main.js`, todos con `classList.add('show')`). Con solo `style.display`, el modal quedaba con `display:flex` pero `opacity:0` y `pointer-events:none` — invisible e inclickeable aunque el botón sí disparara la función. Arreglado cambiando las 3 líneas de `home.js` a `classList.add('show')`/`classList.remove('show')`. Verificado en navegador: el modal se ve, los toggles funcionan, "Aplicar" persiste y muestra "Panel actualizado".

**2. `reportBrokenLink()` en `js/juegos-extras.js` — backend real y completo (`POST /api/report-broken-link` en `worker.js`, con email al admin), sin ningún botón en la ficha de juego que lo llamara.** Agregado botón "Reportar link roto" en la ficha de juego, junto al botón "Copiar enlace" ya existente (`index.html`, sección `gameStarRating`/detalle). Verificado que la función carga correctamente (`data-lazy-for="juego juegos"`) y el botón aparece en el modal de detalle.

**3. Sufijo "| Eclipse Zone" residual en JS, sobrevivió al fix de títulos del generador estático.** El fix anterior (mismo día) quitó el sufijo de `<title>` en el HTML generado por `generate-everything.js`, pero el JS que reescribe `document.title` en runtime (al navegar dentro de la SPA sin recarga completa, que es lo que Google indexa según el propio comentario del código) seguía agregando el sufijo en 3 lugares: `seoGameTitle()` en `js/main.js`, su fallback en `updateMetaTags()` de `js/juegos-detail.js`, y el título de noticia en `js/main.js` (`updatePageTitle`) y su fallback en `js/noticias.js`. Arreglado quitando `| Eclipse Zone` de los 4 puntos — consistente con el HTML estático.

Hallazgos menores reportados por la auditoría, sin arreglar aún (bajo impacto o requieren más contexto de diseño): `#newsPaginationContainer` en `index.html` no coincide con el id real que usa `renderNewsPaginationControls()` (`#newsPagination`, se crea igual vía `appendChild` así que no rompe nada, solo un `id` sin uso); APIs públicas sin consumidor en `rotonda.js`, `accountBridge.js` y `analytics.js` (código muerto, no bug de UX).

Desplegado a producción vía `wrangler pages deploy ./public --project-name eclipse --branch EclipseZone`.

## 2026-09-07 (extra) — acceso al formulario de juegos desde el dashboard

`admin/juegos/index.html` (el formulario para agregar/editar juegos) solo era accesible escribiendo la URL `/admin/juegos/` a mano — el dashboard admin (`/admin/dashboard/`) ya tenía un link a "Moderación de comentarios" pero ninguno hacia el formulario de juegos. Agregado `<a href="/admin/juegos/">→ Formulario de juegos</a>` en la misma barra de navegación del dashboard.

Desplegado a producción vía `wrangler pages deploy ./public --project-name eclipse --branch EclipseZone`.

## 2026-09-07 (reportes) — panel de reportes de links rotos + rediseño del formulario de juegos

**Los reportes de "link roto" ahora se pueden ver y gestionar, no solo llegan por email.** `reportBrokenLink()` en `worker.js` guardaba el reporte únicamente en un email a `FORM_ADMIN_EMAIL` — si el email fallaba (o simplemente se perdía entre otros correos) no había forma de recuperar el reporte. Agregado:
- `worker.js`: cada reporte ahora también se guarda en GitLab (`reportes-links-rotos.json`, mismo storage y mismo patrón de lock/retry que `comentarios.json`/`estrellas.json`), con `id`, `slug`, `titulo`, `motivo`, `date` y `resolved`. El email se mantiene igual (ahora con link directo al panel nuevo).
- Dos rutas nuevas: `GET /api/admin/broken-links` (lista los reportes) y `POST /api/admin/broken-links/resolve` (marca/desmarca resuelto), ambas con el mismo `requireCommentsAdmin` que ya usan el dashboard y la moderación de comentarios.
- Panel nuevo `/admin/reportes/` (`admin/reportes/index.html`), mismo estilo oscuro y mismo patrón de login por sesión que `/admin/dashboard/` y `/admin/comentarios/` — tabla con fecha, juego (linkeado a la ficha real), motivo, estado (pendiente/resuelto) y botón para togglear el estado.
- `/admin/dashboard/`: agregado el link al panel nuevo, junto a los otros dos.

Desplegado: `worker.js` vía `wrangler deploy` (Worker de producción) y el resto vía `wrangler pages deploy`. Verificado con `curl` contra `eclipsezonehub.com/api/health`, `/api/comments` (rutas existentes, sin romper nada) y `/api/report-broken-link` (ruta modificada, responde `{"ok":true}`).

**Rediseño del Formulario de Juegos (`/admin/juegos/`) — de tema claro/rosa a la paleta oscura del sitio público.** Este panel (para que traductores/staff suban o editen juegos) tenía su propia paleta (`#ff6b9e` rosa, fondo claro `#f8f9fa`) sin relación visual con eclipsezonehub.com. Como todo su CSS (`forms.css`, `layout.css`, `components.css`, etc.) ya estaba escrito en base a variables (`--primary-color`, `--card-bg`, `--bg-color`, `--border-color`...), el rediseño se hizo tocando **solo `variables.css`**: se reemplazó la paleta por la del tema "midnight" que usa el sitio público por defecto (`css/themes.css`, `--primary: #6366f1`, fondo `#0f172a`/`#1e293b`). El modo oscuro propio del panel (`.dark-mode`) y el tema Discord (`.custom-theme`) se ajustaron en la misma línea, sin tocar su lógica de toggle. Verificado visualmente: la pantalla de login/registro ya luce oscura con acento índigo, consistente con el resto de Eclipse Zone.

Desplegado a producción vía `wrangler pages deploy ./public --project-name eclipse --branch EclipseZone`.

## 2026-09-07 (visibilidad) — más visibilidad para la sección del artista (DaniW)

A pedido: la sección "Artista del proyecto" (DaniW) en la home era la **última** de las 4 secciones del panel dinámico (carrusel → noticias → mangas → artista) — casi nadie llegaba a verla haciendo scroll. Cambios en `js/home.js` e `index.html`:

- **Reordenada** a la segunda posición: ahora aparece justo después del carrusel de juegos recientes, antes de noticias y mangas.
- **Botón de acceso directo** agregado arriba de todo en la home ("🖌 Conocé al artista del proyecto"), justo debajo de la descripción del sitio — hace scroll suave a la sección con `scrollIntoView`, sin depender de bajar todo el panel.
- **Avatar real**: reemplazado el ícono placeholder (`bi-person-fill`) por un dibujo propio de DaniW (autoría confirmada por el usuario), agregado como asset del proyecto en `img/daniw-avatar.jpg` en vez de un hosting externo. Se agregó `img` a `staticDirs` en `generate-everything.js` para que el generador lo copie a `public/img/` en cada build, igual que `css`/`js`/`vendor`.

Verificado en navegador: la sección aparece en segunda posición, el botón de acceso rápido scrollea correctamente hasta ella, y `public/img/daniw-avatar.jpg` se sirve con status 200.

Desplegado a producción vía `wrangler pages deploy ./public --project-name eclipse --branch EclipseZone`.

## 2026-09-07 (cierre) — limpieza de los hallazgos menores restantes

**`#newsPaginationContainer` en `index.html` conectado.** `renderNewsPaginationControls()` en `js/noticias.js` creaba su propio contenedor de paginación con `appendChild` directo a `#newsContent`, ignorando el `<div id="newsPaginationContainer">` que ya estaba en el HTML para ese propósito. Arreglado: ahora monta la paginación dentro de `#newsPaginationContainer` (con fallback a `#newsContent` si no existiera). Verificado en `/noticias/`: la paginación aparece dentro del contenedor correcto.

**Código muerto eliminado (sin consumidor real, confirmado con grep en todo el proyecto):**
- `js/rotonda.js`: de las 8 funciones expuestas en `window.Rotonda` (`on`, `off`, `emit`, `provide`, `get`, `ready`, `listModules`, `hasModule`, `waitForModule`), solo `provide` tiene algún llamador real (`Rotonda.provide(...)` en 6 módulos, siempre para registrar, nunca para leer). Reducido el archivo a solo `provide` — quedaba un event-bus/service-locator completo que nadie usaba como tal.
- `js/accountBridge.js`: `window.AccountBridge` y el alias `window.getAccountUser` no los llamaba ningún otro módulo — cada uno (`auth.js`, Discord, Patreon) reimplementa su propio acceso a `localStorage` en vez de usar este puente. Se quitó esa API muerta; el archivo se mantiene porque también provee los fallbacks `loadCache`/`saveCache`/`clearCache` que sí usan `main.js`, `noticias.js` y `juegos-core.js`.
- `js/analytics.js`: `EzAnalytics.flush`, `.fetch` y `.version` no tenían ningún consumidor fuera del propio archivo — probablemente pensados para un panel de admin que nunca se construyó. Se quitaron de la API pública; `flushPending`/`fetchCounterJSON` se mantienen como funciones internas porque `track`/`event` sí las usan.

Verificado en navegador tras el cambio: `Rotonda.provide` sigue registrando módulos sin error, `EzAnalytics.track`/`.event` intactos, `AccountBridge` correctamente ausente de `window`.

Desplegado a producción vía `wrangler pages deploy ./public --project-name eclipse --branch EclipseZone`.

## 2026-09-07 (Patreon + Juegos/Mangas/Noticias en 0) — WebView de Android trabado en Patreon, y contenido "vacío" real en toda la web

**App Android (WebView) se quedaba pegada para siempre en el login de Patreon.** Reportado: al cancelar el login de Patreon dentro de la app, no se podía volver atrás — el botón atrás cerraba la app entera. Causa: `js/patreon.js` navegaba la propia página (`window.location.href = authUrl`) al iniciar el OAuth, y `MainActivity.kt` no siempre interceptaba cada salto de la cadena de redirects de Patreon (`shouldOverrideUrlLoading` no dispara en todos los hops intermedios) — el WebView terminaba cargando patreon.com sin pasar por el filtro de "abrir en navegador externo". Si el usuario cancelaba ahí, los redirects internos de Patreon podían vaciar el historial del WebView, y `webView.canGoBack()` devolvía `false`.

Arreglado con dos capas:
- `MainActivity.kt`: cualquier URL de `patreon.com` se fuerza al navegador externo del sistema (`Intent.ACTION_VIEW`), nunca se carga dentro del WebView de la app.
- `js/patreon.js`: `connect()` ahora abre el OAuth con `window.open(authUrl, '_blank', 'noopener')` en vez de navegar la página actual — dentro del WebView de la app esto se trata como enlace externo y abre en el navegador del sistema, que tiene su propio botón atrás nativo; el sitio queda intacto de fondo pase lo que pase en Patreon.
- Efecto secundario: el `state` anti-CSRF que se guardaba en `sessionStorage` antes de redirigir dejó de ser legible al volver (WebView y navegador externo no comparten `sessionStorage`). Se quitó esa validación cruzada — la protección real sigue intacta server-side, el intercambio de `code` por `access_token` ocurre en el Worker con `PATREON_CLIENT_SECRET`, que nadie fuera del backend puede fabricar.

`MainActivity.kt` es un cambio de código fuente de la app Android — falta compilar y publicar un nuevo APK para que el fix llegue a los usuarios actuales.

**Juegos, Mangas y Noticias mostraban 0 tanto en la home como directamente en sus secciones — bug real, no un problema de Google/SEO.** El usuario reportó capturas de la app Android con "Juegos 0 / Mangas 0 / Noticias 0" en home y la sección Mangas completamente vacía. Investigado en el navegador real del usuario (Chrome, sitio en producción), dos causas distintas:

1. `handleInitialRoute()` en `js/main.js` decidía qué sección mostrar leyendo únicamente `localStorage.getItem('lastSection')`, ignorando la URL real con la que se entraba al sitio. Visitar `/mangas/`, `/juegos/` o `/noticias/` directamente (primera visita, o `lastSection` en otro valor por una visita anterior) mostraba la sección equivocada — el contenido SÍ cargaba de fondo pero quedaba oculto porque nunca se llamaba a `showMangas()`/`showGames()`/`showNews()`. Arreglado: la URL real ahora manda sobre `lastSection` para esas tres rutas. De paso, `showGames()`/`showNews()`/`showMangas()` dejaron de resetear siempre la URL visible a `/` vía `history.replaceState` — cada sección conserva su propia URL (`/juegos/`, `/noticias/`, `/mangas/`), relevante para que Google indexe cada sección con su URL real en vez de que todo colapse a `/`.
2. Los contadores de la home (`totalGamesCounter`/`totalMangasCounter`/`totalNewsCounter`) se quedaban en 0 en cualquier visita nueva porque `renderHomePreview()` (la función que puebla `window.allGames`/`newsData` desde `__HOME_PREVIEW__`, el dato prerenderizado en el HTML estático) solo se llamaba en el camino de error de carga (`_onLoadError`), nunca en el camino normal (`_onLoadSuccess`) — con red funcionando (el caso normal), nada poblaba esas variables hasta que el usuario visitaba Juegos/Mangas. Arreglado llamándola también en `_onLoadSuccess`. El total de mangas no viene en el HTML estático (sale de MangaDex en runtime) y `manga.js` no carga en home — se agregó un fetch liviano (`limit=1`) al proxy propio `/api/md/manga` (mismo que usa `manga.js`, evita problemas de CORS llamando directo a `api.mangadex.org`) solo para ese número.
3. Bug adicional encontrado al verificar el fix anterior: `animateCounter()` (la animación de conteo de la home) no cancelaba su animación previa al ser llamada de nuevo — como `generateHomePanel()` se invoca varias veces por sesión (entrar a home, volver de otra sección, terminar de cargar datos reales), animaciones concurrentes sobre el mismo elemento se pisaban entre sí y el contador quedaba trabado en un número intermedio arbitrario en vez de llegar al total real. Reescrito con `requestAnimationFrame` + timestamp absoluto (cada llamada cancela la anterior y define su propio punto de partida) más un fallback a valor directo si la pestaña está en segundo plano (los navegadores pausan `requestAnimationFrame` en tabs no visibles).

Verificado en el navegador real de producción tras el fix: `/mangas/`, `/juegos/`, `/noticias/` muestran su contenido real al entrar directo, y la home llega a "Juegos 560 / Mangas 10368 / Noticias 16".

Desplegado a producción (varias iteraciones) vía `node generate-everything.js --no-cache` + `wrangler pages deploy ./public --project-name eclipse --branch EclipseZone`.

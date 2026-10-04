# Eclipse Zone — eclipsezonehub.com

Sitio estático (Cloudflare Pages + Worker) de juegos y mangas traducidos al español.
`generate-everything.js` descarga `juegos.json` desde GitLab y genera las ~590 fichas (588 juegos a sep-2026)
estáticas en `public/`. Deploy con `deploy.bat` / `scripts/deploy.py`.

## Cómo trabajar en este proyecto (importante)

- **Investigá a fondo antes de proponer un fix.** Si el usuario dice "por qué no
  funciona X" o "mejorá X", NO des la primera explicación plausible. Listá 2-3
  hipótesis, verificá cada una contra el código real y los datos disponibles, y
  descartá con evidencia antes de concluir.
- **Sé proactivo, tomá decisiones y mostrálas.** El usuario prefiere que explores,
  decidas y le muestres el resultado con evidencia, antes que preguntarle paso a
  paso. Si sabe algo pero no sabe explicarlo, entrevistalo con AskUserQuestion.
- **Cruzá código con datos externos.** Para temas de SEO/indexación, pedile al
  usuario los datos de Search Console (Indexación → Páginas, Ajustes →
  Estadísticas de rastreo) o revisalos en su navegador — tiene sesión abierta.
  No asumas la causa solo mirando el código.
- **Si arreglás un síntoma, buscá la causa de fondo** antes de dar por cerrado
  el tema (ej.: un título faltante → ¿por qué Google no vio el cambio?).

## Estado SEO (diagnóstico jul-2026, no repetir de cero)

Datos de Search Console (jul-2026): 109 indexadas / 615 sin indexar.
Crawl: 66% "carga de recursos de página", JS+CSS+JSON = 62% de solicitudes,
HTML solo 30%. Causas identificadas en el código:

1. **Toda ficha de juego carga el shell SPA completo**: ~34 `<script>` + 12 CSS
   (incluye discord-settings-*, discord-friends, manga.js, noticias.js — nada de
   eso se usa en `/juego/slug/`). Las 742 fichas se ven casi idénticas para
   Google → "Rastreada: actualmente sin indexar".
2. **El contenido único de cada ficha está en un bloque oculto** (`#seo-static`,
   clip sr-only al final del body). El contenido visible lo renderiza JS. Google
   da poco peso a texto oculto → mal ranking aunque el título diga "en Español".
3. **`BUILD_VERSION = Date.now()` re-versiona TODOS los `?v=` en cada deploy** →
   cada deploy invalida los assets de las 742 páginas y Googlebot re-descarga
   todo el JS/CSS. Ese es el 66% de crawl desperdiciado. Mejor: hash por archivo
   (solo cambia el ?v= de archivos realmente modificados).
4. Las etiquetas "español" SÍ existen (title, meta, keywords, JSON-LD) — esa
   teoría está descartada, no volver a "agregar etiquetas" como solución.

**Fixes aplicados y deployados (2026-07-20):**
- **El JS pisaba el título SEO** (causa real de "X - Eclipse Zone" en Google):
  `updateMetaTags` y `updatePageTitle('game-detail')` ahora usan `seoGameTitle()`
  (main.js), mismo formato que el generador. NO volver a "X - Eclipse Zone".
- `#seo-static` ahora es VISIBLE (con h1 "X en Español" y h2 "Descargar X…");
  `removeSeoStatic()` en main.js lo quita cuando la app renderiza.
- Versionado `?v=` por hash md5 de archivo (`assetHash()` en generate-everything.js)
  en vez de Date.now global — solo cambia el ?v= de archivos modificados.
- `vv0.09` en títulos (el JSON ya trae la "v", la plantilla agregaba otra).

- **robots.txt bloquea los scripts que no participan del render** (discord-settings-*,
  discord-friends, analytics, anti-adblock, onboarding, social-popup, site-updates,
  ads-adsterra, patreon, sw.js): solo afecta a crawlers, los usuarios los siguen
  recibiendo. Verificado que todos sus usos en el código de render están guardados
  con `typeof`/`if (window.X)` — si se agrega un uso nuevo SIN guarda, quitarlo
  del bloqueo en generate-everything.js (sección robots.txt).
- Refactor: `versionAssetRefs()` es la ÚNICA función de versionado de assets
  (antes eran dos, addAssetVersion + bustAssetUrls, y divergieron).
- Meta descriptions cortan en límite de palabra con "…" (antes: "un apartamento so").
- **Malla de enlaces internos**: cada ficha lista 6 "Juegos relacionados" en el
  bloque SEO (relatedJuegos(): categorías compartidas +2, misma plataforma +1,
  determinista) + links a Inicio y /juegos/. Los slugs vienen del pre-pase de
  generatePages (ctx.slugOf) — NUNCA slugify() a mano para enlazar entre páginas,
  los títulos duplicados llevan sufijo -2/-3. El hash de página incluye los slugs
  relacionados (extraHashFn), así se regenera si cambian.
- Refactor generatePages: slugs asignados en pre-pase SECUENCIAL (antes se
  asignaban dentro de tareas concurrentes → sufijos de duplicados podían
  intercambiarse entre builds).
- Hollow Memories: página SÍ estaba indexada (verificado en Search Console) — el
  problema era ranking por contenido oculto + título pisado, no indexación.
  Re-indexación solicitada 2026-07-20 desde Search Console.

Pendiente (opcional): lazy-load real de los scripts pesados para usuarios (el
bloqueo robots ya cubre a Googlebot); riesgoso porque el SPA comparte scope
global entre scripts clásicos.

## ⛔ Popunder oficial = "redirect al entrar" (INCIDENTE 2026-07-22)

Reactivar el script oficial de popunder de Adsterra (a218a5a4…) con auto-load en
autoInit provocó de inmediato reportes de "al entrar los mandan a otra pestaña y
no los deja entrar" (app Y navegador). El script salta al PRIMER clic en TODAS
las páginas → indistinguible de un secuestro para el usuario. Revertido: NO se
carga (mountPopunder existe pero no se llama en autoInit). El sw.js
auto-destructivo quedó intacto y el sitio no registra SW propio → el redirect era
transitorio (per-clic), no persistente. NO volver a auto-cargar el popunder
oficial. Si se quiere popunder: acotarlo SOLO al clic de Descargar con debounce,
o quedarse con banners. El popunder "que sí monetiza" no vale espantar usuarios.

## Ads Adsterra — popunder y 1-popup-por-clic (fix 2026-07-22)

- Social Bar OFF y Native casi sin relleno = decisiones/realidad, NO bugs.
- Bug real: el popunder de descarga NUNCA aparecía porque proceedWithDownload
  hacía DOS window.open por clic (descarga + anuncio) y el navegador bloquea el
  2º. Los navegadores permiten UNA sola ventana emergente por gesto. Fix: el
  anuncio usa esa única ventana (popunder, detrás) vía `triggerPopunder()` y la
  descarga navega la pestaña actual (`location.href`); si el anuncio no dispara
  (tope 45min o bloqueado) la descarga vuelve a abrir en pestaña nueva.
- REGLA: nunca dos window.open en el mismo handler de clic.

## FOOTGUN de caché de generación — huella de assets (fix 2026-07-22)

`.generate-cache.json` saltea páginas cuyos DATOS no cambiaron. Antes, cambiar un
js/css NO regeneraba esas páginas → seguían con el `?v=` viejo (700+ páginas con
JS viejo; probable causa de varios incidentes de caché). Fix: generatePages
mezcla en el hash de cada página una huella md5 del template ya versionado
(`assetsFp`) — cualquier cambio de js/css cambia la huella y regenera TODO.
Ya NO hace falta borrar `.generate-cache.json` al cambiar assets (igual es válido
para forzar regen completa).

## Animaciones de entrada y prefers-reduced-motion (fix 2026-07-20)

El usuario tiene **"reducir movimiento" activado** en Windows (`prefers-reduced-motion:
reduce` = true en su Chrome real). Trampa: una `@keyframes` que va de opacity:0 a
opacity:1 aplicada a un overlay que se muestra con toggle de display queda CONGELADA
en el keyframe 0% (opacity:0) bajo reduced-motion → el overlay abre pero es invisible.
Fue la causa de "cuando tocas Amigos no te lleva a ningún lado" (#friendsOverlay /
.dmf-screen en discord-friends.css).
- Regla: el estado VISIBLE de un overlay nunca debe depender de que una animación/
  transición llegue a su fin. Mostrar con `display:flex` (opacity 1 por defecto) y
  poner la animación de entrada SOLO dentro de `@media (prefers-reduced-motion:
  no-preference)`.
- El navegador de preview in-app (mcp__Claude_Browser) congela el timeline de
  animaciones (corre en segundo plano) → NO sirve para verificar timing de
  animaciones. Usar mcp__claude-in-chrome (Chrome real del usuario) para eso.

## Mangas (MangaDex) — trampas conocidas (fixes 2026-07-20)

- **NUNCA cachear `/at-home/server/*` en el Worker**: MangaDex genera esas URLs
  por request y expiran en ~15 min; una respuesta cacheada da 404 en TODAS las
  páginas del capítulo (pasó con cache de 600s). Ahora va con `no-store`.
  El lector además reintenta 1 vez con at-home fresco si primary+fallback fallan
  (`reloadReaderPages()` en manga.js).
- **Todo request de capítulos debe llevar `contentRating` con los 4 valores**
  (MD_ALL_RATINGS): sin él MangaDex excluye pornographic por defecto → los
  mangas +18 muestran "No hay capítulos disponibles" aunque los tengan.
- **`/chapter` acepta `manga` solo como STRING** (array → 400 validation_exception).
  El filtro de listado (filterReadableMangas) chequea por manga con limit=1 +
  includeExternalUrl=0 y oculta los que no tienen capítulos legibles en español.
Datos del panel: muchas versiones desactualizadas (ej. Hollow Memories v0.09 vs
v1.0 real) — Google prefiere la página de competidores con versión nueva.

## Vistas de juegos (2026-09-27)

Las vistas ya NO se guardan en GitLab (`stats/views_data.json`, bloqueado): van a
D1 `ez-views` (binding EZ_VIEWS_DB, sin tokens) vía `POST /api/view` (home.js, sendBeacon,
1 por juego por sesión): tablas `view_totals` y `view_hourly` (cron borra >8 días), top en
`GET /api/views/top`. NO volver a Analytics Engine: leerlo exige un API token que el
usuario no pudo crear. El dataset AE `ez_views` quedó huérfano. El contador que ve cada visitante
en las cards sale de su propio localStorage (nunca mostró el total global).
`public/slugs.json` (título → slug) lo genera generate-everything.js para el bot.

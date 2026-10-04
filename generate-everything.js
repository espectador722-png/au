// =============================================================
// generate-everything.js — Eclipse Zone v5.2
// Generador estático para Cloudflare Pages + IndexNow + Google Indexing API
//
// CAMBIOS v5.2:
//   - Google Indexing API: notificación directa a Google en cada deploy
//   - pingSitemapGoogle(): ping automático del sitemap a Google
//   - Corregido: IndexNow solo notifica a Bing/Yandex (Google lo ignora)
//   - Nueva env var: GOOGLE_SERVICE_ACCOUNT_JSON (ver SETUP.md)
//   - Nueva env var: GOOGLE_INDEX_FORCE_ALL=true para re-indexación masiva
//
// CAMBIOS v5.1:
//   - robots.txt: Allow explícito para manifest.json y stats.json (PWA/SEO)
//   - VideoGame schema: campo operatingSystem añadido
//   - WebSite schema: campo publisher (Organization) añadido al home
//   - Prioridad sitemap juegos ajustada a 0.85 (home=1.0, /juegos/=0.9)
//   - Páginas índice /juegos/ y /noticias/ con datos pre-embebidos (SEO)
//   - stats.json — contadores listos antes de que cargue el JSON principal
//   - Manifest PWA generado automáticamente
//   - Validación mejorada (imágenes faltantes, links inválidos)
//   - --help flag con documentación completa
//   - --only=home para builds rápidos (solo estáticos)
//   - CSP y headers de seguridad mejorados
//   - Reporte final más detallado
//
// LÓGICA DE INDEXACIÓN:
//   - IndexNow notifica a Bing y Yandex en cada deploy (Google ignora IndexNow).
//   - Google Indexing API notifica a Google directamente (requiere GOOGLE_SERVICE_ACCOUNT_JSON).
//   - Las páginas nuevas/modificadas se envían primero; cuota Google: 200 URLs/día.
//   - Compatible con Cloudflare Pages (build command: node generate-everything.js)
// =============================================================

'use strict';

const fs     = require('fs');
const path   = require('path');
const https  = require('https');
const http   = require('http');
const crypto = require('crypto');
const os     = require('os');
const { runGoogleIndexingAPI } = require('./scripts/google-indexing');

// ─── CLI FLAGS ────────────────────────────────────────────────
const argv = process.argv.slice(2).reduce((acc, arg) => {
    if (arg === '--help' || arg === '-h') { acc['help'] = true; return acc; }
    const [key, val] = arg.replace(/^--/, '').split('=');
    acc[key] = val !== undefined ? val : true;
    return acc;
}, {});

if (argv['help']) {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Eclipse Zone — Generador estático v5.0                      ║
╠══════════════════════════════════════════════════════════════╣
║  USO: node generate-everything.js [opciones]                 ║
╠══════════════════════════════════════════════════════════════╣
║  OPCIONES:                                                   ║
║    --only=<sección>    Generar solo una sección:             ║
║                        all | juegos | noticias | home        ║
║    --output=<dir>      Directorio de salida (default: public)║
║    --dry-run           Simular sin escribir archivos         ║
║    --no-cache          Ignorar caché y regenerar todo        ║
║    --verbose           Log detallado (DEBUG level)           ║
║    --concurrency=<n>   Workers paralelos (default: 10)       ║
║    --skip-index        Omitir notificación IndexNow          ║
║    --check-links       Verificar accesibilidad de links      ║
║    --help, -h          Mostrar esta ayuda                    ║
╠══════════════════════════════════════════════════════════════╣
║  ENV VARS:                                                   ║
║    INDEXNOW_KEY                Clave para IndexNow           ║
║                                (32-128 hex chars)            ║
║    GOOGLE_SERVICE_ACCOUNT_JSON JSON de Service Account       ║
║                                (Google Indexing API)         ║
║    GOOGLE_INDEX_FORCE_ALL      "true" para enviar todas las  ║
║                                URLs (usa toda la cuota)      ║
╠══════════════════════════════════════════════════════════════╣
║  EJEMPLOS:                                                   ║
║    node generate-everything.js                               ║
║    node generate-everything.js --only=juegos                 ║
║    node generate-everything.js --dry-run --verbose           ║
║    node generate-everything.js --no-cache --concurrency=20   ║
║    node generate-everything.js --only=home                   ║
╚══════════════════════════════════════════════════════════════╝
`);
    process.exit(0);
}

const ONLY        = argv['only']        || 'all';
const DRY_RUN     = argv['dry-run']     === true;
const NO_CACHE    = argv['no-cache']    === true;
const VERBOSE     = argv['verbose']     === true;
const CONCURRENCY = parseInt(argv['concurrency'] || '10', 10);
const SKIP_INDEX  = argv['skip-index']  === true;
const CHECK_LINKS = argv['check-links'] === true;

// ─── CONFIGURACIÓN GENERAL ───────────────────────────────────
const CONFIG = {
    baseUrl:          'https://eclipsezonehub.com',
    // Van por el Worker, no por gitlab.com directo: `senpai1940/juegos` es
    // privado desde 2026-07-29 y las URLs "/-/raw/" devuelven 302 al login.
    // El Worker inyecta el token server-side, así que el generador no necesita
    // credenciales locales. (`noticias` sigue público, pero se unifica igual.)
    juegosJsonUrl:    'https://eclipsezonehub.com/api/gl/projects/senpai1940%2Fjuegos/repository/files/juegos.json/raw?ref=main',
    noticiasJsonUrl:  'https://eclipsezonehub.com/api/gl/projects/senpai1940%2Fnoticias/repository/files/noticias.json/raw?ref=main',
    rootDir:          __dirname,
    publicDir:        argv['output'] ? path.resolve(argv['output']) : path.join(__dirname, 'public'),
    templatePath:     path.join(__dirname, 'index.html'),
    cacheFile:        path.join(__dirname, '.generate-cache.json'),
    // 'admin' se agregó 2026-09-21: antes public/admin/ quedaba desincronizado
    // a mano (el panel nuevo /admin/patreon/ no existía ahí hasta correr esto).
    staticDirs:       ['css', 'js', 'vendor', 'cosmetics', 'eclipse-mod', 'img', 'admin'],
    staticFiles:      ['favicon.png', 'Eclipse.png', 'Eclipse-icon.png', 'icon-192.png', 'icon-512.png', 'sw.js'],
    fetchTimeout:     15_000,
    maxRedirects:     5,
    sitemapMaxUrls:   45_000,
    // Fecha fija para lastmod de items sin fecha real en su JSON (ver comentario
    // en generatePages) — NUNCA "hoy": debe quedar estable entre builds.
    fallbackLastmod:  '2026-01-01',
    // PWA Manifest
    pwaManifest: {
        name:             'Eclipse Zone',
        short_name:       'EclipseZone',
        description:      'Juegos y mangas traducidos al español',
        start_url:        '/',
        display:          'standalone',
        background_color: '#0d0d0d',
        theme_color:      '#5865F2',
        // icon-192/icon-512 generados a partir de favicon.png (500x500, cuadrado).
        // Antes se usaba Eclipse.png etiquetado como 512x512 pero el archivo real
        // es 3000x1700 — Android/Chrome recortaban o mostraban el ícono genérico.
        icons: [
            { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
        categories: ['games', 'entertainment'],
        lang:        'es',
    },
};

// ─── CONFIGURACIÓN DE INDEXNOW ───────────────────────────────
const INDEXNOW = {
    enabled:     !!process.env.INDEXNOW_KEY,
    key:         process.env.INDEXNOW_KEY || '',
    get keyLocation() {
        return `${CONFIG.baseUrl}/${this.key}.txt`;
    },
};

// ─── CONFIGURACIÓN DE GOOGLE INDEXING API ────────────────────
// Requiere GOOGLE_SERVICE_ACCOUNT_JSON en las variables de entorno.
// Ver SETUP.md para instrucciones de configuración.
const GOOGLE_INDEXING = {
    // Cuota diaria (default Google: 200). Usamos 180 para dejar margen.
    // Para ampliarla: Google Cloud Console → Indexing API → Quotas
    dailyQuota: 180,
    // Delay entre requests (ms). 500 = 2 req/s máximo.
    delayMs: 500,
    // Si true, envía TODAS las URLs en cada deploy (usa toda la cuota).
    // Activar con: GOOGLE_INDEX_FORCE_ALL=true en Cloudflare Pages env vars.
    forceAll: process.env.GOOGLE_INDEX_FORCE_ALL === 'true',
};

// ─── LOGGER ──────────────────────────────────────────────────
const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const LOG_MIN    = VERBOSE ? LOG_LEVELS.DEBUG : LOG_LEVELS.INFO;

const log = {
    debug : (...a) => LOG_MIN <= LOG_LEVELS.DEBUG && console.debug('\x1b[90m[DEBUG]\x1b[0m', ...a),
    info  : (...a) => LOG_MIN <= LOG_LEVELS.INFO  && console.log  ('\x1b[36m[INFO ]\x1b[0m', ...a),
    warn  : (...a) => LOG_MIN <= LOG_LEVELS.WARN  && console.warn ('\x1b[33m[WARN ]\x1b[0m', ...a),
    error : (...a) => LOG_MIN <= LOG_LEVELS.ERROR && console.error('\x1b[31m[ERROR]\x1b[0m', ...a),
    ok    : (...a) => console.log('\x1b[32m[OK   ]\x1b[0m', ...a),
};

// ─── HELPERS ─────────────────────────────────────────────────

function slugify(text) {
    if (!text) return '';
    return text.toString().toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/--+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function uniqueSlug(base, used) {
    if (!used.has(base)) { used.add(base); return base; }
    let i = 2;
    while (used.has(`${base}-${i}`)) i++;
    used.add(`${base}-${i}`);
    return `${base}-${i}`;
}

function formatDate(d) {
    if (!d) return new Date().toISOString().split('T')[0];
    try { return new Date(d).toISOString().split('T')[0]; }
    catch { return new Date().toISOString().split('T')[0]; }
}

function esc(str = '') {
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Redirige cualquier imagen externa a través del proxy/caché del Worker
// (/api/img), que la guarda en KV la primera vez que se pide. Así, si el
// link original (ej. cdn.discordapp.com, que expira a las pocas horas) se
// rompe después, la página estática generada sigue mostrando la imagen ya
// cacheada. Ver eclipse-main/worker.js → proxyImage().
function cachedImageUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
    if (rawUrl.startsWith(CONFIG.baseUrl)) return rawUrl;
    return `${CONFIG.baseUrl}/api/img?u=${encodeURIComponent(rawUrl)}`;
}

function hashObject(obj) {
    return crypto.createHash('sha1').update(JSON.stringify(obj)).digest('hex');
}

async function runPool(tasks, concurrency) {
    const results = [];
    let i = 0;
    async function worker() {
        while (i < tasks.length) {
            const idx = i++;
            results[idx] = await tasks[idx]();
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
    return results;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Formato humano de bytes
function humanSize(bytes) {
    if (bytes < 1024)       return `${bytes} B`;
    if (bytes < 1024**2)    return `${(bytes/1024).toFixed(1)} KB`;
    return `${(bytes/1024**2).toFixed(1)} MB`;
}

// ─── FETCH GENÉRICO ──────────────────────────────────────────

function fetchText(url, retries = 3, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        if (redirectCount > CONFIG.maxRedirects) {
            return reject(new Error(`Demasiadas redirecciones: ${url}`));
        }
        const lib = url.startsWith('https') ? https : http;
        const req = lib.get(url, { headers: { 'User-Agent': 'EclipseZoneSiteGenerator/5.0' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return fetchText(res.headers.location, retries, redirectCount + 1).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} → ${url}`));
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve(data));
        });
        req.setTimeout(CONFIG.fetchTimeout, () => req.destroy(new Error(`Timeout → ${url}`)));
        req.on('error', (err) => {
            if (retries > 1) {
                const delay = 2000 * Math.pow(2, 3 - retries);
                log.debug(`Reintentando ${url} en ${delay}ms…`);
                setTimeout(() => fetchText(url, retries - 1, redirectCount).then(resolve).catch(reject), delay);
            } else reject(err);
        });
    });
}

// Verificación rápida de disponibilidad de un link (HEAD request, timeout 5s)
function checkLinkAlive(url) {
    return new Promise((resolve) => {
        try {
            const lib = url.startsWith('https') ? https : http;
            const req = lib.request(url, { method: 'HEAD', headers: { 'User-Agent': 'EclipseZoneLinkChecker/1.0' } }, (res) => {
                resolve({ url, ok: res.statusCode < 400, status: res.statusCode });
            });
            req.setTimeout(5000, () => { req.destroy(); resolve({ url, ok: false, status: 'timeout' }); });
            req.on('error', () => resolve({ url, ok: false, status: 'error' }));
            req.end();
        } catch {
            resolve({ url, ok: false, status: 'exception' });
        }
    });
}

// ─── HTTP POST HELPER ────────────────────────────────────────

function httpPost(hostname, urlPath, headers, body) {
    return new Promise((resolve, reject) => {
        const bodyStr = JSON.stringify(body);
        const options = {
            hostname, path: urlPath, method: 'POST',
            headers: {
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(bodyStr),
                ...headers,
            },
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
                catch { resolve({ status: res.statusCode, body: data }); }
            });
        });
        req.setTimeout(15_000, () => req.destroy(new Error('Timeout en httpPost')));
        req.on('error', reject);
        req.write(bodyStr);
        req.end();
    });
}

// ─── VALIDACIÓN ──────────────────────────────────────────────

const VALIDATION_ERRORS   = [];
const VALIDATION_WARNINGS = [];

function validateJuego(juego, idx) {
    const errors   = [];
    const warnings = [];

    if (!juego.titulo)      errors.push('Falta "titulo"');
    if (!juego.descripcion) errors.push('Falta "descripcion"');

    // Advertencias (no bloquean la generación)
    if (!juego.imagen && !(juego.imagenes && juego.imagenes.length))
        warnings.push('Sin imagen');
    if (!juego.links || !juego.links.length)
        warnings.push('Sin links de descarga');
    if (!(Array.isArray(juego.plataformas) && juego.plataformas.length) && !juego.plataforma)
        warnings.push('Sin plataforma definida');
    if (!juego.version)
        warnings.push('Sin versión');

    if (errors.length) {
        VALIDATION_ERRORS.push({ tipo: 'juego', idx, id: juego.titulo || `índice ${idx}`, errors });
        log.warn(`Juego #${idx} inválido [${errors.join(', ')}]: ${juego.titulo || 'sin título'}`);
    }
    if (warnings.length && VERBOSE) {
        VALIDATION_WARNINGS.push({ tipo: 'juego', idx, id: juego.titulo || `índice ${idx}`, warnings });
        log.debug(`Juego #${idx} advertencias [${warnings.join(', ')}]: ${juego.titulo || 'sin título'}`);
    }
    return errors.length === 0;
}

function validateNoticia(noticia, idx) {
    const errors   = [];
    const warnings = [];

    if (!noticia.title)                            errors.push('Falta "title"');
    if (!noticia.shortContent && !noticia.content) errors.push('Falta "shortContent" o "content"');

    if (!noticia.image && !(noticia.images && noticia.images.length))
        warnings.push('Sin imagen');
    if (!noticia.date && !noticia.fecha)
        warnings.push('Sin fecha');
    if (!noticia.author)
        warnings.push('Sin autor');

    if (errors.length) {
        VALIDATION_ERRORS.push({ tipo: 'noticia', idx, id: noticia.title || `índice ${idx}`, errors });
        log.warn(`Noticia #${idx} inválida [${errors.join(', ')}]: ${noticia.title || 'sin título'}`);
    }
    if (warnings.length && VERBOSE) {
        VALIDATION_WARNINGS.push({ tipo: 'noticia', idx, id: noticia.title || `índice ${idx}`, warnings });
        log.debug(`Noticia #${idx} advertencias [${warnings.join(', ')}]: ${noticia.title || 'sin título'}`);
    }
    return errors.length === 0;
}

// ─── CACHÉ ───────────────────────────────────────────────────

function loadCache() {
    if (NO_CACHE || !fs.existsSync(CONFIG.cacheFile)) return {};
    try { return JSON.parse(fs.readFileSync(CONFIG.cacheFile, 'utf8')); }
    catch { return {}; }
}

function saveCache(cache) {
    if (DRY_RUN) return;
    fs.writeFileSync(CONFIG.cacheFile, JSON.stringify(cache, null, 2), 'utf8');
}

// ─── HTML BUILDER ────────────────────────────────────────────

function buildHTML(template, { title, description, image, canonicalUrl, structuredData, breadcrumb, seoBody, headExtra, pageType }) {
    let html = template;

    // pageType → data-page en <body>: pageLoader.js (ver js/pageLoader.js)
    // lo lee para decidir qué scripts data-lazy-src cargar. Sin pageType
    // (home) no se agrega el atributo — el grupo "home" se asigna aparte
    // en buildHomeHTML porque la home no pasa por buildHTML genérico.
    if (pageType) {
        html = html.replace(/<body([^>]*)>/, (m, attrs) => {
            if (/data-page=/.test(attrs)) return m;
            return `<body${attrs} data-page="${pageType}">`;
        });
    }

    const safeTitle = esc(title);
    let cleanDesc = description.replace(/<[^>]+>/g, '').replace(/\n/g, ' ').trim();
    if (cleanDesc.length > 160) {
        // Cortar en límite de palabra (antes quedaba a mitad de palabra:
        // "…un apartamento so" — se ve roto en los resultados de Google).
        cleanDesc = cleanDesc.slice(0, 157).replace(/\s+\S*$/, '') + '…';
    }
    const safeDesc  = esc(cleanDesc);
    // Discord/Twitter/Facebook no muestran preview si og:image es AVIF (el
    // formato que F95Zone sirve por defecto para las imágenes de juegos).
    // &format=jpeg activa la transformación cf.image del proxy solo acá,
    // sin afectar el AVIF que sí conviene para el resto del sitio.
    const ogImageRaw = image || `${CONFIG.baseUrl}/Eclipse.png`;
    const safeImage  = esc(ogImageRaw.startsWith(`${CONFIG.baseUrl}/api/img?`) ? `${ogImageRaw}&format=jpeg` : ogImageRaw);
    const safeUrl   = esc(canonicalUrl);
    const ogType    = ['NewsArticle', 'VideoGame'].includes(structuredData['@type']) ? 'article' : 'website';

    html = html.replace(/<title>[^<]*<\/title>/, `<title>${safeTitle}</title>`);
    html = html.replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${safeDesc}">`);
    html = html
        .replace(/<link rel="canonical"[^>]*>/gi, '')
        .replace(/<meta property="og:[^"]*"[^>]*>/gi, '')
        .replace(/<meta name="twitter:[^"]*"[^>]*>/gi, '')
        .replace(/<meta name="robots"[^>]*>/gi, '')
        .replace(/<script type="application\/ld\+json"[\s\S]*?<\/script>/gi, '');

    const ldScripts = [structuredData, breadcrumb].filter(Boolean)
        .map(s => `<script type="application/ld+json">\n${JSON.stringify(s, null, 2)}\n</script>`)
        .join('\n  ');

    const injection = `
  <link rel="canonical" href="${safeUrl}">
  <link rel="manifest" href="/manifest.json">
  <link rel="alternate" type="application/rss+xml" title="Eclipse Zone — Noticias" href="/feed.xml">
  <meta name="theme-color" content="#5865F2">
  <meta name="robots" content="index, follow">
  <meta property="og:type"         content="${ogType}">
  <meta property="og:url"          content="${safeUrl}">
  <meta property="og:title"        content="${safeTitle}">
  <meta property="og:description"  content="${safeDesc}">
  <meta property="og:image"        content="${safeImage}">
  <meta property="og:locale"       content="es_ES">
  <meta property="og:site_name"    content="Eclipse Zone">${ogType === 'article' ? `
  <meta property="article:published_time" content="${structuredData.datePublished}">
  <meta property="article:modified_time"  content="${structuredData.dateModified}">` : ''}
  <meta name="twitter:card"        content="summary_large_image">
  <meta name="twitter:site"        content="@eclipsezonehub">
  <meta name="twitter:title"       content="${safeTitle}">
  <meta name="twitter:description" content="${safeDesc}">
  <meta name="twitter:image"       content="${safeImage}">
  ${ldScripts}`;

    html = html.replace('</head>', injection + '\n</head>');

    if (headExtra) {
        html = html.replace('</head>', headExtra + '\n</head>');
    }

    // ── Ocultar pantallas de carga/splash ────────────────────
    // Antes se ocultaba loadingScreen/initialBlackScreen de entrada para que
    // Googlebot (que no puede llamar a la API externa en su sandbox) no se
    // quedara viendo "Error de carga". Pero eso dejaba a los usuarios reales
    // sin ninguna pantalla de carga durante el fetch, exponiendo el #seo-static
    // (texto plano sin estilos) como único contenido visible — el "pantallazo"
    // reportado 2026-08-18. _onLoadError ya tiene un fallback a los datos
    // prerenderizados (__GAME_DATA__/__NEWS_DATA__/__HOME_PREVIEW__) que cubre
    // el caso de Googlebot sin necesidad de ocultar el loader, así que dejamos
    // que loadingScreen/initialBlackScreen se comporten con normalidad.

    if (seoBody) {
        // #seo-static es contenido VISIBLE: Google le da muy poco peso al texto
        // oculto (la técnica sr-only anterior hacía que Google reescribiera los
        // títulos a "X - Eclipse Zone" porque nada visible los respaldaba).
        // main.js lo elimina (removeSeoStatic) cuando la app renderiza el
        // contenido real, así que los usuarios con JS no lo ven duplicado.
        //
        // Se inyecta INMEDIATAMENTE después de <body>, antes de initialBlackScreen/
        // loadingScreen: antes iba pegado a </body>, es decir después de ~800 líneas
        // de HTML idéntico en las 554 páginas del sitio (splash, nav, contenedores
        // vacíos de la SPA). Google evalúa de qué trata la página en gran medida por
        // lo que aparece primero en el documento — con el contenido único al final,
        // lo primero que "leía" en cada página era el mismo chrome genérico repetido
        // en todo el sitio, diluyendo la señal de relevancia del contenido real.
        const seoStyle = `<style>
#seo-static{max-width:820px;margin:24px auto;padding:16px 20px;line-height:1.6;color:#d5d5e0}
#seo-static img{max-width:100%;max-height:360px;width:auto;height:auto;object-fit:contain;border-radius:12px;display:block;margin:0 auto 12px}
#seo-static h1{font-size:1.55rem;margin:10px 0}
#seo-static h2{font-size:1.15rem;margin:14px 0 6px}
</style>`;
        html = html.replace(/(<body[^>]*>)/, `$1\n<!-- SEO static block -->\n${seoStyle}\n${seoBody}`);
    }

    return html;
}

// ─── BREADCRUMB ──────────────────────────────────────────────

function buildBreadcrumb(items) {
    return {
        "@context": "https://schema.org",
        "@type":    "BreadcrumbList",
        "itemListElement": items.map((item, i) => ({
            "@type": "ListItem", "position": i + 1, "name": item.name, "item": item.url,
        })),
    };
}

// ─── HELPERS COMPARTIDOS DE JSON-LD / SEO ────────────────────
// Antes estos patrones estaban copiados en cada buildXHTML; centralizarlos
// evita que vuelvan a divergir (ya pasó con las funciones de versionado).
const ORG_NAME = 'Eclipse Zone';

// Objeto Organization (Schema.org) reutilizado en todos los JSON-LD.
function orgPublisher({ logo = false } = {}) {
    const org = { "@type": "Organization", "name": ORG_NAME, "url": CONFIG.baseUrl };
    if (logo) org.logo = { "@type": "ImageObject", "url": CONFIG.baseUrl + '/Eclipse.png' };
    return org;
}

// Schema CollectionPage para las páginas índice (/juegos/, /noticias/).
function collectionPageSchema(title, description, url, count) {
    return {
        "@context": "https://schema.org", "@type": "CollectionPage",
        "name": title, "description": description,
        "url": url, "inLanguage": "es",
        "publisher": orgPublisher(),
        "numberOfItems": count,
    };
}

// Lista <li><a> de enlaces internos para el bloque #seo-static de los índices.
// `path` es el prefijo de sección ('/juego/', '/noticia/') y getTitle extrae
// el título del item (el slug se deriva de él).
function seoLinkList(items, { path, getTitle }) {
    return items.map(it => {
        const t = getTitle(it);
        return `<li><a href="${esc(CONFIG.baseUrl + path + slugify(t) + '/')}">${esc(t)}</a></li>`;
    }).join('');
}

// Platforms as a flat array. The admin saves juego.plataformas (array), but
// F95Pipeline/auto_upload save juego.plataforma (singular) AS AN ARRAY
// (161 games as of 2026-09-26) — both shapes must be accepted, otherwise the
// title shows the raw "PC,Android".
function plataformasDe(j) {
    if (Array.isArray(j.plataformas) && j.plataformas.length) return j.plataformas;
    if (Array.isArray(j.plataforma)) return j.plataforma.filter(Boolean);
    return j.plataforma ? [j.plataforma] : [];
}
function plataformaTexto(j) {
    const arr = plataformasDe(j);
    return arr.length ? arr.join(', ') : 'Multiplataforma';
}

// Formato "PC y Android" / "PC, Android y JoiPlay" para título/H1 — imita el
// patrón de competidores (hotzone18.com: "Español PC/Android") que listan
// plataformas con conectores naturales en vez de una lista con comas cruda.
// PC primero porque así lo hace la competencia y es la plataforma "default".
function plataformaTituloTexto(plataformasArr) {
    if (!plataformasArr.length) return 'Multiplataforma';
    const ordenadas = [...plataformasArr].sort((a, b) => {
        const aPc = /^pc$/i.test(a) ? 0 : 1;
        const bPc = /^pc$/i.test(b) ? 0 : 1;
        return aPc - bPc;
    });
    if (ordenadas.length === 1) return ordenadas[0];
    return `${ordenadas.slice(0, -1).join(', ')} y ${ordenadas[ordenadas.length - 1]}`;
}

// Mapeos de preview embebido (window.__*_PREVIEW__), compartidos entre el home
// y las páginas índice. El frontend los lee antes de descargar el JSON completo.
function juegoPreview(g) {
    return {
        titulo:     g.titulo,
        plataforma: plataformaTexto(g),
        imagen:     cachedImageUrl((g.imagenes && g.imagenes[0]) || g.imagen || ''),
        version:    g.version || '',
        categorias: g.categorias || [],
        slug:       slugify(g.titulo),
    };
}
function noticiaPreview(n) {
    return {
        title:        n.title,
        shortContent: n.shortContent || (n.content || '').substring(0, 120),
        image:        (n.images && n.images[0]) || n.image || '',
        date:         n.date || n.fecha || '',
        slug:         slugify(n.title),
    };
}

// ─── GENERADORES POR TIPO ────────────────────────────────────

// Juegos relacionados (para la malla de enlaces internos del bloque SEO):
// puntúa por categorías compartidas (+2 c/u) y misma plataforma (+1).
// Determinista: desempata por título para que el mismo input dé el mismo HTML.
function relatedJuegos(juego, ctx, max = 12) {
    if (!ctx || !ctx.items) return [];
    const cats = new Set(Array.isArray(juego.categorias) ? juego.categorias : []);
    return ctx.items
        .map((other, idx) => {
            if (other === juego || !ctx.isValid[idx]) return null;
            const otherCats = Array.isArray(other.categorias) ? other.categorias : [];
            let score = otherCats.reduce((s, c) => s + (cats.has(c) ? 2 : 0), 0);
            if (plataformaTexto(other) === plataformaTexto(juego)) score += 1;
            return score > 0 ? { other, score } : null;
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score || String(a.other.titulo).localeCompare(String(b.other.titulo)))
        .slice(0, max)
        .map(r => r.other);
}

function buildJuegoHTML(template, juego, canonicalUrl, ctx) {
    // Algunos títulos vienen con espacio inicial desde el origen del dato
    // (ej. F95zone con un emoji/espacio delante del nombre real) — sin
    // normalizar, ese espacio se propaga a <title>, <h1>, meta description
    // y keywords, generando " NTR Hunter..." en vez de "NTR Hunter...".
    if (typeof juego.titulo === 'string') juego.titulo = juego.titulo.trim();
    const plataformasArr = plataformasDe(juego);
    const plataforma     = plataformaTexto(juego);
    // Quien busca "<juego> apk" o "<juego> en español apk" está buscando el
    // paquete de instalación para Android/JoiPlay — el título original nunca
    // decía "apk" en ningún juego (usaba juego.plataforma, campo inexistente,
    // así que siempre caía a "Multiplataforma"), por eso Google no rankeaba
    // esas variantes aunque el sitio sí tuviera el juego.
    const esAndroid       = plataformasArr.some(p => /android|joiplay/i.test(p));
    // "APK" solo tiene sentido cuando TODAS las plataformas son Android/JoiPlay:
    // en un juego multiplataforma (ej. "para Android, PC, JoiPlay") mezclar
    // "APK" con "PC" en el título es semánticamente incoherente — APK es un
    // formato de instalación exclusivo de Android, no existe "PC APK".
    const soloAndroid     = plataformasArr.length > 0 && plataformasArr.every(p => /android|joiplay/i.test(p));
    // "v" only for purely numeric versions: "S2 v10.0.1" / "Ep. 5" stay as-is.
    const version         = juego.version ? ` ${String(juego.version).trim().replace(/^v*(?=\d)/i, 'v')}` : '';
    const apkSuffix       = soloAndroid ? ' APK' : '';
    // Si es solo Android/JoiPlay, "APK" ya lo dice todo — repetir "Android"
    // después es redundante ("Español APK Android").
    const plataformaTitulo = soloAndroid ? '' : ` ${plataformaTituloTexto(plataformasArr)}`;
    const title          = `${juego.titulo}${version} Español${apkSuffix}${plataformaTitulo}`;
    const description    = (juego.descripcion || `Descarga ${juego.titulo} traducido al español gratis en Eclipse Zone.`)
                            .replace(/<[^>]+>/g, '').replace(/"/g, "'").trim();
    const image          = cachedImageUrl((juego.imagenes && juego.imagenes[0]) || juego.imagen || '');
    const categorias     = Array.isArray(juego.categorias) ? juego.categorias : [];
    const keywords       = [
        juego.titulo, `${juego.titulo} en español`,
        ...(esAndroid ? [`${juego.titulo} apk`, `${juego.titulo} en español apk`, `${juego.titulo} apk en español`] : []),
        plataforma, 'eclipse zone', 'traducción español', ...categorias,
    ].filter(Boolean).join(', ');
    const datePublished  = formatDate(juego.fechaRegistro || juego.fechaActualizacion);
    const dateModified   = formatDate(juego.fechaActualizacion || juego.fechaRegistro);

    const structuredData = {
        "@context": "https://schema.org", "@type": "VideoGame",
        "name": juego.titulo, "description": description, "image": image,
        "genre": categorias,
        "gamePlatform": plataforma, "version": juego.version || '',
        "operatingSystem": plataforma,
        "inLanguage": "es", "url": canonicalUrl,
        "datePublished":  datePublished,
        "dateModified":   dateModified,
        "offers": { "@type": "Offer", "price": "0", "priceCurrency": "USD", "availability": "https://schema.org/InStock" },
        "publisher": orgPublisher(),
        "applicationCategory": "Game",
    };
    const breadcrumb = buildBreadcrumb([
        { name: 'Inicio', url: CONFIG.baseUrl + '/' },
        { name: 'Juegos', url: CONFIG.baseUrl + '/juegos/' },
        { name: juego.titulo, url: canonicalUrl },
    ]);

    // Solo enlazamos categorías que tienen su propia página generada
    // (MIN_CATEGORIA_JUEGOS) — enlazar a una URL que no existe sería peor
    // que no enlazar nada.
    const categoriasHtml  = categorias.length
        ? categorias.map(c => (ctx && ctx.categoriaSlugs && ctx.categoriaSlugs.has(c))
            ? `<a href="/categoria/${categoriaSlug(c)}/">${esc(c)}</a>`
            : `<span>${esc(c)}</span>`).join(', ')
        : '';
    const fechaMod    = dateModified;
    const versionText = juego.version ? `<span>Versión: ${esc(juego.version)}</span> · ` : '';
    const imgTag      = image ? `<img src="${esc(image)}" alt="${esc(juego.titulo)}" width="300" height="169" loading="lazy" decoding="async">` : '';

    // Bloque de datos propios de Eclipse Zone (traductor, fecha de alta en
    // el sitio, estado de la traducción): ningún espejo que republica la
    // misma sinopsis de F95zone tiene estos datos, así que ayuda a que la
    // ficha no se vea como "una copia más" ante Google (ver CHANGELOG.md,
    // fix de indexación 2026-09-07 — 62 páginas "Rastreada: sin indexar").
    const traductoresArr = Array.isArray(juego.traductores) ? juego.traductores.filter(Boolean) : [];
    // formatDate() devuelve la fecha de HOY si no recibe dato — no usarla acá
    // directo, o "Agregado a Eclipse Zone: <hoy>" saldría en juegos sin ese
    // campo real en vez de omitir la línea.
    const fechaAlta        = juego.fechaRegistro ? formatDate(juego.fechaRegistro) : '';
    const estadoTraduccion = juego.estado ? String(juego.estado).trim() : '';
    const datosPropiosHtml = (traductoresArr.length || fechaAlta || estadoTraduccion)
        ? `\n  <p>${[
            traductoresArr.length ? `<span>Traducido por: ${esc(traductoresArr.join(', '))}</span>` : '',
            fechaAlta ? `<span>Agregado a Eclipse Zone: ${fechaAlta}</span>` : '',
            estadoTraduccion ? `<span>Estado de la traducción: ${esc(estadoTraduccion)}</span>` : '',
          ].filter(Boolean).join(' · ')}</p>`
        : '';

    // Malla de enlaces internos: sin esto cada ficha era un callejón sin
    // salida para Google (solo el listado /juegos/ la enlazaba).
    const relacionados = relatedJuegos(juego, ctx);
    const relatedHtml  = relacionados.length
        ? `\n  <h2>Juegos relacionados en Español</h2>\n  <ul>\n${relacionados.map(r =>
            `    <li><a href="/juego/${ctx.slugOf.get(r)}/">${esc(r.titulo)} en Español (${esc(plataformaTexto(r))})</a></li>`
          ).join('\n')}\n  </ul>`
        : '';

    const seoBody = `<div id="seo-static">
  ${imgTag}
  <h1>${esc(juego.titulo)} Español${apkSuffix}${esc(plataformaTitulo)}</h1>
  <p>${esc(description)}</p>
  <h2>Descargar ${esc(juego.titulo)} Español${apkSuffix}${esc(plataformaTitulo)}</h2>
  <p>
    <span>Plataforma: ${esc(plataforma)}</span> ·
    ${versionText}
    <span>Actualizado: ${fechaMod}</span>
    ${categoriasHtml ? ` · <span>Géneros: ${categoriasHtml}</span>` : ''}
  </p>${datosPropiosHtml}${relatedHtml}
  <p><a href="/">Inicio</a> · <a href="/juegos/">Todos los juegos</a></p>
</div>`;

    // Juegos exclusivos (Patreon): el link real NUNCA va en el HTML estático
    // (es público, sin login, indexable por cualquiera con "ver código
    // fuente"). Se pide en vivo a /api/patreon/exclusive-games, que el Worker
    // solo responde si la membresía está verificada como activa en KV — ver
    // js/patreon.js (fetchExclusiveGames) y patreonExclusiveGames() en worker.js.
    // Lo mismo aplica a juegos bloqueados por género completo (no solo por el
    // flag `exclusivo` individual) — ver isGameLocked() en juegos-core.js.
    const esExclusivo = juego.exclusivo === true;
    const gameDataScript = `<script>window.__GAME_DATA__ = ${JSON.stringify({
        slug:              canonicalUrl.replace(/\/$/, '').split('/').pop(),
        titulo:            juego.titulo,
        descripcion:       juego.descripcion || '',
        version:           juego.version || '',
        plataforma:        plataforma,
        categorias:        categorias,
        imagen:            image,
        imagenes:          (juego.imagenes || (image ? [image] : [])).map(cachedImageUrl),
        exclusivo:         esExclusivo,
        links:             esExclusivo ? [] : (juego.links || []),
        traductores:       juego.traductores || [],
        linksPorTraductor: esExclusivo ? {} : (juego.linksPorTraductor || {}),
        fechaActualizacion:juego.fechaActualizacion || '',
        fechaRegistro:     juego.fechaRegistro || '',
        estado:            juego.estado || '',
    })};</script>`;

    // keywords meta inyectado en headExtra
    const keywordsMeta = `<meta name="keywords" content="${esc(keywords)}">`;

    return buildHTML(template, { title, description, image, canonicalUrl, structuredData, breadcrumb, seoBody, headExtra: keywordsMeta + '\n  ' + gameDataScript, pageType: 'juego' });
}

function buildNoticiaHTML(template, noticia, canonicalUrl) {
    const title          = noticia.title;
    const description    = (noticia.shortContent || noticia.content || `Lee la noticia: ${noticia.title} en Eclipse Zone.`)
                            .replace(/"/g, "'").replace(/<[^>]+>/g, '').trim();
    const image          = (noticia.images && noticia.images[0]) || noticia.image || noticia.thumbnail || '';
    const structuredData = {
        "@context": "https://schema.org", "@type": "NewsArticle",
        "headline": noticia.title, "description": description,
        "image": image ? [image] : [],
        "datePublished":  formatDate(noticia.date || noticia.fecha),
        "dateModified":   formatDate(noticia.dateModified || noticia.date || noticia.fecha),
        "inLanguage": "es", "url": canonicalUrl,
        "author":    { "@type": "Organization", "name": noticia.author || ORG_NAME },
        "publisher": orgPublisher({ logo: true }),
        "keywords": Array.isArray(noticia.tags) ? noticia.tags.join(', ') : (noticia.categoria || ''),
        "mainEntityOfPage": { "@type": "WebPage", "@id": canonicalUrl },
    };
    const breadcrumb = buildBreadcrumb([
        { name: 'Inicio',   url: CONFIG.baseUrl + '/' },
        { name: 'Noticias', url: CONFIG.baseUrl + '/noticias/' },
        { name: noticia.title, url: canonicalUrl },
    ]);

    const fechaPub   = formatDate(noticia.date || noticia.fecha);
    const autor      = esc(noticia.author || 'Eclipse Zone');
    const tags       = Array.isArray(noticia.tags) && noticia.tags.length
        ? noticia.tags.map(t => `<span>${esc(t)}</span>`).join(', ')
        : (noticia.categoria ? esc(noticia.categoria) : '');
    const imgTag     = image ? `<img src="${esc(image)}" alt="${esc(noticia.title)}" width="300" height="169" loading="lazy" decoding="async">` : '';
    const fullText   = (noticia.content || noticia.shortContent || '')
        .replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().substring(0, 600);

    const seoBody = `<div id="seo-static">
  ${imgTag}
  <h1>${esc(noticia.title)}</h1>
  <p>
    <span>Publicado: ${fechaPub}</span> ·
    <span>Autor: ${autor}</span>
    ${tags ? ` · <span>Tags: ${tags}</span>` : ''}
  </p>
  <p>${esc(fullText)}</p>
</div>`;

    const newsDataScript = `<script>window.__NEWS_DATA__ = ${JSON.stringify({
        slug:         canonicalUrl.replace(/\/$/, '').split('/').pop(),
        title:        noticia.title,
        shortContent: noticia.shortContent || '',
        content:      noticia.content      || '',
        image:        image,
        images:       noticia.images       || (image ? [image] : []),
        date:         noticia.date         || noticia.fecha || '',
        author:       noticia.author       || 'Eclipse Zone',
        tags:         noticia.tags         || [],
        categoria:    noticia.categoria    || '',
    })};</script>`;

    const newsTags    = Array.isArray(noticia.tags) ? noticia.tags : [];
    const newsKeywords = [noticia.title, noticia.author || 'Eclipse Zone', noticia.categoria || '', 'eclipse zone', 'noticias', ...newsTags].filter(Boolean).join(', ');
    const keywordsMeta = `<meta name="keywords" content="${esc(newsKeywords)}">`;

    return buildHTML(template, { title, description, image, canonicalUrl, structuredData, breadcrumb, seoBody, headExtra: keywordsMeta + '\n  ' + newsDataScript, pageType: 'noticia' });
}

// ─── PÁGINAS DE CATEGORÍA ──────────────────────────────────────
// Equivalente estático a las páginas de tag/categoría que WordPress genera
// gratis con sus taxonomías (visto en eroganso.com, erodeus.xyz, hotzone18.com:
// 8-65 links internos por ficha vía esos tags). Sin esto cada ficha nuestra
// solo enlazaba a ~6 "relacionados" — muy por debajo de la competencia.
// Solo se generan categorías con suficientes juegos (MIN_CATEGORIA_JUEGOS)
// para evitar páginas "thin" de 1-2 resultados que no aportan a SEO.
const MIN_CATEGORIA_JUEGOS = 8;

function categoriaSlug(cat) {
    return slugify(cat);
}

function buildCategoriaHTML(template, cat, juegosDeCategoria, ctx) {
    const catEsc       = esc(cat);
    const title         = `Juegos de ${cat} en Español`;
    const description   = `Descargá ${juegosDeCategoria.length} juegos de ${cat} traducidos al español gratis en Eclipse Zone. PC, Android y JoiPlay.`;
    const canonicalUrl  = `${CONFIG.baseUrl}/categoria/${categoriaSlug(cat)}/`;
    const image         = CONFIG.baseUrl + '/Eclipse.png';

    const structuredData = collectionPageSchema(title, description, canonicalUrl, juegosDeCategoria.length);
    const breadcrumb = buildBreadcrumb([
        { name: 'Inicio', url: CONFIG.baseUrl + '/' },
        { name: 'Juegos', url: CONFIG.baseUrl + '/juegos/' },
        { name: cat, url: canonicalUrl },
    ]);

    const preview = juegosDeCategoria.slice(0, 20).map(juegoPreview);
    const listItems = juegosDeCategoria.map(g =>
        `<li><a href="/juego/${ctx.slugOf.get(g)}/">${esc(g.titulo)} en Español (${esc(plataformaTexto(g))})</a></li>`
    ).join('');
    const seoBody = `<div id="seo-static">
  <h1>${title}</h1>
  <p>${esc(description)}</p>
  <ul>${listItems}</ul>
  <p><a href="/juegos/">Todos los juegos</a></p>
</div>`;

    const headExtra = `<script>window.__JUEGOS_PREVIEW__ = ${JSON.stringify(preview)}; window.__JUEGOS_TOTAL__ = ${juegosDeCategoria.length};</script>`;

    return buildHTML(template, { title, description, image, canonicalUrl, structuredData, breadcrumb, seoBody, headExtra, pageType: 'juegos' });
}

// ─── PÁGINAS ÍNDICE DE SECCIÓN ────────────────────────────────
// Genera /juegos/ y /noticias/ con datos pre-embebidos para SEO y
// carga instantánea (el frontend los lee antes de descargar el JSON).

function buildJuegosIndexHTML(template, juegos) {
    const title       = 'Juegos traducidos al español';
    const description = `Descargá ${juegos.length} juegos traducidos al español gratis en Eclipse Zone. RPGs, aventuras, acción y más. Actualizado diariamente.`;
    const canonicalUrl = `${CONFIG.baseUrl}/juegos/`;
    const image        = CONFIG.baseUrl + '/Eclipse.png';

    const structuredData = collectionPageSchema(title, description, canonicalUrl, juegos.length);
    const breadcrumb = buildBreadcrumb([
        { name: 'Inicio', url: CONFIG.baseUrl + '/' },
        { name: 'Juegos', url: canonicalUrl },
    ]);

    // Primeros 20 juegos pre-embebidos para carga instantánea
    const preview = juegos.slice(0, 20).map(juegoPreview);

    // SEO body con lista visible para Googlebot
    const listItems = seoLinkList(juegos.slice(0, 100), { path: '/juego/', getTitle: g => g.titulo });
    const seoBody = `<div id="seo-static">
  <h1>${esc(title)}</h1>
  <p>${esc(description)}</p>
  <ul>${listItems}</ul>
</div>`;

    const headExtra = `<script>window.__JUEGOS_PREVIEW__ = ${JSON.stringify(preview)}; window.__JUEGOS_TOTAL__ = ${juegos.length};</script>`;

    return buildHTML(template, { title, description, image, canonicalUrl, structuredData, breadcrumb, seoBody, headExtra, pageType: 'juegos' });
}

function buildHomeHTML(template, juegos, noticias) {
    const title        = 'Eclipse Zone — Juegos y Mangas traducidos al español';
    const description  = `El mejor sitio de traducciones al español. Más de ${juegos.length} juegos y ${noticias.length} noticias actualizadas. Gratis y sin registro.`;
    const canonicalUrl = `${CONFIG.baseUrl}/`;
    const image        = CONFIG.baseUrl + '/Eclipse.png';

    const structuredData = {
        '@context': 'https://schema.org', '@type': 'WebSite',
        'name': 'Eclipse Zone', 'url': CONFIG.baseUrl,
        'description': description, 'inLanguage': 'es',
        'potentialAction': { '@type': 'SearchAction', 'target': `${CONFIG.baseUrl}/juegos/?q={search_term_string}`, 'query-input': 'required name=search_term_string' },
        'publisher': orgPublisher({ logo: true }),
    };

    const juegosRecientes   = juegos.slice(0, 12).map(juegoPreview);
    const noticiasRecientes = noticias.slice(0, 5).map(noticiaPreview);

    const homePreview = { juegosRecientes, noticiasRecientes, stats: { juegos: juegos.length, noticias: noticias.length } };

    // seo-static: enlaces visibles para Googlebot sin diferir de lo visible
    const seoJuegos   = seoLinkList(juegos.slice(0, 12), { path: '/juego/', getTitle: g => g.titulo });
    const seoNoticias = seoLinkList(noticias.slice(0, 5), { path: '/noticia/', getTitle: n => n.title });
    const seoBody = `<div id="seo-static">
  <h1>${esc(title)}</h1>
  <p>${esc(description)}</p>
  <ul>${seoJuegos}</ul>
  <ul>${seoNoticias}</ul>
</div>`;

    const headExtra = `<script>window.__HOME_PREVIEW__ = ${JSON.stringify(homePreview)};</script>`;

    return buildHTML(template, { title, description, image, canonicalUrl, structuredData, seoBody, headExtra, pageType: 'home' });
}

function buildNoticiasIndexHTML(template, noticias) {
    const title        = 'Noticias de juegos y mangas';
    const description  = `Las últimas ${noticias.length} noticias sobre juegos y mangas en español. Traducciones, lanzamientos y actualizaciones en Eclipse Zone.`;
    const canonicalUrl = `${CONFIG.baseUrl}/noticias/`;
    const image        = CONFIG.baseUrl + '/Eclipse.png';

    const structuredData = collectionPageSchema(title, description, canonicalUrl, noticias.length);
    const breadcrumb = buildBreadcrumb([
        { name: 'Inicio',   url: CONFIG.baseUrl + '/' },
        { name: 'Noticias', url: canonicalUrl },
    ]);

    const preview = noticias.slice(0, 20).map(noticiaPreview);

    const listItems = seoLinkList(noticias.slice(0, 50), { path: '/noticia/', getTitle: n => n.title });
    const seoBody = `<div id="seo-static">
  <h1>${esc(title)}</h1>
  <p>${esc(description)}</p>
  <ul>${listItems}</ul>
</div>`;

    const headExtra = `<script>window.__NOTICIAS_PREVIEW__ = ${JSON.stringify(preview)}; window.__NOTICIAS_TOTAL__ = ${noticias.length};</script>`;

    return buildHTML(template, { title, description, image, canonicalUrl, structuredData, breadcrumb, seoBody, headExtra, pageType: 'noticias' });
}

function buildMangasIndexHTML(template) {
    const title        = 'Mangas traducidos al español';
    const description  = 'Leé mangas traducidos al español gratis en Eclipse Zone, con capítulos actualizados desde MangaDex.';
    const canonicalUrl = `${CONFIG.baseUrl}/mangas/`;
    const image        = CONFIG.baseUrl + '/Eclipse.png';

    const structuredData = collectionPageSchema(title, description, canonicalUrl, 0);
    const breadcrumb = buildBreadcrumb([
        { name: 'Inicio', url: CONFIG.baseUrl + '/' },
        { name: 'Mangas', url: canonicalUrl },
    ]);

    // El listado de mangas viene de MangaDex en runtime (js/manga.js vía
    // /api/md/*), no hay datos propios que pre-embeber para SEO acá.
    const seoBody = `<div id="seo-static">
  <h1>${esc(title)}</h1>
  <p>${esc(description)}</p>
</div>`;

    return buildHTML(template, { title, description, image, canonicalUrl, structuredData, breadcrumb, seoBody, headExtra: '', pageType: 'manga' });
}

// ─── SITEMAP ─────────────────────────────────────────────────

function sitemapUrl({ loc, lastmod, changefreq, priority }) {
    return `  <url>\n    <loc>${esc(loc)}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>\n  </url>`;
}

function writeSitemaps(outDir, groups) {
    // Sitemap único plano — todas las URLs en un solo sitemap.xml
    const allUrls = groups.flatMap(g => g.urls);
    const content = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${allUrls.map(sitemapUrl).join('\n')}\n</urlset>`;
    if (!DRY_RUN) fs.writeFileSync(path.join(outDir, 'sitemap.xml'), content, 'utf8');
    log.ok(`sitemap.xml generado (${allUrls.length} URLs en un único archivo).`);
}

// ── RSS feed de noticias ─────────────────────────────────────
// Usa la misma lógica de slugs (slugify + uniqueSlug, en orden del JSON)
// que generatePages() para que los <link> coincidan exactamente con las
// URLs reales ya generadas.
function parseNoticiaDate(raw) {
    if (!raw) return new Date();
    const dmy = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
    if (dmy) return new Date(`${dmy[3]}-${dmy[2]}-${dmy[1]}`);
    const d = new Date(raw);
    return isNaN(d.getTime()) ? new Date() : d;
}

function writeRssFeed(outDir, noticias) {
    const usedSlugs = new Set();
    const items = noticias
        .filter(n => n && n.title)
        .map(n => ({ n, slug: uniqueSlug(slugify(n.title), usedSlugs), parsedDate: parseNoticiaDate(n.date || n.fecha) }))
        .sort((a, b) => b.parsedDate - a.parsedDate)
        .slice(0, 50);

    const rssItems = items.map(({ n, slug, parsedDate }) => {
        const url         = `${CONFIG.baseUrl}/noticia/${slug}/`;
        const title       = esc(n.title);
        const description = esc((n.shortContent || n.content || '').replace(/<[^>]+>/g, '').trim().slice(0, 400));
        const pubDate     = parsedDate.toUTCString();
        return `  <item>\n    <title>${title}</title>\n    <link>${url}</link>\n    <guid isPermaLink="true">${url}</guid>\n    <pubDate>${pubDate}</pubDate>\n    <description>${description}</description>\n  </item>`;
    });

    const content = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0">\n<channel>\n  <title>Eclipse Zone — Noticias</title>\n  <link>${CONFIG.baseUrl}/noticias/</link>\n  <description>Últimas noticias de Eclipse Zone.</description>\n  <language>es</language>\n${rssItems.join('\n')}\n</channel>\n</rss>`;
    if (!DRY_RUN) fs.writeFileSync(path.join(outDir, 'feed.xml'), content, 'utf8');
    log.ok(`feed.xml generado (${items.length} noticias).`);
}

// ─── ESCRITURA ATÓMICA ───────────────────────────────────────

// ── Cache-busting de assets propios ──────────────────────────
// Versiona /js/*.js y /css/*.css con un build-id por deploy para que los
// navegadores pidan la versión nueva apenas cambia el HTML (los assets se
// sirven con max-age corto, pero el ?v= garantiza coherencia inmediata).
function writeFileAtomic(filePath, content) {
    if (DRY_RUN) return;
    if (filePath.endsWith('.html') && typeof content === 'string') {
        content = versionAssetRefs(content);
    }
    const tmp = filePath + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, filePath);
}

// ─── GENERACIÓN DE PÁGINAS ───────────────────────────────────

async function generatePages(items, { template, cache, tipo, slugPrefix, buildFn, validateFn, sitemapOpts, extraHashFn, categoriaSlugs }) {
    const usedSlugs     = new Set();
    const sitemapUrls   = [];
    const newCache      = {};
    const generatedUrls = [];
    let   generated = 0, skipped = 0, invalid = 0;

    // Pre-pase SECUENCIAL de validación y slugs. Antes uniqueSlug() corría
    // dentro de las tareas concurrentes de runPool: con títulos duplicados,
    // los sufijos -2/-3 podían intercambiarse entre ejecuciones según el
    // orden en que el pool las completara — misma URL, contenido distinto
    // entre builds. El pre-pase fija los slugs en el orden del JSON.
    const isValid = items.map((item, idx) => validateFn(item, idx));
    const slugs   = items.map((item, idx) =>
        isValid[idx] ? uniqueSlug(slugify(item.titulo || item.title), usedSlugs) : null);
    // Contexto compartido para buildFn: resolver el slug REAL de cualquier
    // item (respeta sufijos de duplicados — no usar slugify() a mano para
    // enlazar entre páginas).
    const slugOf = new Map(items.map((item, idx) => [item, slugs[idx]]));
    const ctx    = { items, slugOf, slugPrefix, isValid, categoriaSlugs };

    // Huella de assets: el template ya trae embebidos todos los ?v=<hash> de
    // js/css (versionAssetRefs). Si CUALQUIER js/css cambia, esta huella cambia
    // y TODAS las páginas se regeneran para tomar el hash nuevo. Sin esto, un
    // cambio de JS/CSS no invalidaba la caché por-página y 700+ páginas
    // quedaban apuntando al ?v= viejo (footgun de caché, visto 2026-07-22).
    const assetsFp = crypto.createHash('md5').update(template).digest('hex').slice(0, 12);

    const tasks = items.map((item, idx) => async () => {
        if (!isValid[idx]) { invalid++; return; }

        const slug         = slugs[idx];
        const canonicalUrl = `${CONFIG.baseUrl}/${slugPrefix}/${slug}/`;
        // extraHashFn permite que el hash de página dependa de datos EXTERNOS
        // al item (ej.: los juegos relacionados) — si eso cambia, se regenera.
        const hash         = hashObject(item) + '|a:' + assetsFp +
                             (extraHashFn ? '|' + extraHashFn(item, ctx) : '');
        newCache[slug]     = hash;

        // lastmod NO debe caer en el fallback "hoy" de formatDate(): sin fecha
        // real del ítem, eso hace que el sitemap reporte "cambié hoy" en TODO
        // ítem sin fecha cada vez que se corre el build (aunque el contenido no
        // haya cambiado) — 202/554 juegos no traen fecha, así que cada deploy
        // enviaba a Google una señal falsa de cambio masivo en ~36% del sitio,
        // haciendo que priorizara re-rastrear esas URLs "actualizadas" en vez
        // de descubrir páginas nuevas (detectado en Search Console: 92% del
        // rastreo era "Actualización" vs 8% "Detección").
        const itemFecha = item.fechaActualizacion || item.fechaRegistro || item.dateModified || item.date || item.fecha;
        sitemapUrls.push({
            loc:     canonicalUrl,
            lastmod: itemFecha ? formatDate(itemFecha) : CONFIG.fallbackLastmod,
            ...sitemapOpts,
        });

        if (!NO_CACHE && cache[slug] === hash) { skipped++; log.debug(`SKIP ${slug}`); return; }

        try {
            const pageDir = path.join(CONFIG.publicDir, slugPrefix, slug);
            const html    = buildFn(template, item, canonicalUrl, ctx);
            if (!DRY_RUN) {
                fs.mkdirSync(pageDir, { recursive: true });
                writeFileAtomic(path.join(pageDir, 'index.html'), html);
            }
            generatedUrls.push(canonicalUrl);
            generated++;
            log.debug(`GEN ${canonicalUrl}`);
        } catch (err) {
            invalid++;
            log.error(`Error generando [${tipo}] "${slug}": ${err.message}`);
        }
    });

    await runPool(tasks, CONCURRENCY);
    return { generated, skipped, invalid, sitemapUrls, newCache, generatedUrls, slugOf };
}

// ─── VERIFICACIÓN DE LINKS ───────────────────────────────────

async function runLinkCheck(juegos) {
    log.info('🔗 Verificando links de descarga…');
    const allLinks = [];
    for (const juego of juegos) {
        if (!juego.links) continue;
        for (const link of juego.links) {
            if (link.url) allLinks.push({ url: link.url, juego: juego.titulo });
        }
    }
    if (!allLinks.length) { log.info('  No hay links para verificar.'); return; }

    const tasks   = allLinks.map(l => () => checkLinkAlive(l.url));
    const results = await runPool(tasks, 5); // concurrencia baja para no sobrecargar

    let dead = 0;
    results.forEach((r, i) => {
        if (!r || !r.ok) {
            dead++;
            log.warn(`  ❌ Link caído (${r?.status || '?'}) en "${allLinks[i].juego}": ${allLinks[i].url}`);
        }
    });
    if (dead === 0) log.ok(`  ✅ Todos los links OK (${allLinks.length} verificados).`);
    else            log.warn(`  ⚠️  ${dead}/${allLinks.length} links con problemas.`);
}

// ─── CACHE-BUSTING DE ASSETS ─────────────────────────────────
// Agrega ?v=<build> a las referencias locales de /js/ y /css/ en el HTML.
// Motivo: en julio 2026 la caché edge de Cloudflare quedó con copias viejas
// de CSS/JS servidas con "immutable, max-age=1año" (el _headers anterior),
// y ni un deploy nuevo las desalojaba. Con el query string por build, cada
// deploy usa claves de caché nuevas y las entradas envenenadas se ignoran.
// /vendor/ queda afuera a propósito: es inmutable de verdad (bootstrap, etc.).

const BUILD_VERSION = Date.now().toString(36);

// Hash por archivo en vez de build-id global: si el archivo no cambió, su
// ?v= tampoco cambia, así Googlebot NO re-descarga todo el JS/CSS de las
// ~740 páginas en cada deploy (en jul-2026 el 66% del presupuesto de rastreo
// se iba en "carga de recursos de página" por el ?v= global con Date.now).
// Sigue busteando la caché edge apenas un archivo sí cambia (mismo fix del
// incidente de caché envenenada, pero sin invalidar lo que no se tocó).
const _assetHashCache = new Map();

function assetHash(assetPath) {
    if (_assetHashCache.has(assetPath)) return _assetHashCache.get(assetPath);
    let v;
    try {
        const buf = fs.readFileSync(path.join(CONFIG.rootDir, assetPath.replace(/^\//, '')));
        v = crypto.createHash('md5').update(buf).digest('hex').slice(0, 8);
    } catch (e) {
        v = BUILD_VERSION; // archivo no encontrado localmente: fallback al build-id
    }
    _assetHashCache.set(assetPath, v);
    return v;
}

// ÚNICA función de versionado de assets (antes había dos — addAssetVersion y
// bustAssetUrls — que divergieron y una se perdió en una reescritura, causando
// el incidente de caché clavada de jul-2026). Es idempotente: no re-versiona
// URLs que ya tienen ?v=. Se aplica al template al cargarlo y en cada .html
// al escribirlo (writeFileAtomic).
function versionAssetRefs(html) {
    return html
        .replace(/(["'])(\/(?:js|css)\/[^"'?#]+\.(?:js|css))\1/g, (m, q, p) => `${q}${p}?v=${assetHash(p)}${q}`)
        .replace(/(["'])(\/rotonda\.js)\1/g, (m, q, p) => `${q}${p}?v=${assetHash(p)}${q}`);
}

// ─── COPIA DE ESTÁTICOS ──────────────────────────────────────

function copyDirRecursive(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        entry.isDirectory() ? copyDirRecursive(s, d) : fs.copyFileSync(s, d);
    }
}

function copyDir(dirName, destBase) {
    const src = path.join(CONFIG.rootDir, dirName);
    if (!fs.existsSync(src)) { log.warn(`Directorio no encontrado: ${dirName}`); return; }
    if (!DRY_RUN) copyDirRecursive(src, path.join(destBase, dirName));
}

function copyFile(fileName, destBase) {
    const src = path.join(CONFIG.rootDir, fileName);
    if (fs.existsSync(src) && !DRY_RUN) fs.copyFileSync(src, path.join(destBase, fileName));
}

// ─── STATS.JSON ──────────────────────────────────────────────
// Archivo pequeño (~200 bytes) que el frontend lee al inicio para
// mostrar contadores en el home antes de que cargue el JSON completo.

function writeStatsFile(outDir, { juegosCount, noticiasCount, generatedAt }) {
    const stats = {
        juegos:      juegosCount,
        noticias:    noticiasCount,
        generatedAt: generatedAt,
        version:     '5.0',
    };
    if (!DRY_RUN) fs.writeFileSync(path.join(outDir, 'stats.json'), JSON.stringify(stats), 'utf8');
    log.ok(`stats.json generado (juegos: ${juegosCount}, noticias: ${noticiasCount}).`);
}

// ─── PWA MANIFEST ────────────────────────────────────────────

function writeManifest(outDir) {
    const manifest = CONFIG.pwaManifest;
    if (!DRY_RUN) fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    log.ok('manifest.json generado (PWA).');
}

// ─── INDEXNOW ────────────────────────────────────────────────

async function runIndexNow({ newUrls, allUrls }) {
    if (SKIP_INDEX || DRY_RUN) {
        log.warn('IndexNow omitido (--skip-index o --dry-run).'); return;
    }
    if (!INDEXNOW.enabled) {
        log.warn('IndexNow deshabilitado: falta INDEXNOW_KEY en Cloudflare Pages → Settings → Environment Variables.'); return;
    }

    if (!DRY_RUN) {
        fs.writeFileSync(path.join(CONFIG.publicDir, `${INDEXNOW.key}.txt`), INDEXNOW.key, 'utf8');
        log.ok(`IndexNow key file generado: public/${INDEXNOW.key}.txt`);
    }

    const urlsToSend = newUrls.length > 0 ? newUrls : allUrls;

    const sep = '─'.repeat(48);
    console.log(`\n┌${sep}┐`);
    console.log(`│  📡 INDEXNOW — Notificación inmediata            │`);
    console.log(`├${sep}┤`);
    console.log(`│  URLs nuevas/modificadas:     ${String(newUrls.length).padEnd(17)}│`);
    console.log(`│  Enviando ahora:              ${String(urlsToSend.length).padEnd(17)}│`);
    console.log(`│  Buscadores notificados:      ${'Bing, Yandex'.padEnd(17)}│`);
    console.log(`└${sep}┘`);

    const payload = {
        host:        new URL(CONFIG.baseUrl).hostname,
        key:         INDEXNOW.key,
        keyLocation: INDEXNOW.keyLocation,
        urlList:     urlsToSend,
    };

    try {
        const res = await httpPost('api.indexnow.org', '/indexnow', {}, payload);
        if (res.status === 200 || res.status === 202) {
            log.ok(`IndexNow: ${urlsToSend.length} URLs enviadas correctamente (HTTP ${res.status}).`);
        } else if (res.status === 422) {
            log.warn(`IndexNow: URL inválida en el batch (HTTP 422). Revisá que baseUrl sea correcto.`);
        } else if (res.status === 429) {
            log.warn(`IndexNow: demasiadas peticiones (HTTP 429). Reintenta en el próximo deploy.`);
        } else {
            log.error(`IndexNow: HTTP ${res.status} — ${JSON.stringify(res.body)}`);
        }
    } catch (err) {
        log.error(`IndexNow error: ${err.message}`);
    }
}

// ─── REPORTE FINAL ───────────────────────────────────────────

function printReport({ juegos, noticias, sitemapTotal, elapsed, linkCheckRan }) {
    const dryTag = DRY_RUN ? ' [DRY-RUN]' : '';
    const sep    = '═'.repeat(48);
    const warn   = VALIDATION_WARNINGS.length;
    const err    = VALIDATION_ERRORS.length;

    console.log(`\n╔${sep}╗`);
    console.log(`║  ECLIPSE ZONE — REPORTE FINAL${dryTag.padEnd(18)}║`);
    console.log(`╠${sep}╣`);
    console.log(`║  🎮 Juegos generados:    ${String(juegos.generated).padEnd(22)}║`);
    console.log(`║  🎮 Sin cambios (cache): ${String(juegos.skipped).padEnd(22)}║`);
    console.log(`║  🎮 Inválidos:           ${String(juegos.invalid).padEnd(22)}║`);
    console.log(`║  📰 Noticias generadas:  ${String(noticias.generated).padEnd(22)}║`);
    console.log(`║  📰 Sin cambios (cache): ${String(noticias.skipped).padEnd(22)}║`);
    console.log(`║  📰 Inválidas:           ${String(noticias.invalid).padEnd(22)}║`);
    console.log(`╠${sep}╣`);
    console.log(`║  🗺️  URLs en sitemap:     ${String(sitemapTotal).padEnd(22)}║`);
    console.log(`║  ⏱️  Tiempo total:         ${String(elapsed + 's').padEnd(21)}║`);
    if (err)  console.log(`║  ❌ Errores validación:  ${String(err).padEnd(22)}║`);
    if (warn) console.log(`║  ⚠️  Advertencias:        ${String(warn).padEnd(22)}║`);
    if (linkCheckRan) console.log(`║  🔗 Links verificados    ✅${''.padEnd(19)}║`);
    console.log(`╚${sep}╝\n`);

    if (DRY_RUN) log.warn('DRY-RUN: ningún archivo fue escrito.');
    else         log.ok('¡Todo generado correctamente!');

    if (err > 0) {
        log.warn(`\n  Items con errores de validación (no generados):`);
        VALIDATION_ERRORS.slice(0, 10).forEach(e =>
            log.warn(`    [${e.tipo}] ${e.id}: ${e.errors.join(', ')}`)
        );
        if (err > 10) log.warn(`    … y ${err - 10} más.`);
    }
}

// ─── SCRIPT PRINCIPAL ────────────────────────────────────────

async function generateEverything() {
    const startTime = Date.now();
    console.log('\n🚀 Eclipse Zone — Generador unificado v5.1 (Cloudflare Pages)');
    if (DRY_RUN)      log.warn('Modo DRY-RUN activado.');
    if (NO_CACHE)     log.warn('Caché desactivado. Regenerando todo.');
    if (SKIP_INDEX)   log.warn('Indexación desactivada (--skip-index).');
    if (CHECK_LINKS)  log.warn('Verificación de links activada (--check-links).');
    log.info(`IndexNow: ${INDEXNOW.enabled ? '✅ Configurado' : '❌ Falta INDEXNOW_KEY en Cloudflare Pages → Environment Variables'}`);
    console.log(`   Concurrencia: ${CONCURRENCY} | Output: ${CONFIG.publicDir} | Solo: ${ONLY}\n`);

    if (!fs.existsSync(CONFIG.templatePath)) {
        log.error('No se encontró index.html.'); process.exit(1);
    }
    const template = versionAssetRefs(fs.readFileSync(CONFIG.templatePath, 'utf8'));

    if (!DRY_RUN) fs.mkdirSync(CONFIG.publicDir, { recursive: true });

    // ── MODO --only=home: solo copia estáticos sin descargar datos ──
    if (ONLY === 'home') {
        log.info('Modo "home": copiando estáticos y generando archivos de configuración...');
        log.warn('Nota: --only=home no descarga datos; index.html se copia como template. Usar --only=all para __HOME_PREVIEW__.');
        writeManifest(CONFIG.publicDir);
        if (!DRY_RUN) {
            const tplHtml = template;
            writeFileAtomic(path.join(CONFIG.publicDir, '404.html'),   tplHtml);
            writeFileAtomic(path.join(CONFIG.publicDir, 'index.html'), tplHtml);
        }
        CONFIG.staticDirs.forEach(d  => copyDir(d, CONFIG.publicDir));
        CONFIG.staticFiles.forEach(f => copyFile(f, CONFIG.publicDir));
        log.ok('Modo "home" completado.');
        return;
    }

    const cache = loadCache();
    log.info(`Caché: ${Object.keys(cache).length} entradas.`);

    // Descarga de datos
    const toFetch = [];
    if (ONLY === 'all' || ONLY === 'juegos')   toFetch.push(fetchText(CONFIG.juegosJsonUrl));
    if (ONLY === 'all' || ONLY === 'noticias') toFetch.push(fetchText(CONFIG.noticiasJsonUrl));
    log.info('Descargando datos...');
    const fetched = await Promise.all(toFetch);

    let rawJuegos, rawNoticias;
    if      (ONLY === 'all')      [rawJuegos, rawNoticias] = fetched;
    else if (ONLY === 'juegos')   [rawJuegos]              = fetched;
    else                          [rawNoticias]             = fetched;

    const juegos   = rawJuegos   ? JSON.parse(rawJuegos)   : [];
    const noticias = rawNoticias ? JSON.parse(rawNoticias)  : [];

    // Tamaño de los JSONs descargados
    const juegosSize   = rawJuegos   ? humanSize(Buffer.byteLength(rawJuegos))   : '–';
    const noticiasSize = rawNoticias ? humanSize(Buffer.byteLength(rawNoticias)) : '–';
    log.ok(`Juegos: ${juegos.length} (${juegosSize}) | Noticias: ${noticias.length} (${noticiasSize})`);

    const today       = formatDate();
    const sitemapHome = [
        { loc: CONFIG.baseUrl + '/',          lastmod: today, changefreq: 'daily',   priority: '1.0' },
        { loc: CONFIG.baseUrl + '/juegos/',   lastmod: today, changefreq: 'daily',   priority: '0.9' },
        { loc: CONFIG.baseUrl + '/noticias/', lastmod: today, changefreq: 'weekly',  priority: '0.8' },
        { loc: CONFIG.baseUrl + '/mangas/',   lastmod: today, changefreq: 'weekly',  priority: '0.7' },
    ];

    let juegosResult   = { generated: 0, skipped: 0, invalid: 0, sitemapUrls: [], newCache: {}, generatedUrls: [] };
    let noticiasResult = { generated: 0, skipped: 0, invalid: 0, sitemapUrls: [], newCache: {}, generatedUrls: [] };

    // ── Verificación de links (opcional) ────────────────────────
    if (CHECK_LINKS && juegos.length) {
        await runLinkCheck(juegos);
    }

    if (juegos.length) {
        // Categorías con suficientes juegos como para merecer su propia página
        // (equivalente estático a las páginas de tag de WordPress) — calculado
        // antes de generar las fichas para poder enlazarlas desde ahí.
        const categoriaCount = new Map();
        for (const g of juegos) {
            for (const c of (Array.isArray(g.categorias) ? g.categorias : [])) {
                categoriaCount.set(c, (categoriaCount.get(c) || 0) + 1);
            }
        }
        const categoriaSlugs = new Set(
            [...categoriaCount.entries()].filter(([, n]) => n >= MIN_CATEGORIA_JUEGOS).map(([c]) => c)
        );

        log.info('🎮 Generando páginas de juegos...');
        juegosResult = await generatePages(juegos, {
            template, cache, tipo: 'juego', slugPrefix: 'juego',
            buildFn: buildJuegoHTML, validateFn: validateJuego,
            sitemapOpts: { changefreq: 'weekly', priority: '0.85' },
            extraHashFn: (juego, ctx) => relatedJuegos(juego, ctx).map(r => ctx.slugOf.get(r)).join(','),
            categoriaSlugs,
        });
        log.ok(`Juegos: ${juegosResult.generated} gen, ${juegosResult.skipped} skip, ${juegosResult.invalid} inválidos.`);

        // slugs.json: título (minúsculas) → slug(s) real(es) de la ficha. Lo usa
        // el bot (juego del día, pedidos) para enlazar sin slugify a mano
        // (sufijos -2/-3). Con títulos duplicados el valor es un array de slugs
        // en vez de un string — antes se quedaba con el primero y perdía el
        // resto (568 entradas para 587 juegos, fix 2026-09-28).
        const slugMap = {};
        for (const [j, slug] of juegosResult.slugOf) {
            const t = String(j.titulo || j.title || '').trim().toLowerCase();
            if (!slug || !t) continue;
            if (!(t in slugMap)) {
                slugMap[t] = slug;
            } else if (Array.isArray(slugMap[t])) {
                if (!slugMap[t].includes(slug)) slugMap[t].push(slug);
            } else if (slugMap[t] !== slug) {
                slugMap[t] = [slugMap[t], slug];
            }
        }
        if (!DRY_RUN) writeFileAtomic(path.join(CONFIG.publicDir, 'slugs.json'), JSON.stringify(slugMap));
        const slugCount = Object.values(slugMap).reduce((n, v) => n + (Array.isArray(v) ? v.length : 1), 0);
        log.ok(`slugs.json generado (${Object.keys(slugMap).length} títulos, ${slugCount} juegos).`);

        // Página índice /juegos/
        log.info('🎮 Generando índice /juegos/...');
        const juegosIndexDir  = path.join(CONFIG.publicDir, 'juegos');
        const juegosIndexHtml = buildJuegosIndexHTML(template, juegos);
        if (!DRY_RUN) {
            fs.mkdirSync(juegosIndexDir, { recursive: true });
            writeFileAtomic(path.join(juegosIndexDir, 'index.html'), juegosIndexHtml);
        }
        log.ok('Índice /juegos/ generado.');

        // Páginas /categoria/<slug>/ — una por cada categoría con suficientes
        // juegos. Usa el mismo slugOf que las fichas para que los links
        // relativos coincidan exactamente con las carpetas reales generadas.
        log.info('🏷️  Generando páginas de categoría...');
        const isValidJuego = juegos.map((j, idx) => validateJuego(j, idx));
        const usedSlugsCat = new Set();
        const slugOfCat = new Map(juegos.map((j, idx) =>
            [j, isValidJuego[idx] ? uniqueSlug(slugify(j.titulo), usedSlugsCat) : null]));
        const ctxCat = { slugOf: slugOfCat };
        let categoriasGeneradas = 0;
        for (const cat of categoriaSlugs) {
            const juegosDeCategoria = juegos.filter((g, idx) =>
                isValidJuego[idx] && Array.isArray(g.categorias) && g.categorias.includes(cat));
            const catDir  = path.join(CONFIG.publicDir, 'categoria', categoriaSlug(cat));
            const catHtml = buildCategoriaHTML(template, cat, juegosDeCategoria, ctxCat);
            if (!DRY_RUN) {
                fs.mkdirSync(catDir, { recursive: true });
                writeFileAtomic(path.join(catDir, 'index.html'), catHtml);
            }
            sitemapHome.push({
                loc: `${CONFIG.baseUrl}/categoria/${categoriaSlug(cat)}/`,
                lastmod: today, changefreq: 'weekly', priority: '0.6',
            });
            categoriasGeneradas++;
        }
        log.ok(`Categorías: ${categoriasGeneradas} generadas (mín. ${MIN_CATEGORIA_JUEGOS} juegos c/u).`);
    }

    if (noticias.length) {
        log.info('📰 Generando páginas de noticias...');
        noticiasResult = await generatePages(noticias, {
            template, cache, tipo: 'noticia', slugPrefix: 'noticia',
            buildFn: buildNoticiaHTML, validateFn: validateNoticia,
            sitemapOpts: { changefreq: 'monthly', priority: '0.7' },
        });
        log.ok(`Noticias: ${noticiasResult.generated} gen, ${noticiasResult.skipped} skip, ${noticiasResult.invalid} inválidas.`);

        // Página índice /noticias/
        log.info('📰 Generando índice /noticias/...');
        const noticiasIndexDir  = path.join(CONFIG.publicDir, 'noticias');
        const noticiasIndexHtml = buildNoticiasIndexHTML(template, noticias);
        if (!DRY_RUN) {
            fs.mkdirSync(noticiasIndexDir, { recursive: true });
            writeFileAtomic(path.join(noticiasIndexDir, 'index.html'), noticiasIndexHtml);
        }
        log.ok('Índice /noticias/ generado.');
    }

    // Página índice /mangas/ — sin datos propios (todo viene de MangaDex en
    // runtime), pero necesita su propio data-page="manga" para que
    // pageLoader.js cargue js/manga.js cuando Googlebot la visite.
    log.info('📖 Generando índice /mangas/...');
    const mangasIndexDir  = path.join(CONFIG.publicDir, 'mangas');
    const mangasIndexHtml = buildMangasIndexHTML(template);
    if (!DRY_RUN) {
        fs.mkdirSync(mangasIndexDir, { recursive: true });
        writeFileAtomic(path.join(mangasIndexDir, 'index.html'), mangasIndexHtml);
    }
    log.ok('Índice /mangas/ generado.');

    // ── Stats.json ───────────────────────────────────────────────
    log.info('📊 Generando stats.json...');
    writeStatsFile(CONFIG.publicDir, {
        juegosCount:   juegos.length,
        noticiasCount: noticias.length,
        generatedAt:   new Date().toISOString(),
    });

    // ── PWA Manifest ─────────────────────────────────────────────
    log.info('📱 Generando manifest.json (PWA)...');
    writeManifest(CONFIG.publicDir);

    // ── Sitemaps ─────────────────────────────────────────────────
    log.info('🗺️  Generando sitemaps...');
    writeSitemaps(CONFIG.publicDir, [
        { name: 'home',     urls: sitemapHome },
        { name: 'juegos',   urls: juegosResult.sitemapUrls },
        { name: 'noticias', urls: noticiasResult.sitemapUrls },
    ]);

    // ── RSS feed ─────────────────────────────────────────────────
    if (noticias.length) {
        log.info('📡 Generando feed RSS...');
        writeRssFeed(CONFIG.publicDir, noticias);
    }

    // ── robots.txt ───────────────────────────────────────────────
    const robots = [
        'User-agent: *',
        'Allow: /',
        '# Bloquear solo rutas de API sensibles (auth, admin)',
        '# NO bloquear /api/gl/ — es el Worker proxy que el sitio necesita para cargar datos.',
        '# Bloquearlo causa que Googlebot no pueda ejecutar el JS y clasifique las páginas como Soft 404.',
        'Disallow: /api/auth/',
        'Disallow: /api/admin/',
        '# /usuario/* es una ruta 100% client-side (perfiles de Discord, sin',
        '# generación estática): un GET directo devuelve 404 real. Sin valor de',
        '# SEO — la excluimos para no gastar crawl budget en 404s.',
        'Disallow: /usuario/',
        '# Permitir manifest.json (PWA) y stats.json (contadores SEO)',
        'Allow: /manifest.json',
        'Allow: /stats.json',
        '# Bloquear otros JSON internos de datos',
        'Disallow: /*.json$',
        'Disallow: /404.html',
        '',
        '# Scripts que NO participan del render de contenido (settings de Discord,',
        '# amigos, ads, analytics, onboarding): bloquearlos ahorra crawl budget.',
        '# Todos sus usos en el código de render están guardados con typeof/if(window.X),',
        '# verificado 2026-07-20 — si se agrega un uso NUEVO sin guarda, quitar de acá.',
        '# Esto solo afecta a crawlers; los navegadores de usuarios ignoran robots.txt.',
        'Disallow: /js/discord-settings-*.js',
        'Disallow: /js/discord-friends.js',
        'Disallow: /js/analytics.js',
        'Disallow: /js/onboarding.js',
        'Disallow: /js/social-popup.js',
        'Disallow: /js/site-updates.js',
        'Disallow: /js/patreon.js',
        'Disallow: /js/radio.js',
        'Disallow: /sw.js',
        '',
        '# CSS que NO participa del render de NINGUNA página fuera de su propia',
        '# sección (home/manga/noticias) o de paneles nunca visibles al cargar',
        '# (discord-settings/discord-friends/onboarding/social-popup) — pero se',
        '# cargaba SIN condición en las 700+ páginas del sitio (a diferencia del JS,',
        '# que ya se lazy-carga por sección desde julio vía pageLoader.js). Verificado',
        '# 2026-09-21: Estadísticas de rastreo mostraba 79% del crawl budget en',
        '# JSON+JS+CSS vs 16% HTML, con 557/682 páginas "Descubierta: sin indexar"',
        '# (sobre todo /categoria/* y /juego/*, que no usan ninguno de estos CSS).',
        '# Cada archivo se verificó standalone: selectores propios de su sección,',
        '# sin depender de layout global (nav/header/footer) — EXCEPCIÓN CONOCIDA:',
        '# discord-settings.css sí define .nav-acct-avatar/.nav-acct-status (el',
        '# avatar de cuenta en la navbar móvil, presente en toda página). Bloquearlo',
        '# a Googlebot es un trade-off cosmético aceptado (mismo tipo de decisión ya',
        '# tomada con discord-friends.js/discord-settings-*.js en julio) — no afecta',
        '# contenido ni funcionalidad, y Googlebot no necesita ver ese avatar para',
        '# indexar la página. Esto solo afecta a crawlers — los navegadores de',
        '# usuarios reales ignoran robots.txt y siguen recibiendo el CSS normal.',
        'Disallow: /css/home.css',
        'Disallow: /css/manga.css',
        'Disallow: /css/noticias.css',
        'Disallow: /css/discord-settings.css',
        'Disallow: /css/discord-friends.css',
        'Disallow: /css/onboarding.css',
        'Disallow: /css/social-popup.css',
        '',
        '# Cloudflare Pages internals',
        'Disallow: /_next/',
        'Disallow: /_worker.js',
        '',
        `Sitemap: ${CONFIG.baseUrl}/sitemap.xml`,
    ].join('\n');
    if (!DRY_RUN) fs.writeFileSync(path.join(CONFIG.publicDir, 'robots.txt'), robots, 'utf8');
    log.ok('robots.txt generado.');

    // ── _redirects (Cloudflare Pages) ────────────────────────────
    // Cloudflare Pages sirve index.html de subcarpetas de forma nativa.
    // Las reglas "200 rewrite" con :splat interferían con ese mecanismo
    // y causaban 404 en Google Search Console. Solo se necesitan 301
    // para normalizar URLs sin trailing slash → con trailing slash.
    // Pages of duplicate entries merged into another one (old slug → kept slug),
    // so indexed URLs don't turn into 404s.
    const MERGED_SLUGS = {
        'single-again-2': 'single-again', // MZ Games duplicate, merged 2026-09-27
    };
    const redirects = [
        // www → sin www (canonicalización — evita contenido duplicado en Google)
        'https://www.eclipsezonehub.com/*  https://eclipsezonehub.com/:splat  301',
        ...Object.entries(MERGED_SLUGS).flatMap(([from, to]) => [
            `/juego/${from}/  /juego/${to}/  301`,
            `/juego/${from}   /juego/${to}/  301`,
        ]),
        // Trailing-slash normalization
        '/juego/:slug    /juego/:slug/    301',
        '/noticia/:slug  /noticia/:slug/  301',
        '/juegos         /juegos/         301',
        '/noticias       /noticias/       301',
        '/mangas         /mangas/         301',
    ].join('\n') + '\n';
    if (!DRY_RUN) fs.writeFileSync(path.join(CONFIG.publicDir, '_redirects'), redirects, 'utf8');
    log.ok('_redirects generado (Cloudflare Pages 301 trailing-slash normalization).');

    // ── _headers (Cloudflare Pages) ──────────────────────────────
    const headers = [
        '/*',
        '  X-Content-Type-Options: nosniff',
        '  X-Frame-Options: SAMEORIGIN',
        '  Referrer-Policy: strict-origin-when-cross-origin',
        '  Permissions-Policy: camera=(), microphone=(), geolocation=()',
        '  X-XSS-Protection: 1; mode=block',
        '  Strict-Transport-Security: max-age=31536000; includeSubDomains; preload',
        // Report-Only: no bloquea nada todavía, solo reporta a la consola del
        // navegador qué violaría la política. El sitio usa bastante inline
        // script/style y varios orígenes externos (ads, APIs de fallback,
        // MangaDex, etc.) — hay que ver qué realmente se necesita antes de
        // aplicar el CSP real (sin -Report-Only), que si bloquea.
        "  Content-Security-Policy-Report-Only: default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https:; connect-src 'self' https:; frame-src 'self' https://www.youtube.com https://www.patreon.com; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
        '',
        '/juego/*',
        '  Cache-Control: public, max-age=3600, stale-while-revalidate=86400',
        '',
        '/juegos/',
        '  Cache-Control: public, max-age=1800, stale-while-revalidate=43200',
        '',
        '/noticia/*',
        '  Cache-Control: public, max-age=3600, stale-while-revalidate=86400',
        '',
        '/noticias/',
        '  Cache-Control: public, max-age=1800, stale-while-revalidate=43200',
        '',
        '/mangas/',
        '  Cache-Control: public, max-age=1800, stale-while-revalidate=43200',
        '',
        // NOTA: /js/* y /css/* NO llevan "immutable" porque los nombres de
        // archivo no tienen hash (el hash va solo en el ?v= de la URL que los
        // referencia). Con immutable, los navegadores guardaban juegos.js
        // VIEJO un año entero → SyntaxError "currentGamesTab has already been
        // declared" al mezclarse con juegos-core.js nuevo — pasó en jul-2026
        // cuando algo (proxy/caché intermedio) sirvió una respuesta cacheada
        // por el path sin considerar el ?v=. max-age más largo que antes
        // (24h en vez de 1h) sigue siendo seguro porque stale-while-revalidate
        // revisa en segundo plano, y cualquier archivo que sí cambió ya tiene
        // una URL ?v= nueva (PageSpeed pedía subir esto de las 2h por defecto
        // de Cloudflare — ver auditoría PageSpeed 2026-09-07).
        '/css/*',
        '  Cache-Control: public, max-age=86400, stale-while-revalidate=604800',
        '',
        '/js/*',
        '  Cache-Control: public, max-age=86400, stale-while-revalidate=604800',
        '',
        '/vendor/*',
        '  Cache-Control: public, max-age=31536000, immutable',
        '',
        '/stats.json',
        '  Cache-Control: public, max-age=300, stale-while-revalidate=3600',
        '',
        '/manifest.json',
        '  Cache-Control: public, max-age=86400',
        '',
        '/sitemap*.xml',
        '  Cache-Control: public, max-age=3600',
        '',
        '/robots.txt',
        '  Cache-Control: public, max-age=86400',
        '',
        '/*.json',
        '  Cache-Control: public, max-age=300',
    ].join('\n') + '\n';
    if (!DRY_RUN) fs.writeFileSync(path.join(CONFIG.publicDir, '_headers'), headers, 'utf8');
    log.ok('_headers generado (security + cache headers mejorados).');

    // ── Avatar manifest ──────────────────────────────────────────
    const avatarSrc  = path.join(CONFIG.rootDir, 'cosmetics', 'avatar');
    const avatarDest = path.join(CONFIG.publicDir, 'cosmetics', 'avatar');
    if (fs.existsSync(avatarSrc) && !DRY_RUN) {
        fs.mkdirSync(avatarDest, { recursive: true });
        const exts    = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
        const files   = fs.readdirSync(avatarSrc).filter(f => exts.has(path.extname(f).toLowerCase()));
        fs.writeFileSync(path.join(avatarDest, 'manifest.json'), JSON.stringify(files), 'utf8');
        log.ok(`cosmetics/avatar/manifest.json generado (${files.length} avatares).`);
    }

    // ── 404 e index ──────────────────────────────────────────────
    if (!DRY_RUN) {
        // data-page="juego": Cloudflare Pages sirve este archivo para
        // cualquier ruta sin archivo físico (ej. /juego/<slug-borrado>/,
        // el caso más común de link roto — F95Zone cambia URLs o el juego
        // se elimina). Sin este atributo, pageLoader.js (ver js/pageLoader.js)
        // nunca carga juegos-core.js y handleGameRoute() se queda en el
        // stub de main.js, sin poder mostrar el toast de "juego no
        // encontrado" ni redirigir al listado — la página se ve cargando
        // en blanco/home sin ninguna explicación.
        const notFoundHtml = template.replace(/<body([^>]*)>/, (m, attrs) => {
            return /data-page=/.test(attrs) ? m : `<body${attrs} data-page="juego">`;
        });
        writeFileAtomic(path.join(CONFIG.publicDir, '404.html'), notFoundHtml);
        const homeHtml = buildHomeHTML(template, juegos, noticias);
        writeFileAtomic(path.join(CONFIG.publicDir, 'index.html'), homeHtml);
    }

    // ── Estáticos ────────────────────────────────────────────────
    log.info('📁 Copiando estáticos...');
    CONFIG.staticDirs.forEach(d  => copyDir(d, CONFIG.publicDir));
    CONFIG.staticFiles.forEach(f => copyFile(f, CONFIG.publicDir));

    // ── Caché ────────────────────────────────────────────────────
    const updatedCache = { ...cache, ...juegosResult.newCache, ...noticiasResult.newCache };
    saveCache(updatedCache);

    // ── Reporte ──────────────────────────────────────────────────
    const elapsed   = ((Date.now() - startTime) / 1000).toFixed(1);
    const totalUrls = sitemapHome.length + juegosResult.sitemapUrls.length + noticiasResult.sitemapUrls.length;
    printReport({
        juegos: juegosResult,
        noticias: noticiasResult,
        sitemapTotal: totalUrls,
        elapsed,
        linkCheckRan: CHECK_LINKS,
    });

    // ── IndexNow (Bing + Yandex) ─────────────────────────────────
    // NOTA: IndexNow NO funciona con Google. Solo notifica a Bing y Yandex.
    // Google se notifica por separado via Indexing API más abajo.
    const allUrls = [
        ...sitemapHome.map(u => u.loc),
        ...juegosResult.sitemapUrls.map(u => u.loc),
        ...noticiasResult.sitemapUrls.map(u => u.loc),
    ];
    const newUrls = [
        ...juegosResult.generatedUrls,
        ...noticiasResult.generatedUrls,
    ];
    await runIndexNow({ newUrls, allUrls });

    // ── Google Indexing API ───────────────────────────────────────
    // Prioridad: primero URLs nuevas/modificadas, luego home.
    // Si no hubo cambios, envía las primeras 20 del sitemap como mínimo.
    // Con GOOGLE_INDEX_FORCE_ALL=true envía todo (consume toda la cuota).
    if (!SKIP_INDEX) {
        const googleUrls = GOOGLE_INDEXING.forceAll
            ? allUrls
            : newUrls.length > 0
                ? [...newUrls, ...sitemapHome.map(u => u.loc)]
                : allUrls.slice(0, 20);

        await runGoogleIndexingAPI(googleUrls, {
            dailyQuota: GOOGLE_INDEXING.dailyQuota,
            delayMs:    GOOGLE_INDEXING.delayMs,
            log,
            dryRun:     DRY_RUN,
        });
    }
}

generateEverything().catch(err => {
    log.error('Error fatal:', err.message);
    if (VERBOSE) console.error(err);
    process.exit(1);
});

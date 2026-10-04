// ============================================================
// worker.js — Eclipse Zone API
// Cloudflare Workers + KV
//
// RUTAS:
//   GET/PUT/POST  /api/gl/*  → proxy transparente a GitLab API v4,
//                              SOLO para projects/:id/repository/files/*
//                              con :id en GITLAB_ALLOWED_PROJECTS
//                              (usa secret GITLAB_TOKEN del Worker)
//
//   GET  /api/img?u=<url>    → proxy + caché PERMANENTE de imágenes externas
//                              en KV. La primera vez que se pide una URL se
//                              descarga y se guarda; después se sirve siempre
//                              desde KV aunque el link original expire o lo
//                              borren (soluciona el problema de las URLs
//                              firmadas de cdn.discordapp.com que expiran).
//
//   GET  /api/get_friends?user=X
//   GET  /api/get_pending_requests?user=X
//   POST /api/send_friend_request   { from, to, fromAvatar }
//   POST /api/handle_friend_request { from, to, action, fromAvatar, toAvatar }
//   POST /api/remove_friend         { user, friend }
//   POST /api/send_dm               { from, to, text, replyTo? }
//   GET  /api/get_dms?user1=X&user2=Y[&since=ISO][&limit=100]
//   GET  /api/stats
//   GET  /api/health
//   POST /api/register  { name, email, password }  → { user, sessionToken }
//   POST /api/login     { email, password }         → { user, sessionToken }
//
//   GET  /api/patreon/status                     → { configured }
//   POST /api/patreon/callback { code }          → { connected }  [Bearer sessionToken]
//        Intercambia el code por un access_token CON Patreon (server-to-
//        server, client_secret nunca sale del Worker) y guarda el estado de
//        membresía verificado en KV. Ver signSessionToken/verifySessionToken.
//   GET  /api/patreon/check                      → { connected }  [Bearer sessionToken]
//        (endpoint /api/patreon/exclusive-link eliminado 2026-08-04 junto con
//        el panel "💎 Link exclusivo de Patreon" — ver nota más abajo, cerca
//        de GITLAB_BLOCKED_FILES y del bloque de rutas /api/patreon/*.)
//
// STORAGE: Cloudflare KV namespace "EZ_DATA"
//   Claves usadas:
//     "friends"          → array de pares de amistad
//     "pending_requests" → array de solicitudes pendientes
//     "dms:{convId}"     → array de mensajes por conversación
//     "imgcache:{hash}"       → bytes de una imagen cacheada
//     "imgcache:{hash}:meta"  → { contentType, cachedAt, source }
//     "patreon:{email}"        → { patreonUserId, connected, patronStatus, verifiedAt }
//     "exclusive_links:{slug}" → { links, linksPorTraductor } — link real de un
//                                 juego exclusivo (slug = slugify() del título)
//
// SECRETS requeridos en Cloudflare Workers:
//   wrangler secret put GITLAB_TOKEN
//   wrangler secret put SESSION_SECRET          (random, 32+ bytes — firma sessionToken)
//   wrangler secret put PATREON_CLIENT_ID       (público, pero igual como secret por simpleza)
//   wrangler secret put PATREON_CLIENT_SECRET
// ============================================================

// ── Rate limiter en memoria del isolate ─────────────────────
// NOTA: antes vivía en KV, pero eso costaba UNA ESCRITURA de KV por request.
// El plan free de KV permite 1000 escrituras/día — se agotaba la cuota y
// kv.put() lanzaba excepción, tirando 500 en TODAS las rutas rate-limiteadas
// (/api/img, /api/gl, etc.). En memoria es gratis e infinitamente más rápido;
// se resetea en cada redeploy/isolate nuevo, lo cual es aceptable para un
// límite anti-abuso. SIEMPRE fail-open: un error acá nunca debe tumbar la ruta.
const RATE_BUCKETS = new Map();
function rateLimit(ip, action, maxPerMinute = 20) {
    try {
        const now = Date.now();
        const key = `${ip}:${action}`;
        let entry = RATE_BUCKETS.get(key);
        if (!entry || now > entry.reset) {
            entry = { count: 0, reset: now + 60_000 };
            RATE_BUCKETS.set(key, entry);
        }
        entry.count++;
        // Limpieza ocasional para que el Map no crezca sin límite
        if (RATE_BUCKETS.size > 5000) {
            for (const [k, v] of RATE_BUCKETS) {
                if (now > v.reset) RATE_BUCKETS.delete(k);
            }
        }
        return entry.count > maxPerMinute;
    } catch {
        return false; // fail-open
    }
}

// ── Orígenes permitidos ──────────────────────────────────────
const ALLOWED_ORIGINS = [
    'https://eclipse1940zone.online',
    'https://www.eclipse1940zone.online',
    'https://eclipsezonehub.com',
    'https://www.eclipsezonehub.com',
    // Previews de Cloudflare Pages:
    'https://eclipse-6y7.pages.dev',
    // Para pruebas locales:
    'http://localhost',
    'http://127.0.0.1',
];

// Orígenes dinámicos permitidos (deploys de preview de Pages)
function isAllowedOrigin(origin) {
    if (ALLOWED_ORIGINS.includes(origin)) return true;
    // Cualquier preview de Cloudflare Pages del proyecto eclipse
    if (/^https:\/\/[a-f0-9]+\.eclipse-6y7\.pages\.dev$/.test(origin)) return true;
    // localhost / 127.0.0.1 con cualquier puerto (desarrollo local)
    if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
    return false;
}

// ── CORS helpers ─────────────────────────────────────────────
function corsHeaders(origin) {
    const allowed = isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS[0];
    return {
        'Access-Control-Allow-Origin':  allowed,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
        // Authorization: la usan las rutas /api/patreon/* (Bearer sessionToken).
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age':       '86400',
    };
}

// CORS permisivo — usado solo por /api/gl/* y /api/img, que no dependen del
// origen para su seguridad (ver GITLAB_ALLOWED_PROJECTS / IMG_ALLOWED_HOSTS
// más abajo). Formularios y otros sitios externos (ej. formulario-juegos)
// necesitan poder leer la respuesta de estas dos rutas.
function corsHeadersPermissive(origin) {
    return {
        'Access-Control-Allow-Origin':  origin || '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
        // Authorization: /api/gl-auth/* y /api/form/admin/* exigen
        // "Bearer <sessionToken>" (ver requireSession/proxyGitlab authed).
        // Sin listarlo acá, el preflight lo rechaza antes de que la
        // petición real salga ("Request header field authorization is
        // not allowed by Access-Control-Allow-Headers").
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age':       '86400',
    };
}

function json(data, status = 200, origin = '', permissive = false) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...(permissive ? corsHeadersPermissive(origin) : corsHeaders(origin)) },
    });
}

function err(msg, status = 400, origin = '', permissive = false) {
    return json({ ok: false, error: msg }, status, origin, permissive);
}

// json()/err() con CORS permisivo: para rutas que llaman sitios EXTERNOS
// (formulario-juegos-09f976.gitlab.io, otro dominio) y no dependen del
// origen para su seguridad (llevan su propia verificación: password,
// Bearer sessionToken). Bug real 2026-07-29: formLogin/formRegister
// devolvían corsHeaders() estricto (solo eclipse1940zone.online) — el
// Worker respondía 200 bien, pero el browser tiraba la respuesta por CORS
// antes de que el JS del formulario pudiera leerla. curl no lo mostraba
// porque curl no aplica same-origin policy.
function jsonP(data, status, origin) { return json(data, status, origin, true); }
function errP(msg, status, origin)   { return err(msg, status, origin, true); }

// ── KV helpers ───────────────────────────────────────────────
async function kvGet(kv, key) {
    const raw = await kv.get(key);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
}

async function kvSet(kv, key, value, ttlSeconds = null) {
    const opts = ttlSeconds ? { expirationTtl: ttlSeconds } : undefined;
    await kv.put(key, JSON.stringify(value), opts);
}

async function kvDelete(kv, key) {
    await kv.delete(key);
}

// ── conv_id estable (igual que PHP) ─────────────────────────
function convId(a, b) {
    const parts = [a.toLowerCase(), b.toLowerCase()].sort();
    return parts.join('__');
}

// ── Enrutador principal ──────────────────────────────────────
export default {
    async fetch(request, env, ctx) {
        const origin = request.headers.get('Origin') || '';
        const url    = new URL(request.url);
        const path   = url.pathname.replace(/\/$/, '');
        const method = request.method.toUpperCase();

        // Preflight CORS — rutas llamadas desde otros orígenes (el proxy
        // abierto, el proxy autenticado del formulario, login/registro del
        // formulario, y recuperación de contraseña) usan headers permisivos.
        if (method === 'OPTIONS') {
            const permissive = path.startsWith('/api/gl/')
                || path.startsWith('/api/gl-auth/')
                || path === '/api/img'
                || path === '/api/login'
                || path === '/api/form/login'
                || path === '/api/form/register'
                || path.startsWith('/api/password-reset/')
                || path.startsWith('/api/form/admin/')
                || path.startsWith('/api/admin/');
            return new Response(null, { status: 204, headers: permissive ? corsHeadersPermissive(origin) : corsHeaders(origin) });
        }

        // KV namespace — configurado en wrangler.toml como EZ_DATA
        const kv = env.EZ_DATA;
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

        // ── Rutas ────────────────────────────────────────────
        try {
            if (path === '/api/get_friends' && method === 'GET') {
                return await getFriends(kv, url, origin);
            }
            if (path === '/api/get_pending_requests' && method === 'GET') {
                return await getPendingRequests(kv, url, origin);
            }
            if (path === '/api/send_friend_request' && method === 'POST') {
                if (rateLimit(ip, 'friend_req', 10)) return err('Demasiadas solicitudes. Esperá un momento.', 429, origin);
                return await sendFriendRequest(kv, request, origin);
            }
            if (path === '/api/handle_friend_request' && method === 'POST') {
                if (rateLimit(ip, 'friend_req_handle', 20)) return err('Demasiadas solicitudes. Esperá un momento.', 429, origin);
                return await handleFriendRequest(kv, request, origin);
            }
            if (path === '/api/remove_friend' && method === 'POST') {
                return await removeFriend(kv, request, origin);
            }
            if (path === '/api/send_dm' && method === 'POST') {
                if (rateLimit(ip, 'dm', 30)) return err('Demasiados mensajes. Esperá un momento.', 429, origin);
                return await sendDm(kv, request, origin);
            }
            if (path === '/api/get_dms' && method === 'GET') {
                return await getDms(kv, url, origin);
            }
            if (path === '/api/register' && method === 'POST') {
                if (rateLimit(ip, 'register', 5)) return err('Demasiados intentos. Esperá un momento.', 429, origin);
                return await registerAccount(request, env, origin);
            }
            if (path === '/api/verify-email' && method === 'POST') {
                if (rateLimit(ip, 'verify_email', 10)) return err('Demasiados intentos. Esperá un momento.', 429, origin);
                return await verifyEmail(request, env, origin);
            }
            if (path === '/api/resend-verification' && method === 'POST') {
                if (rateLimit(ip, 'resend_verification', 3)) return err('Ya pediste varias veces. Esperá un momento.', 429, origin);
                return await resendVerification(request, env, origin);
            }
            if (path === '/api/login' && method === 'POST') {
                if (rateLimit(ip, 'login', 10)) return err('Demasiados intentos. Esperá un momento.', 429, origin);
                return await loginAccount(request, env, origin);
            }
            // POST /api/form/login — login del formulario de carga (cuenta.json).
            // Devuelve un sessionToken de scope 'form' para /api/gl-auth/*.
            if (path === '/api/form/login' && method === 'POST') {
                if (rateLimit(ip, 'form_login', 10)) return err('Demasiados intentos. Esperá un momento.', 429, origin);
                return await formLogin(request, env, origin);
            }
            if (path === '/api/form/register' && method === 'POST') {
                if (rateLimit(ip, 'form_register', 5)) return err('Demasiados intentos. Esperá un momento.', 429, origin);
                return await formRegister(request, env, origin);
            }
            // POST /api/password-reset/request { email, system } — pedir el link.
            // POST /api/password-reset/confirm { token, newPassword } — usarlo.
            // CORS permisivo: puede llamarse desde el sitio o desde el formulario.
            if (path === '/api/password-reset/request' && method === 'POST') {
                if (rateLimit(ip, 'pwreset_request', 5)) return errP('Demasiados intentos. Esperá un momento.', 429, origin);
                return await passwordResetRequest(request, env, origin);
            }
            if (path === '/api/password-reset/confirm' && method === 'POST') {
                if (rateLimit(ip, 'pwreset_confirm', 10)) return errP('Demasiados intentos. Esperá un momento.', 429, origin);
                return await passwordResetConfirm(request, env, origin);
            }
            // Admin del formulario — requireFormAdmin() adentro verifica el
            // email server-side, no alcanza con tener sesión 'form' válida.
            if (path === '/api/form/admin/accounts' && method === 'GET') {
                if (rateLimit(ip, 'form_admin', 60)) return errP('Demasiadas solicitudes. Esperá un momento.', 429, origin);
                return await getFormAdminAccounts(request, env, origin);
            }
            if (path === '/api/form/admin/action' && method === 'POST') {
                if (rateLimit(ip, 'form_admin', 30)) return errP('Demasiadas solicitudes. Esperá un momento.', 429, origin);
                return await formAdminAction(request, env, origin);
            }
            // GET /api/accounts/public — lista de cuentas SIN password, para
            // búsqueda de usuarios (amigos, @menciones) y para que checkSession()
            // pueda mostrar el perfil propio sin arrastrar el hash al cliente.
            if (path === '/api/accounts/public' && method === 'GET') {
                return await getPublicAccounts(env, origin);
            }
            // POST /api/account/profile — Authorization: Bearer <sessionToken>
            // Única forma de editar el propio perfil: nunca más un
            // read-modify-write del array completo desde el cliente.
            if (path === '/api/account/profile' && method === 'POST') {
                return await updateAccountProfile(request, env, origin);
            }
            // ── Comentarios / estrellas — server-side (fix condición de carrera) ──
            if (path === '/api/comments' && method === 'GET') {
                if (rateLimit(ip, 'comments_read', 120)) return err('Demasiadas solicitudes. Esperá un momento.', 429, origin);
                return await loadComments(url, env, origin);
            }
            if (path === '/api/comments/post' && method === 'POST') {
                if (rateLimit(ip, 'comments_post', 6)) return err('Demasiados comentarios. Esperá un momento.', 429, origin);
                return await postComment(request, env, origin);
            }
            if (path === '/api/comments/delete' && method === 'POST') {
                if (rateLimit(ip, 'comments_delete', 15)) return err('Demasiadas solicitudes. Esperá un momento.', 429, origin);
                return await deleteComment(request, env, origin);
            }
            if (path === '/api/comments/like' && method === 'POST') {
                if (rateLimit(ip, 'comments_like', 30)) return err('Demasiadas solicitudes. Esperá un momento.', 429, origin);
                return await likeComment(request, env, origin);
            }
            if (path === '/api/comments/reply' && method === 'POST') {
                if (rateLimit(ip, 'comments_reply', 10)) return err('Demasiadas respuestas. Esperá un momento.', 429, origin);
                return await replyComment(request, env, origin);
            }
            if (path === '/api/comments/delete-reply' && method === 'POST') {
                if (rateLimit(ip, 'comments_delete_reply', 15)) return err('Demasiadas solicitudes. Esperá un momento.', 429, origin);
                return await deleteReply(request, env, origin);
            }
            if (path === '/api/admin/dashboard' && method === 'GET') {
                if (rateLimit(ip, 'admin_dashboard', 20)) return err('Demasiadas solicitudes. Esperá un momento.', 429, origin);
                return await getAdminDashboard(request, env, origin);
            }
            if (path === '/api/comments/admin/all' && method === 'GET') {
                if (rateLimit(ip, 'comments_admin_all', 30)) return err('Demasiadas solicitudes. Esperá un momento.', 429, origin);
                return await getAllCommentsAdmin(request, env, origin);
            }
            if (path === '/api/comments/admin/delete' && method === 'POST') {
                if (rateLimit(ip, 'comments_admin_delete', 30)) return err('Demasiadas solicitudes. Esperá un momento.', 429, origin);
                return await deleteCommentAdmin(request, env, origin);
            }
            if (path === '/api/stars' && method === 'GET') {
                if (rateLimit(ip, 'stars_read', 120)) return err('Demasiadas solicitudes. Esperá un momento.', 429, origin);
                return await loadStars(url, env, origin);
            }
            if (path === '/api/stars/vote' && method === 'POST') {
                if (rateLimit(ip, 'stars_vote', 20)) return err('Demasiadas solicitudes. Esperá un momento.', 429, origin);
                return await voteStars(request, env, origin);
            }
            // ── Vistas de juegos/mangas (D1) ──
            if (path === '/api/view' && method === 'POST') {
                if (rateLimit(ip, 'view', 60)) return new Response(null, { status: 204, headers: corsHeadersPermissive(origin) });
                return await recordView(request, env, origin, ctx);
            }
            if (path === '/api/views' && method === 'GET') {
                if (rateLimit(ip, 'views_read', 60)) return err('Demasiadas solicitudes. Esperá un momento.', 429, origin, true);
                return jsonP(await getViewTotals(env), 200, origin);
            }
            if (path === '/api/views/top' && method === 'GET') {
                if (rateLimit(ip, 'views_top', 30)) return err('Demasiadas solicitudes. Esperá un momento.', 429, origin, true);
                return await getTopViews(url, env, origin);
            }
            if (path === '/api/report-broken-link' && method === 'POST') {
                if (rateLimit(ip, 'report_broken_link', 5)) return err('Demasiados reportes. Esperá un momento.', 429, origin);
                return await reportBrokenLink(request, env, origin);
            }
            if (path === '/api/report-js-error' && method === 'POST') {
                if (rateLimit(ip, 'report_js_error', 10)) return err('Demasiados reportes. Esperá un momento.', 429, origin);
                return await reportJsError(request, env, origin);
            }
            if (path === '/api/admin/broken-links' && method === 'GET') {
                if (rateLimit(ip, 'admin_broken_links', 30)) return err('Demasiadas solicitudes. Esperá un momento.', 429, origin);
                return await getBrokenLinksAdmin(request, env, origin);
            }
            if (path === '/api/admin/broken-links/resolve' && method === 'POST') {
                if (rateLimit(ip, 'admin_broken_links_resolve', 30)) return err('Demasiadas solicitudes. Esperá un momento.', 429, origin);
                return await resolveBrokenLinkAdmin(request, env, origin);
            }

            if (path === '/api/stats' && method === 'GET') {
                return await getStats(kv, origin);
            }
            if (path === '/api/health' && method === 'GET') {
                return json({ ok: true, ts: new Date().toISOString() }, 200, origin);
            }

            // GET /api/patreon/status — "ping" para saber si el backend ya tiene
            // las credenciales cargadas (ver PATREON_CLIENT_ID/SECRET más abajo).
            if (path === '/api/patreon/status' && method === 'GET') {
                const configured = !!(env && env.PATREON_CLIENT_ID && env.PATREON_CLIENT_SECRET);
                // client_id es público (va en la URL de autorización igual), lo
                // sirve el Worker para no duplicarlo también en el frontend.
                return json({ ok: true, configured, clientId: configured ? env.PATREON_CLIENT_ID : null }, 200, origin);
            }
            if (path === '/api/patreon/callback' && method === 'POST') {
                if (rateLimit(ip, 'patreon_callback', 10)) return err('Demasiados intentos. Esperá un momento.', 429, origin);
                return await patreonCallback(request, env, origin);
            }
            if (path === '/api/patreon/check' && method === 'GET') {
                if (rateLimit(ip, 'patreon_check', 60)) return err('Demasiadas solicitudes. Esperá un momento.', 429, origin);
                return await patreonCheck(request, env, origin);
            }
            if (path === '/api/patreon/exclusive-games' && method === 'GET') {
                if (rateLimit(ip, 'patreon_exclusive_games', 30)) return err('Demasiadas solicitudes. Esperá un momento.', 429, origin);
                return await patreonExclusiveGames(request, env, origin);
            }
            if (path === '/api/patreon-genres' && method === 'GET') {
                if (rateLimit(ip, 'patreon_genres_public', 120)) return err('Demasiadas solicitudes. Esperá un momento.', 429, origin);
                return await getPatreonGenresPublic(request, env, origin);
            }
            if (path === '/api/admin/patreon-genres' && method === 'GET') {
                if (rateLimit(ip, 'admin_patreon_genres', 30)) return err('Demasiadas solicitudes. Esperá un momento.', 429, origin);
                return await getPatreonGenresAdmin(request, env, origin);
            }
            if (path === '/api/admin/patreon-genres' && method === 'POST') {
                if (rateLimit(ip, 'admin_patreon_genres_save', 15)) return err('Demasiadas solicitudes. Esperá un momento.', 429, origin);
                return await savePatreonGenresAdmin(request, env, origin);
            }
            // NOTA 2026-08-04: se eliminó el panel "💎 Link exclusivo de Patreon"
            // (/api/admin/exclusive-link, /api/admin/exclusive-link/remove y
            // /api/patreon/exclusive-link) a pedido — era confuso y solo lo podía
            // usar SITE_ADMIN_EMAIL. Ahora un juego exclusivo de Patreon se carga
            // marcando el checkbox "Juego exclusivo de Patreon" en el formulario
            // normal, con sus Links de descarga puestos ahí mismo; eso lo manda a
            // exclusivos.json (ver EXCLUSIVE_GAMES_FILE_PATH en form.js) en vez de
            // juegos.json. Ver también el comentario junto a GITLAB_BLOCKED_FILES.
            //
            // 2026-09-21: reemplazo real del /api/admin/exclusive-link eliminado —
            // F95Pipeline (no el formulario web) alimenta exclusivos.json para todo
            // juego NUEVO que tenga link directo (sin acortador), sea o no marcado
            // "exclusivo" — ver saveExclusiveDirectGame más abajo y la nota junto a
            // GAMES_PROJECT_ID. Solo aplica a publicaciones nuevas, sin backfill.
            if (path === '/api/admin/exclusive-direct-link' && method === 'POST') {
                if (rateLimit(ip, 'admin_exclusive_direct_link', 20)) return err('Demasiadas solicitudes. Esperá un momento.', 429, origin);
                return await saveExclusiveDirectGame(request, env, origin);
            }

            // ── Proxy GitLab — /api/gl/* → https://gitlab.com/api/v4/* ──
            // El token nunca sale del Worker: se inyecta desde el secret GITLAB_TOKEN.
            // Soporta GET (lectura), PUT y POST (escritura de archivos).
            // Restringido a projects/:id/repository/files/* con :id conocido
            // (ver GITLAB_ALLOWED_PROJECTS) — no es un proxy abierto a toda la API.
            if (path.startsWith('/api/gl/') && ['GET', 'PUT', 'POST'].includes(method)) {
                const limit = method === 'GET' ? 120 : 15;
                if (rateLimit(ip, 'gitlab_proxy_' + method, limit)) {
                    return err('Demasiadas solicitudes. Esperá un momento.', 429, origin);
                }
                return await proxyGitlab(request, url, env, origin);
            }

            // ── Proxy GitLab CON SESIÓN — /api/gl-auth/* ──
            // Lo usa el formulario de carga (sitio estático aparte) para leer y
            // escribir sus JSON sin llevar un token de GitLab en su JS público.
            if (path.startsWith('/api/gl-auth/') && ['GET', 'PUT', 'POST'].includes(method)) {
                const limit = method === 'GET' ? 120 : 15;
                if (rateLimit(ip, 'gitlab_auth_proxy_' + method, limit)) {
                    return err('Demasiadas solicitudes. Esperá un momento.', 429, origin);
                }
                return await proxyGitlab(request, url, env, origin, { authed: true });
            }

            // ── Proxy GitHub CON SESIÓN — /api/gh-auth/pendientes-brandon ──
            // Lo usa admin/juegos/pendientes.js. Ver proxyGithubPendientesBrandon.
            if (path === '/api/gh-auth/pendientes-brandon' && ['GET', 'PUT'].includes(method)) {
                const limit = method === 'GET' ? 120 : 15;
                if (rateLimit(ip, 'github_pendientes_brandon_' + method, limit)) {
                    return err('Demasiadas solicitudes. Esperá un momento.', 429, origin);
                }
                return await proxyGithubPendientesBrandon(request, env, origin);
            }

            // ── Proxy AI-Fill — /api/ai-fill-proxy ──────────────────────────
            // Lo usa admin/juegos/form.js ("Completar campos con IA") en vez
            // de pegarle directo a la URL de Railway del bot (que rota y
            // quedaba hardcodeada). Ver proxyAiFill.
            if (path === '/api/ai-fill-proxy' && ['POST', 'OPTIONS'].includes(method)) {
                if (method === 'POST' && rateLimit(ip, 'ai_fill_proxy', 10)) {
                    return err('Demasiadas solicitudes. Esperá un momento.', 429, origin);
                }
                return await proxyAiFill(request, env, origin);
            }

            // ── Proxy — /api/f95-brandon-complete ──
            // admin/juegos/pendientes.js posts here, but the route lives on
            // the bot (WebServer.py), not in this Worker: without this it
            // answered "Ruta no encontrada".
            if (path === '/api/f95-brandon-complete' && ['POST', 'OPTIONS'].includes(method)) {
                if (method === 'POST' && rateLimit(ip, 'brandon_complete_proxy', 10)) {
                    return err('Demasiadas solicitudes. Esperá un momento.', 429, origin);
                }
                return await proxyBrandonComplete(request, env, origin);
            }

            // ── Proxy GitLab CON TOKEN DE BOT — /api/gl-bot/* ──
            // Lo usa el bot de Discord (Railway, ScheduledPublishCog en
            // senpaibot/cogs.py) para revelar juegos programados en
            // juegos.json (sacar "oculto"/"fechaPublicacion") el día
            // indicado. El bot nunca tiene sesión de formulario ni el
            // GITLAB_TOKEN real — usa un secret propio (X-Bot-Token,
            // env.BOT_GITLAB_TOKEN) que solo habilita esta ruta, restringida
            // SIEMPRE al proyecto de juegos.json (ver GITLAB_ALLOWED_PROJECTS
            // / project id 75579701) — mismo criterio que
            // proxyGithubPendientesBrandon (repo/archivo fijo en el código,
            // nunca en la URL que manda el cliente).
            if (path.startsWith('/api/gl-bot/') && ['GET', 'PUT'].includes(method)) {
                const limit = method === 'GET' ? 60 : 20;
                if (rateLimit(ip, 'gitlab_bot_proxy_' + method, limit)) {
                    return err('Demasiadas solicitudes. Esperá un momento.', 429, origin);
                }
                return await proxyGitlab(request, url, env, origin, { botToken: true });
            }

            // ── Proxy GitHub CON TOKEN DE BOT — /api/gh-bot/pendientes-brandon ──
            // Mismo archivo/repo que /api/gh-auth/pendientes-brandon (ver
            // proxyGithubPendientesBrandon) pero para el bot de Discord
            // (Railway): cuando ScheduledPublishCog revela un juego
            // programado que tiene canal de Brandon pendiente, necesita
            // encolarlo en pendientes_brandon.json sin sesión de
            // formulario. Reusa el mismo X-Bot-Token/env.BOT_GITLAB_TOKEN
            // que /api/gl-bot/* — es "token del bot", no específico de
            // GitLab pese al nombre del secret.
            if (path === '/api/gh-bot/pendientes-brandon' && ['GET', 'PUT'].includes(method)) {
                const limit = method === 'GET' ? 60 : 20;
                if (rateLimit(ip, 'github_pendientes_brandon_bot_' + method, limit)) {
                    return err('Demasiadas solicitudes. Esperá un momento.', 429, origin);
                }
                return await proxyGithubPendientesBrandon(request, env, origin, { botToken: true });
            }

            // ── Proxy GitHub CON TOKEN DE BOT — /api/gh-bot/milestone-counters ──
            // ScheduledPublishCog suma los juegos programados a los hitos de
            // Discord el día que los revela. Solo token de bot (sin variante
            // de sesión de formulario: nadie más escribe este archivo desde la web).
            if (path === '/api/gh-bot/milestone-counters' && ['GET', 'PUT'].includes(method)) {
                const limit = method === 'GET' ? 60 : 20;
                if (rateLimit(ip, 'github_milestone_counters_bot_' + method, limit)) {
                    return err('Demasiadas solicitudes. Esperá un momento.', 429, origin);
                }
                return await proxyGithubPendientesBrandon(request, env, origin, {
                    botToken: true, targetApi: GITHUB_MILESTONE_COUNTERS_API,
                });
            }

            // ── Proxy + caché de imágenes — GET /api/img?u=<url> ──
            // Límite alto: una sola grilla de mangas pide ~24 portadas de golpe.
            if (path === '/api/img' && method === 'GET') {
                if (rateLimit(ip, 'img_proxy', 300)) {
                    return err('Demasiadas solicitudes. Esperá un momento.', 429, origin);
                }
                return await proxyImage(request, url, env, origin, ctx);
            }

            // ── Proxy MangaDex — /api/md/* → https://api.mangadex.org/* ──
            // MangaDex bloquea CORS en dominios externos; este proxy server-side lo resuelve.
            // Solo GET (lectura pública). El Worker reenvía query string tal cual.
            if (path.startsWith('/api/md/') && method === 'GET') {
                return await proxyMangaDex(request, url, origin);
            }

            return err('Ruta no encontrada', 404, origin);
        } catch (e) {
            console.error('Worker error:', e);
            return err('Error interno del servidor', 500, origin);
        }
    },

    // Cron (wrangler.toml [triggers]): once a day, prune old hourly view buckets.
    async scheduled(event, env, ctx) {
        ctx.waitUntil(pruneViews(env).catch(e => console.error('pruneViews:', e)));
    },
};


// ── Vistas (D1) ──────────────────────────────────────────────────────────
// Antes: cada navegador bajaba stats/views_data.json de GitLab, sumaba y lo
// subía entero → visitas simultáneas se pisaban y cada visita era un commit.
// Ahora cada visita es un UPSERT atómico en D1 (binding EZ_VIEWS_DB, sin
// tokens): view_totals = total histórico, view_hourly = por hora para el top
// de las últimas N horas (el cron borra lo de más de 8 días). Free: 100k
// filas escritas/día → 2 por visita ≈ 50k visitas/día.
// (2026-09-27: se usó Analytics Engine unas horas, pero leerlo exige un API
// token que no se pudo crear; lo contado ahí antes del cambio se perdió.)
const VIEWS_TYPES   = new Set(['game', 'manga']);
const VIEWS_KEEP_H  = 8 * 24;
const _viewsMem = new Map();                     // per-isolate cache: key -> {at, data}

function viewKey(s) {
    return String(s || '').trim().toLowerCase().slice(0, 200);
}

async function _memo(key, ttlMs, fn) {
    const hit = _viewsMem.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.data;
    const data = await fn();
    _viewsMem.set(key, { at: Date.now(), data });
    return data;
}

// POST /api/view  {type, key} — body as text/plain so sendBeacon needs no preflight.
async function recordView(request, env, origin, ctx) {
    const data = await request.text().then(t => JSON.parse(t)).catch(() => ({}));
    const type = VIEWS_TYPES.has(data.type) ? data.type : null;
    const key  = viewKey(data.key);
    if (type && key && env.EZ_VIEWS_DB) {
        const hour = Math.floor(Date.now() / 3_600_000);
        const db = env.EZ_VIEWS_DB;
        const write = db.batch([
            db.prepare('INSERT INTO view_totals (type, key, n) VALUES (?1, ?2, 1) ' +
                       'ON CONFLICT(type, key) DO UPDATE SET n = n + 1').bind(type, key),
            db.prepare('INSERT INTO view_hourly (hour, type, key, n) VALUES (?1, ?2, ?3, 1) ' +
                       'ON CONFLICT(hour, type, key) DO UPDATE SET n = n + 1').bind(hour, type, key),
        ]).catch(e => console.error('recordView:', e));   // e.g. daily free limit reached
        if (ctx) ctx.waitUntil(write); else await write;
    }
    return new Response(null, { status: 204, headers: corsHeadersPermissive(origin) });
}

// GET /api/views → {game:{key:n}, manga:{key:n}}
async function getViewTotals(env) {
    return _memo('totals', 10 * 60_000, async () => {
        const out = { game: {}, manga: {} };
        if (!env.EZ_VIEWS_DB) return out;
        const { results } = await env.EZ_VIEWS_DB.prepare('SELECT type, key, n FROM view_totals').all();
        for (const r of results || []) {
            if (out[r.type]) out[r.type][r.key] = Number(r.n) || 0;
        }
        return out;
    });
}

// GET /api/views/top?type=game&hours=24&limit=10 → {ok, top:[{key, views}]}
async function getTopViews(url, env, origin) {
    const type  = VIEWS_TYPES.has(url.searchParams.get('type')) ? url.searchParams.get('type') : 'game';
    const hours = Math.max(1, Math.min(168, parseInt(url.searchParams.get('hours') || '24', 10) || 24));
    const limit = Math.max(1, Math.min(50, parseInt(url.searchParams.get('limit') || '10', 10) || 10));
    try {
        const top = await _memo(`top:${type}:${hours}:${limit}`, 60 * 60_000, async () => {
            if (!env.EZ_VIEWS_DB) return [];
            const since = Math.floor(Date.now() / 3_600_000) - hours;
            const { results } = await env.EZ_VIEWS_DB.prepare(
                'SELECT key, SUM(n) AS views FROM view_hourly WHERE type = ?1 AND hour > ?2 ' +
                'GROUP BY key ORDER BY views DESC LIMIT ?3').bind(type, since, limit).all();
            return (results || []).map(r => ({ key: r.key, views: Number(r.views) || 0 }));
        });
        return jsonP({ ok: true, configured: !!env.EZ_VIEWS_DB, top }, 200, origin);
    } catch (e) {
        console.error('getTopViews:', e);
        return errP('No se pudieron leer las vistas', 502, origin);
    }
}

// Cron: drop hourly buckets older than VIEWS_KEEP_H (totals are kept forever).
async function pruneViews(env) {
    if (!env.EZ_VIEWS_DB) return;
    const cutoff = Math.floor(Date.now() / 3_600_000) - VIEWS_KEEP_H;
    await env.EZ_VIEWS_DB.prepare('DELETE FROM view_hourly WHERE hour <= ?1').bind(cutoff).run();
}

// GET /api/get_friends?user=X
async function getFriends(kv, url, origin) {
    const user = (url.searchParams.get('user') || '').trim();
    if (!user) return err('Falta parámetro user', 400, origin);

    const all     = (await kvGet(kv, 'friends')) || [];
    const me      = user.toLowerCase();
    const friends = [];

    for (const f of all) {
        const u1 = (f.user1 || '').toLowerCase();
        const u2 = (f.user2 || '').toLowerCase();
        if (u1 === me) {
            friends.push({ nombre: f.user2, avatar: f.avatar2 || '', since: f.since || '' });
        } else if (u2 === me) {
            friends.push({ nombre: f.user1, avatar: f.avatar1 || '', since: f.since || '' });
        }
    }

    return json({ ok: true, friends }, 200, origin);
}

// GET /api/get_pending_requests?user=X
async function getPendingRequests(kv, url, origin) {
    const user = (url.searchParams.get('user') || '').trim();
    if (!user) return err('Falta parámetro user', 400, origin);

    const all     = (await kvGet(kv, 'pending_requests')) || [];
    const pending = all.filter(r => (r.to || '').toLowerCase() === user.toLowerCase());

    return json({ ok: true, requests: pending }, 200, origin);
}

// Límites de tamaño para campos de texto de usuario (evitan abuso/DoS vía payloads gigantes)
const MAX_USERNAME_LEN = 50;
const MAX_URL_LEN      = 500;

// POST /api/send_friend_request  { from, to, fromAvatar }
async function sendFriendRequest(kv, request, origin) {
    const data       = await request.json().catch(() => ({}));
    const from       = (data.from       || '').trim();
    const to         = (data.to         || '').trim();
    const fromAvatar = (data.fromAvatar || '').trim();

    if (!from || !to)   return err('Faltan parámetros', 400, origin);
    if (from.length > MAX_USERNAME_LEN || to.length > MAX_USERNAME_LEN) {
        return err(`El nombre de usuario no puede superar ${MAX_USERNAME_LEN} caracteres`, 400, origin);
    }
    if (fromAvatar.length > MAX_URL_LEN) return err('URL de avatar demasiado larga', 400, origin);
    if (from === to)    return json({ ok: false, error: 'No puedes enviarte una solicitud a ti mismo' }, 200, origin);

    const requests = (await kvGet(kv, 'pending_requests')) || [];

    const already = requests.some(
        r => r.from.toLowerCase() === from.toLowerCase() &&
             r.to.toLowerCase()   === to.toLowerCase()
    );

    if (!already) {
        requests.push({
            from, to, fromAvatar,
            date: new Date().toISOString(),
            id:   crypto.randomUUID(),
        });
        await kvSet(kv, 'pending_requests', requests);
    }

    return json({ ok: true, already }, 200, origin);
}

// POST /api/handle_friend_request  { from, to, action, fromAvatar, toAvatar }
async function handleFriendRequest(kv, request, origin) {
    const data       = await request.json().catch(() => ({}));
    const from       = (data.from       || '').trim();
    const to         = (data.to         || '').trim();
    const action     = (data.action     || '').trim();   // "accept" | "reject"
    const fromAvatar = (data.fromAvatar || '').trim();
    const toAvatar   = (data.toAvatar   || '').trim();

    if (!from || !to || !['accept', 'reject'].includes(action)) {
        return err('Parámetros inválidos', 400, origin);
    }
    if (from.length > MAX_USERNAME_LEN || to.length > MAX_USERNAME_LEN) {
        return err(`El nombre de usuario no puede superar ${MAX_USERNAME_LEN} caracteres`, 400, origin);
    }
    if (fromAvatar.length > MAX_URL_LEN || toAvatar.length > MAX_URL_LEN) {
        return err('URL de avatar demasiado larga', 400, origin);
    }

    // 1. Eliminar de pending_requests
    let pending = (await kvGet(kv, 'pending_requests')) || [];
    pending = pending.filter(
        r => !(r.from.toLowerCase() === from.toLowerCase() &&
               r.to.toLowerCase()   === to.toLowerCase())
    );
    await kvSet(kv, 'pending_requests', pending);

    // 2. Si accept → añadir a friends
    if (action === 'accept') {
        const friends = (await kvGet(kv, 'friends')) || [];
        const key     = [from, to].map(s => s.toLowerCase()).sort().join('|');

        const already = friends.some(f => {
            const k = [f.user1, f.user2].map(s => s.toLowerCase()).sort().join('|');
            return k === key;
        });

        if (!already) {
            friends.push({
                user1:   from,
                user2:   to,
                avatar1: fromAvatar,
                avatar2: toAvatar,
                since:   new Date().toISOString(),
                id:      crypto.randomUUID(),
            });
            await kvSet(kv, 'friends', friends);
        }
    }

    return json({ ok: true, action }, 200, origin);
}

// POST /api/remove_friend  { user, friend }
async function removeFriend(kv, request, origin) {
    const data   = await request.json();
    const user   = (data.user   || '').trim().toLowerCase();
    const friend = (data.friend || '').trim().toLowerCase();

    if (!user || !friend) return err('Faltan parámetros', 400, origin);

    let friends = (await kvGet(kv, 'friends')) || [];
    friends = friends.filter(f => {
        const u1 = (f.user1 || '').toLowerCase();
        const u2 = (f.user2 || '').toLowerCase();
        return !((u1 === user && u2 === friend) || (u1 === friend && u2 === user));
    });
    await kvSet(kv, 'friends', friends);

    return json({ ok: true }, 200, origin);
}

// POST /api/send_dm  { from, to, text, replyTo? }
async function sendDm(kv, request, origin) {
    const data    = await request.json();
    const from    = (data.from || '').trim();
    const to      = (data.to   || '').trim();
    const text    = (data.text || '').trim();
    const replyTo = data.replyTo || null;

    if (!from || !to || !text) return err('Faltan parámetros', 400, origin);
    if (text.length > 2000)    return err('Mensaje demasiado largo (máx. 2000 caracteres)', 400, origin);

    const cid  = convId(from, to);
    const key  = `dms:${cid}`;
    const msgs = (await kvGet(kv, key)) || [];
    const isNew = msgs.length === 0;

    const msg = {
        id:   crypto.randomUUID(),
        from, to,
        text, // Texto crudo — el frontend escapa al renderizar
        date: new Date().toISOString(),
    };
    if (replyTo) msg.replyTo = replyTo;

    msgs.push(msg);

    const trimmed = msgs.length > 500 ? msgs.slice(-500) : msgs;
    await kvSet(kv, key, trimmed);

    // Actualizar contador de estadísticas (best-effort, sin bloquear la respuesta)
    (async () => {
        try {
            const statsKey = 'meta:stats';
            const stats    = (await kvGet(kv, statsKey)) || { totalMessages: 0, totalConvs: 0 };
            stats.totalMessages = (stats.totalMessages || 0) + 1;
            if (isNew) stats.totalConvs = (stats.totalConvs || 0) + 1;
            await kvSet(kv, statsKey, stats);
        } catch { /* ignorar errores de stats */ }
    })();

    return json({ ok: true, msg }, 200, origin);
}

// GET /api/get_dms?user1=X&user2=Y[&since=ISO][&limit=100][&before=ISO]
async function getDms(kv, url, origin) {
    const user1  = (url.searchParams.get('user1') || '').trim();
    const user2  = (url.searchParams.get('user2') || '').trim();
    const since  = url.searchParams.get('since')  || '';
    const before = url.searchParams.get('before') || '';
    const limit  = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit') || '100', 10)));

    if (!user1 || !user2) return err('Faltan parámetros', 400, origin);

    const cid  = convId(user1, user2);
    const key  = `dms:${cid}`;
    let msgs   = (await kvGet(kv, key)) || [];

    if (since) {
        const sinceMs = new Date(since).getTime();
        msgs = msgs.filter(m => new Date(m.date || 0).getTime() > sinceMs);
    }
    if (before) {
        const beforeMs = new Date(before).getTime();
        msgs = msgs.filter(m => new Date(m.date || 0).getTime() < beforeMs);
    }

    const total = msgs.length;
    msgs = msgs.slice(-limit);
    const hasMore = total > limit;

    return json({ ok: true, messages: msgs, convId: cid, hasMore, total }, 200, origin);
}

// GET /api/stats — métricas públicas del sistema
async function getStats(kv, origin) {
    const friends  = (await kvGet(kv, 'friends'))          || [];
    const pending  = (await kvGet(kv, 'pending_requests')) || [];

    // Contar conversaciones activas (claves dms:*)
    // Nota: KV list con prefix requiere permisos, se usa un contador incremental
    const statsKey = 'meta:stats';
    const stats    = (await kvGet(kv, statsKey)) || { totalMessages: 0, totalConvs: 0 };

    return json({
        ok: true,
        friends:          friends.length,
        pendingRequests:  pending.length,
        totalMessages:    stats.totalMessages || 0,
        totalConvs:       stats.totalConvs    || 0,
        ts:               new Date().toISOString(),
    }, 200, origin);
}

// ── Proxy MangaDex ────────────────────────────────────────────
// GET /api/md/* → https://api.mangadex.org/*
//
// MangaDex no permite CORS desde dominios externos.
// Este proxy server-side reenvía la petición con los headers correctos
// y devuelve la respuesta con los headers CORS del Worker.
// Solo acepta GET (la API pública de MangaDex es solo lectura).
async function proxyMangaDex(request, url, origin) {
    // Reconstruir la URL de MangaDex:
    //   /api/md/manga/tag?limit=100  →  https://api.mangadex.org/manga/tag?limit=100
    const mdPath = url.pathname.replace(/^\/api\/md/, '');
    const mdUrl  = 'https://api.mangadex.org' + mdPath + (url.search || '');

    const mdHeaders = new Headers();
    mdHeaders.set('Accept', 'application/json');
    // User-Agent personalizado — MangaDex requiere uno válido para evitar 403
    mdHeaders.set('User-Agent', 'EclipseZone/1.0 (https://eclipsezonehub.com; manga reader)');
    // Referer ayuda a que MangaDex no considere la petición como scraping
    mdHeaders.set('Referer', 'https://mangadex.org/');

    let mdRes;
    try {
        mdRes = await fetch(new Request(mdUrl, {
            method:  'GET',
            headers: mdHeaders,
        }));
    } catch (e) {
        console.error('[proxyMangaDex] Error de red hacia MangaDex:', e.message);
        return err('Proxy MangaDex: error de red', 502, origin);
    }

    // Loggear status para facilitar diagnóstico
    if (!mdRes.ok) {
        console.warn(`[proxyMangaDex] MangaDex HTTP ${mdRes.status} para: ${mdPath}${url.search || ''}`);
    }

    const resHeaders = new Headers();
    resHeaders.set('Content-Type', mdRes.headers.get('Content-Type') || 'application/json');

    // Cache en Cloudflare Edge según el tipo de endpoint:
    // - /manga/tag (estático) → 1 hora
    // - /manga (listados) → 3 minutos
    // - /at-home (páginas) → NUNCA cachear: MangaDex genera esas URLs
    //   (baseUrl + token del nodo) por request y expiran en ~15 min. Servir
    //   una respuesta cacheada da URLs muertas → 404 en TODAS las páginas
    //   del capítulo (bug visto 2026-07-20 con cache de 600s).
    // - resto → 2 minutos
    let cacheSeconds = 120;
    if (mdPath === '/manga/tag') cacheSeconds = 3600;
    else if (mdPath === '/manga') cacheSeconds = 180;
    else if (mdPath.startsWith('/at-home')) cacheSeconds = 0;
    resHeaders.set('Cache-Control', cacheSeconds === 0
        ? 'no-store'
        : `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}`);

    Object.entries(corsHeaders(origin)).forEach(([k, v]) => resHeaders.set(k, v));

    return new Response(mdRes.body, {
        status:  mdRes.status,
        headers: resHeaders,
    });
}

// ── Proyectos de GitLab a los que este Worker tiene permitido acceder ────
// Cualquier otro :id es rechazado con 403. Sin esto, /api/gl/* sería un
// proxy abierto a TODA la API v4 de GitLab (issues, members, otros
// proyectos privados, etc.) con el token privilegiado del Worker.
// Aceptamos tanto IDs numéricos como "namespace/proyecto" (ambos formatos
// son válidos como :id en la API de GitLab).
const GITLAB_ALLOWED_PROJECTS = new Set([
    '75579701',                        // senpai1940/juegos      (juegos.json)
    '75579697',                        // senpai1940/contador    (contador.json)
    '75579703',                        // noticias.json
    '81192889',                        // vistas/favoritos (home.js, juegos.js) y comentarios (comments.js)
    'senpai1940/juegos',
    'senpai1940/noticias',
    'eclipse1482609/cuenta-usuarios',  // comentarios.json, estrellas.json
]);

// Proyectos que SOLO son accesibles con sesión válida, vía /api/gl-auth/*
// (los usa el formulario de carga, nunca el sitio público). Se sacaron del
// allow-list abierto de arriba en 2026-07-29: `cuenta.json` (77157664) tenía
// exactamente el mismo problema que usuarios_cuenta.json — se servía entero,
// con contraseñas, a cualquiera sin login.
const GITLAB_AUTH_ONLY_PROJECTS = new Set([
    '75579701',                        // juegos.json    (escritura del formulario)
    '75579703',                        // noticias.json  (escritura del formulario)
    '77157664',                        // cuenta.json    (cuentas del formulario)
    '79641566',                        // caledario.json (calendario del formulario)
]);

// Único proyecto accesible vía /api/gl-bot/* (token de bot, sin sesión de
// usuario) — SOLO juegos.json, para que el bot revele juegos programados
// (ver ScheduledPublishCog). Deliberadamente no se reusa
// GITLAB_AUTH_ONLY_PROJECTS acá: el token de bot no debe poder tocar
// cuenta.json ni caledario.json aunque ese Set se amplíe en el futuro.
const GITLAB_BOT_PROJECTS = new Set([
    '75579701',                        // juegos.json
]);

// ── Archivos NUNCA servidos por el proxy abierto ─────────────────────────
// GITLAB_ALLOWED_PROJECTS filtra por PROYECTO, no por archivo — el repo de
// cuentas (81192889 / eclipse1482609/cuenta-usuarios) tiene que estar
// permitido para que comentarios.json/estrellas.json sigan siendo públicos,
// pero eso dejaba usuarios_cuenta.json (con el hash/contraseña de cada
// cuenta) accesible por GET *y editable por PUT/POST* a cualquiera sin
// login (incidente 2026-07-29, encontrado en vivo con curl sin token).
// Las lecturas/escrituras legítimas de este archivo van SIEMPRE server-side
// (glLoadAccounts/glSaveAccounts, más abajo) o por los endpoints
// autenticados /api/accounts/public y /api/account/profile — nunca acá.
// `cuenta.json` (cuentas del formulario) se suma en 2026-07-29 por el mismo
// motivo, como defensa en profundidad además de haber sacado su proyecto del
// allow-list: aunque alguien vuelva a agregar 77157664 arriba sin pensarlo,
// el archivo sigue sin poder salir por la ruta abierta.
const GITLAB_BLOCKED_FILES = new Set([
    'usuarios_cuenta.json',
    'cuenta.json',
    'exclusivos.json',
    // 2026-09-27: vistas pasaron a D1 (/api/view, /api/views);
    // el archivo viejo era escribible por cualquiera desde el proxy abierto.
    'stats/views_data.json',
]);

// NOTA 2026-08-04: exclusivos.json DEJÓ de ser el archivo privado del panel
// "💎 Link exclusivo de Patreon" (ese panel se eliminó junto con
// glLoadExclusivos/glSaveExclusivos y los endpoints /api/admin/exclusive-link*
// y /api/patreon/exclusive-link). Ahora es, como juegos.json, un array de
// juegos completos — los que se marcan "Juego exclusivo de Patreon" en el
// formulario (ver EXCLUSIVE_GAMES_FILE_PATH en form.js) — así que el
// formulario logueado SÍ necesita poder leerlo y escribirlo por
// /api/gl-auth/*. Antes estaba en GITLAB_ALWAYS_BLOCKED_FILES (bloqueado
// incluso con sesión), lo cual dejaba esa función del formulario rota sin
// excepción. Se lo baja a GITLAB_BLOCKED_FILES: sigue sin poder salir por el
// proxy abierto/público (/api/gl/*, sin login), pero el formulario logueado
// puede leerlo/escribirlo igual que juegos.json.
const GITLAB_ALWAYS_BLOCKED_FILES = new Set([]);

// ── Proxy GitLab ─────────────────────────────────────────────
// GET/PUT/POST /api/gl/projects/:id/repository/files/:path[?ref=...]
// → https://gitlab.com/api/v4/projects/:id/repository/files/:path[?ref=...]
//
// El header PRIVATE-TOKEN se inyecta desde env.GITLAB_TOKEN (secret del Worker).
// Nunca se expone al frontend.
//
// Solo se permite el endpoint repository/files (lectura/escritura de UN
// archivo) sobre proyectos en GITLAB_ALLOWED_PROJECTS — nunca el resto de
// la API de GitLab (issues, members, variables, otros proyectos, etc.) — y
// nunca sobre un archivo de GITLAB_BLOCKED_FILES, sin importar el proyecto.
//
// CORS: se usan headers permisivos (corsHeadersPermissive) porque el origen
// no es lo que protege esta ruta — el allow-list de proyectos sí.
//
// ── /api/gl-auth/* (mismo shape, con sesión) ────────────────────────────
// Idéntico, pero exige `Authorization: Bearer <sessionToken>` y usa
// GITLAB_AUTH_ONLY_PROJECTS. Existe para que el formulario de carga
// (formulario-juegos, sitio estático) pueda leer/escribir sus JSON SIN
// llevar un token de GitLab en su JS público — antes tenía uno con scope
// `api` completo hardcodeado y servido a cualquiera (incidente 2026-07-29).
//
// ── /api/gl-bot/* (mismo shape, con token de bot) ────────────────────────
// Para el bot de Discord (Railway, sin sesión de formulario humana). Exige
// `X-Bot-Token: <BOT_GITLAB_TOKEN>` (secret propio del Worker, distinto de
// GITLAB_TOKEN y de cualquier sessionToken) y restringe a
// GITLAB_BOT_PROJECTS (solo juegos.json) — nunca la allowlist completa,
// aunque esta ruta se use para poco más que revelar juegos programados.
async function proxyGitlab(request, url, env, origin, opts = {}) {
    const authed   = !!opts.authed;
    const botToken = !!opts.botToken;
    const token    = (env && env.GITLAB_TOKEN) ? env.GITLAB_TOKEN.trim() : '';
    // /api/gl-auth/* lo llama el formulario desde OTRO origen
    // (formulario-juegos-09f976.gitlab.io) — sus respuestas, incluidas las de
    // error, necesitan CORS permisivo o el browser las descarta antes de que
    // el JS del formulario las vea (bug real 2026-07-29: el login devolvía
    // 200 bien pero corsHeaders() estricto tiraba la respuesta en el browser).
    const errFn  = (authed || botToken) ? errP : err;

    if (!token) {
        console.error('[proxyGitlab] GITLAB_TOKEN no configurado en el Worker.');
        return errFn('Proxy GitLab: token no configurado. Ejecutá: wrangler secret put GITLAB_TOKEN', 503, origin);
    }

    let formEmail = null;
    if (authed) {
        formEmail = await requireSession(request, env, 'form');
        if (!formEmail) return errFn('Iniciá sesión en el formulario para hacer esta acción', 401, origin);
    }
    if (botToken) {
        const botSecret = (env && env.BOT_GITLAB_TOKEN) ? env.BOT_GITLAB_TOKEN.trim() : '';
        if (!botSecret) {
            console.error('[proxyGitlab] BOT_GITLAB_TOKEN no configurado en el Worker.');
            return errFn('Proxy GitLab (bot): token de bot no configurado. Ejecutá: wrangler secret put BOT_GITLAB_TOKEN', 503, origin);
        }
        if (request.headers.get('X-Bot-Token') !== botSecret) {
            return errFn('No autorizado', 401, origin);
        }
    }

    const prefix       = botToken ? '/api/gl-bot' : (authed ? '/api/gl-auth' : '/api/gl');
    const allowedSet   = botToken ? GITLAB_BOT_PROJECTS : (authed ? GITLAB_AUTH_ONLY_PROJECTS : GITLAB_ALLOWED_PROJECTS);
    const routeRe      = new RegExp(`^${prefix}/projects/([^/]+)/repository/files/([^/]+)`);

    // Validar forma de la ruta y proyecto permitido ANTES de reenviar nada.
    const m = url.pathname.match(routeRe);
    const projectId = m ? decodeURIComponent(m[1]) : null;
    const fileName  = m ? decodeURIComponent(m[2]) : null;
    if (!m || !allowedSet.has(projectId)) {
        console.error('[proxyGitlab] Ruta o proyecto no permitido:', url.pathname);
        return errFn('Ruta no permitida', 403, origin);
    }
    if (GITLAB_ALWAYS_BLOCKED_FILES.has(fileName)) {
        console.error('[proxyGitlab] Archivo bloqueado sin excepción:', fileName);
        return errFn('Ruta no permitida', 403, origin);
    }
    // El resto del bloqueo por archivo aplica SOLO a la ruta abierta:
    // /api/gl-auth/* ya exigió sesión, y el formulario necesita justamente
    // esos archivos (cuenta.json) para strikes/límite diario propio.
    if (!authed && GITLAB_BLOCKED_FILES.has(fileName)) {
        console.error('[proxyGitlab] Archivo bloqueado (solo acceso server-side):', fileName);
        return errFn('Ruta no permitida', 403, origin);
    }
    // exclusivos.json (juegos marcados "Juego exclusivo de Patreon") solo lo
    // puede ESCRIBIR senpai1940 — el checkbox del formulario ya aparece
    // deshabilitado para cualquier otro traductor, esto es la verificación
    // real del lado del servidor (lo del cliente es solo cosmético). La
    // LECTURA sigue abierta a cualquier traductor logueado, porque el panel
    // de "editar/eliminar juegos" del formulario necesita listar también los
    // juegos exclusivos existentes.
    if (authed && fileName === 'exclusivos.json' && ['PUT', 'POST'].includes(request.method.toUpperCase())
        && (formEmail || '').toLowerCase() !== 'senpai1940@gmail.com') {
        console.error('[proxyGitlab] Intento de escribir exclusivos.json sin ser senpai1940:', formEmail);
        return errFn('Solo senpai1940 puede marcar/editar juegos exclusivos de Patreon', 403, origin);
    }

    // Reconstruir la URL de GitLab:
    //   /api/gl/projects/123/repository/files/foo.json?ref=main
    // →  https://gitlab.com/api/v4/projects/123/repository/files/foo.json?ref=main
    const glPath = url.pathname.replace(new RegExp(`^${prefix}`), '/api/v4');
    const glUrl  = 'https://gitlab.com' + glPath + (url.search || '');

    // ── Cache corto para GET de lectura pública (2026-09-21) ───────────────
    // Sin esto, CADA carga de página (home + las 700+ fichas de juego, todos
    // los visitantes) pegaba en vivo a la API de GitLab por juegos.json, todos
    // compartiendo el mismo GITLAB_TOKEN. Cualquier lentitud/429/5xx transitorio
    // de GitLab dejaba a esa visita sin juegos ni mangas — reportado por el
    // usuario como "a veces se carga todo y otras veces no, es aleatorio".
    // fetchWithFallback ya reintenta con una 2da fuente (api v4 directo desde
    // el browser), pero si GitLab mismo está teniendo un mal momento, las dos
    // fuentes pegan al mismo backend y ambas pueden fallar igual.
    // Cache de Cloudflare (Cache API del Worker) por 90s en GETs no autenticados
    // ni de bot (evita servir cache a /api/gl-auth/* o /api/gl-bot/*, que deben
    // ver siempre el dato más fresco tras guardar desde el formulario/bot).
    const cacheable = !authed && !botToken && request.method.toUpperCase() === 'GET';
    const cache = cacheable ? caches.default : null;
    const cacheKey = cacheable ? new Request(url.toString(), { method: 'GET' }) : null;
    if (cache) {
        const cached = await cache.match(cacheKey);
        if (cached) return cached;
    }

    // Construir headers para GitLab, preservando Content-Type en PUT/POST
    const glHeaders = new Headers();
    glHeaders.set('PRIVATE-TOKEN', token);
    if (['PUT', 'POST'].includes(request.method.toUpperCase())) {
        const ct = request.headers.get('Content-Type') || 'application/json';
        glHeaders.set('Content-Type', ct);
    }

    const glReq = new Request(glUrl, {
        method:  request.method,
        headers: glHeaders,
        body:    ['GET', 'HEAD'].includes(request.method.toUpperCase()) ? undefined : request.body,
    });

    let glRes;
    try {
        glRes = await fetch(glReq);
    } catch (e) {
        console.error('[proxyGitlab] Error de red hacia GitLab:', e);
        // Si hay una copia cacheada aunque esté vencida, mejor eso que nada —
        // Cache API no nos deja pedir "stale" directo, así que esto solo cubre
        // el caso de red caída (el 429/5xx transitorio de GitLab SÍ pasa por
        // el bloque de abajo, que también intenta el cache antes de fallar).
        return err('Proxy GitLab: error de red', 502, origin);
    }

    // Reenviar respuesta con los headers CORS del Worker
    const resHeaders = new Headers();
    // Copiar Content-Type de la respuesta de GitLab
    const contentType = glRes.headers.get('Content-Type') || 'application/json';
    resHeaders.set('Content-Type', contentType);
    // Inyectar CORS
    Object.entries(corsHeadersPermissive(origin)).forEach(([k, v]) => resHeaders.set(k, v));

    if (!glRes.ok && cache) {
        // GitLab devolvió error (429/5xx/etc): si tenemos algo servible en
        // cache aunque ya haya expirado el TTL de arriba, lo hubiéramos
        // devuelto en el cache.match() de más arriba — llegar acá significa
        // que no había nada cacheado. No cacheamos la respuesta de error.
        return new Response(glRes.body, { status: glRes.status, headers: resHeaders });
    }

    if (glRes.ok && cache) {
        resHeaders.set('Cache-Control', 'public, max-age=90');
        const body = await glRes.arrayBuffer();
        const respToCache = new Response(body, { status: glRes.status, headers: resHeaders });
        // No bloquear la respuesta al usuario por escribir al cache.
        cache.put(cacheKey, respToCache.clone());
        return respToCache;
    }

    return new Response(glRes.body, {
        status:  glRes.status,
        headers: resHeaders,
    });
}

// ── Proxy GitHub — SOLO pendientes_brandon.json ──────────────────────────
// GET/PUT /api/gh-auth/pendientes-brandon
// → https://api.github.com/repos/espectador722-png/senpai1940/contents/pendientes_brandon.json
//
// A diferencia de proxyGitlab, esto NO es un proxy genérico: el repo y el
// archivo están fijos en el código, nunca vienen de la URL. Mismo motivo
// que gl-auth (el formulario, admin/juegos/pendientes.js, no puede llevar
// un token real en su JS público) pero para GitHub en vez de GitLab, porque
// F95Pipeline (que ya lee/escribe este mismo archivo desde la PC del
// usuario vía GITHUB_TOKEN local) usa la Contents API de GitHub, no GitLab
// — ver _PENDIENTES_BRANDON_GH_API en F95Pipeline/f95_publish.py. El bot de
// Discord (Railway) nunca toca GitHub directo en este sistema; ese trabajo
// siempre lo hace F95Pipeline o, para el navegador, este Worker — mismo
// criterio que gl-auth para GitLab.
//
// El header Authorization se inyecta desde env.GITHUB_TOKEN (secret del
// Worker, `wrangler secret put GITHUB_TOKEN`). Nunca se expone al frontend.
const GITHUB_PENDIENTES_BRANDON_API =
    'https://api.github.com/repos/espectador722-png/senpai1940/contents/pendientes_brandon.json';
// Contadores de hitos de Discord — mismo archivo que escribe F95Pipeline
// (f95_publish.py::_MILESTONE_COUNTERS_GH_API) con su token local; el bot
// lo usa vía /api/gh-bot/milestone-counters para sumar los juegos
// programados el día que los publica.
const GITHUB_MILESTONE_COUNTERS_API =
    'https://api.github.com/repos/espectador722-png/senpai1940/contents/milestone_counters.json';

// ── Proxy /api/ai-fill — resuelve la URL del bot dinámicamente ───────────
// GET/PUT /api/gh-auth/pendientes-brandon (arriba) y este proxy comparten
// el mismo problema: el usuario rota de cuenta de Railway seguido, así que
// hardcodear la URL del bot en JS público (como hacía admin/juegos/form.js
// con AI_FILL_ENDPOINT) rompe todo apenas rota — nadie se acuerda de
// actualizar el JS. F95Pipeline/AnnounceUpdate ya resuelven esto leyendo
// railway_url.json en GitHub (mismo repo que pendientes_brandon.json) con
// GITHUB_TOKEN local; acá se hace lo mismo pero server-side en el Worker,
// que ya tiene ese mismo secret. form.js deja de necesitar saber la URL
// real del bot — le pega a este proxy y listo (2026-09-21, reportado por
// el usuario: "Groq no funciona" era en realidad el bot caído/con URL
// vieja hardcodeada, no un bug de CORS aunque el navegador lo mostrara así).
const RAILWAY_URL_GH_API =
    'https://api.github.com/repos/espectador722-png/senpai1940/contents/railway_url.json';

async function _resolveSenpaibotUrl(env) {
    const token = (env && env.GITHUB_TOKEN) ? env.GITHUB_TOKEN.trim() : '';
    if (!token) return null;
    try {
        const r = await fetch(RAILWAY_URL_GH_API, {
            headers: {
                'Authorization': `token ${token}`,
                'Accept': 'application/vnd.github+json',
                'User-Agent': 'eclipsezonehub-worker',
            },
        });
        if (!r.ok) return null;
        const data = await r.json();
        const contenido = JSON.parse(decodeURIComponent(escape(atob((data.content || '').replace(/\n/g, '')))));
        const url = (contenido && contenido.url) ? String(contenido.url).trim().replace(/\/+$/, '') : '';
        return url || null;
    } catch (e) {
        console.error('[_resolveSenpaibotUrl] Error leyendo railway_url.json:', e);
        return null;
    }
}

// Mismo valor que _AIFILL_SECRET_DEFAULT en WebServer.py del bot — ya
// vivía expuesto en el JS público de admin/juegos/form.js (AI_FILL_TOKEN),
// así que hardcodearlo acá no empeora la exposición. No es un secreto
// crítico: solo autoriza pegarle a /api/ai-fill (rate-limited del lado del
// bot); el que sí importa (GITHUB_TOKEN) sigue siendo un secret real del
// Worker, nunca en el código. Si se quiere subir el nivel de seguridad más
// adelante, mover esto a `wrangler secret put AIFILL_TOKEN` (env.AIFILL_TOKEN)
// y sacar esta constante.
const AIFILL_TOKEN_FALLBACK = 'sbform-aifill-9d41c6e8b27f4a05';

async function proxyAiFill(request, env, origin) {
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeadersPermissive(origin) });
    }

    const aifillToken = ((env && env.AIFILL_TOKEN) ? env.AIFILL_TOKEN.trim() : '') || AIFILL_TOKEN_FALLBACK;

    const baseUrl = await _resolveSenpaibotUrl(env);
    if (!baseUrl) {
        return errP('No se pudo resolver la URL del bot (railway_url.json) — revisá GITHUB_TOKEN o el archivo en GitHub.', 502, origin);
    }

    // Buffered on purpose: forwarding request.body as a stream goes out chunked,
    // and bodies over ~2KB came back as Cloudflare "error code: 502".
    const body = request.method === 'POST' ? await request.text() : undefined;

    let botRes;
    try {
        botRes = await fetch(`${baseUrl}/api/ai-fill`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-AIFill-Token': aifillToken,
            },
            body,
        });
    } catch (e) {
        console.error('[proxyAiFill] Error de red hacia el bot:', e);
        return errP('Proxy AI-Fill: error de red hacia el bot', 502, origin);
    }

    const resHeaders = new Headers();
    resHeaders.set('Content-Type', botRes.headers.get('Content-Type') || 'application/json');
    Object.entries(corsHeadersPermissive(origin)).forEach(([k, v]) => resHeaders.set(k, v));
    // Cloudflare swaps a 502 body for its own "error code: 502", hiding the
    // bot's message; form.js already keys off json.success, not the status.
    const status = (botRes.status >= 500 && resHeaders.get('Content-Type').includes('json')) ? 200 : botRes.status;
    return new Response(botRes.body, { status, headers: resHeaders });
}

async function proxyBrandonComplete(request, env, origin) {
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeadersPermissive(origin) });
    }
    const baseUrl = await _resolveSenpaibotUrl(env);
    if (!baseUrl) {
        return errP('No se pudo resolver la URL del bot (railway_url.json).', 502, origin);
    }
    const body = await request.text();
    let botRes;
    try {
        botRes = await fetch(`${baseUrl}/api/f95-brandon-complete`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Brandon-Token': request.headers.get('X-Brandon-Token') || '',
            },
            body,
        });
    } catch (e) {
        console.error('[proxyBrandonComplete] Error de red hacia el bot:', e);
        return errP('Error de red hacia el bot', 502, origin);
    }
    const resHeaders = new Headers();
    resHeaders.set('Content-Type', botRes.headers.get('Content-Type') || 'application/json');
    Object.entries(corsHeadersPermissive(origin)).forEach(([k, v]) => resHeaders.set(k, v));
    // Same as proxyAiFill: keep the bot's JSON error visible (pendientes.js reads json.success).
    const status = (botRes.status >= 500 && resHeaders.get('Content-Type').includes('json')) ? 200 : botRes.status;
    return new Response(botRes.body, { status, headers: resHeaders });
}

async function proxyGithubPendientesBrandon(request, env, origin, opts = {}) {
    const botToken = !!opts.botToken;
    const targetApi = opts.targetApi || GITHUB_PENDIENTES_BRANDON_API;
    const token = (env && env.GITHUB_TOKEN) ? env.GITHUB_TOKEN.trim() : '';
    if (!token) {
        console.error('[proxyGithubPendientesBrandon] GITHUB_TOKEN no configurado en el Worker.');
        return errP('Proxy GitHub: token no configurado. Ejecutá: wrangler secret put GITHUB_TOKEN', 503, origin);
    }

    if (botToken) {
        const botSecret = (env && env.BOT_GITLAB_TOKEN) ? env.BOT_GITLAB_TOKEN.trim() : '';
        if (!botSecret) {
            console.error('[proxyGithubPendientesBrandon] BOT_GITLAB_TOKEN no configurado en el Worker.');
            return errP('Proxy GitHub (bot): token de bot no configurado. Ejecutá: wrangler secret put BOT_GITLAB_TOKEN', 503, origin);
        }
        if (request.headers.get('X-Bot-Token') !== botSecret) {
            return errP('No autorizado', 401, origin);
        }
    } else {
        const formEmail = await requireSession(request, env, 'form');
        if (!formEmail) return errP('Iniciá sesión en el formulario para hacer esta acción', 401, origin);
    }

    const ghHeaders = new Headers();
    ghHeaders.set('Authorization', `token ${token}`);
    ghHeaders.set('Accept', 'application/vnd.github+json');
    ghHeaders.set('User-Agent', 'eclipsezonehub-worker');
    const method = request.method.toUpperCase();
    if (method === 'PUT') ghHeaders.set('Content-Type', 'application/json');

    const ghReq = new Request(targetApi, {
        method,
        headers: ghHeaders,
        body: method === 'GET' ? undefined : request.body,
    });

    let ghRes;
    try {
        ghRes = await fetch(ghReq);
    } catch (e) {
        console.error('[proxyGithubPendientesBrandon] Error de red hacia GitHub:', e);
        return errP('Proxy GitHub: error de red', 502, origin);
    }

    const resHeaders = new Headers();
    resHeaders.set('Content-Type', ghRes.headers.get('Content-Type') || 'application/json');
    Object.entries(corsHeadersPermissive(origin)).forEach(([k, v]) => resHeaders.set(k, v));

    return new Response(ghRes.body, { status: ghRes.status, headers: resHeaders });
}

// ── Proxy + caché permanente de imágenes externas ────────────────────────
// GET /api/img?u=<url-encoded original image URL>
//
// La primera vez que se pide una URL se descarga del origen y se guarda en
// KV; a partir de ahí siempre se sirve desde KV. Así, aunque el link
// original expire (típico de las URLs firmadas de cdn.discordapp.com, que
// traen ?ex=...&is=...&hm=... y dejan de funcionar a las pocas horas) o lo
// borren de su hosting original, la imagen ya cacheada sigue funcionando.
//
// Para evitar que esto se use como proxy abierto (SSRF / abuso de ancho de
// banda), solo se aceptan hosts de imágenes conocidos y nunca IPs literales.
const IMG_ALLOWED_HOSTS = [
    'imgur.com', 'i.imgur.com', 'ibb.co', 'i.ibb.co', 'postimg.cc', 'i.postimg.cc',
    'imageshack.com', 'flickr.com', 'staticflickr.com', 'photobucket.com',
    'tinypic.com', 'imageshack.us', 'googleusercontent.com', 'blogspot.com',
    'bp.blogspot.com', 'drive.google.com',
    'dropbox.com', 'dropboxusercontent.com', 'images.unsplash.com', 'picsum.photos',
    'placekitten.com', 'via.placeholder.com', 'placehold.co',
    'f95zone.to', 'f95zone.com', 'attachments.f95zone.to',
    'imageban.ru', 'imagetwist.com', 'imgbb.com', 'prnt.sc', 'prntscr.com',
    'catbox.moe', 'litterbox.catbox.moe', 'files.catbox.moe',
    'steamuserimages-a.akamaihd.net', 'steamcdn-a.akamaihd.net',
    'vndb.org', 'zonaferoz.site',
    'itch.zone', 'img.itch.zone',
    'mangadex.org', 'uploads.mangadex.org',
    // Hosts de imágenes usados por noticias.json
    'eroeronews.com', 'en.eroeronews.com',
    'hentaila.com', 'cdn.hentaila.com',
    'wp.com',            // i0/i1/i2.wp.com (CDN de WordPress)
    'bing.com', 'th.bing.com',
    'pinimg.com', 'i.pinimg.com',
    // Discord — para poder rescatar imágenes YA publicadas mientras el link
    // firmado siga vivo. El formulario bloquea que se sigan agregando nuevas.
    'cdn.discordapp.com', 'media.discordapp.net',
];

function isAllowedImageHost(hostname) {
    const h = (hostname || '').toLowerCase();
    return IMG_ALLOWED_HOSTS.some(d => h === d || h.endsWith('.' + d));
}

// Algunos hosts (ej. f95zone) bloquean la descarga si el Referer no es el
// suyo propio ("hotlink protection") — sin esto, fetch() del Worker recibe
// 403 y la imagen nunca llega a cachearse.
const IMG_REFERER_MAP = {
    'f95zone.to':             'https://f95zone.to/',
    'attachments.f95zone.to': 'https://f95zone.to/',
    'f95zone.com':            'https://f95zone.to/',
    // Sin este Referer, MangaDex devuelve una imagen genérica
    // "You can read this at: MANGADEX" en vez de la portada real.
    'mangadex.org':           'https://mangadex.org/',
    'uploads.mangadex.org':   'https://mangadex.org/',
};

function refererFor(hostname) {
    const h = (hostname || '').toLowerCase();
    for (const domain in IMG_REFERER_MAP) {
        if (h === domain || h.endsWith('.' + domain)) return IMG_REFERER_MAP[domain];
    }
    return null;
}

function isIpLiteralHost(hostname) {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true; // IPv4
    if (hostname.includes(':')) return true;                    // IPv6
    return false;
}

async function sha256Hex(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Hosts cuyas URLs EXPIRAN (links firmados) — solo estos se persisten en KV,
// porque una vez muerto el link original no hay otra forma de recuperar la
// imagen. El resto de hosts (f95zone, mangadex, imgur…) tienen URLs estables:
// alcanza con el caché edge de Cloudflare (gratis) y re-descargar si expira.
// Esto reduce las escrituras de KV a casi cero (el plan free da 1000/día).
const IMG_KV_PERSIST_HOSTS = ['cdn.discordapp.com', 'media.discordapp.net'];

// Hosts para los que NUNCA se lee el caché KV viejo: MangaDex sirvió durante
// un tiempo la imagen genérica "You can read this at: MANGADEX" (por falta de
// Referer) y esos placeholders quedaron guardados de forma permanente en KV.
// Saltear KV para estos hosts equivale a purgar ese caché envenenado.
// NOTA: MangaDex además BLOQUEA los fetch hechos desde Cloudflare Workers
// (detecta el header CF-Worker → 400), así que el frontend carga las
// portadas directo con referrerpolicy="no-referrer" (ver js/manga.js) y
// esta ruta queda solo como respaldo/caché.
const IMG_KV_SKIP_HOSTS = ['mangadex.org', 'uploads.mangadex.org'];

function _hostMatches(hostname, list) {
    const h = (hostname || '').toLowerCase();
    return list.some(d => h === d || h.endsWith('.' + d));
}

async function proxyImage(request, url, env, origin, ctx) {
    const kv  = env && env.EZ_DATA;
    const src = url.searchParams.get('u') || '';
    // &format=jpeg: opt-in, solo para og:image (Discord/Twitter/Facebook no
    // renderizan preview de link si la imagen es AVIF). El resto del sitio no
    // manda este parámetro y sigue recibiendo el Content-Type del origen tal
    // cual (AVIF es preferible ahí por peso). No comparte caché con la
    // variante normal — ver dataKey/metaKey más abajo.
    const forceJpeg = url.searchParams.get('format') === 'jpeg';

    let parsed;
    try { parsed = new URL(src); } catch { return err('URL inválida', 400, origin); }

    if (!/^https?:$/.test(parsed.protocol))   return err('Protocolo no soportado', 400, origin);
    if (isIpLiteralHost(parsed.hostname))     return err('Host no permitido', 400, origin);
    if (!isAllowedImageHost(parsed.hostname)) return err('Host de imagen no permitido', 400, origin);

    // 0. Caché edge de Cloudflare (gratis, no consume cuota de KV).
    //    La clave incluye la URL completa del request (con ?u= y ?v=), así
    //    que subir la versión en el frontend invalida automáticamente.
    let edgeCache = null, edgeKey = null;
    try {
        edgeCache = caches.default;
        edgeKey   = new Request(url.toString(), { method: 'GET' });
        const hit = await edgeCache.match(edgeKey);
        if (hit) {
            const res = new Response(hit.body, hit);
            Object.entries(corsHeadersPermissive(origin)).forEach(([k, v]) => res.headers.set(k, v));
            return res;
        }
    } catch { /* Cache API no disponible — seguir sin edge cache */ }

    const hash    = await sha256Hex(forceJpeg ? `${src}|jpeg` : src);
    const dataKey = `imgcache:${hash}`;
    const metaKey = `imgcache:${hash}:meta`;
    const skipKv  = _hostMatches(parsed.hostname, IMG_KV_SKIP_HOSTS);

    // Para MangaDex el caché es de 1 día (no "immutable" de 1 año): si el
    // origen llegara a servir el placeholder de hotlink, se auto-corrige solo
    // en vez de quedar envenenado permanentemente en navegadores y edge.
    const cacheControl = skipKv
        ? 'public, max-age=86400'
        : 'public, max-age=31536000, immutable';

    function buildImageResponse(bytes, contentType) {
        return new Response(bytes, {
            status: 200,
            headers: {
                'Content-Type':  contentType || 'application/octet-stream',
                'Cache-Control': cacheControl,
                ...corsHeadersPermissive(origin),
            },
        });
    }

    // Guarda en el caché edge sin bloquear la respuesta.
    function saveToEdge(res) {
        if (!edgeCache || !edgeKey) return;
        try {
            const p = edgeCache.put(edgeKey, res.clone());
            if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p);
        } catch { /* best-effort */ }
    }

    // 1. Servir desde KV si ya la tenemos (best-effort: un fallo de KV
    //    nunca debe tirar 500 — se sigue al origen).
    if (kv && !skipKv) {
        try {
            const meta = await kvGet(kv, metaKey);
            if (meta) {
                const cached = await kv.get(dataKey, 'arrayBuffer');
                if (cached) {
                    const res = buildImageResponse(cached, meta.contentType);
                    saveToEdge(res);
                    return res;
                }
            }
        } catch (e) {
            console.warn('[proxyImage] KV read falló (se ignora):', e && e.message);
        }
    }

    // 2. No está cacheada — descargarla ahora (puede ser la última vez que el link funcione)
    const fetchHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    };
    const knownReferer = refererFor(parsed.hostname);
    if (knownReferer) fetchHeaders['Referer'] = knownReferer;

    const cfImageOpts = forceJpeg ? { image: { format: 'jpeg', quality: 85 } } : undefined;

    let originRes;
    try {
        originRes = await fetch(parsed.toString(), { headers: fetchHeaders, cf: cfImageOpts });
    } catch (e) {
        return err('No se pudo descargar la imagen original', 502, origin);
    }

    // Reintento con Referer propio del host: cubre hosts con protección
    // anti-hotlink que no están en IMG_REFERER_MAP (la mayoría solo exige
    // que el Referer pertenezca a su propio dominio, no uno exacto).
    if (!originRes.ok && (originRes.status === 403 || originRes.status === 401) && !knownReferer) {
        try {
            originRes = await fetch(parsed.toString(), {
                headers: { ...fetchHeaders, 'Referer': `${parsed.protocol}//${parsed.hostname}/` },
            });
        } catch { /* mantener el error original */ }
    }

    // Reintento SIN Referer: algunos CDNs (uploads.mangadex.org) devuelven
    // 400/403 cuando una IP de datacenter manda un Referer de su propio
    // dominio (lo consideran spoofing). Sin Referer, la petición parece un
    // acceso directo y sirven la imagen real.
    if (!originRes.ok && originRes.status >= 400 && originRes.status < 500 && knownReferer) {
        try {
            const bare = { ...fetchHeaders };
            delete bare['Referer'];
            const retry = await fetch(parsed.toString(), { headers: bare });
            if (retry.ok) originRes = retry;
        } catch { /* mantener el error original */ }
    }

    if (!originRes.ok) {
        // &debug=1 → devuelve detalle del error del origen (diagnóstico)
        if (url.searchParams.get('debug') === '1') {
            let bodySnippet = '';
            try { bodySnippet = (await originRes.text()).slice(0, 300); } catch {}
            return json({
                ok: false,
                originStatus: originRes.status,
                originContentType: originRes.headers.get('Content-Type') || '',
                originServer: originRes.headers.get('Server') || '',
                bodySnippet,
            }, 502, origin);
        }
        return err(`La imagen original respondió ${originRes.status}`, 502, origin);
    }

    const contentType = originRes.headers.get('Content-Type') || '';
    if (!contentType.startsWith('image/')) {
        return err('El recurso no es una imagen', 400, origin);
    }

    const bytes = await originRes.arrayBuffer();
    if (bytes.byteLength > 15 * 1024 * 1024) {
        return err('Imagen demasiado grande para cachear', 413, origin);
    }

    // 3. Persistir en KV SOLO los hosts cuyos links expiran (Discord).
    //    Best-effort: si la cuota de escrituras está agotada, igual servimos.
    if (kv && _hostMatches(parsed.hostname, IMG_KV_PERSIST_HOSTS)) {
        try {
            await kv.put(dataKey, bytes);
            await kvSet(kv, metaKey, { contentType, cachedAt: new Date().toISOString(), source: src });
        } catch (e) {
            console.warn('[proxyImage] KV write falló (se ignora):', e && e.message);
        }
    }

    const res = buildImageResponse(bytes, contentType);
    saveToEdge(res);
    return res;
}

// ── Hashing de contraseñas (PBKDF2-SHA256 vía Web Crypto) ────────────────
// Formato almacenado: pbkdf2$<iteraciones>$<saltHex>$<hashHex>
const PBKDF2_ITERATIONS = 100_000;

function _bufToHex(buf) {
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function _hexToBuf(hex) {
    const arr = new Uint8Array(hex.length / 2);
    for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 2, 2), 16);
    return arr;
}

async function _deriveHash(password, salt, iterations) {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
        keyMaterial,
        256
    );
    return _bufToHex(bits);
}

async function hashPassword(password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hashHex = await _deriveHash(password, salt, PBKDF2_ITERATIONS);
    return `pbkdf2$${PBKDF2_ITERATIONS}$${_bufToHex(salt)}$${hashHex}`;
}

function _timingSafeEqual(a, b) {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

// Verifica la contraseña contra el hash almacenado. Soporta el esquema legado
// (Base64 reversible, usado por versiones anteriores del cliente) solo para
// no romper el login de cuentas existentes — se migra a PBKDF2 en loginAccount().
async function verifyPassword(password, stored) {
    if (!stored) return false;
    if (stored.startsWith('pbkdf2$')) {
        const [, iterStr, saltHex, hashHex] = stored.split('$');
        const iterations = parseInt(iterStr, 10);
        const salt = _hexToBuf(saltHex);
        const candidateHex = await _deriveHash(password, salt, iterations);
        return _timingSafeEqual(candidateHex, hashHex);
    }
    // Esquema legado: btoa(encodeURIComponent(password + 's3cr3t_s4lt'))
    const legacy = btoa(encodeURIComponent(password + 's3cr3t_s4lt'));
    return _timingSafeEqual(legacy, stored);
}

// ── Token de sesión firmado (solo para /api/patreon/*) ───────────────────
// El resto del sitio (amigos, DMs, comentarios) confía en lo que el propio
// navegador dice ser (localStorage), sin verificación de servidor — un
// usuario puede poner el email de otra persona en localStorage y el sitio
// se lo cree. Para el estado de Patreon eso es un problema real: alguien
// podría "heredar" gratis el acceso de un mecenas real solo con eso.
//
// Este token SÍ está firmado (HMAC-SHA256 con el secret SESSION_SECRET, que
// nunca sale del Worker). loginAccount/registerAccount lo devuelven junto al
// user; el frontend lo manda como "Authorization: Bearer <token>" en las
// rutas /api/patreon/*, que son las ÚNICAS que lo exigen — no toca ni rompe
// nada del resto del sitio.
const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 días — igual que SESSION_DURATION en auth.js

function _b64urlEncode(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function _b64urlDecode(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    const bin = atob(str);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

async function _hmacKey(secret) {
    return crypto.subtle.importKey(
        'raw', new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']
    );
}

// Devuelve null si SESSION_SECRET no está configurado — así el resto del
// código puede tratar "sin token" como "función de Patreon no disponible
// todavía" en vez de romper el login.
// `scope` separa dos poblaciones distintas de usuarios que NO deben heredar
// permisos entre sí (2026-07-29):
//   'site' → cuentas del sitio público (usuarios_cuenta.json). Patreon, perfil.
//   'form' → cuentas del formulario de carga (cuenta.json). Escribe juegos.json,
//            noticias.json y el calendario vía /api/gl-auth/*.
// Sin esto, cualquier lector registrado del sitio podría editar el catálogo.
// Los tokens emitidos antes de este cambio no traen `scope`; se tratan como
// 'site' para no invalidar sesiones ya activas.
async function signSessionToken(email, env, scope = 'site') {
    const secret = env && env.SESSION_SECRET;
    if (!secret) return null;
    const payload    = JSON.stringify({ email, scope, exp: Date.now() + SESSION_DURATION_MS });
    const payloadB64 = _b64urlEncode(new TextEncoder().encode(payload));
    const key        = await _hmacKey(secret);
    const sig        = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64));
    return `${payloadB64}.${_b64urlEncode(new Uint8Array(sig))}`;
}

// Devuelve el email si el token es válido y no expiró; null en cualquier
// otro caso (firma inválida, formato raro, expirado, sin secret).
async function verifySessionToken(token, env, requiredScope = 'site') {
    const secret = env && env.SESSION_SECRET;
    if (!secret || !token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [payloadB64, sigB64] = parts;
    try {
        const key   = await _hmacKey(secret);
        const valid = await crypto.subtle.verify(
            'HMAC', key, _b64urlDecode(sigB64), new TextEncoder().encode(payloadB64)
        );
        if (!valid) return null;
        const payload = JSON.parse(new TextDecoder().decode(_b64urlDecode(payloadB64)));
        if (!payload.email || !payload.exp || Date.now() > payload.exp) return null;
        // Tokens viejos (pre-2026-07-29) no traen scope → valen como 'site'.
        if ((payload.scope || 'site') !== requiredScope) return null;
        return payload.email;
    } catch (e) {
        return null;
    }
}

// Extrae y valida el Bearer token del header Authorization. Devuelve el
// email o null. `scope` debe coincidir con el del token (ver signSessionToken).
async function requireSession(request, env, scope = 'site') {
    const auth = request.headers.get('Authorization') || '';
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return null;
    return verifySessionToken(m[1], env, scope);
}

// ── Cuentas de usuario — almacenadas como JSON en GitLab ─────────────────
// El token GITLAB_TOKEN nunca sale del Worker (secret de servidor).
const ACCOUNT_PROJECT_ID = '81192889';       // eclipse1482609/cuenta-usuarios
const ACCOUNT_FILE_PATH  = 'usuarios_cuenta.json';
const GL_API_BASE        = 'https://gitlab.com/api/v4/projects';

async function glLoadAccounts(env) {
    const token = (env && env.GITLAB_TOKEN) ? env.GITLAB_TOKEN.trim() : '';
    if (!token) throw new Error('GITLAB_TOKEN no configurado');

    const res = await fetch(
        `${GL_API_BASE}/${ACCOUNT_PROJECT_ID}/repository/files/${encodeURIComponent(ACCOUNT_FILE_PATH)}?ref=main`,
        { headers: { 'PRIVATE-TOKEN': token } }
    );
    if (!res.ok) return [];

    const data    = await res.json();
    const content = decodeURIComponent(escape(atob(data.content)));
    return content.trim() ? JSON.parse(content) : [];
}

async function glSaveAccounts(env, accounts) {
    const token = (env && env.GITLAB_TOKEN) ? env.GITLAB_TOKEN.trim() : '';
    if (!token) throw new Error('GITLAB_TOKEN no configurado');

    const encodedPath = encodeURIComponent(ACCOUNT_FILE_PATH);
    const jsonString  = JSON.stringify(accounts, null, 2);
    const MAX_RETRIES = 3;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const checkRes = await fetch(
            `${GL_API_BASE}/${ACCOUNT_PROJECT_ID}/repository/files/${encodedPath}?ref=main`,
            { headers: { 'PRIVATE-TOKEN': token } }
        );

        // Archivo no existe → crear
        if (!checkRes.ok) {
            const commitRes = await fetch(
                `${GL_API_BASE}/${ACCOUNT_PROJECT_ID}/repository/commits`,
                {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json', 'PRIVATE-TOKEN': token },
                    body: JSON.stringify({
                        branch: 'main',
                        commit_message: 'Crear archivo de cuentas',
                        actions: [{ action: 'create', file_path: ACCOUNT_FILE_PATH, content: jsonString }],
                    }),
                }
            );
            return commitRes.ok;
        }

        // Archivo existe → actualizar con last_commit_id fresco
        const fileData = await checkRes.json();
        const putRes = await fetch(
            `${GL_API_BASE}/${ACCOUNT_PROJECT_ID}/repository/files/${encodedPath}`,
            {
                method:  'PUT',
                headers: { 'Content-Type': 'application/json', 'PRIVATE-TOKEN': token },
                body: JSON.stringify({
                    branch: 'main',
                    content: jsonString,
                    commit_message: 'Actualización de cuentas',
                    last_commit_id: fileData.last_commit_id,
                }),
            }
        );

        if (putRes.ok) return true;

        // SHA desactualizado → reintentar con datos frescos
        if (putRes.status === 400 && attempt < MAX_RETRIES - 1) {
            await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
            continue;
        }
        return false;
    }
    return false;
}

// POST /api/register  { name, email, password }
async function registerAccount(request, env, origin) {
    const data     = await request.json().catch(() => ({}));
    const name     = (data.name     || '').trim();
    const email    = (data.email    || '').trim().toLowerCase();
    const password = data.password  || '';

    if (!name || !email || !password) return err('Faltan parámetros', 400, origin);
    if (name.length > MAX_USERNAME_LEN) return err(`El nombre no puede superar ${MAX_USERNAME_LEN} caracteres`, 400, origin);
    if (email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err('Correo electrónico no válido', 400, origin);
    if (password.length < 6 || password.length > 200) return err('La contraseña debe tener entre 6 y 200 caracteres', 400, origin);

    let accounts;
    try {
        accounts = await glLoadAccounts(env);
    } catch (e) {
        console.error('[registerAccount] Error al leer cuentas:', e);
        return err('Error al conectar con el almacenamiento de cuentas', 502, origin);
    }

    if (accounts.some(a => (a.email || '').toLowerCase() === email)) {
        return err('Este correo ya está registrado', 409, origin);
    }

    const newAccount = {
        email,
        password      : await hashPassword(password),
        nombre        : name,
        avatar        : '',
        banner        : '',
        bio           : '',
        fechaRegistro : new Date().toISOString().split('T')[0],
        ultimoAcceso  : null,
        emailVerificado: false,
    };
    accounts.push(newAccount);

    const saved = await glSaveAccounts(env, accounts);
    if (!saved) return err('Error al registrar. Intentá de nuevo.', 500, origin);

    // La verificación es informativa, no bloqueante: la cuenta ya queda
    // usable (sessionToken de una) — el mail solo confirma que el correo es
    // real, no es una puerta para poder entrar al sitio.
    sendVerificationEmail(env, email).catch(e => console.error('[registerAccount] email verificación:', e));

    const { password: _pw, ...safeUser } = newAccount;
    const sessionToken = await signSessionToken(email, env);
    return json({ ok: true, user: safeUser, sessionToken }, 200, origin);
}

const EMAIL_VERIFY_TTL_SECONDS = 24 * 60 * 60; // 24 horas
const EMAIL_VERIFY_URL = 'https://eclipsezonehub.com/?verifyToken=';

async function sendVerificationEmail(env, email) {
    const token = _randomToken();
    await kvSet(env.EZ_DATA, `emailverify:${token}`, { email }, EMAIL_VERIFY_TTL_SECONDS);
    const link = EMAIL_VERIFY_URL + token;
    return sendEmail(env, {
        to: email,
        subject: 'Confirmá tu correo — Eclipse Zone',
        html: `
            <p>¡Gracias por registrarte en Eclipse Zone!</p>
            <p><a href="${link}">Hacé clic acá para confirmar tu correo</a> (válido por 24 horas).</p>
            <p>Si no fuiste vos, podés ignorar este correo.</p>
        `,
    });
}

// POST /api/verify-email  { token }
async function verifyEmail(request, env, origin) {
    const data  = await request.json().catch(() => ({}));
    const token = (data.token || '').trim();
    if (!token) return err('Falta el token', 400, origin);

    const entry = await kvGet(env.EZ_DATA, `emailverify:${token}`);
    if (!entry || !entry.email) return err('Este link ya no es válido. Volvé a pedirlo desde tu perfil.', 400, origin);

    let accounts;
    try { accounts = await glLoadAccounts(env); } catch (e) { return err('Error al conectar con el almacenamiento de cuentas', 502, origin); }

    const idx = accounts.findIndex(a => (a.email || '').toLowerCase() === entry.email.toLowerCase());
    if (idx === -1) return err('No se encontró la cuenta', 404, origin);

    accounts[idx].emailVerificado = true;
    const saved = await glSaveAccounts(env, accounts);
    if (!saved) return err('Error al confirmar. Intentá de nuevo.', 500, origin);

    await kvDelete(env.EZ_DATA, `emailverify:${token}`);
    return json({ ok: true }, 200, origin);
}

// POST /api/resend-verification — Authorization: Bearer <sessionToken>
// El rate limit por IP (ver dispatcher, 'resend_verification') ya cubre el
// abuso — no hace falta un segundo límite por email acá.
async function resendVerification(request, env, origin) {
    const email = await requireSession(request, env);
    if (!email) return err('Iniciá sesión en Eclipse Zone', 401, origin);

    const sent = await sendVerificationEmail(env, email);
    if (!sent) return err('No se pudo enviar el correo. Intentá más tarde.', 502, origin);
    return json({ ok: true }, 200, origin);
}

// POST /api/login  { email, password }
// CORS permisivo: además del sitio principal, esto lo llama el formulario
// (formulario-juegos-09f976.gitlab.io) para la reautenticación de sitio del
// link exclusivo — no depende del origen para su seguridad (password +
// sessionToken de scope 'site' devuelto, igual razonamiento que jsonP/errP
// más arriba).
async function loginAccount(request, env, origin) {
    const data     = await request.json().catch(() => ({}));
    const email    = (data.email    || '').trim().toLowerCase();
    const password = data.password  || '';

    if (!email || !password) return errP('Faltan parámetros', 400, origin);
    if (email.length > 120 || password.length > 200) return errP('Parámetros inválidos', 400, origin);

    let accounts;
    try {
        accounts = await glLoadAccounts(env);
    } catch (e) {
        console.error('[loginAccount] Error al leer cuentas:', e);
        return errP('Error al conectar con el almacenamiento de cuentas', 502, origin);
    }

    const idx = accounts.findIndex(a => (a.email || '').toLowerCase() === email);
    if (idx === -1) return jsonP({ ok: false, error: 'Correo o contraseña incorrectos' }, 200, origin);

    const account = accounts[idx];
    const valid   = await verifyPassword(password, account.password);
    if (!valid) return jsonP({ ok: false, error: 'Correo o contraseña incorrectos' }, 200, origin);

    // Migración transparente del esquema legado (Base64) a PBKDF2 real
    if (!account.password.startsWith('pbkdf2$')) {
        account.password = await hashPassword(password);
    }
    account.ultimoAcceso = new Date().toISOString();

    // Best-effort: si falla el guardado, igual dejamos entrar al usuario ya autenticado
    await glSaveAccounts(env, accounts).catch(e => console.error('[loginAccount] Error al guardar:', e));

    const { password: _pw, ...safeUser } = account;
    const sessionToken = await signSessionToken(email, env);
    return jsonP({ ok: true, user: safeUser, sessionToken }, 200, origin);
}

// ── Cuentas del FORMULARIO de carga (proyecto aparte del sitio) ──────────
const FORM_ACCOUNT_PROJECT_ID = '77157664';
const FORM_ACCOUNT_FILE_PATH  = 'cuenta.json';

async function glLoadFormAccounts(env) {
    const token = (env && env.GITLAB_TOKEN) ? env.GITLAB_TOKEN.trim() : '';
    if (!token) throw new Error('GITLAB_TOKEN no configurado');
    const res = await fetch(
        `${GL_API_BASE}/${FORM_ACCOUNT_PROJECT_ID}/repository/files/${encodeURIComponent(FORM_ACCOUNT_FILE_PATH)}?ref=main`,
        { headers: { 'PRIVATE-TOKEN': token } }
    );
    if (!res.ok) return [];
    const data    = await res.json();
    const content = decodeURIComponent(escape(atob(data.content)));
    return content.trim() ? JSON.parse(content) : [];
}

// POST /api/form/login  { email, password } → { user, sessionToken }
// El formulario de carga necesitaba leer cuenta.json (con las contraseñas)
// para validar el login del lado del cliente, y para eso llevaba un token de
// GitLab en su JS público. Acá la validación pasa server-side y el formulario
// solo recibe un sessionToken de scope 'form'.
async function formLogin(request, env, origin) {
    const data     = await request.json().catch(() => ({}));
    const email    = (data.email    || '').trim().toLowerCase();
    const password = data.password  || '';

    if (!email || !password) return errP('Faltan parámetros', 400, origin);
    if (email.length > 120 || password.length > 200) return errP('Parámetros inválidos', 400, origin);

    let accounts;
    try {
        accounts = await glLoadFormAccounts(env);
    } catch (e) {
        console.error('[formLogin] Error al leer cuentas:', e);
        return errP('Error al conectar con el almacenamiento de cuentas', 502, origin);
    }

    const account = accounts.find(a => (a.email || '').toLowerCase() === email);
    if (!account) return jsonP({ ok: false, error: 'Correo o contraseña incorrectos' }, 200, origin);

    const valid = await verifyPassword(password, account.password);
    if (!valid) return jsonP({ ok: false, error: 'Correo o contraseña incorrectos' }, 200, origin);

    const { password: _pw, ...safeUser } = account;

    // Baneados y no confirmados NO reciben token. El formulario ya mostraba
    // estos avisos, pero eran chequeos de cliente: con un token en la mano,
    // cualquiera podía saltarse la UI y escribir juegos.json directo por
    // /api/gl-auth/*. La decisión tiene que vivir acá.
    if (account.banned) {
        return jsonP({ ok: false, error: '⛔ Tu cuenta ha sido suspendida. Contactá al administrador para más información.', user: safeUser }, 200, origin);
    }
    if (!account.confirmado) {
        return jsonP({ ok: false, error: 'Tu cuenta aún no fue confirmada por el administrador. Esperá a que se active tu acceso.', user: safeUser }, 200, origin);
    }

    const sessionToken = await signSessionToken(email, env, 'form');
    return jsonP({ ok: true, user: safeUser, sessionToken }, 200, origin);
}

async function glSaveFormAccounts(env, accounts) {
    const token = (env && env.GITLAB_TOKEN) ? env.GITLAB_TOKEN.trim() : '';
    if (!token) throw new Error('GITLAB_TOKEN no configurado');
    const encodedPath = encodeURIComponent(FORM_ACCOUNT_FILE_PATH);
    const jsonString  = JSON.stringify(accounts, null, 2);

    const checkRes = await fetch(
        `${GL_API_BASE}/${FORM_ACCOUNT_PROJECT_ID}/repository/files/${encodedPath}?ref=main`,
        { headers: { 'PRIVATE-TOKEN': token } }
    );
    if (!checkRes.ok) return false;
    const fileData = await checkRes.json();

    const putRes = await fetch(
        `${GL_API_BASE}/${FORM_ACCOUNT_PROJECT_ID}/repository/files/${encodedPath}`,
        {
            method:  'PUT',
            headers: { 'Content-Type': 'application/json', 'PRIVATE-TOKEN': token },
            body: JSON.stringify({
                branch: 'main',
                content: jsonString,
                commit_message: 'Actualización de cuentas',
                last_commit_id: fileData.last_commit_id,
            }),
        }
    );
    return putRes.ok;
}

// POST /api/form/register  { name, email, password }
// Registrarse es el único caso donde hace falta escribir cuenta.json SIN
// sesión previa (huevo y gallina), así que va por su propio endpoint en vez
// de /api/gl-auth/*. La cuenta nace con confirmado:false, igual que antes.
async function formRegister(request, env, origin) {
    const data     = await request.json().catch(() => ({}));
    const name     = (data.name     || '').trim();
    const email    = (data.email    || '').trim().toLowerCase();
    const password = data.password  || '';

    if (!name || !email || !password) return errP('Faltan parámetros', 400, origin);
    if (name.length > MAX_USERNAME_LEN) return errP(`El nombre no puede superar ${MAX_USERNAME_LEN} caracteres`, 400, origin);
    if (email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return errP('Correo electrónico no válido', 400, origin);
    if (password.length < 6 || password.length > 200) return errP('La contraseña debe tener entre 6 y 200 caracteres', 400, origin);

    let accounts;
    try {
        accounts = await glLoadFormAccounts(env);
    } catch (e) {
        console.error('[formRegister] Error al leer cuentas:', e);
        return errP('Error al conectar con el almacenamiento de cuentas', 502, origin);
    }

    if (accounts.some(a => (a.email || '').toLowerCase() === email)) {
        return jsonP({ ok: false, error: 'Este correo ya está registrado' }, 200, origin);
    }

    accounts.push({
        email,
        password: await hashPassword(password),
        nombre: name,
        confirmado: false,
        banned: false,
        strikes: 0,
        strikesLog: [],
        fechaRegistro: new Date().toISOString().split('T')[0],
        ultimoAcceso: null,
        totalJuegos: 0,
        ultimaContribucion: null,
        juegosHoy: null,
    });

    const saved = await glSaveFormAccounts(env, accounts);
    if (!saved) return errP('Error al registrar. Intentá de nuevo.', 500, origin);
    return jsonP({ ok: true }, 200, origin);
}

// ── RECUPERAR CONTRASEÑA ──────────────────────────────────────────────────
// Dos poblaciones de cuentas ('site' = usuarios_cuenta.json del sitio,
// 'form' = cuenta.json del formulario) comparten el mismo flujo: pedís el
// reset con tu email, te llega un link de un solo uso (1h) con un token
// random guardado en KV, y ese link te deja poner una contraseña nueva.
//
// CORS permisivo (jsonP/errP) en las dos rutas: el pedido puede venir tanto
// de eclipsezonehub.com como de formulario-juegos-09f976.gitlab.io — mismo
// motivo que /api/form/login (ver eclipse-zone-infra).
const PWRESET_TTL_SECONDS = 60 * 60; // 1 hora
const PWRESET_SITE_URL = 'https://eclipsezonehub.com/?resetToken=';
const PWRESET_FORM_URL = 'https://formulario-juegos-09f976.gitlab.io/?resetToken=';

function _randomToken() {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    return _bufToHex(bytes);
}

// Envía un email vía Resend. Usa el remitente de pruebas onboarding@resend.dev
// (Resend permite mandar a cualquier destinatario con ese remitente, sin
// verificar dominio propio) — sirve para arrancar; se puede migrar a un
// remitente con el dominio propio (ej. noreply@eclipsezonehub.com) más
// adelante verificando el dominio en el panel de Resend.
async function sendEmail(env, { to, subject, html }) {
    const apiKey = env && env.RESEND_API_KEY;
    if (!apiKey) {
        console.error('[sendEmail] RESEND_API_KEY no configurado en el Worker.');
        return false;
    }
    try {
        const res = await fetch('https://api.resend.com/emails', {
            method:  'POST',
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                from:    'Eclipse Zone <onboarding@resend.dev>',
                to:      [to],
                subject,
                html,
            }),
        });
        if (!res.ok) {
            console.error('[sendEmail] Resend respondió', res.status, await res.text().catch(() => ''));
            return false;
        }
        return true;
    } catch (e) {
        console.error('[sendEmail] Error de red:', e);
        return false;
    }
}

// POST /api/password-reset/request  { email, system: 'site'|'form' }
// SIEMPRE responde ok:true con el mismo mensaje genérico, exista o no la
// cuenta — si no, alguien podría usar este endpoint para averiguar qué
// emails están registrados (account enumeration).
async function passwordResetRequest(request, env, origin) {
    const data   = await request.json().catch(() => ({}));
    const email  = (data.email  || '').trim().toLowerCase();
    const system = data.system === 'form' ? 'form' : 'site';
    const generic = { ok: true, message: 'Si ese correo está registrado, te enviamos un link para restablecer tu contraseña.' };

    if (!email || email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return errP('Correo electrónico no válido', 400, origin);
    }

    let accounts;
    try {
        accounts = system === 'form' ? await glLoadFormAccounts(env) : await glLoadAccounts(env);
    } catch (e) {
        console.error('[passwordResetRequest] Error al leer cuentas:', e);
        return jsonP(generic, 200, origin); // no revelar el error interno tampoco
    }

    const account = accounts.find(a => (a.email || '').toLowerCase() === email);
    if (account) {
        const token = _randomToken();
        await kvSet(env.EZ_DATA, `pwreset:${token}`, { email, system }, PWRESET_TTL_SECONDS);
        const link = (system === 'form' ? PWRESET_FORM_URL : PWRESET_SITE_URL) + token;
        await sendEmail(env, {
            to: email,
            subject: 'Restablecer tu contraseña — Eclipse Zone',
            html: `
                <p>Pediste restablecer tu contraseña${system === 'form' ? ' del formulario de carga' : ''} de Eclipse Zone.</p>
                <p><a href="${link}">Hacé clic acá para poner una contraseña nueva</a> (válido por 1 hora).</p>
                <p>Si no fuiste vos, ignorá este correo — tu contraseña actual sigue funcionando.</p>
            `,
        });
    }
    // Igual si no existe la cuenta: mismo tiempo de respuesta aproximado y
    // mismo mensaje, para no delatar por timing si el email está registrado.
    return jsonP(generic, 200, origin);
}

// POST /api/password-reset/confirm  { token, newPassword }
async function passwordResetConfirm(request, env, origin) {
    const data        = await request.json().catch(() => ({}));
    const token       = (data.token || '').trim();
    const newPassword = data.newPassword || '';

    if (!token) return errP('Falta el token', 400, origin);
    if (newPassword.length < 6 || newPassword.length > 200) {
        return errP('La contraseña debe tener entre 6 y 200 caracteres', 400, origin);
    }

    const entry = await kvGet(env.EZ_DATA, `pwreset:${token}`);
    if (!entry || !entry.email) {
        return errP('Este link ya no es válido. Pedí uno nuevo.', 400, origin);
    }

    const { email, system } = entry;
    let accounts;
    try {
        accounts = system === 'form' ? await glLoadFormAccounts(env) : await glLoadAccounts(env);
    } catch (e) {
        console.error('[passwordResetConfirm] Error al leer cuentas:', e);
        return errP('Error al conectar con el almacenamiento de cuentas', 502, origin);
    }

    const idx = accounts.findIndex(a => (a.email || '').toLowerCase() === email.toLowerCase());
    if (idx === -1) return errP('No se encontró la cuenta asociada a este link', 404, origin);

    accounts[idx].password = await hashPassword(newPassword);

    const saved = system === 'form'
        ? await glSaveFormAccounts(env, accounts)
        : await glSaveAccounts(env, accounts);
    if (!saved) return errP('Error al guardar la nueva contraseña. Intentá de nuevo.', 500, origin);

    // Token de un solo uso: se borra tanto si se usó bien como para que no
    // quede reutilizable si algo raro pasó en el guardado.
    await kvDelete(env.EZ_DATA, `pwreset:${token}`);

    return jsonP({ ok: true }, 200, origin);
}

// ── ADMIN DEL FORMULARIO ──────────────────────────────────────────────────
// El panel de admin (banear, confirmar, strikes, límite diario) usaba
// isAdminUser() del lado del cliente (compara currentUser.email) para decidir
// si MOSTRAR los botones — pero las acciones en sí pegaban directo a
// /api/gl-auth/* con cualquier sesión 'form' válida, sin verificar que fuera
// realmente el admin. Cualquier traductor confirmado podía banear/confirmar
// cuentas ajenas o leer el array completo (con contraseñas en base64) desde
// la consola del navegador. Fix 2026-07-29: la decisión de "sos admin" pasa
// a vivir acá, server-side, antes de tocar cuenta.json.
const FORM_ADMIN_EMAIL = 'senpai1940@gmail.com';

async function requireFormAdmin(request, env) {
    const email = await requireSession(request, env, 'form');
    if (!email || email.toLowerCase() !== FORM_ADMIN_EMAIL) return null;
    return email;
}

// GET /api/form/admin/accounts — lista completa de cuentas del formulario,
// SIN password, solo para el admin.
async function getFormAdminAccounts(request, env, origin) {
    const admin = await requireFormAdmin(request, env);
    if (!admin) return errP('No autorizado', 403, origin);

    let accounts;
    try {
        accounts = await glLoadFormAccounts(env);
    } catch (e) {
        console.error('[getFormAdminAccounts] Error al leer cuentas:', e);
        return errP('Error al conectar con el almacenamiento de cuentas', 502, origin);
    }
    return jsonP(accounts.map(({ password: _pw, ...safe }) => safe), 200, origin);
}

// POST /api/form/admin/action  { action, email, razon?, newLimit? }
// action: 'add_strike' | 'remove_strike' | 'ban' | 'unban' | 'confirm' | 'set_limit'
async function formAdminAction(request, env, origin) {
    const admin = await requireFormAdmin(request, env);
    if (!admin) return errP('No autorizado', 403, origin);

    const data       = await request.json().catch(() => ({}));
    const action     = data.action || '';
    const email      = (data.email || '').trim().toLowerCase();
    const VALID_ACTIONS = ['add_strike', 'remove_strike', 'ban', 'unban', 'confirm', 'set_limit'];
    if (!email || !VALID_ACTIONS.includes(action)) return errP('Parámetros inválidos', 400, origin);

    let accounts;
    try {
        accounts = await glLoadFormAccounts(env);
    } catch (e) {
        console.error('[formAdminAction] Error al leer cuentas:', e);
        return errP('Error al conectar con el almacenamiento de cuentas', 502, origin);
    }

    const idx = accounts.findIndex(a => (a.email || '').toLowerCase() === email);
    if (idx === -1) return errP('Cuenta no encontrada', 404, origin);
    const acc = accounts[idx];

    switch (action) {
        case 'add_strike': {
            const razon = (data.razon || 'Sin especificar').toString().slice(0, 200);
            acc.strikes = (acc.strikes || 0) + 1;
            if (!acc.strikesLog) acc.strikesLog = [];
            acc.strikesLog.push({ fecha: new Date().toISOString().split('T')[0], razon, tipo: 'admin' });
            break;
        }
        case 'remove_strike':
            acc.strikes = Math.max(0, (acc.strikes || 0) - 1);
            break;
        case 'ban':
            acc.banned    = true;
            acc.banRazon  = (data.razon || 'Sin especificar').toString().slice(0, 200);
            acc.banFecha  = new Date().toISOString().split('T')[0];
            break;
        case 'unban':
            acc.banned   = false;
            acc.banRazon = null;
            break;
        case 'confirm':
            acc.confirmado = true;
            break;
        case 'set_limit': {
            const newLimit = parseInt(data.newLimit, 10);
            if (!Number.isFinite(newLimit) || newLimit < 1 || newLimit > 100) {
                return errP('Límite inválido. Debe ser un número entre 1 y 100.', 400, origin);
            }
            acc.limitesDiario = newLimit;
            break;
        }
    }

    const saved = await glSaveFormAccounts(env, accounts);
    if (!saved) return errP('Error al guardar. Intentá de nuevo.', 500, origin);
    return jsonP({ ok: true }, 200, origin);
}

// GET /api/accounts/public — lista completa de cuentas SIN password. Único
// reemplazo válido para lo que antes leía usuarios_cuenta.json directo por
// /api/gl/* (búsqueda de amigos, checkSession, etc.) — mismo dato, sin el hash.
async function getPublicAccounts(env, origin) {
    let accounts;
    try {
        accounts = await glLoadAccounts(env);
    } catch (e) {
        console.error('[getPublicAccounts] Error al leer cuentas:', e);
        return err('Error al conectar con el almacenamiento de cuentas', 502, origin);
    }
    const safeAccounts = accounts.map(({ password: _pw, ...safe }) => safe);
    return json(safeAccounts, 200, origin);
}

// Campos de perfil que un usuario puede editar de sí mismo. Cualquier otro
// campo del body se ignora — nunca se toca password/email/fechaRegistro/etc.
const PROFILE_EDITABLE_FIELDS = ['nombre', 'bio', 'avatar', 'banner', 'avatarDeco', 'placaNombre', 'efectoPerfil'];

// POST /api/account/profile  { nombre?, bio?, avatar?, banner?, avatarDeco?,
//                               placaNombre?, efectoPerfil? }
// Authorization: Bearer <sessionToken>
// Reemplaza el viejo patrón cliente de "traer TODO el array, modificar mi
// entrada, reescribir TODO el array" — que iba por el proxy abierto y
// permitía a cualquiera pisar el archivo completo de cuentas. Acá se edita
// server-side, una sola cuenta, solo los campos permitidos.
async function updateAccountProfile(request, env, origin) {
    const email = await requireSession(request, env);
    if (!email) return err('Iniciá sesión en Eclipse Zone antes de editar tu perfil', 401, origin);

    const data = await request.json().catch(() => ({}));

    let accounts;
    try {
        accounts = await glLoadAccounts(env);
    } catch (e) {
        console.error('[updateAccountProfile] Error al leer cuentas:', e);
        return err('Error al conectar con el almacenamiento de cuentas', 502, origin);
    }

    const idx = accounts.findIndex(a => (a.email || '').toLowerCase() === email.toLowerCase());
    if (idx === -1) return err('No se encontró tu cuenta', 404, origin);

    if (typeof data.nombre === 'string') {
        const nombre = data.nombre.trim();
        if (!nombre) return err('El nombre no puede estar vacío', 400, origin);
        if (nombre.length > MAX_USERNAME_LEN) return err(`El nombre no puede superar ${MAX_USERNAME_LEN} caracteres`, 400, origin);
    }

    PROFILE_EDITABLE_FIELDS.forEach(field => {
        if (typeof data[field] === 'string') {
            accounts[idx][field] = field === 'nombre' ? data[field].trim() : data[field];
        }
    });

    const saved = await glSaveAccounts(env, accounts);
    if (!saved) return err('Error al guardar el perfil. Intentá de nuevo.', 500, origin);

    const { password: _pw, ...safeUser } = accounts[idx];
    return json({ ok: true, user: safeUser }, 200, origin);
}

// ── Comentarios / estrellas — server-side (fix condición de carrera) ────
// Antes el cliente (js/comments.js) hacía read-modify-write directo contra
// GitLab vía /api/gl/*: dos pestañas escribiendo casi al mismo tiempo podían
// pisarse el estado (el retry de SHA evita el 400 pero no que un comentario
// se "pierda" si dos requests leen antes de que el otro escriba). Server-side
// se comparte el mismo lock lógico (COMMENTS_WRITE_QUEUE) para todos los
// requests que llegan a esta instancia del Worker.
const COMMENTS_PROJECT_ID = '81192889';       // eclipse1482609/cuenta-usuarios
const COMMENTS_FILE_PATH  = 'comentarios.json';
const STARS_FILE_PATH     = 'estrellas.json';
const BROKEN_LINKS_FILE_PATH = 'reportes-links-rotos.json';

async function glLoadJson(env, filePath) {
    return glLoadJsonFromProject(env, COMMENTS_PROJECT_ID, filePath);
}

// Igual que glLoadJson pero sobre un proyecto GitLab arbitrario — hace
// falta para exclusivos.json, que vive en senpai1940/juegos (75579701),
// no en el repo de comentarios/estrellas.
async function glLoadJsonFromProject(env, projectId, filePath) {
    const token = (env && env.GITLAB_TOKEN) ? env.GITLAB_TOKEN.trim() : '';
    if (!token) throw new Error('GITLAB_TOKEN no configurado');
    const res = await fetch(
        `${GL_API_BASE}/${projectId}/repository/files/${encodeURIComponent(filePath)}?ref=main`,
        { headers: { 'PRIVATE-TOKEN': token } }
    );
    if (!res.ok) return {};
    const data    = await res.json();
    const content = decodeURIComponent(escape(atob(data.content)));
    return content.trim() ? JSON.parse(content) : {};
}

// Igual patrón que glSaveAccounts: relee el SHA fresco justo antes de cada
// intento de PUT, reintenta si otro write ganó la carrera mientras tanto.
async function glSaveJson(env, filePath, data, commitMsg) {
    return glSaveJsonToProject(env, COMMENTS_PROJECT_ID, filePath, data, commitMsg);
}

// Igual que glSaveJson pero sobre un proyecto GitLab arbitrario.
async function glSaveJsonToProject(env, projectId, filePath, data, commitMsg) {
    const token = (env && env.GITLAB_TOKEN) ? env.GITLAB_TOKEN.trim() : '';
    if (!token) throw new Error('GITLAB_TOKEN no configurado');

    const encodedPath = encodeURIComponent(filePath);
    const jsonString  = JSON.stringify(data, null, 2);
    const MAX_RETRIES = 3;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const checkRes = await fetch(
            `${GL_API_BASE}/${projectId}/repository/files/${encodedPath}?ref=main`,
            { headers: { 'PRIVATE-TOKEN': token } }
        );

        if (!checkRes.ok) {
            const commitRes = await fetch(
                `${GL_API_BASE}/${projectId}/repository/commits`,
                {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json', 'PRIVATE-TOKEN': token },
                    body: JSON.stringify({
                        branch: 'main',
                        commit_message: commitMsg,
                        actions: [{ action: 'create', file_path: filePath, content: jsonString }],
                    }),
                }
            );
            return commitRes.ok;
        }

        const fileData = await checkRes.json();
        const putRes = await fetch(
            `${GL_API_BASE}/${projectId}/repository/files/${encodedPath}`,
            {
                method:  'PUT',
                headers: { 'Content-Type': 'application/json', 'PRIVATE-TOKEN': token },
                body: JSON.stringify({
                    branch: 'main',
                    content: jsonString,
                    commit_message: commitMsg,
                    last_commit_id: fileData.last_commit_id,
                }),
            }
        );

        if (putRes.ok) return true;

        if (putRes.status === 400 && attempt < MAX_RETRIES - 1) {
            await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
            continue;
        }
        return false;
    }
    return false;
}

// Cola en memoria de esta instancia del Worker: serializa todos los writes
// de comentarios/estrellas entre sí, para que dos requests concurrentes al
// mismo Worker nunca lean el mismo estado "viejo" antes de escribir.
let _commentsWriteQueue = Promise.resolve();
function queueCommentsWrite(fn) {
    const result = _commentsWriteQueue.then(fn, fn);
    _commentsWriteQueue = result.catch(() => {});
    return result;
}

const COMMENT_MAX_LEN = 1000;

function sanitizeCommentAuthor(user) {
    return {
        author      : (user && (user.nombre || user.name)) || 'Anónimo',
        userEmail   : (user && user.email) || null,
        userId      : (user && user.id) || null,
        avatar      : (user && user.avatar) || null,
        avatarDeco  : (user && user.avatarDeco) || null,
        placaNombre : (user && user.placaNombre) || null,
        efectoPerfil: (user && user.efectoPerfil) || null,
    };
}

// POST /api/comments/post  { type, id, text } — Authorization: Bearer <sessionToken>
async function postComment(request, env, origin) {
    const email = await requireSession(request, env);
    if (!email) return err('Iniciá sesión en Eclipse Zone antes de comentar', 401, origin);

    const data = await request.json().catch(() => ({}));
    const type = (data.type || '').trim();
    const id   = (data.id   || '').trim();
    const text = (data.text || '').trim();
    if (!['game', 'news', 'manga'].includes(type)) return err('Tipo inválido', 400, origin);
    if (!id) return err('Falta el identificador del contenido', 400, origin);
    if (!text) return err('El comentario no puede estar vacío', 400, origin);
    if (text.length > COMMENT_MAX_LEN) return err(`El comentario no puede superar ${COMMENT_MAX_LEN} caracteres`, 400, origin);

    let accounts;
    try { accounts = await glLoadAccounts(env); } catch (e) { return err('Error al conectar con el almacenamiento', 502, origin); }
    const user = accounts.find(a => (a.email || '').toLowerCase() === email.toLowerCase());

    const newComment = {
        id: Date.now().toString() + '-' + Math.random().toString(36).slice(2, 8),
        text,
        ...sanitizeCommentAuthor(user),
        date   : new Date().toISOString(),
        likes  : 0,
        likedBy: [],
        replies: [],
    };

    const ok = await queueCommentsWrite(async () => {
        const all = await glLoadJson(env, COMMENTS_FILE_PATH);
        if (!all[type])     all[type]     = {};
        if (!all[type][id]) all[type][id] = [];
        all[type][id].unshift(newComment);
        return glSaveJson(env, COMMENTS_FILE_PATH, all, `Nuevo comentario en ${type}/${id}`);
    });

    if (!ok) return err('Error al publicar. Intentá de nuevo.', 500, origin);
    return json({ ok: true, comment: newComment }, 200, origin);
}

// POST /api/comments/delete  { type, id, commentId } — Authorization: Bearer <sessionToken>
async function deleteComment(request, env, origin) {
    const email = await requireSession(request, env);
    if (!email) return err('Iniciá sesión en Eclipse Zone', 401, origin);

    const data      = await request.json().catch(() => ({}));
    const type      = (data.type || '').trim();
    const id        = (data.id   || '').trim();
    const commentId = (data.commentId || '').trim();
    if (!type || !id || !commentId) return err('Faltan parámetros', 400, origin);

    let notFound = false;
    const ok = await queueCommentsWrite(async () => {
        const all  = await glLoadJson(env, COMMENTS_FILE_PATH);
        const list = all[type]?.[id];
        if (!list) { notFound = true; return true; }
        const c = list.find(x => x.id === commentId);
        // Solo el autor puede borrar su propio comentario — verificado server-side,
        // nunca confiando en lo que mande el cliente.
        if (!c || (c.userEmail || '').toLowerCase() !== email.toLowerCase()) { notFound = true; return true; }
        all[type][id] = list.filter(x => x.id !== commentId);
        return glSaveJson(env, COMMENTS_FILE_PATH, all, `Comentario eliminado en ${type}/${id}`);
    });

    if (notFound) return err('No se encontró el comentario o no te pertenece', 404, origin);
    if (!ok) return err('Error al eliminar. Intentá de nuevo.', 500, origin);
    return json({ ok: true }, 200, origin);
}

// POST /api/comments/like  { type, id, commentId } — Authorization: Bearer <sessionToken>
async function likeComment(request, env, origin) {
    const email = await requireSession(request, env);
    if (!email) return err('Iniciá sesión en Eclipse Zone', 401, origin);

    const data      = await request.json().catch(() => ({}));
    const type      = (data.type || '').trim();
    const id        = (data.id   || '').trim();
    const commentId = (data.commentId || '').trim();
    if (!type || !id || !commentId) return err('Faltan parámetros', 400, origin);

    let result   = null;
    let notFound = false;
    const ok = await queueCommentsWrite(async () => {
        const all  = await glLoadJson(env, COMMENTS_FILE_PATH);
        const list = all[type]?.[id];
        const c    = list && list.find(x => x.id === commentId);
        if (!c) { notFound = true; return true; }

        if (!c.likedBy) c.likedBy = [];
        const idx = c.likedBy.indexOf(email);
        const alreadyLiked = idx !== -1;
        if (alreadyLiked) {
            c.likedBy.splice(idx, 1);
            c.likes = Math.max(0, (c.likes || 0) - 1);
        } else {
            c.likedBy.push(email);
            c.likes = (c.likes || 0) + 1;
        }
        result = { likes: c.likes, alreadyLiked: !alreadyLiked };
        return glSaveJson(env, COMMENTS_FILE_PATH, all, `${alreadyLiked ? 'Unlike' : 'Like'} en comentario ${commentId}`);
    });

    if (notFound) return err('No se encontró el comentario', 404, origin);
    if (!ok) return err('Error al registrar el like. Intentá de nuevo.', 500, origin);
    return json({ ok: true, ...result }, 200, origin);
}

// POST /api/comments/reply  { type, id, commentId, text } — Authorization: Bearer <sessionToken>
async function replyComment(request, env, origin) {
    const email = await requireSession(request, env);
    if (!email) return err('Iniciá sesión en Eclipse Zone', 401, origin);

    const data      = await request.json().catch(() => ({}));
    const type      = (data.type || '').trim();
    const id        = (data.id   || '').trim();
    const commentId = (data.commentId || '').trim();
    const text      = (data.text || '').trim();
    if (!type || !id || !commentId) return err('Faltan parámetros', 400, origin);
    if (!text) return err('La respuesta no puede estar vacía', 400, origin);
    if (text.length > COMMENT_MAX_LEN) return err(`La respuesta no puede superar ${COMMENT_MAX_LEN} caracteres`, 400, origin);

    let accounts;
    try { accounts = await glLoadAccounts(env); } catch (e) { return err('Error al conectar con el almacenamiento', 502, origin); }
    const user = accounts.find(a => (a.email || '').toLowerCase() === email.toLowerCase());

    const newReply = {
        id: Date.now().toString() + '-' + Math.random().toString(36).slice(2, 8),
        text,
        ...sanitizeCommentAuthor(user),
        date: new Date().toISOString(),
    };

    let notFound = false;
    const ok = await queueCommentsWrite(async () => {
        const all  = await glLoadJson(env, COMMENTS_FILE_PATH);
        const list = all[type]?.[id];
        const c    = list && list.find(x => x.id === commentId);
        if (!c) { notFound = true; return true; }
        if (!c.replies) c.replies = [];
        c.replies.push(newReply);
        return glSaveJson(env, COMMENTS_FILE_PATH, all, `Respuesta en comentario ${commentId}`);
    });

    if (notFound) return err('No se encontró el comentario', 404, origin);
    if (!ok) return err('Error al responder. Intentá de nuevo.', 500, origin);
    return json({ ok: true, reply: newReply }, 200, origin);
}

// POST /api/comments/delete-reply  { type, id, commentId, replyId } — Authorization: Bearer <sessionToken>
async function deleteReply(request, env, origin) {
    const email = await requireSession(request, env);
    if (!email) return err('Iniciá sesión en Eclipse Zone', 401, origin);

    const data      = await request.json().catch(() => ({}));
    const type      = (data.type || '').trim();
    const id        = (data.id   || '').trim();
    const commentId = (data.commentId || '').trim();
    const replyId   = (data.replyId   || '').trim();
    if (!type || !id || !commentId || !replyId) return err('Faltan parámetros', 400, origin);

    let notFound = false;
    const ok = await queueCommentsWrite(async () => {
        const all  = await glLoadJson(env, COMMENTS_FILE_PATH);
        const list = all[type]?.[id];
        const c    = list && list.find(x => x.id === commentId);
        if (!c || !c.replies) { notFound = true; return true; }
        const r = c.replies.find(x => x.id === replyId);
        if (!r || (r.userEmail || '').toLowerCase() !== email.toLowerCase()) { notFound = true; return true; }
        c.replies = c.replies.filter(x => x.id !== replyId);
        return glSaveJson(env, COMMENTS_FILE_PATH, all, `Respuesta eliminada en comentario ${commentId}`);
    });

    if (notFound) return err('No se encontró la respuesta o no te pertenece', 404, origin);
    if (!ok) return err('Error al eliminar. Intentá de nuevo.', 500, origin);
    return json({ ok: true }, 200, origin);
}

// GET /api/admin/dashboard — métricas agregadas para el panel de admin.
async function getAdminDashboard(request, env, origin) {
    const admin = await requireCommentsAdmin(request, env);
    if (!admin) return err('No autorizado', 403, origin);

    const [comentarios, estrellas, cuentas] = await Promise.all([
        glLoadJson(env, COMMENTS_FILE_PATH).catch(() => ({})),
        glLoadJson(env, STARS_FILE_PATH).catch(() => ({})),
        glLoadAccounts(env).catch(() => []),
    ]);

    let totalComments = 0, totalReplies = 0, totalLikes = 0;
    const perGame = [];
    for (const type of Object.keys(comentarios)) {
        for (const id of Object.keys(comentarios[type] || {})) {
            const list = comentarios[type][id] || [];
            totalComments += list.length;
            for (const c of list) {
                totalReplies += (c.replies || []).length;
                totalLikes   += c.likes || 0;
            }
            if (list.length) perGame.push({ type, id, count: list.length });
        }
    }
    perGame.sort((a, b) => b.count - a.count);

    let totalVotes = 0, ratedGames = 0;
    for (const gameId of Object.keys(estrellas)) {
        const n = estrellas[gameId]?.count || 0;
        if (n) { ratedGames++; totalVotes += n; }
    }

    const verifiedAccounts = cuentas.filter(a => a.emailVerificado).length;

    return json({
        ok: true,
        comments: { total: totalComments, replies: totalReplies, likes: totalLikes, topGames: perGame.slice(0, 10) },
        stars:    { totalVotes, ratedGames },
        accounts: { total: cuentas.length, verified: verifiedAccounts },
        ts: new Date().toISOString(),
    }, 200, origin);
}

// Admin de comentarios reusa FORM_ADMIN_EMAIL, pero la sesión del admin en el
// sitio (comentarios) es scope 'site', no 'form' — por eso no usa requireFormAdmin.
async function requireCommentsAdmin(request, env) {
    const email = await requireSession(request, env, 'site');
    if (!email || email.toLowerCase() !== FORM_ADMIN_EMAIL) return null;
    return email;
}

// GET /api/comments/admin/all — lista todos los comentarios de todos los
// juegos/noticias/mangas, aplanados, para el panel de moderación.
async function getAllCommentsAdmin(request, env, origin) {
    const admin = await requireCommentsAdmin(request, env);
    if (!admin) return err('No autorizado', 403, origin);

    let all;
    try { all = await glLoadJson(env, COMMENTS_FILE_PATH); } catch (e) { return err('Error al conectar con el almacenamiento', 502, origin); }

    const flat = [];
    for (const type of Object.keys(all)) {
        for (const id of Object.keys(all[type] || {})) {
            for (const c of (all[type][id] || [])) {
                flat.push({ type, id, commentId: c.id, author: c.author, userEmail: c.userEmail, text: c.text, date: c.date, likes: c.likes, replyCount: (c.replies || []).length });
                for (const r of (c.replies || [])) {
                    flat.push({ type, id, commentId: c.id, replyId: r.id, author: r.author, userEmail: r.userEmail, text: r.text, date: r.date, isReply: true });
                }
            }
        }
    }
    flat.sort((a, b) => new Date(b.date) - new Date(a.date));
    return json({ ok: true, comments: flat }, 200, origin);
}

// POST /api/comments/admin/delete  { type, id, commentId, replyId? } — borra
// cualquier comentario/respuesta sin verificar autoría (solo admin).
async function deleteCommentAdmin(request, env, origin) {
    const admin = await requireCommentsAdmin(request, env);
    if (!admin) return err('No autorizado', 403, origin);

    const data      = await request.json().catch(() => ({}));
    const type      = (data.type || '').trim();
    const id        = (data.id   || '').trim();
    const commentId = (data.commentId || '').trim();
    const replyId   = (data.replyId   || '').trim();
    if (!type || !id || !commentId) return err('Faltan parámetros', 400, origin);

    let notFound = false;
    const ok = await queueCommentsWrite(async () => {
        const all  = await glLoadJson(env, COMMENTS_FILE_PATH);
        const list = all[type]?.[id];
        if (!list) { notFound = true; return true; }
        const c = list.find(x => x.id === commentId);
        if (!c) { notFound = true; return true; }
        if (replyId) {
            if (!c.replies) { notFound = true; return true; }
            const r = c.replies.find(x => x.id === replyId);
            if (!r) { notFound = true; return true; }
            c.replies = c.replies.filter(x => x.id !== replyId);
        } else {
            all[type][id] = list.filter(x => x.id !== commentId);
        }
        return glSaveJson(env, COMMENTS_FILE_PATH, all, `[admin] Comentario eliminado en ${type}/${id}`);
    });

    if (notFound) return err('No se encontró el comentario', 404, origin);
    if (!ok) return err('Error al eliminar. Intentá de nuevo.', 500, origin);
    return json({ ok: true }, 200, origin);
}

// GET /api/comments?type=game&id=Ripples — público, sin sesión
async function loadComments(url, env, origin) {
    const type = (url.searchParams.get('type') || '').trim();
    const id   = (url.searchParams.get('id')   || '').trim();
    if (!['game', 'news', 'manga'].includes(type) || !id) return err('Parámetros inválidos', 400, origin);
    let all;
    try { all = await glLoadJson(env, COMMENTS_FILE_PATH); } catch (e) { return err('Error al conectar con el almacenamiento', 502, origin); }
    return json({ ok: true, comments: (all[type] && all[type][id]) || [] }, 200, origin);
}

// GET /api/stars?gameId=Ripples — público, sin sesión
async function loadStars(url, env, origin) {
    const gameId = (url.searchParams.get('gameId') || '').trim();
    if (!gameId) return err('Falta el identificador del juego', 400, origin);
    let all;
    try { all = await glLoadJson(env, STARS_FILE_PATH); } catch (e) { return err('Error al conectar con el almacenamiento', 502, origin); }
    return json({ ok: true, ...(all[gameId] || { average: 0, count: 0, votes: {} }) }, 200, origin);
}

// ── ESTRELLAS ─────────────────────────────────────────────────────────
// POST /api/stars/vote  { gameId, rating } — Authorization: Bearer <sessionToken>
async function voteStars(request, env, origin) {
    const email = await requireSession(request, env);
    if (!email) return err('Iniciá sesión en Eclipse Zone antes de votar', 401, origin);

    const data   = await request.json().catch(() => ({}));
    const gameId = (data.gameId || '').trim();
    const rating = Number(data.rating);
    if (!gameId) return err('Falta el identificador del juego', 400, origin);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return err('Rating inválido', 400, origin);

    let result;
    const ok = await queueCommentsWrite(async () => {
        const all = await glLoadJson(env, STARS_FILE_PATH);
        if (!all[gameId]) all[gameId] = { average: 0, count: 0, votes: {} };
        const entry    = all[gameId];
        const wasVoted = entry.votes[email] !== undefined;
        entry.votes[email] = rating;

        const voteValues = Object.values(entry.votes);
        entry.count   = voteValues.length;
        entry.average = voteValues.reduce((a, b) => a + b, 0) / entry.count;
        result = { average: entry.average, count: entry.count, userVote: rating };

        return glSaveJson(env, STARS_FILE_PATH, all, `${wasVoted ? 'Voto actualizado' : 'Nuevo voto'} en ${gameId}: ${rating}★`);
    });

    if (!ok) return err('Error al votar. Intentá de nuevo.', 500, origin);
    return json({ ok: true, ...result }, 200, origin);
}

// ── Reportar link roto ────────────────────────────────────────────────
// POST /api/report-broken-link  { slug, titulo, motivo? }
// Público, sin sesión (cualquier visitante puede avisar) — el rate limit por
// IP en el dispatcher es la única defensa contra abuso/spam.
const BROKEN_LINK_MAX_LEN = 300;

// Loguea errores JS no capturados del cliente a KV, agrupados por hash de
// mensaje+archivo+línea (evita que un mismo error repetido en muchos
// usuarios genere miles de entradas — solo suma un contador).
async function reportJsError(request, env, origin) {
    const kv = env && env.EZ_DATA;
    if (!kv) return json({ ok: true }, 200, origin);
    const data    = await request.json().catch(() => ({}));
    const message = (data.message || '').toString().slice(0, 500);
    const source  = (data.source  || '').toString().slice(0, 300);
    const line    = Number(data.line) || 0;
    const stack   = (data.stack   || '').toString().slice(0, 1000);
    const url     = (data.url     || '').toString().slice(0, 300);
    if (!message) return json({ ok: true }, 200, origin);

    const hash = await sha256Hex(`${message}|${source}|${line}`);
    const key  = `jserror:${hash}`;
    try {
        const existing = await kv.get(key, 'json');
        const entry = existing || { message, source, line, stack, count: 0, firstSeen: new Date().toISOString() };
        entry.count++;
        entry.lastSeen = new Date().toISOString();
        entry.lastUrl  = url;
        await kv.put(key, JSON.stringify(entry), { expirationTtl: 60 * 60 * 24 * 30 });
    } catch (e) {
        console.error('[reportJsError] No se pudo guardar en KV.', e);
    }
    return json({ ok: true }, 200, origin);
}

async function reportBrokenLink(request, env, origin) {
    const data   = await request.json().catch(() => ({}));
    const slug   = (data.slug   || '').trim().slice(0, 200);
    const titulo = (data.titulo || '').trim().slice(0, 200);
    const motivo = (data.motivo || '').trim().slice(0, BROKEN_LINK_MAX_LEN);
    if (!slug && !titulo) return err('Falta indicar qué juego/página tiene el link roto', 400, origin);

    const report = {
        id:       crypto.randomUUID(),
        slug, titulo, motivo,
        date:     new Date().toISOString(),
        resolved: false,
    };

    // Se guarda en GitLab (mismo storage que comentarios/estrellas) para que
    // el panel /admin/reportes/ pueda listarlos — antes solo se mandaba el
    // email y no había forma de verlos ni marcarlos como resueltos.
    const saved = await queueCommentsWrite(async () => {
        const all = await glLoadJson(env, BROKEN_LINKS_FILE_PATH);
        if (!Array.isArray(all.reports)) all.reports = [];
        all.reports.unshift(report);
        return glSaveJson(env, BROKEN_LINKS_FILE_PATH, all, `Link roto reportado: ${titulo || slug}`);
    }).catch(() => false);
    if (!saved) console.error('[reportBrokenLink] No se pudo guardar el reporte en GitLab.');

    const sent = await sendEmail(env, {
        to: FORM_ADMIN_EMAIL,
        subject: `Link roto reportado: ${titulo || slug}`,
        html: `
            <p><strong>Página:</strong> ${slug ? `eclipsezonehub.com/juego/${slug}/` : '(sin slug)'}</p>
            <p><strong>Título:</strong> ${titulo || '(no indicado)'}</p>
            <p><strong>Motivo:</strong> ${motivo || '(no indicado)'}</p>
            <p><a href="https://eclipsezonehub.com/admin/reportes/">Ver en el panel de reportes</a></p>
        `,
    });

    // Siempre responde ok — aunque el email falle (ej. RESEND_API_KEY sin
    // configurar), no tiene sentido mostrarle un error al usuario que solo
    // quería avisar de un problema; queda guardado en GitLab igual.
    if (!sent) console.error('[reportBrokenLink] No se pudo enviar el email de aviso.');
    return json({ ok: true }, 200, origin);
}

// GET /api/admin/broken-links — lista los reportes de link roto para el
// panel /admin/reportes/. Mismo scope de sesión que el resto de paneles admin.
async function getBrokenLinksAdmin(request, env, origin) {
    const admin = await requireCommentsAdmin(request, env);
    if (!admin) return err('No autorizado', 403, origin);

    let all;
    try { all = await glLoadJson(env, BROKEN_LINKS_FILE_PATH); } catch (e) { return err('Error al conectar con el almacenamiento', 502, origin); }
    const reports = Array.isArray(all.reports) ? all.reports : [];
    return json({ ok: true, reports }, 200, origin);
}

// POST /api/admin/broken-links/resolve  { id }
async function resolveBrokenLinkAdmin(request, env, origin) {
    const admin = await requireCommentsAdmin(request, env);
    if (!admin) return err('No autorizado', 403, origin);

    const data = await request.json().catch(() => ({}));
    const id   = (data.id || '').trim();
    if (!id) return err('Falta el id del reporte', 400, origin);

    let notFound = false;
    const ok = await queueCommentsWrite(async () => {
        const all = await glLoadJson(env, BROKEN_LINKS_FILE_PATH);
        const list = Array.isArray(all.reports) ? all.reports : [];
        const rep = list.find(r => r.id === id);
        if (!rep) { notFound = true; return true; }
        rep.resolved = !rep.resolved;
        all.reports = list;
        return glSaveJson(env, BROKEN_LINKS_FILE_PATH, all, `[admin] Reporte de link roto ${rep.resolved ? 'resuelto' : 'reabierto'}: ${id}`);
    });

    if (notFound) return err('No se encontró el reporte', 404, origin);
    if (!ok) return err('Error al actualizar. Intentá de nuevo.', 500, origin);
    return json({ ok: true }, 200, origin);
}

// ── PATREON ────────────────────────────────────────────────────────────
// Debe ser EXACTAMENTE el mismo algoritmo que slugify() en js/juegos-core.js
// — es la clave con la que se guardan y buscan los links de juegos exclusivos
// en KV (exclusive_links:<slug>). El regex de abajo son los caracteres
// combinantes U+0300–U+036F (acentos tras normalize('NFD')), equivalente a
// /[̀-ͯ]/ — verificado con node que da el mismo resultado byte a
// byte que la versión del frontend en varios casos con tildes/ñ.
function slugifyServer(text) {
    if (!text) return '';
    return text.toString().toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/--+/g, '-')
        .replace(/^-+|-+$/g, '');
}

// Debe coincidir con el redirect_uri registrado en el portal de Patreon.
const PATREON_REDIRECT_URI = 'https://eclipsezonehub.com/patreon/callback';

// POST /api/patreon/callback  { code }  — Authorization: Bearer <sessionToken>
//
// El intercambio del code por un access_token pasa ACÁ, server-to-server,
// usando PATREON_CLIENT_SECRET (nunca visible para el navegador). Un code
// solo lo emite Patreon después de que el usuario se autenticó de verdad en
// patreon.com y aprobó la conexión — nadie puede fabricar uno falso.
async function patreonCallback(request, env, origin) {
    const email = await requireSession(request, env);
    if (!email) return err('Iniciá sesión en Eclipse Zone antes de conectar Patreon', 401, origin);

    if (!env.PATREON_CLIENT_ID || !env.PATREON_CLIENT_SECRET) {
        return err('Patreon no está configurado todavía', 503, origin);
    }

    const data = await request.json().catch(() => ({}));
    const code = data.code || '';
    if (!code) return err('Falta el código de autorización', 400, origin);

    let tokenData;
    try {
        const tokenRes = await fetch('https://www.patreon.com/api/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                grant_type:    'authorization_code',
                client_id:     env.PATREON_CLIENT_ID,
                client_secret: env.PATREON_CLIENT_SECRET,
                redirect_uri:  PATREON_REDIRECT_URI,
            }),
        });
        if (!tokenRes.ok) {
            console.error('[patreonCallback] token exchange failed:', tokenRes.status, await tokenRes.text().catch(() => ''));
            return err('No se pudo verificar con Patreon. Probá de nuevo.', 502, origin);
        }
        tokenData = await tokenRes.json();
    } catch (e) {
        console.error('[patreonCallback] token exchange error:', e);
        return err('Error de red al hablar con Patreon', 502, origin);
    }

    const accessToken = tokenData && tokenData.access_token;
    if (!accessToken) return err('Respuesta inválida de Patreon', 502, origin);

    let idData;
    try {
        const idRes = await fetch(
            'https://www.patreon.com/api/oauth2/v2/identity' +
            '?include=memberships&fields%5Bmember%5D=patron_status',
            { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (!idRes.ok) {
            console.error('[patreonCallback] identity fetch failed:', idRes.status, await idRes.text().catch(() => ''));
            return err('No se pudo leer tu membresía de Patreon', 502, origin);
        }
        idData = await idRes.json();
    } catch (e) {
        console.error('[patreonCallback] identity fetch error:', e);
        return err('Error de red al leer tu membresía de Patreon', 502, origin);
    }

    // "Cualquier nivel de membresía (desde el nivel 1) da acceso" — alcanza con
    // patron_status === 'active_patron' en alguna membresía, sin filtrar por tier.
    const memberships = (idData && idData.included || []).filter(i => i.type === 'member');
    const activeMembership = memberships.find(m => m.attributes && m.attributes.patron_status === 'active_patron');
    const connected = !!activeMembership;
    const patreonUserId = (idData && idData.data && idData.data.id) || null;

    const kv = env.EZ_DATA;
    await kvSet(kv, `patreon:${email}`, {
        patreonUserId,
        connected,
        patronStatus: activeMembership
            ? 'active_patron'
            : ((memberships[0] && memberships[0].attributes && memberships[0].attributes.patron_status) || 'none'),
        verifiedAt: new Date().toISOString(),
    });

    return json({ ok: true, connected }, 200, origin);
}

// GET /api/patreon/check — Authorization: Bearer <sessionToken>
// Chequeo EN VIVO contra KV — el frontend nunca decide por su cuenta si el
// usuario "está conectado", siempre le pregunta al Worker.
async function patreonCheck(request, env, origin) {
    const email = await requireSession(request, env);
    if (!email) return json({ ok: true, connected: false }, 200, origin);
    const record = await kvGet(env.EZ_DATA, `patreon:${email}`);
    return json({ ok: true, connected: !!(record && record.connected) }, 200, origin);
}

// NOTA 2026-08-04: se eliminaron acá glLoadExclusivos/glSaveExclusivos,
// requireSiteAdmin/SITE_ADMIN_EMAIL, adminSetExclusiveLink,
// adminRemoveExclusiveLink y patreonExclusiveLink — eran el backend del panel
// "💎 Link exclusivo de Patreon" (link privado adicional, solo lo cargaba
// SITE_ADMIN_EMAIL). Se sacó todo ese sistema: ahora un juego exclusivo de
// Patreon se resuelve enteramente marcando "Juego exclusivo de Patreon" en el
// formulario normal y cargando ahí los Links de descarga de siempre — eso
// hace que el juego se guarde en exclusivos.json en vez de juegos.json (ver
// EXCLUSIVE_GAMES_FILE_PATH y el flujo de guardado en form.js).
//
// FIX 2026-09-21: esa migración había quedado a medio hacer — el link real
// de un juego exclusivo nunca tuvo forma de cargarse desde el 2026-08-04
// (el único consumidor, upload_exclusive_link() en F95Pipeline, llamaba a
// un endpoint que este mismo comentario dice que ya no existe).
//
// CORRECCIÓN a la nota anterior: form.js NO escribe en exclusivos.json —
// sigue bloqueado por el chequeo "solo senpai1940" de proxyGitlab (ver
// arriba, cerca de GITLAB_BLOCKED_FILES), porque escribe vía el proxy
// genérico /api/gl-auth/* con la sesión del traductor logueado. Quien
// alimenta exclusivos.json de verdad, para todo juego NUEVO con link
// directo (exclusivo o no), es F95Pipeline vía saveExclusiveDirectGame
// (endpoint /api/admin/exclusive-direct-link, más abajo) — no pasa por
// proxyGitlab, así que no requiere ser senpai1940, solo una sesión de
// sitio válida. Sin backfill: el catálogo histórico no se toca.
// slugifyServer (arriba) vuelve a tener uso.
const GAMES_PROJECT_ID = '75579701';           // senpai1940/juegos
const GAMES_FILE_PATH_SERVER = 'juegos.json';
const EXCLUSIVE_GAMES_FILE_PATH = 'exclusivos.json';

// GET /api/patreon/exclusive-games — Authorization: Bearer <sessionToken>
// Solo devuelve datos a mecenas con membresía activa verificada (mismo
// chequeo que patreonCheck, contra el registro real en KV — el frontend
// nunca decide esto solo). A un no-mecenas le contesta connected:false y
// games:[] — el sitio público ya sabe mostrar el gate de "conectate con
// Patreon" en ese caso (mismo patrón que renderExclusiveGames en
// juegos-render.js).
async function patreonExclusiveGames(request, env, origin) {
    const email = await requireSession(request, env);
    if (!email) return json({ ok: true, connected: false, games: [] }, 200, origin);

    const record = await kvGet(env.EZ_DATA, `patreon:${email}`);
    const connected = !!(record && record.connected);
    if (!connected) return json({ ok: true, connected: false, games: [] }, 200, origin);

    let games;
    try {
        const raw = await glLoadJsonFromProject(env, GAMES_PROJECT_ID, EXCLUSIVE_GAMES_FILE_PATH);
        games = Array.isArray(raw) ? raw : [];
    } catch (e) {
        return err('Error al conectar con el almacenamiento', 502, origin);
    }
    return json({ ok: true, connected: true, games }, 200, origin);
}

// Cola en memoria de esta instancia del Worker: serializa los writes a
// exclusivos.json entre sí, mismo motivo que _commentsWriteQueue (arriba) —
// ahora tiene un escritor real y concurrente (cada publicación de
// F95Pipeline), antes casi no se escribía nunca.
let _exclusiveWriteQueue = Promise.resolve();
function queueExclusiveWrite(fn) {
    const result = _exclusiveWriteQueue.then(fn, fn);
    _exclusiveWriteQueue = result.catch(() => {});
    return result;
}

// POST /api/admin/exclusive-direct-link — Authorization: Bearer <sessionToken>
// Lo llama F95Pipeline (Python) después de publicar en juegos.json, para
// reflejar el juego también en exclusivos.json con su link directo
// (Mediafire sin acortador) — reemplaza a upload_exclusive_link()/
// /api/admin/exclusive-link (eliminado 2026-08-04, ver nota arriba).
// Exige sesión de scope 'form' (cuenta del formulario, la misma con la que
// F95Pipeline escribe juegos.json). Desde 2026-09-27; antes era scope 'site'. Hace
// upsert por título (slugifyServer) — si el juego ya existía en
// exclusivos.json (por ejemplo una versión anterior, o si estaba marcado
// "exclusivo" desde el formulario), se actualiza en vez de duplicarse.
async function saveExclusiveDirectGame(request, env, origin) {
    // Scope 'form' (same trust as writing juegos.json via /api/gl-auth/*).
    // It used to accept 'site', i.e. ANY public account registered on the
    // website could overwrite exclusivos.json — and F95Pipeline's form
    // credentials didn't match a site account, so the call always failed.
    const email = await requireSession(request, env, 'form');
    if (!email) return err('No autorizado', 401, origin);

    let body;
    try { body = await request.json(); } catch (e) { return err('JSON inválido', 400, origin); }
    const game = body && body.game;
    if (!game || typeof game !== 'object' || !game.titulo) {
        return err('Falta "game" con al menos "titulo"', 400, origin);
    }
    if (!Array.isArray(game.links) || game.links.length === 0) {
        return err('El juego debe traer al menos un link directo en "links"', 400, origin);
    }

    const huella = slugifyServer(game.titulo);

    const ok = await queueExclusiveWrite(async () => {
        let raw;
        try {
            raw = await glLoadJsonFromProject(env, GAMES_PROJECT_ID, EXCLUSIVE_GAMES_FILE_PATH);
        } catch (e) {
            return false;
        }
        const games = Array.isArray(raw) ? raw : [];
        const idx = games.findIndex(g => slugifyServer(g.titulo || '') === huella);
        if (idx !== -1) games[idx] = game; else games.push(game);
        return glSaveJsonToProject(env, GAMES_PROJECT_ID, EXCLUSIVE_GAMES_FILE_PATH, games,
            `${idx !== -1 ? 'Actualizar' : 'Agregar'} exclusivo directo: ${game.titulo} - Por: ${email}`);
    });

    if (!ok) return err('Error al guardar en exclusivos.json. Probá de nuevo.', 500, origin);
    return json({ ok: true }, 200, origin);
}

// ── Géneros exclusivos de Patreon (2026-09-21) ──────────────────────────
// Lista corta de categorías completas marcadas "solo Patreon" — cualquier
// juego con alguna de estas categorías se muestra bloqueado (visible, con
// candado) en el sitio público hasta que el visitante conecte Patreon.
// Vive en patreon-config.json, mismo repo que juegos.json — archivo
// separado (no un campo más en juegos.json) porque es una lista corta e
// independiente que solo edita el admin, no el flujo normal de alta de
// juegos del formulario.
const PATREON_CONFIG_FILE_PATH = 'patreon-config.json';
let patreonGenresCache = null;       // { generos: string[], ts: number }
const PATREON_GENRES_CACHE_MS = 5 * 60 * 1000; // 5 min — ver nota de cache en proxyGitlab

async function loadPatreonGenres(env) {
    if (patreonGenresCache && (Date.now() - patreonGenresCache.ts) < PATREON_GENRES_CACHE_MS) {
        return patreonGenresCache.generos;
    }
    let raw;
    try { raw = await glLoadJsonFromProject(env, GAMES_PROJECT_ID, PATREON_CONFIG_FILE_PATH); }
    catch (e) { return patreonGenresCache ? patreonGenresCache.generos : []; }
    const generos = Array.isArray(raw.generosExclusivos) ? raw.generosExclusivos : [];
    patreonGenresCache = { generos, ts: Date.now() };
    return generos;
}

// GET /api/patreon-genres — público, sin auth. El sitio lo consulta en cada
// carga para saber qué categorías bloquear; el cache en memoria de arriba
// evita pegarle a GitLab en cada visita.
async function getPatreonGenresPublic(request, env, origin) {
    const generos = await loadPatreonGenres(env);
    return json({ ok: true, generos }, 200, origin);
}

// GET /api/admin/patreon-genres — lista completa de categorías existentes
// (derivadas de juegos.json, igual que extractUniqueCategories en el
// cliente) + cuáles están marcadas, para poblar los checkboxes del panel.
async function getPatreonGenresAdmin(request, env, origin) {
    const admin = await requireCommentsAdmin(request, env);
    if (!admin) return err('No autorizado', 403, origin);

    const [marcados, juegosRaw] = await Promise.all([
        loadPatreonGenres(env),
        glLoadJsonFromProject(env, GAMES_PROJECT_ID, GAMES_FILE_PATH_SERVER).catch(() => []),
    ]);
    const juegos = Array.isArray(juegosRaw) ? juegosRaw : [];
    const todas = new Set();
    juegos.forEach(g => (Array.isArray(g.categorias) ? g.categorias : []).forEach(c => {
        if (typeof c === 'string' && c.trim()) todas.add(c.trim().toLowerCase());
    }));
    return json({ ok: true, categorias: [...todas].sort(), marcados }, 200, origin);
}

// POST /api/admin/patreon-genres  { generos: string[] }
async function savePatreonGenresAdmin(request, env, origin) {
    const admin = await requireCommentsAdmin(request, env);
    if (!admin) return err('No autorizado', 403, origin);

    let body;
    try { body = await request.json(); } catch (e) { return err('JSON inválido', 400, origin); }
    const generos = Array.isArray(body.generos) ? body.generos.filter(g => typeof g === 'string' && g.trim()) : null;
    if (!generos) return err('Falta el array "generos"', 400, origin);

    // Mismo repo que juegos.json/exclusivos.json (75579701) — reusa
    // glSaveJson con un projectId distinto vía la variante de abajo, no el
    // fijo a COMMENTS_PROJECT_ID.
    const ok = await glSaveJsonToProject(
        env, GAMES_PROJECT_ID, PATREON_CONFIG_FILE_PATH,
        { generosExclusivos: generos },
        `Actualizar géneros exclusivos de Patreon - Por: ${admin}`
    );
    if (!ok) return err('Error al guardar. Probá de nuevo.', 500, origin);

    patreonGenresCache = { generos, ts: Date.now() }; // invalidar cache local
    return json({ ok: true, generos }, 200, origin);
}

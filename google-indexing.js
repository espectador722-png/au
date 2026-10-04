// =============================================================
// google-indexing.js — Eclipse Zone
// Notificación a Google Indexing API usando solo módulos
// de Node.js (crypto + https). Sin dependencias externas.
//
// SETUP (una sola vez):
//   1. Google Cloud Console → habilitar "Web Search Indexing API"
//   2. Crear Service Account → descargar JSON de credenciales
//   3. En Search Console → Configuración → Agregar ese email
//      como "Propietario" de la propiedad
//   4. Cloudflare Pages → Settings → Environment Variables:
//      GOOGLE_SERVICE_ACCOUNT_JSON = <contenido JSON en una línea>
//
// CUOTA:
//   - Default: 200 URL updates / día (por Service Account)
//   - Ampliable: Google Cloud Console → APIs → Quotas → solicitar aumento
//   - El script envía primero las URLs nuevas/modificadas
// =============================================================

'use strict';

const https  = require('https');
const crypto = require('crypto');

// ─── CONSTANTES ───────────────────────────────────────────────

const INDEXING_API_HOST = 'indexing.googleapis.com';
const INDEXING_API_PATH = '/v3/urlNotifications:publish';
const TOKEN_HOST        = 'oauth2.googleapis.com';
const TOKEN_PATH        = '/token';
const SCOPE             = 'https://www.googleapis.com/auth/indexing';

// ─── JWT (RS256) ──────────────────────────────────────────────

/**
 * Genera un JWT firmado con la clave privada de la Service Account.
 * Google usa RS256 (RSASSA-PKCS1-v1_5 con SHA-256).
 */
function buildJWT(clientEmail, privateKey) {
    const header  = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const now     = Math.floor(Date.now() / 1000);
    const payload = b64url(JSON.stringify({
        iss: clientEmail,
        scope: SCOPE,
        aud: `https://${TOKEN_HOST}${TOKEN_PATH}`,
        iat: now,
        exp: now + 3600,
    }));
    const input = `${header}.${payload}`;
    const sign  = crypto.createSign('RSA-SHA256');
    sign.update(input);
    const sig = sign.sign(privateKey, 'base64url');
    return `${input}.${sig}`;
}

function b64url(str) {
    return Buffer.from(str).toString('base64url');
}

// ─── TOKEN OAUTH2 ─────────────────────────────────────────────

/**
 * Intercambia un JWT por un access_token de Google.
 */
function fetchAccessToken(jwt) {
    return new Promise((resolve, reject) => {
        const body = [
            'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer'),
            'assertion='  + encodeURIComponent(jwt),
        ].join('&');

        const options = {
            hostname: TOKEN_HOST,
            path:     TOKEN_PATH,
            method:   'POST',
            headers: {
                'Content-Type':   'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body),
            },
        };

        const req = https.request(options, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.access_token) resolve(parsed.access_token);
                    else reject(new Error(`Token error (HTTP ${res.statusCode}): ${JSON.stringify(parsed)}`));
                } catch (e) { reject(e); }
            });
        });
        req.setTimeout(20_000, () => req.destroy(new Error('Timeout obteniendo token')));
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ─── NOTIFY URL ───────────────────────────────────────────────

/**
 * Envía una notificación de URL a Google Indexing API.
 * type: 'URL_UPDATED' (nueva/actualizada) | 'URL_DELETED' (eliminada)
 */
function notifyUrl(accessToken, url, type = 'URL_UPDATED') {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ url, type });
        const options = {
            hostname: INDEXING_API_HOST,
            path:     INDEXING_API_PATH,
            method:   'POST',
            headers: {
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(body),
                'Authorization':  `Bearer ${accessToken}`,
            },
        };
        const req = https.request(options, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
                catch { resolve({ status: res.statusCode, body: data }); }
            });
        });
        req.setTimeout(15_000, () => req.destroy(new Error(`Timeout notificando: ${url}`)));
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// ─── SLEEP ────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── FUNCIÓN PRINCIPAL ────────────────────────────────────────

/**
 * Envía una lista de URLs a Google Indexing API.
 *
 * @param {string[]} urls          - URLs a notificar (se envían primero las nuevas)
 * @param {object}   options
 * @param {number}   options.dailyQuota   - Cuota diaria (default: 180, deja margen de 20)
 * @param {number}   options.delayMs      - Delay entre requests en ms (default: 500)
 * @param {object}   options.log          - Logger compatible (info/ok/warn/error)
 * @param {boolean}  options.dryRun       - Si true, no hace llamadas reales
 * @returns {Promise<{submitted: number, errors: number, skipped: number}>}
 */
async function runGoogleIndexingAPI(urls, {
    dailyQuota = 180,
    delayMs    = 500,
    log        = null,
    dryRun     = false,
} = {}) {
    const info  = log?.info  || (msg => console.log('[INFO ]', msg));
    const ok    = log?.ok    || (msg => console.log('[OK   ]', msg));
    const warn  = log?.warn  || (msg => console.warn('[WARN ]', msg));
    const error = log?.error || (msg => console.error('[ERROR]', msg));

    // ── Leer credenciales ───────────────────────────────────────
    const rawCreds = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!rawCreds) {
        warn('Google Indexing API omitido: falta GOOGLE_SERVICE_ACCOUNT_JSON.');
        warn('  → Sigue los pasos en SETUP al inicio de este archivo.');
        return { submitted: 0, errors: 0, skipped: urls.length };
    }

    let creds;
    try {
        creds = JSON.parse(rawCreds);
    } catch {
        error('GOOGLE_SERVICE_ACCOUNT_JSON no es JSON válido.');
        return { submitted: 0, errors: 1, skipped: 0 };
    }

    if (!creds.client_email || !creds.private_key) {
        error('GOOGLE_SERVICE_ACCOUNT_JSON: faltan "client_email" o "private_key".');
        return { submitted: 0, errors: 1, skipped: 0 };
    }

    // ── Limitar a cuota diaria ──────────────────────────────────
    const urlsToSend = urls.slice(0, dailyQuota);
    const skipped    = urls.length - urlsToSend.length;

    if (urls.length === 0) {
        info('Google Indexing API: no hay URLs nuevas para enviar.');
        return { submitted: 0, errors: 0, skipped: 0 };
    }

    // ── Autenticación ───────────────────────────────────────────
    info(`Google Indexing API: autenticando como ${creds.client_email}…`);

    if (dryRun) {
        warn(`DRY-RUN: se enviarían ${urlsToSend.length} URLs (cuota: ${dailyQuota}).`);
        return { submitted: 0, errors: 0, skipped };
    }

    let accessToken;
    try {
        const jwt   = buildJWT(creds.client_email, creds.private_key);
        accessToken = await fetchAccessToken(jwt);
        ok('Google Indexing API: token obtenido ✓');
    } catch (e) {
        error(`Google Indexing API: error de autenticación — ${e.message}`);
        return { submitted: 0, errors: 1, skipped };
    }

    // ── Envío de URLs ───────────────────────────────────────────
    let submitted = 0;
    let errors    = 0;
    let rateLimited = false;

    info(`Google Indexing API: enviando ${urlsToSend.length} URLs (cuota diaria: ${dailyQuota})…`);
    if (skipped > 0) warn(`  → ${skipped} URLs omitidas por cuota (aumentar dailyQuota o solicitar cuota extra)`);

    for (let i = 0; i < urlsToSend.length; i++) {
        const url = urlsToSend[i];

        if (rateLimited) {
            warn('Rate limit alcanzado. Deteniendo para hoy — el resto en el próximo deploy.');
            skipped += urlsToSend.length - i;
            break;
        }

        try {
            const res = await notifyUrl(accessToken, url);

            if (res.status === 200) {
                submitted++;
            } else if (res.status === 429) {
                rateLimited = true;
                warn(`Rate limit (429) en URL ${i + 1}/${urlsToSend.length}: ${url}`);
            } else if (res.status === 400) {
                errors++;
                error(`URL inválida (400): ${url}`);
            } else if (res.status === 403) {
                errors++;
                error(`Sin permisos (403): verifica que el email de Service Account sea "Propietario" en Search Console`);
                break; // Error de configuración, no reintentar
            } else {
                errors++;
                error(`HTTP ${res.status} para ${url}: ${JSON.stringify(res.body).substring(0, 200)}`);
            }
        } catch (e) {
            errors++;
            error(`Excepción enviando ${url}: ${e.message}`);
        }

        // Delay entre requests para no saturar la API
        if (i < urlsToSend.length - 1 && delayMs > 0) {
            await sleep(delayMs);
        }
    }

    // ── Reporte ─────────────────────────────────────────────────
    const bar = '─'.repeat(48);
    console.log(`\n┌${bar}┐`);
    console.log(`│  🔍 GOOGLE INDEXING API — Resultado              │`);
    console.log(`├${bar}┤`);
    console.log(`│  URLs notificadas:   ${String(submitted).padEnd(26)}│`);
    console.log(`│  Errores:            ${String(errors).padEnd(26)}│`);
    console.log(`│  Omitidas (cuota):   ${String(skipped).padEnd(26)}│`);
    console.log(`└${bar}┘\n`);

    return { submitted, errors, skipped };
}

module.exports = { runGoogleIndexingAPI };

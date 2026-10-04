/* sw.js — Service worker LIMPIO / auto-destructivo
 * ---------------------------------------------------------------------------
 * ANTES este archivo alojaba un service worker de una red de anuncios "push"
 * de terceros (dominio 3nbf4punto com, zoneId 11275359) que se cargaba con un
 * importScripts remoto.
 *
 * Ese worker corría por fuera de la página y persistía entre visitas, y era el
 * causante REAL de los anuncios/redirects que a los usuarios les saltaban
 * "apenas entran", antes de que cargara la página y sin poder evitarlos. No lo
 * registraba ningún código del sitio: lo registraba el propio script de la red
 * de anuncios cuando le servía un creative de push a ciertos usuarios (por eso
 * solo le pasaba a algunos y no al dueño). El sitio NO usa ningún service
 * worker propio.
 *
 * Este archivo ahora es un worker inerte que además se elimina a sí mismo y
 * borra sus cachés. Así, los navegadores que ya tenían registrado el SW
 * malicioso lo reemplazan por éste en la próxima visita y luego queda todo
 * des-registrado. Si algún creative vuelve a llamar register('/sw.js'),
 * aterriza aquí (inofensivo) en lugar de en 3nbf4.
 * ------------------------------------------------------------------------- */
self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    // Borrar cualquier caché dejada por el worker anterior.
    try {
      var keys = await caches.keys();
      await Promise.all(keys.map(function (k) { return caches.delete(k); }));
    } catch (e) { /* ignorar */ }

    // Tomar control de las pestañas abiertas para poder limpiarlas.
    try { await self.clients.claim(); } catch (e) { /* ignorar */ }

    // Des-registrar este service worker por completo.
    try { await self.registration.unregister(); } catch (e) { /* ignorar */ }

    // Recargar una vez las pestañas para que queden sin ningún controlador SW.
    try {
      var clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach(function (c) { try { c.navigate(c.url); } catch (e) {} });
    } catch (e) { /* ignorar */ }
  })());
});

// No interceptamos fetch: sin redirects, sin popunders, sin push.

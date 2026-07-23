// Service worker minimo. Su presencia permite instalar la PWA en el celular
// y ayuda a que el navegador mantenga la pestaña con mayor prioridad.
// IMPORTANTE: ningun navegador garantiza geolocalizacion 100% en segundo plano
// si la app esta cerrada del todo. Lo mas confiable es: PWA "instalada" en la
// pantalla de inicio (Android) y con la pantalla encendida en el bolsillo,
// o dejar el celular con la app abierta en primer plano durante la ruta.

const CACHE_NAME = 'repartidor-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // No cacheamos nada dinamico (ubicacion, paradas); solo dejamos pasar la red.
});

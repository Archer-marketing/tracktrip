const { getSetting, setSetting } = require('./settingsService');
const { parseLatLng } = require('./mapsLinkService');

// Punto de partida por defecto (ej. la oficina/bodega) para armar rutas.
// Se resuelve una sola vez (la liga de Maps -> lat/lng) y se cachea en
// settings, para no pegarle a Google en cada carga del panel.
async function getDefaultStartPoint() {
  const url = getSetting('default_start_url');
  if (!url) return null;

  const label = getSetting('default_start_label') || '📍 Punto por defecto';
  const cachedLat = getSetting('default_start_lat');
  const cachedLng = getSetting('default_start_lng');
  if (cachedLat && cachedLng) {
    return { url, label, lat: parseFloat(cachedLat), lng: parseFloat(cachedLng) };
  }

  const resolved = await parseLatLng(url);
  if (!resolved) return { url, label, lat: null, lng: null };

  setSetting('default_start_lat', String(resolved.lat));
  setSetting('default_start_lng', String(resolved.lng));
  return { url, label, lat: resolved.lat, lng: resolved.lng };
}

function setDefaultStartPoint(url, label) {
  setSetting('default_start_url', url || '');
  setSetting('default_start_label', label || '');
  // Limpia las coords cacheadas para forzar que se resuelva la liga nueva.
  setSetting('default_start_lat', '');
  setSetting('default_start_lng', '');
}

module.exports = { getDefaultStartPoint, setDefaultStartPoint };

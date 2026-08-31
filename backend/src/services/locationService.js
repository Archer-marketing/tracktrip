const db = require('../db');
const { haversine } = require('./routingService');

// Si se movio menos de esto desde el ultimo punto guardado, se considera
// "el mismo lugar" (ruido normal de GPS parado).
const STATIONARY_THRESHOLD_METERS = 40;

// Guarda la ubicacion del repartidor y, de paso, detecta si sigue
// "en el mismo punto" desde hace rato (para que el admin vea cuanto
// llevan detenidos - solo informativo, no afecta nada mas del sistema).
function updateDriverLocation(driverId, lat, lng) {
  const prev = db
    .prepare('SELECT lat, lng, stationary_since FROM driver_locations WHERE driver_id = ?')
    .get(driverId);

  let stationarySince = new Date().toISOString();
  if (prev && prev.stationary_since) {
    const movedMeters = haversine({ lat: prev.lat, lng: prev.lng }, { lat, lng });
    if (movedMeters < STATIONARY_THRESHOLD_METERS) {
      stationarySince = prev.stationary_since;
    }
  }

  db.prepare(
    `INSERT INTO driver_locations (driver_id, lat, lng, updated_at, stationary_since)
     VALUES (?, ?, ?, datetime('now'), ?)
     ON CONFLICT(driver_id) DO UPDATE SET
       lat=excluded.lat, lng=excluded.lng, updated_at=excluded.updated_at,
       stationary_since=excluded.stationary_since`
  ).run(driverId, lat, lng, stationarySince);
}

module.exports = { updateDriverLocation };

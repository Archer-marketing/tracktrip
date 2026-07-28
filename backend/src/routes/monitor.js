const express = require('express');
const db = require('../db');

const router = express.Router();

// Publica y sin token: es la liga fija que se comparte con el equipo para
// ver a todos los repartidores en vivo (solo lectura, no permite editar
// nada). A proposito no pide contraseña ni token para que la liga sea
// siempre /monitor, sin nada que copiar mal ni que se rompa con un deploy.
router.get('/data', (req, res) => {
  const drivers = db
    .prepare(
      `SELECT d.id, d.name, l.lat, l.lng, l.updated_at, l.stationary_since
       FROM drivers d LEFT JOIN driver_locations l ON l.driver_id = d.id
       WHERE d.active = 1`
    )
    .all();

  const stopsByDriver = db.prepare(
    `SELECT s.driver_id, s.id, s.status, s.sequence, c.name, c.lat, c.lng
     FROM stops s JOIN customers c ON c.id = s.customer_id
     WHERE s.driver_id = ?
       AND (s.status = 'assigned' OR (s.status = 'delivered' AND date(s.delivered_at) = date('now')))
     ORDER BY s.sequence ASC`
  );

  const result = drivers.map((d) => {
    const stops = stopsByDriver.all(d.id);
    const delivered = stops.filter((s) => s.status === 'delivered').length;
    const remaining = stops
      .filter((s) => s.status === 'assigned' && s.lat != null && s.lng != null)
      .map((s) => ({ id: s.id, name: s.name, lat: s.lat, lng: s.lng, seq: s.sequence }));

    return {
      id: d.id,
      name: d.name,
      lat: d.lat,
      lng: d.lng,
      updated_at: d.updated_at,
      stationary_since: d.stationary_since,
      delivered,
      total: stops.length,
      remaining,
    };
  });

  res.json({ drivers: result });
});

module.exports = router;

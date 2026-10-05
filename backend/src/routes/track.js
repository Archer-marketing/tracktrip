const express = require('express');
const db = require('../db');

const router = express.Router();

// Publico, sin contraseña de admin: es la liga que se comparte con el cliente.
router.get('/:token', (req, res) => {
  const { token } = req.params;

  const customer = db
    .prepare(
      `SELECT id, name, lat, lng, tracking_token_expires_at
       FROM customers WHERE tracking_token = ?`
    )
    .get(token);

  if (!customer) return res.status(404).json({ status: 'no_encontrado' });
  if (new Date(customer.tracking_token_expires_at).getTime() < Date.now()) {
    return res.status(410).json({ status: 'expirado' });
  }

  const stop = db
    .prepare(
      `SELECT id, status, sequence, driver_id
       FROM stops WHERE customer_id = ?
       ORDER BY id DESC LIMIT 1`
    )
    .get(customer.id);

  if (!stop) return res.json({ status: 'sin_pedido' });

  if (stop.status === 'delivered') {
    return res.json({ status: 'delivered' });
  }

  if (stop.status !== 'assigned' || !stop.driver_id) {
    return res.json({ status: 'pendiente' });
  }

  const remaining = db
    .prepare(
      `SELECT COUNT(*) as n FROM stops
       WHERE driver_id = ? AND status = 'assigned' AND sequence < ?`
    )
    .get(stop.driver_id, stop.sequence).n;

  const driverLoc = db
    .prepare('SELECT lat, lng, updated_at FROM driver_locations WHERE driver_id = ?')
    .get(stop.driver_id);

  const driver = db.prepare('SELECT name FROM drivers WHERE id = ?').get(stop.driver_id);

  res.json({
    status: 'en_ruta',
    remaining,
    driverName: driver ? driver.name : null,
    driverLocation: driverLoc ? { lat: driverLoc.lat, lng: driverLoc.lng, updatedAt: driverLoc.updated_at } : null,
    customerLocation: customer.lat != null ? { lat: customer.lat, lng: customer.lng } : null,
  });
});

module.exports = router;

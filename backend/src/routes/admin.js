const express = require('express');
const db = require('../db');
const { syncFromKommo } = require('../services/kommoService');
const { optimizeRoute } = require('../services/routingService');

const router = express.Router();

function requireAdmin(req, res, next) {
  const pass = req.headers['x-admin-password'];
  if (pass !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
}
router.use(requireAdmin);

// --- Drivers ---
router.get('/drivers', (req, res) => {
  const drivers = db
    .prepare(
      `SELECT d.id, d.name, d.login_code, d.active, l.lat, l.lng, l.updated_at
       FROM drivers d LEFT JOIN driver_locations l ON l.driver_id = d.id`
    )
    .all();
  res.json(drivers);
});

router.post('/drivers', (req, res) => {
  const { name, login_code } = req.body;
  if (!name || !login_code) return res.status(400).json({ error: 'Faltan datos' });
  const info = db
    .prepare('INSERT INTO drivers (name, login_code) VALUES (?, ?)')
    .run(name, login_code);
  res.json({ id: info.lastInsertRowid });
});

// --- Kommo sync ---
router.post('/sync-kommo', async (req, res) => {
  try {
    const result = await syncFromKommo();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Customers / stops pendientes ---
router.get('/stops', (req, res) => {
  const stops = db
    .prepare(
      `SELECT s.id, s.status, s.sequence, s.driver_id,
              c.id as customer_id, c.name, c.address, c.lat, c.lng
       FROM stops s JOIN customers c ON c.id = s.customer_id
       WHERE s.status != 'delivered'
       ORDER BY s.driver_id, s.sequence`
    )
    .all();
  res.json(stops);
});

// --- Asignar y optimizar ruta para un repartidor ---
router.post('/assign-route', async (req, res) => {
  const { driver_id, stop_ids } = req.body; // stop_ids: ids de stops pendientes a asignar
  if (!driver_id || !Array.isArray(stop_ids) || !stop_ids.length) {
    return res.status(400).json({ error: 'Faltan datos' });
  }

  const loc = db.prepare('SELECT lat, lng FROM driver_locations WHERE driver_id = ?').get(driver_id);
  if (!loc) {
    return res.status(400).json({ error: 'No hay ubicacion reciente de ese repartidor todavia' });
  }

  const placeholders = stop_ids.map(() => '?').join(',');
  const stops = db
    .prepare(
      `SELECT s.id as stop_id, c.id, c.name, c.lat, c.lng
       FROM stops s JOIN customers c ON c.id = s.customer_id
       WHERE s.id IN (${placeholders})`
    )
    .all(...stop_ids);

  const ordered = await optimizeRoute(loc, stops);

  const update = db.prepare(
    `UPDATE stops SET driver_id = ?, sequence = ?, status = 'assigned', assigned_at = datetime('now') WHERE id = ?`
  );
  const tx = db.transaction((items) => {
    items.forEach((item, idx) => update.run(driver_id, idx + 1, item.stop_id));
  });
  tx(ordered);

  res.json({ ok: true, order: ordered.map((o) => o.name) });
});

module.exports = router;

const express = require('express');
const db = require('../db');

const router = express.Router();

router.post('/login', (req, res) => {
  const { code } = req.body;
  const driver = db.prepare('SELECT * FROM drivers WHERE login_code = ? AND active = 1').get(code);
  if (!driver) return res.status(401).json({ error: 'Codigo invalido' });
  res.json({ id: driver.id, name: driver.name });
});

// Respaldo por HTTP ademas de socket.io (por si el socket se cae)
router.post('/location', (req, res) => {
  const { driver_id, lat, lng } = req.body;
  if (!driver_id || lat == null || lng == null) return res.status(400).json({ error: 'Faltan datos' });
  db.prepare(
    `INSERT INTO driver_locations (driver_id, lat, lng, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(driver_id) DO UPDATE SET lat=excluded.lat, lng=excluded.lng, updated_at=excluded.updated_at`
  ).run(driver_id, lat, lng);
  res.json({ ok: true });
});

router.get('/next-stop/:driverId', (req, res) => {
  const { driverId } = req.params;
  const stop = db
    .prepare(
      `SELECT s.id, c.name, c.address, c.lat, c.lng, s.sequence
       FROM stops s JOIN customers c ON c.id = s.customer_id
       WHERE s.driver_id = ? AND s.status = 'assigned'
       ORDER BY s.sequence ASC LIMIT 1`
    )
    .get(driverId);

  if (!stop) return res.json({ stop: null });

  const remaining = db
    .prepare(`SELECT COUNT(*) as n FROM stops WHERE driver_id = ? AND status = 'assigned'`)
    .get(driverId).n;

  const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${stop.lat},${stop.lng}&travelmode=driving`;

  res.json({ stop: { ...stop, mapsUrl }, remaining });
});

router.post('/complete-stop', (req, res) => {
  const { stop_id } = req.body;
  db.prepare(`UPDATE stops SET status = 'delivered', delivered_at = datetime('now') WHERE id = ?`).run(
    stop_id
  );
  res.json({ ok: true });
});

module.exports = router;

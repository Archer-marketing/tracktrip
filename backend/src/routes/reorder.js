const express = require('express');
const db = require('../db');
const { nextSequenceForDriverToday } = require('../services/sequenceService');
const { checkBotTriggersForDriver } = require('../services/botNotificationService');

const router = express.Router();

// Liga separada para reacomodar rutas en vivo (drag-and-drop, pensada para
// celular). Tiene su propio password (REORDER_PASSWORD), distinto del
// admin, para poder compartirla con un supervisor/encargado de ruta sin
// darle acceso al panel completo (repartidores, Kommo, Zoho, etc).
router.post('/login', (req, res) => {
  const { password } = req.body;
  if (!process.env.REORDER_PASSWORD || password !== process.env.REORDER_PASSWORD) {
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  res.json({ ok: true });
});

function requireReorderAccess(req, res, next) {
  const pass = req.headers['x-reorder-password'];
  if (!process.env.REORDER_PASSWORD || pass !== process.env.REORDER_PASSWORD) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
}
router.use(requireReorderAccess);

// Repartidores con ruta activa hoy, para elegir cual reacomodar.
router.get('/drivers', (req, res) => {
  const drivers = db
    .prepare(
      `SELECT d.id, d.name,
        (SELECT COUNT(*) FROM stops s WHERE s.driver_id = d.id AND s.status = 'assigned') as active_count
       FROM drivers d
       WHERE d.active = 1
       ORDER BY d.name`
    )
    .all();
  res.json(drivers);
});

// Ruta activa (sin entregar) de un repartidor, en orden.
router.get('/route/:driverId', (req, res) => {
  const { driverId } = req.params;
  const stops = db
    .prepare(
      `SELECT s.id, s.sequence, c.name, c.address
       FROM stops s JOIN customers c ON c.id = s.customer_id
       WHERE s.driver_id = ? AND s.status = 'assigned'
       ORDER BY s.sequence ASC`
    )
    .all(driverId);
  res.json({ stops });
});

// Guarda el nuevo orden. Solo toca paradas 'assigned' de ESE repartidor
// (ignora cualquier id que no le pertenezca o ya este entregado, por si
// la lista en pantalla quedo desactualizada). No resetea route_started -
// reacomodar no es lo mismo que reasignar la ruta, el repartidor ya la
// inicio y solo cambia el orden.
router.post('/route/:driverId', (req, res) => {
  const { driverId } = req.params;
  const { ordered_stop_ids } = req.body;
  if (!Array.isArray(ordered_stop_ids) || !ordered_stop_ids.length) {
    return res.status(400).json({ error: 'Faltan datos' });
  }

  const valid = db
    .prepare(`SELECT id FROM stops WHERE driver_id = ? AND status = 'assigned'`)
    .all(driverId)
    .map((r) => r.id);
  const validSet = new Set(valid);
  const ids = ordered_stop_ids.filter((id) => validSet.has(Number(id)));
  if (!ids.length) return res.status(400).json({ error: 'Ninguna parada valida para reacomodar' });

  const baseSeq = nextSequenceForDriverToday(driverId, ids);
  const update = db.prepare('UPDATE stops SET sequence = ? WHERE id = ?');
  const tx = db.transaction((rows) => {
    rows.forEach((id, idx) => update.run(baseSeq + idx + 1, id));
  });
  tx(ids);

  checkBotTriggersForDriver(driverId).catch((err) => {
    console.error('Error revisando salesbots tras reacomodar:', err.message);
  });

  res.json({ ok: true });
});

module.exports = router;

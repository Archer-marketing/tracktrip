const express = require('express');
const db = require('../db');
const { checkBotTriggersForDriver } = require('../services/botNotificationService');
const { updateDriverLocation } = require('../services/locationService');
const { markLeadDelivered } = require('../services/kommoService');

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
  updateDriverLocation(driver_id, lat, lng);
  res.json({ ok: true });
});

router.get('/next-stop/:driverId', (req, res) => {
  const { driverId } = req.params;
  const driver = db.prepare('SELECT route_started FROM drivers WHERE id = ?').get(driverId);
  const routeStarted = !!(driver && driver.route_started);

  const stop = db
    .prepare(
      `SELECT s.id, c.name, c.address, c.lat, c.lng, c.invoice, s.sequence
       FROM stops s JOIN customers c ON c.id = s.customer_id
       WHERE s.driver_id = ? AND s.status = 'assigned'
       ORDER BY s.sequence ASC LIMIT 1`
    )
    .get(driverId);

  if (!stop) return res.json({ stop: null, routeStarted });

  const remaining = db
    .prepare(`SELECT COUNT(*) as n FROM stops WHERE driver_id = ? AND status = 'assigned'`)
    .get(driverId).n;

  // Sin liga de Maps hasta que confirme "Iniciar ruta" (ver tambien
  // /complete-stop, que rechaza la entrega por la misma razon).
  const mapsUrl = routeStarted
    ? `https://www.google.com/maps/dir/?api=1&destination=${stop.lat},${stop.lng}&travelmode=driving`
    : null;

  res.json({ stop: { ...stop, mapsUrl }, remaining, routeStarted });
});

// El repartidor toca "Iniciar ruta" en su pantalla; hasta entonces no se
// dispara ninguna alerta de Kommo para su ruta actual. Al tocarlo, revisa
// de una vez si ya toca avisar algo (ej. si ya arrancaba a 0 o 3 de una).
router.post('/start-route', (req, res) => {
  const { driver_id } = req.body;
  if (!driver_id) return res.status(400).json({ error: 'Faltan datos' });
  db.prepare('UPDATE drivers SET route_started = 1 WHERE id = ?').run(driver_id);
  res.json({ ok: true });

  checkBotTriggersForDriver(driver_id).catch((err) => {
    console.error('Error revisando salesbots al iniciar ruta:', err.message);
  });
});

// Ruta completa del repartidor (pendientes + entregados hoy, en orden),
// para que vea el panorama completo y no solo la siguiente parada -
// util si un cliente no esta y prefiere saltarlo y volver despues.
router.get('/route/:driverId', (req, res) => {
  const { driverId } = req.params;
  const driver = db.prepare('SELECT route_started FROM drivers WHERE id = ?').get(driverId);
  const routeStarted = !!(driver && driver.route_started);

  const stops = db
    .prepare(
      `SELECT s.id, s.status, s.sequence, c.name, c.address, c.lat, c.lng, c.invoice
       FROM stops s JOIN customers c ON c.id = s.customer_id
       WHERE s.driver_id = ?
         AND (s.status = 'assigned' OR (s.status = 'delivered' AND date(s.delivered_at) = date('now')))
       ORDER BY s.sequence ASC`
    )
    .all(driverId);

  const withMaps = stops.map((s) => ({
    ...s,
    mapsUrl: routeStarted
      ? `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}&travelmode=driving`
      : null,
  }));

  res.json({ stops: withMaps, routeStarted });
});

router.post('/complete-stop', (req, res) => {
  const { stop_id } = req.body;
  const stop = db
    .prepare(
      `SELECT s.driver_id, c.kommo_lead_id
       FROM stops s JOIN customers c ON c.id = s.customer_id
       WHERE s.id = ?`
    )
    .get(stop_id);
  if (!stop) return res.status(404).json({ error: 'Pedido no encontrado' });

  // No se puede marcar como entregado sin antes confirmar "Iniciar ruta"
  // (misma regla que bloquea las alertas de Kommo y la liga de Maps).
  const driver = db.prepare('SELECT route_started FROM drivers WHERE id = ?').get(stop.driver_id);
  if (!driver || !driver.route_started) {
    return res.status(403).json({ error: 'Primero tienes que confirmar el inicio de la ruta' });
  }

  db.prepare(`UPDATE stops SET status = 'delivered', delivered_at = datetime('now') WHERE id = ?`).run(
    stop_id
  );
  res.json({ ok: true });

  // Al entregar, los que faltaban antes de los demas pedidos de este
  // repartidor bajan uno - revisa si alguno acaba de quedar a 3 o a 0.
  if (stop && stop.driver_id) {
    checkBotTriggersForDriver(stop.driver_id).catch((err) => {
      console.error('Error disparando salesbots de Kommo:', err.message);
    });
  }

  // Mueve el lead a la etapa de "entregado" configurada por env (si se
  // configuro - ver KOMMO_DELIVERED_STATUS_ID).
  if (stop && stop.kommo_lead_id) {
    markLeadDelivered(stop.kommo_lead_id).catch((err) => {
      console.error('Error moviendo el lead de Kommo al entregar:', err.message);
    });
  }
});

module.exports = router;

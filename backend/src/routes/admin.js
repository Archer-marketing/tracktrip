const express = require('express');
const db = require('../db');
const {
  syncFromKommo,
  getPipelines,
  getSyncStatusFilter,
  setSyncStatusFilter,
  getLeadCustomFields,
  getSyncFieldConfig,
  setSyncFieldConfig,
  getSyncInvoiceFieldConfig,
  setSyncInvoiceFieldConfig,
} = require('../services/kommoService');
const { optimizeRoute } = require('../services/routingService');
const { createTrackingLinksForStops } = require('../services/trackingService');

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
  try {
    const info = db
      .prepare('INSERT INTO drivers (name, login_code) VALUES (?, ?)')
      .run(name, login_code);
    res.json({ id: info.lastInsertRowid });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(400).json({ error: 'Ese código de acceso ya está en uso, elige otro' });
    }
    res.status(500).json({ error: err.message });
  }
});

// Activa/desactiva el codigo de acceso de un repartidor. El login en
// /driver ya filtra por active=1, asi que desactivarlo aqui bloquea la
// entrada al instante sin borrar su historial de pedidos/entregas.
router.post('/drivers/:id/active', (req, res) => {
  const { id } = req.params;
  const { active } = req.body;
  db.prepare('UPDATE drivers SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
  res.json({ ok: true });
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

// --- Kommo: embudos/etapas para elegir cual sincronizar ---
router.get('/kommo/pipelines', async (req, res) => {
  try {
    const pipelines = await getPipelines();
    res.json(pipelines);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/kommo/status-filter', (req, res) => {
  res.json(getSyncStatusFilter());
});

router.post('/kommo/status-filter', (req, res) => {
  const { pipeline_id, status_id } = req.body;
  if (!pipeline_id || !status_id) return res.status(400).json({ error: 'Faltan datos' });
  setSyncStatusFilter(pipeline_id, status_id);
  res.json({ ok: true });
});

// --- Kommo: campo de direccion o liga de Maps a leer de cada lead ---
router.get('/kommo/custom-fields', async (req, res) => {
  try {
    const fields = await getLeadCustomFields();
    res.json(fields);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/kommo/field-config', (req, res) => {
  res.json(getSyncFieldConfig());
});

router.post('/kommo/field-config', (req, res) => {
  const { field_id } = req.body;
  if (!field_id) return res.status(400).json({ error: 'Faltan datos' });
  setSyncFieldConfig(field_id);
  res.json({ ok: true });
});

// --- Kommo: campo opcional con la factura, para mostrarsela al repartidor ---
router.get('/kommo/invoice-field-config', (req, res) => {
  res.json(getSyncInvoiceFieldConfig());
});

router.post('/kommo/invoice-field-config', (req, res) => {
  const { invoice_field_id } = req.body;
  setSyncInvoiceFieldConfig(invoice_field_id);
  res.json({ ok: true });
});

// --- Customers / stops (pendientes + asignados + entregados hoy, para ver
// en el mapa quien va, quien falta y quien ya entrego) ---
router.get('/stops', (req, res) => {
  const stops = db
    .prepare(
      `SELECT s.id, s.status, s.sequence, s.driver_id, s.delivered_at,
              c.id as customer_id, c.name, c.address, c.lat, c.lng, c.kommo_lead_id
       FROM stops s JOIN customers c ON c.id = s.customer_id
       WHERE s.status != 'delivered' OR date(s.delivered_at) = date('now')
       ORDER BY s.driver_id, s.sequence`
    )
    .all();
  const subdomain = process.env.KOMMO_SUBDOMAIN;
  const withKommoUrl = stops.map((s) => ({
    ...s,
    kommo_url:
      subdomain && s.kommo_lead_id
        ? `https://${subdomain}.kommo.com/leads/detail/${s.kommo_lead_id}`
        : null,
  }));
  res.json(withKommoUrl);
});

// Resuelve el punto de partida (pin/cliente resuelto ya en el frontend, o
// la ubicacion actual del repartidor si no se manda `start`) y los stops
// con ubicacion valida, compartido por preview-route y assign-route.
function resolveRouteInputs(req, res) {
  const { driver_id, stop_ids, start, end } = req.body;
  if (!driver_id || !Array.isArray(stop_ids) || !stop_ids.length) {
    res.status(400).json({ error: 'Faltan datos' });
    return null;
  }

  let startLoc = start && start.lat != null && start.lng != null ? start : null;
  if (!startLoc) {
    const loc = db.prepare('SELECT lat, lng FROM driver_locations WHERE driver_id = ?').get(driver_id);
    if (!loc) {
      res.status(400).json({ error: 'No hay ubicacion reciente de ese repartidor todavia' });
      return null;
    }
    startLoc = loc;
  }
  const endLoc = end && end.lat != null && end.lng != null ? end : null;

  const placeholders = stop_ids.map(() => '?').join(',');
  const allStops = db
    .prepare(
      `SELECT s.id as stop_id, c.id, c.name, c.lat, c.lng
       FROM stops s JOIN customers c ON c.id = s.customer_id
       WHERE s.id IN (${placeholders})`
    )
    .all(...stop_ids);

  const stops = allStops.filter((s) => s.lat != null && s.lng != null);
  if (!stops.length) {
    res.status(400).json({ error: 'Ninguno de los pedidos seleccionados tiene ubicacion' });
    return null;
  }

  return { driver_id, startLoc, endLoc, stops };
}

// --- Vista previa: calcula el orden optimo pero NO guarda nada todavia ---
router.post('/preview-route', async (req, res) => {
  const inputs = resolveRouteInputs(req, res);
  if (!inputs) return;
  const { startLoc, endLoc, stops } = inputs;

  const ordered = await optimizeRoute(startLoc, stops, endLoc);

  res.json({
    start: startLoc,
    end: endLoc,
    order: ordered.map((o, idx) => ({
      stop_id: o.stop_id,
      name: o.name,
      lat: o.lat,
      lng: o.lng,
      seq: idx + 1,
    })),
  });
});

// --- Confirma y guarda el orden ya calculado (via preview-route) ---
router.post('/assign-route', (req, res) => {
  const { driver_id, ordered_stop_ids } = req.body;
  if (!driver_id || !Array.isArray(ordered_stop_ids) || !ordered_stop_ids.length) {
    return res.status(400).json({ error: 'Faltan datos' });
  }

  const update = db.prepare(
    `UPDATE stops SET driver_id = ?, sequence = ?, status = 'assigned', assigned_at = datetime('now') WHERE id = ?`
  );
  const tx = db.transaction((ids) => {
    ids.forEach((id, idx) => update.run(driver_id, idx + 1, id));
  });
  tx(ordered_stop_ids);

  // Genera/renueva la liga publica de rastreo (24h) de cada pedido recien
  // asignado y la manda al campo de Kommo configurado. No se espera aqui
  // (fire-and-forget) para no atrasar la respuesta al panel.
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  createTrackingLinksForStops(baseUrl, ordered_stop_ids).catch((err) => {
    console.error('Error generando ligas de rastreo:', err.message);
  });

  res.json({ ok: true });
});

module.exports = router;

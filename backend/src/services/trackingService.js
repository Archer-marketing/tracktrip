const crypto = require('crypto');
const db = require('../db');
const { updateLeadTrackingField } = require('./kommoService');

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas

function generateToken() {
  return crypto.randomBytes(24).toString('base64url');
}

// Genera (o renueva) la liga publica de rastreo para cada stop recien
// asignado, y manda esa liga al custom field configurado en Kommo. Se llama
// sin esperar la respuesta (fire-and-forget) desde /assign-route, para no
// atrasar la confirmacion en el panel - la cola de kommoService ya se
// encarga de no pasarse del limite de solicitudes por segundo.
async function createTrackingLinksForStops(baseUrl, stopIds) {
  if (!stopIds.length) return;

  const placeholders = stopIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT s.id as stop_id, c.id as customer_id, c.kommo_lead_id
       FROM stops s JOIN customers c ON c.id = s.customer_id
       WHERE s.id IN (${placeholders})`
    )
    .all(...stopIds);

  const update = db.prepare(
    `UPDATE customers SET tracking_token = ?, tracking_token_expires_at = ? WHERE id = ?`
  );

  for (const row of rows) {
    const token = generateToken();
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
    update.run(token, expiresAt, row.customer_id);

    if (row.kommo_lead_id) {
      const url = `${baseUrl}/track/${token}`;
      await updateLeadTrackingField(row.kommo_lead_id, url);
    }
  }
}

module.exports = { createTrackingLinksForStops };
